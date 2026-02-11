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
      }
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
        }
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
    if (game !== "DRAWING" && game !== "WHEEL" && game !== "LOBBY") return;

    const user = room.users.find((u) => u.socketId === socket.id);
    if (!user) return;

    user.currentGame = game;
    syncWheelTurn(room);
    io.to(roomId).emit("ROOM_STATE", room);
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
      syncStatuses(room);
      syncWheelTurn(room);

      io.to(room.roomId).emit("ROOM_STATE", room);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
