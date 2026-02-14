const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const rooms = require("./rooms");
const words = require("./words");

const app = express();
const server = http.createServer(app);
const PORT = Number(process.env.PORT || 3001);
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "*";
const io = new Server(server, {
  cors: {
    origin: CLIENT_ORIGIN,
    methods: ["GET", "POST"]
  }
});
const MAX_SCORE = 5;
const MAX_WRONG_GUESSES = 5;
const MAX_LOBBY_NOTES = 50;
const MAX_MUSIC_SUGGESTIONS = 100;
const MAX_MUSIC_QUEUE = 200;
const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
const SPOTIFY_API_BASE = "https://api.spotify.com/v1";
const DEFAULT_WHEEL_OPTIONS = [
  "Movie night pick",
  "Coffee date challenge",
  "Sing one chorus",
  "Tell a fun memory"
];
function randomWord() {
  return words[Math.floor(Math.random() * words.length)];
}

function normalizeWheelOptions(options) {
  if (!Array.isArray(options)) return [];
  const seen = new Set();
  const result = [];
  for (const raw of options) {
    const value = String(raw || "").trim().slice(0, 80);
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
    if (result.length >= 24) break;
  }
  return result;
}

function normalizeLobbyNote(text) {
  return String(text || "").trim().slice(0, 220);
}

function makeId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeTrackCandidate(track) {
  if (!track || typeof track !== "object") return null;
  const uri = String(track.uri || "").trim();
  const name = String(track.name || "").trim().slice(0, 160);
  if (!uri || !name) return null;
  if (!uri.startsWith("spotify:track:")) return null;

  return {
    id: String(track.id || "").trim().slice(0, 120),
    uri,
    name,
    artists: String(track.artists || "").trim().slice(0, 220),
    albumImage: String(track.albumImage || "").trim().slice(0, 500)
  };
}

async function refreshSpotifySession(clientId, refreshToken) {
  if (!clientId || !refreshToken) return null;
  const params = new URLSearchParams();
  params.set("client_id", clientId);
  params.set("grant_type", "refresh_token");
  params.set("refresh_token", refreshToken);

  const res = await fetch(SPOTIFY_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params
  });
  if (!res.ok) {
    throw new Error("Spotify refresh failed.");
  }
  const data = await res.json();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000
  };
}

async function ensureRoomSpotifySession(room) {
  const music = room.music || {};
  const session = music.hostSession;
  if (!session?.accessToken) return null;
  if (Date.now() <= (session.expiresAt || 0) - 30_000) return session;

  const next = await refreshSpotifySession(music.clientId, session.refreshToken);
  if (!next) return null;
  room.music.hostSession = next;
  return next;
}

async function spotifyHostFetch(room, path, init) {
  const session = await ensureRoomSpotifySession(room);
  if (!session?.accessToken) throw new Error("Host Spotify session is missing.");

  const res = await fetch(`${SPOTIFY_API_BASE}${path}`, {
    ...init,
    headers: {
      ...(init?.headers || {}),
      Authorization: `Bearer ${session.accessToken}`
    }
  });
  if (res.status === 204) return null;
  if (!res.ok) throw new Error(`Spotify API failed (${res.status}).`);
  return res.json();
}

function getMusicDeviceQuery(room) {
  const deviceId = room.music?.hostDeviceId;
  return deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : "";
}

function syncStatuses(room) {
  room.users.forEach((u) => {
    if (u.userKey === room.game.drawerUserKey) {
      u.status = u.socketId ? "DRAWING" : "DISCONNECTED";
      return;
    }

    if (u.userKey === room.game.guesserUserKey) {
      u.status = u.socketId ? "GUESSING" : "DISCONNECTED";
      return;
    }

    u.status = u.socketId ? "WAITING" : "DISCONNECTED";
  });
}

function rotateRoles(room) {
  const nextDrawerUserKey = room.game.guesserUserKey;
  const nextGuesserUserKey = room.game.drawerUserKey;
  const nextDrawer = room.users.find((u) => u.userKey === nextDrawerUserKey);
  const nextGuesser = room.users.find((u) => u.userKey === nextGuesserUserKey);

  room.game.drawerUserKey = nextDrawerUserKey;
  room.game.guesserUserKey = nextGuesserUserKey;
  room.game.drawerId = nextDrawer?.socketId || null;
  room.game.guesserId = nextGuesser?.socketId || null;
  room.game.currentWord = randomWord();
  room.game.strokes = [];
  room.game.winnerUserKey = null;
  room.game.wrongGuessCount = 0;

  syncStatuses(room);
}

function startRound(room) {
  const connectedUsers = room.users.filter((u) => !!u.socketId);
  if (connectedUsers.length < 2) {
    room.game.drawerId = null;
    room.game.guesserId = null;
    room.game.drawerUserKey = null;
    room.game.guesserUserKey = null;
    room.game.currentWord = null;
    room.game.strokes = [];
    room.game.winnerUserKey = null;
    syncStatuses(room);
    return;
  }

  const [u1, u2] = connectedUsers;
  room.game.drawerId = u1.socketId;
  room.game.guesserId = u2.socketId;
  room.game.drawerUserKey = u1.userKey;
  room.game.guesserUserKey = u2.userKey;
  room.game.currentWord = randomWord();
  room.game.strokes = [];
  room.game.winnerUserKey = null;
  room.game.wrongGuessCount = 0;
  syncStatuses(room);
}

function syncWheelTurn(room) {
  const wheelUsers = room.users.filter(
    (u) => !!u.socketId && u.currentGame === "WHEEL"
  );
  if (wheelUsers.length === 0) {
    room.game.wheelTurnUserKey = null;
    return;
  }

  const hasCurrentTurn = wheelUsers.some(
    (u) => u.userKey === room.game.wheelTurnUserKey
  );
  if (!hasCurrentTurn) {
    room.game.wheelTurnUserKey = wheelUsers[0].userKey;
  }
}

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  // ========================
  // CREATE ROOM
  // ========================
  socket.on("CREATE_ROOM", ({ roomId, pin, name, color, userKey }) => {
    if (rooms[roomId]) return;

    rooms[roomId] = {
      roomId,
      pin,
      users: [
        {
          userKey,
          socketId: socket.id,
          name,
          color,
          status: "WAITING",
          points: 0,
          currentGame: "DRAWING"
        }
      ],
      game: {
        drawerId: null,
        guesserId: null,
        drawerUserKey: null,
        guesserUserKey: null,
        currentWord: null,
        strokes: [],
        winnerUserKey: null,
        wrongGuessCount: 0,
        wheelTurnUserKey: null,
        wheelOptions: [...DEFAULT_WHEEL_OPTIONS]
      },
      music: {
        hostUserKey: null,
        hostSocketId: null,
        hostName: null,
        hostDeviceId: null,
        hasHostSession: false,
        clientId: null,
        hostSession: null,
        suggestions: [],
        queue: []
      },
      lobbyNotes: []
    };

    socket.join(roomId);
    io.to(roomId).emit("ROOM_STATE", rooms[roomId]);
  });

  // ========================
  // JOIN / REJOIN ROOM
  // ========================
  socket.on("JOIN_ROOM", ({ roomId, pin, name, color, userKey }) => {
    // First user creates the room implicitly by joining.
    if (!rooms[roomId]) {
      rooms[roomId] = {
        roomId,
        pin,
        users: [
          {
            userKey,
            socketId: socket.id,
            name,
            color,
            status: "WAITING",
            points: 0,
            currentGame: "DRAWING"
          }
        ],
        game: {
          drawerId: null,
          guesserId: null,
          drawerUserKey: null,
          guesserUserKey: null,
          currentWord: null,
          strokes: [],
          winnerUserKey: null,
          wrongGuessCount: 0,
          wheelTurnUserKey: null,
          wheelOptions: [...DEFAULT_WHEEL_OPTIONS]
        },
        music: {
          hostUserKey: null,
          hostSocketId: null,
          hostName: null,
          hostDeviceId: null,
          hasHostSession: false,
          clientId: null,
          hostSession: null,
          suggestions: [],
          queue: []
        },
        lobbyNotes: []
      };

      socket.join(roomId);
      socket.emit("ROOM_STATE", rooms[roomId]);
      io.to(roomId).emit("ROOM_STATE", rooms[roomId]);
      return;
    }
    
    const room = rooms[roomId];
    if (room.pin !== pin) {
      socket.emit("JOIN_ERROR", { message: "Invalid PIN for this room." });
      return;
    }

    socket.join(roomId);

    let user = room.users.find(u => u.userKey === userKey);

    // 🔁 Rejoin
    if (user) {
      user.socketId = socket.id;
      if (!user.currentGame) user.currentGame = "DRAWING";

      // Restore live role socket IDs by stable user identity.
      if (room.game.drawerUserKey === user.userKey) {
        room.game.drawerId = socket.id;
      }
      if (room.game.guesserUserKey === user.userKey) {
        room.game.guesserId = socket.id;
      }
    } else {
      if (room.users.length >= 2) {
        socket.emit("JOIN_ERROR", { message: "Room is full." });
        return;
      }

      user = {
        userKey,
        socketId: socket.id,
        name,
        color,
        status: "WAITING",
        points: 0,
        currentGame: "DRAWING"
      };
      room.users.push(user);
    }

    // 🎮 Start game if ready
    if (room.users.length === 2 && !room.game.drawerUserKey) {
      const [u1, u2] = room.users;

      room.game.drawerId = u1.socketId;
      room.game.guesserId = u2.socketId;
      room.game.drawerUserKey = u1.userKey;
      room.game.guesserUserKey = u2.userKey;
      room.game.currentWord = randomWord();
      room.game.winnerUserKey = null;

      io.to(room.game.drawerId).emit("ASSIGN_WORD", {
        word: room.game.currentWord
      });
    }

    // Re-send current word to drawer on reconnect/refresh.
    if (
      room.game.currentWord &&
      room.game.drawerUserKey === userKey
    ) {
      io.to(socket.id).emit("ASSIGN_WORD", {
        word: room.game.currentWord
      });
    }

    // Rehydrate current canvas for refreshed/rejoined client.
    io.to(socket.id).emit("CANVAS_STATE", {
      strokes: room.game.strokes || []
    });

    syncStatuses(room);
    syncWheelTurn(room);
    socket.emit("ROOM_STATE", room);
    io.to(roomId).emit("ROOM_STATE", room);
  });

  // ========================
  // DRAWING SYNC
  // ========================
  socket.on("DRAW", ({ roomId, stroke }) => {
    const room = rooms[roomId];
    if (!room) return;

    if (socket.id !== room.game.drawerId) return;

    room.game.strokes = room.game.strokes || [];
    room.game.strokes.push(stroke);

    socket.to(roomId).emit("DRAW", stroke);
  });

  // ========================
  // MANUAL CLEAR CANVAS
  // ========================
  socket.on("CLEAR_CANVAS_REQUEST", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;

    // Only current drawer can clear.
    if (socket.id !== room.game.drawerId) return;

    room.game.strokes = [];
    io.to(roomId).emit("CLEAR_CANVAS");
  });

  // ========================
  // GUESS HANDLER + ROLE SWAP
  // ========================
  socket.on("GUESS", ({ roomId, guess }) => {
    const room = rooms[roomId];
    if (!room) return;
    if (!room.game.currentWord) return;
    if (!room.game.drawerUserKey || !room.game.guesserUserKey) return;
    if (socket.id !== room.game.guesserId) return;

    if (
      guess.toLowerCase().trim() !==
      room.game.currentWord.toLowerCase()
    ) {
      room.game.wrongGuessCount = (room.game.wrongGuessCount || 0) + 1;

      if (room.game.wrongGuessCount >= MAX_WRONG_GUESSES) {
        const skippedWord = room.game.currentWord;
        rotateRoles(room);

        io.to(roomId).emit("ROUND_SKIPPED", {
          word: skippedWord
        });

        if (room.game.drawerId) {
          io.to(room.game.drawerId).emit("ASSIGN_WORD", {
            word: room.game.currentWord
          });
        }

        io.to(roomId).emit("CLEAR_CANVAS");
        io.to(roomId).emit("ROOM_STATE", room);
        return;
      }

      io.to(socket.id).emit("WRONG_GUESS", {
        message: `Wrong guess (${room.game.wrongGuessCount}/${MAX_WRONG_GUESSES}).`
      });
      return;
    }

    const guessedWord = room.game.currentWord;
    const guesser = room.users.find(
      (u) => u.userKey === room.game.guesserUserKey
    );
    if (!guesser) return;
    guesser.points = (guesser.points || 0) + 1;

    if (guesser.points >= MAX_SCORE) {
      room.game.winnerUserKey = guesser.userKey;
      room.game.drawerId = null;
      room.game.guesserId = null;
      room.game.drawerUserKey = null;
      room.game.guesserUserKey = null;
      room.game.currentWord = null;
      room.game.strokes = [];
      room.game.wrongGuessCount = 0;

      room.users.forEach((u) => {
        u.status = u.socketId ? "WAITING" : "DISCONNECTED";
      });

      io.to(roomId).emit("CLEAR_CANVAS");
      io.to(roomId).emit("GAME_WINNER", {
        userKey: guesser.userKey,
        name: guesser.name,
        points: guesser.points,
        maxScore: MAX_SCORE
      });
      io.to(roomId).emit("ROOM_STATE", room);
      return;
    }

    rotateRoles(room);

    io.to(roomId).emit("ROUND_RESULT", {
      word: guessedWord,
      scorerUserKey: guesser.userKey,
      scorerPoints: guesser.points,
      maxScore: MAX_SCORE
    });

    if (room.game.drawerId) {
      io.to(room.game.drawerId).emit("ASSIGN_WORD", {
        word: room.game.currentWord
      });
    }

    io.to(roomId).emit("CLEAR_CANVAS");
    io.to(roomId).emit("ROOM_STATE", room);
  });

  // ========================
  // SKIP ROUND (NO POINTS)
  // ========================
  socket.on("SKIP_ROUND", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;
    if (!room.game.currentWord) return;
    if (!room.game.drawerUserKey || !room.game.guesserUserKey) return;
    if (socket.id !== room.game.guesserId) return;

    const skippedWord = room.game.currentWord;
    rotateRoles(room);

    io.to(roomId).emit("ROUND_SKIPPED", {
      word: skippedWord
    });

    if (room.game.drawerId) {
      io.to(room.game.drawerId).emit("ASSIGN_WORD", {
        word: room.game.currentWord
      });
    }

    io.to(roomId).emit("CLEAR_CANVAS");
    io.to(roomId).emit("ROOM_STATE", room);
  });

  // ========================
  // RESTART GAME (RESET SCORES)
  // ========================
  socket.on("RESTART_GAME", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;

    const requester = room.users.find((u) => u.socketId === socket.id);
    if (!requester) return;

    room.users.forEach((u) => {
      u.points = 0;
    });
    startRound(room);
    syncWheelTurn(room);

    if (room.game.drawerId) {
      io.to(room.game.drawerId).emit("ASSIGN_WORD", {
        word: room.game.currentWord
      });
    }

    io.to(roomId).emit("CLEAR_CANVAS");
    io.to(roomId).emit("GAME_RESTARTED");
    io.to(roomId).emit("ROOM_STATE", room);
  });

  // ========================
  // ACTIVE TAB / GAME PRESENCE
  // ========================
  socket.on("SET_ACTIVE_GAME", ({ roomId, game }) => {
    const room = rooms[roomId];
    if (!room) return;
    if (game !== "DRAWING" && game !== "WHEEL" && game !== "MUSIC" && game !== "LOBBY") return;

    const user = room.users.find((u) => u.socketId === socket.id);
    if (!user) return;

    user.currentGame = game;
    syncWheelTurn(room);
    io.to(roomId).emit("ROOM_STATE", room);
  });

  // ========================
  // MUSIC HOST / SHARED CONTROL
  // ========================
  socket.on("CLAIM_MUSIC_HOST", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;
    const user = room.users.find((u) => u.socketId === socket.id);
    if (!user) return;

    const currentHostKey = room.music?.hostUserKey;
    if (currentHostKey && currentHostKey !== user.userKey) {
      const currentHost = room.users.find((u) => u.userKey === currentHostKey);
      if (currentHost?.socketId) {
        socket.emit("MUSIC_ERROR", {
          message: `${currentHost.name || "Current host"} is already hosting Spotify.`
        });
        return;
      }
    }

    room.music.hostUserKey = user.userKey;
    room.music.hostSocketId = socket.id;
    room.music.hostName = user.name;
    room.music.hostDeviceId = null;
    room.music.hasHostSession = !!room.music.hostSession?.accessToken;
    io.to(roomId).emit("ROOM_STATE", room);
  });

  socket.on("RELEASE_MUSIC_HOST", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;
    const user = room.users.find((u) => u.socketId === socket.id);
    if (!user) return;
    if (room.music?.hostUserKey !== user.userKey) return;

    room.music.hostUserKey = null;
    room.music.hostSocketId = null;
    room.music.hostName = null;
    room.music.hostDeviceId = null;
    room.music.hasHostSession = false;
    room.music.clientId = null;
    room.music.hostSession = null;
    io.to(roomId).emit("ROOM_STATE", room);
  });

  socket.on("MUSIC_SUGGEST_TRACK", ({ roomId, track }) => {
    const room = rooms[roomId];
    if (!room) return;
    const user = room.users.find((u) => u.socketId === socket.id);
    if (!user) return;

    const normalized = normalizeTrackCandidate(track);
    if (!normalized) return;

    room.music.suggestions = room.music.suggestions || [];
    room.music.suggestions.push({
      suggestionId: makeId("sg"),
      ...normalized,
      suggestedByUserKey: user.userKey,
      suggestedByName: user.name,
      createdAt: Date.now()
    });
    if (room.music.suggestions.length > MAX_MUSIC_SUGGESTIONS) {
      room.music.suggestions = room.music.suggestions.slice(-MAX_MUSIC_SUGGESTIONS);
    }
    io.to(roomId).emit("ROOM_STATE", room);
  });

  socket.on("MUSIC_ACCEPT_SUGGESTION", ({ roomId, suggestionId }) => {
    const room = rooms[roomId];
    if (!room) return;
    const user = room.users.find((u) => u.socketId === socket.id);
    if (!user) return;
    if (room.music?.hostUserKey !== user.userKey) return;

    room.music.suggestions = room.music.suggestions || [];
    const idx = room.music.suggestions.findIndex((s) => s.suggestionId === suggestionId);
    if (idx < 0) return;
    const suggestion = room.music.suggestions[idx];
    room.music.suggestions.splice(idx, 1);

    room.music.queue = room.music.queue || [];
    room.music.queue.push({
      queueId: makeId("q"),
      id: suggestion.id,
      uri: suggestion.uri,
      name: suggestion.name,
      artists: suggestion.artists,
      albumImage: suggestion.albumImage,
      suggestedByUserKey: suggestion.suggestedByUserKey,
      suggestedByName: suggestion.suggestedByName,
      acceptedByUserKey: user.userKey,
      acceptedAt: Date.now()
    });
    if (room.music.queue.length > MAX_MUSIC_QUEUE) {
      room.music.queue = room.music.queue.slice(-MAX_MUSIC_QUEUE);
    }
    io.to(roomId).emit("ROOM_STATE", room);
  });

  socket.on("MUSIC_REJECT_SUGGESTION", ({ roomId, suggestionId }) => {
    const room = rooms[roomId];
    if (!room) return;
    const user = room.users.find((u) => u.socketId === socket.id);
    if (!user) return;
    if (room.music?.hostUserKey !== user.userKey) return;

    room.music.suggestions = (room.music.suggestions || []).filter(
      (s) => s.suggestionId !== suggestionId
    );
    io.to(roomId).emit("ROOM_STATE", room);
  });

  socket.on("MUSIC_ADD_TO_QUEUE", ({ roomId, track }) => {
    const room = rooms[roomId];
    if (!room) return;
    const user = room.users.find((u) => u.socketId === socket.id);
    if (!user) return;
    if (room.music?.hostUserKey !== user.userKey) return;

    const normalized = normalizeTrackCandidate(track);
    if (!normalized) return;

    room.music.queue = room.music.queue || [];
    room.music.queue.push({
      queueId: makeId("q"),
      ...normalized,
      suggestedByUserKey: user.userKey,
      suggestedByName: user.name,
      acceptedByUserKey: user.userKey,
      acceptedAt: Date.now()
    });
    if (room.music.queue.length > MAX_MUSIC_QUEUE) {
      room.music.queue = room.music.queue.slice(-MAX_MUSIC_QUEUE);
    }
    io.to(roomId).emit("ROOM_STATE", room);
  });

  socket.on("SPOTIFY_HOST_SESSION_UPDATE", ({ roomId, clientId, session }) => {
    const room = rooms[roomId];
    if (!room) return;
    const user = room.users.find((u) => u.socketId === socket.id);
    if (!user) return;
    if (room.music?.hostUserKey !== user.userKey) return;
    room.music.hostSocketId = socket.id;
    if (!session?.accessToken) {
      room.music.clientId = String(clientId || room.music.clientId || "");
      room.music.hostSession = null;
      room.music.hasHostSession = false;
      room.music.hostDeviceId = null;
      io.to(roomId).emit("ROOM_STATE", room);
      return;
    }

    room.music.clientId = String(clientId || "");
    room.music.hostSession = {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      expiresAt: Number(session.expiresAt || 0)
    };
    room.music.hasHostSession = true;
    io.to(roomId).emit("ROOM_STATE", room);
  });

  socket.on("SPOTIFY_HOST_DEVICE_UPDATE", ({ roomId, deviceId }) => {
    const room = rooms[roomId];
    if (!room) return;
    const user = room.users.find((u) => u.socketId === socket.id);
    if (!user) return;
    if (room.music?.hostUserKey !== user.userKey) return;

    room.music.hostSocketId = socket.id;
    room.music.hostDeviceId = String(deviceId || "") || null;
    io.to(roomId).emit("ROOM_STATE", room);
  });

  socket.on("MUSIC_CONTROL_REQUEST", async ({ roomId, action, payload }, callback) => {
    const done = typeof callback === "function" ? callback : () => {};
    const room = rooms[roomId];
    if (!room) {
      done({ ok: false, error: "Room not found." });
      return;
    }

    const user = room.users.find((u) => u.socketId === socket.id);
    if (!user) {
      done({ ok: false, error: "User not found." });
      return;
    }

    if (!room.music?.hostUserKey || !room.music?.hasHostSession) {
      done({ ok: false, error: "Spotify host is not ready." });
      return;
    }

    try {
      if (action === "CURRENT_TRACK") {
        const data = await spotifyHostFetch(room, "/me/player/currently-playing", {
          method: "GET"
        });
        if (!data?.item) {
          done({ ok: true, data: null });
          return;
        }
        done({
          ok: true,
          data: {
            id: data.item.id || `${data.item.name}`,
            name: data.item.name,
            artists: (data.item.artists || []).map((a) => a.name).join(", "),
            album: data.item.album?.name,
            albumImage: data.item.album?.images?.[0]?.url,
            durationMs: data.item.duration_ms || 0,
            progressMs: data.progress_ms || 0,
            isPlaying: !!data.is_playing
          }
        });
        return;
      }

      if (action === "SEARCH") {
        const query = String(payload?.query || "").trim();
        if (!query) {
          done({ ok: true, data: [] });
          return;
        }
        const data = await spotifyHostFetch(
          room,
          `/search?type=track&limit=8&q=${encodeURIComponent(query)}`,
          { method: "GET" }
        );
        const items = data?.tracks?.items || [];
        const results = items.map((item) => ({
          id: item.id,
          uri: item.uri,
          name: item.name,
          artists: (item.artists || []).map((a) => a.name).join(", "),
          albumImage: item.album?.images?.[2]?.url || item.album?.images?.[0]?.url
        }));
        done({ ok: true, data: results });
        return;
      }

      if (action === "PLAY_URI") {
        const uri = String(payload?.uri || "");
        if (!uri) {
          done({ ok: false, error: "Track URI is required." });
          return;
        }
        await spotifyHostFetch(room, `/me/player/play${getMusicDeviceQuery(room)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ uris: [uri] })
        });
        done({ ok: true });
        return;
      }

      if (action === "PLAY_QUEUED_NEXT") {
        if (user.userKey !== room.music?.hostUserKey) {
          done({ ok: false, error: "Only host can play from queue." });
          return;
        }
        room.music.queue = room.music.queue || [];
        if (room.music.queue.length === 0) {
          done({ ok: false, error: "Queue is empty." });
          return;
        }

        const next = room.music.queue.shift();
        await spotifyHostFetch(room, `/me/player/play${getMusicDeviceQuery(room)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ uris: [next.uri] })
        });
        io.to(roomId).emit("ROOM_STATE", room);
        done({ ok: true, data: next });
        return;
      }

      if (action === "TOGGLE_PLAY_PAUSE") {
        const current = await spotifyHostFetch(room, "/me/player/currently-playing", {
          method: "GET"
        });
        const isPlaying = !!current?.is_playing;
        const path = isPlaying
          ? `/me/player/pause${getMusicDeviceQuery(room)}`
          : `/me/player/play${getMusicDeviceQuery(room)}`;
        await spotifyHostFetch(room, path, { method: "PUT" });
        done({ ok: true });
        return;
      }

      if (action === "NEXT") {
        await spotifyHostFetch(room, `/me/player/next${getMusicDeviceQuery(room)}`, {
          method: "POST"
        });
        done({ ok: true });
        return;
      }

      if (action === "PREV") {
        await spotifyHostFetch(room, `/me/player/previous${getMusicDeviceQuery(room)}`, {
          method: "POST"
        });
        done({ ok: true });
        return;
      }

      done({ ok: false, error: "Unsupported action." });
    } catch (err) {
      done({ ok: false, error: err?.message || "Music control failed." });
    }
  });

  // ========================
  // WHEEL OPTIONS
  // ========================
  socket.on("SET_WHEEL_OPTIONS", ({ roomId, options }) => {
    const room = rooms[roomId];
    if (!room) return;
    const user = room.users.find((u) => u.socketId === socket.id);
    if (!user) return;

    const nextOptions = normalizeWheelOptions(options);
    if (nextOptions.length === 0) return;
    room.game.wheelOptions = nextOptions;
    io.to(roomId).emit("ROOM_STATE", room);
  });

  // ========================
  // LOBBY STICKY NOTES
  // ========================
  socket.on("ADD_LOBBY_NOTE", ({ roomId, text }) => {
    const room = rooms[roomId];
    if (!room) return;
    const user = room.users.find((u) => u.socketId === socket.id);
    if (!user) return;

    const content = normalizeLobbyNote(text);
    if (!content) return;

    room.lobbyNotes = room.lobbyNotes || [];
    room.lobbyNotes.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      userKey: user.userKey,
      name: user.name,
      color: user.color,
      text: content,
      createdAt: Date.now()
    });

    if (room.lobbyNotes.length > MAX_LOBBY_NOTES) {
      room.lobbyNotes = room.lobbyNotes.slice(-MAX_LOBBY_NOTES);
    }

    io.to(roomId).emit("ROOM_STATE", room);
  });

  socket.on("DELETE_LOBBY_NOTE", ({ roomId, noteId }) => {
    const room = rooms[roomId];
    if (!room) return;
    const user = room.users.find((u) => u.socketId === socket.id);
    if (!user) return;

    room.lobbyNotes = (room.lobbyNotes || []).filter(
      (n) => !(n.id === noteId && n.userKey === user.userKey)
    );

    io.to(roomId).emit("ROOM_STATE", room);
  });

  // ========================
  // WHEELS
  // ========================
  socket.on("SPIN_WHEEL", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;
    const spinner = room.users.find((u) => u.socketId === socket.id);
    if (!spinner) return;
    if (spinner.currentGame !== "WHEEL") return;
    syncWheelTurn(room);

    const options = normalizeWheelOptions(room.game.wheelOptions);
    if (options.length === 0) return;
    room.game.wheelOptions = options;

    const winnerIndex = Math.floor(Math.random() * options.length);
    const prompt = options[winnerIndex];

    const wheelUsers = room.users.filter(
      (u) => !!u.socketId && u.currentGame === "WHEEL"
    );
    if (wheelUsers.length >= 2) {
      const nextSpinner = wheelUsers.find((u) => u.userKey !== spinner.userKey);
      room.game.wheelTurnUserKey = nextSpinner?.userKey || spinner.userKey;
    } else {
      room.game.wheelTurnUserKey = spinner.userKey;
    }

    io.to(roomId).emit("WHEEL_RESULT", {
      prompt,
      winnerIndex,
      spinnerUserKey: spinner.userKey
    });
    io.to(roomId).emit("ROOM_STATE", room);
  });

  // ========================
  // DISCONNECT HANDLING
  // ========================
  socket.on("disconnect", () => {
    console.log("Disconnected:", socket.id);

    for (const room of Object.values(rooms)) {
      const user = room.users.find(u => u.socketId === socket.id);
      if (!user) continue;

      if (room.game.drawerId === socket.id) {
        room.game.drawerId = null;
      }
      if (room.game.guesserId === socket.id) {
        room.game.guesserId = null;
      }

      user.socketId = null;

      if (room.music?.hostUserKey === user.userKey) {
        room.music.hostSocketId = null;
        room.music.hostDeviceId = null;
        room.music.hasHostSession = false;
        room.music.clientId = null;
        room.music.hostSession = null;
      }

      syncStatuses(room);
      syncWheelTurn(room);

      io.to(room.roomId).emit("ROOM_STATE", room);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
