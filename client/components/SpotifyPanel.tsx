"use client";

import { useEffect, useRef, useState } from "react";
import { socket } from "@/lib/socket";
import {
  clearSession,
  getSession,
  isExpired,
  refreshSession,
  startSpotifyLogin
} from "@/lib/spotify";

type Track = {
  id: string;
  name: string;
  artists: string;
  album?: string;
  albumImage?: string;
  durationMs: number;
  progressMs: number;
  isPlaying: boolean;
};

type SyncedLine = {
  timeMs: number;
  text: string;
};

type SearchTrack = {
  id: string;
  uri: string;
  name: string;
  artists: string;
  albumImage?: string;
};

type SuggestionTrack = SearchTrack & {
  suggestionId: string;
  suggestedByName?: string;
};

type QueueTrack = SearchTrack & {
  queueId: string;
  suggestedByName?: string;
};

type LrcLibGetResponse = {
  syncedLyrics?: string;
  plainLyrics?: string;
};

type MusicState = {
  hostUserKey?: string | null;
  hostName?: string | null;
  hasHostSession?: boolean;
  hostDeviceId?: string | null;
  suggestions?: SuggestionTrack[];
  queue?: QueueTrack[];
} | null;

type SpotifyPanelProps = {
  roomId?: string;
  myUserKey: string;
  musicState: MusicState;
};

declare global {
  interface Window {
    Spotify?: any;
    onSpotifyWebPlaybackSDKReady?: () => void;
  }
}

export default function SpotifyPanel({ roomId, myUserKey, musicState }: SpotifyPanelProps) {
  const [sessionReady, setSessionReady] = useState(false);
  const [track, setTrack] = useState<Track | null>(null);
  const [syncedLyrics, setSyncedLyrics] = useState<SyncedLine[]>([]);
  const [plainLyrics, setPlainLyrics] = useState<string>("");
  const [playbackMs, setPlaybackMs] = useState(0);
  const [activeLineIndex, setActiveLineIndex] = useState(-1);
  const [leadLineIndex, setLeadLineIndex] = useState(-1);
  const [leadInMs, setLeadInMs] = useState(1200);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchTrack[]>([]);
  const [searchError, setSearchError] = useState("");
  const [sdkStatus, setSdkStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [sdkDeviceId, setSdkDeviceId] = useState("");
  const [sdkActivated, setSdkActivated] = useState(false);
  const [guestAudioEnabled, setGuestAudioEnabled] = useState(false);
  const [lyricsLoading, setLyricsLoading] = useState(false);
  const [error, setError] = useState<string>("");
  const activeLineRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<any>(null);
  const syncedTrackRef = useRef<string>("");

  const clientId = process.env.NEXT_PUBLIC_SPOTIFY_CLIENT_ID || "";
  const redirectUri =
    process.env.NEXT_PUBLIC_SPOTIFY_REDIRECT_URI ||
    (typeof window !== "undefined" ? `${window.location.origin}/spotify/callback` : "");

  const isHost = !!myUserKey && musicState?.hostUserKey === myUserKey;
  const hostName = musicState?.hostName || "-";
  const hasHost = !!musicState?.hostUserKey;
  const hostReady = !!musicState?.hasHostSession;
  const connected = !!getSession();
  const suggestions = musicState?.suggestions || [];
  const queue = musicState?.queue || [];

  function formatTime(ms: number) {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return `${min}:${String(sec).padStart(2, "0")}`;
  }

  function requestMusicControl<T = any>(action: string, payload?: any) {
    return new Promise<T>((resolve, reject) => {
      socket.emit("MUSIC_CONTROL_REQUEST", { roomId, action, payload }, (res: any) => {
        if (res?.ok) {
          resolve(res.data as T);
          return;
        }
        reject(new Error(res?.error || "Music control failed."));
      });
    });
  }

  function pushHostSession(sessionOverride?: any) {
    if (!isHost || !roomId || !clientId) return;
    const session = sessionOverride || getSession();
    if (!session?.accessToken) return;
    socket.emit("SPOTIFY_HOST_SESSION_UPDATE", {
      roomId,
      clientId,
      session: {
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        expiresAt: session.expiresAt
      }
    });
  }

  async function ensureSession() {
    const current = getSession();
    if (!current) return null;
    if (!isExpired(current)) {
      pushHostSession(current);
      return current;
    }
    if (!clientId || !current.refreshToken) return null;
    try {
      const refreshed = await refreshSession(clientId, current.refreshToken);
      pushHostSession(refreshed);
      return refreshed;
    } catch {
      clearSession();
      return null;
    }
  }

  async function hostSpotifyFetch(path: string, init?: RequestInit) {
    const session = await ensureSession();
    if (!session?.accessToken) throw new Error("Host Spotify session missing.");

    const res = await fetch(`https://api.spotify.com/v1${path}`, {
      ...init,
      headers: {
        ...(init?.headers || {}),
        Authorization: `Bearer ${session.accessToken}`
      }
    });

    if (res.status === 204) return null;
    if (!res.ok) {
      let detail = "";
      try {
        const body = await res.json();
        detail = body?.error?.message ? `: ${body.error.message}` : "";
      } catch {}
      throw new Error(`Spotify API failed (${res.status})${detail}`);
    }

    return res.json();
  }

  async function loadSpotifySdkScript() {
    if (window.Spotify) return;
    await new Promise<void>((resolve, reject) => {
      const existing = document.getElementById("spotify-player-sdk");
      if (existing) {
        window.onSpotifyWebPlaybackSDKReady = () => resolve();
        setTimeout(() => {
          if (window.Spotify) resolve();
        }, 50);
        return;
      }

      const script = document.createElement("script");
      script.id = "spotify-player-sdk";
      script.src = "https://sdk.scdn.co/spotify-player.js";
      script.async = true;
      script.onerror = () => reject(new Error("Failed to load Spotify SDK."));
      window.onSpotifyWebPlaybackSDKReady = () => resolve();
      document.body.appendChild(script);
    });
  }

  async function loadCurrentTrack() {
    if (!roomId || !hostReady) {
      setTrack(null);
      return;
    }
    try {
      const data = await requestMusicControl<Track | null>("CURRENT_TRACK");
      setTrack(data);
      setPlaybackMs(data?.progressMs || 0);
    } catch (e: any) {
      setError(e?.message || "Failed to load Spotify playback.");
    }
  }

  async function transferToInAppDevice(deviceId: string, keepPaused = true) {
    if (!isHost) return;
    await hostSpotifyFetch("/me/player", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        device_ids: [deviceId],
        play: !keepPaused
      })
    });
  }

  async function ensureSdkActivated() {
    if (!playerRef.current || sdkActivated) return;
    try {
      await playerRef.current.activateElement();
      setSdkActivated(true);
    } catch {}
  }

  function parseSyncedLyrics(lrc: string): SyncedLine[] {
    const lines = lrc.split(/\r?\n/);
    const parsed: SyncedLine[] = [];
    for (const line of lines) {
      const tagRegex = /\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/g;
      const tags: RegExpExecArray[] = [];
      let match = tagRegex.exec(line);
      while (match) {
        tags.push(match);
        match = tagRegex.exec(line);
      }
      if (!tags.length) continue;
      const text = line.replace(/\[[^\]]+\]/g, "").trim();
      if (!text) continue;
      for (const tag of tags) {
        const min = Number(tag[1] || 0);
        const sec = Number(tag[2] || 0);
        const fracRaw = tag[3] || "0";
        const frac = fracRaw.length === 3 ? Number(fracRaw) : Number(fracRaw) * 10;
        const timeMs = min * 60_000 + sec * 1000 + frac;
        parsed.push({ timeMs, text });
      }
    }
    return parsed.sort((a, b) => a.timeMs - b.timeMs);
  }

  async function fetchLrcLibLyrics(nextTrack: Track) {
    const query = new URLSearchParams({
      track_name: nextTrack.name,
      artist_name: nextTrack.artists.split(",")[0].trim()
    });
    if (nextTrack.album) query.set("album_name", nextTrack.album);

    const res = await fetch(`https://lrclib.net/api/get?${query.toString()}`);
    if (!res.ok) throw new Error("No lyrics found.");
    return (await res.json()) as LrcLibGetResponse;
  }

  async function fetchPlainLyricsFallback(nextTrack: Track) {
    const url = `https://api.lyrics.ovh/v1/${encodeURIComponent(
      nextTrack.artists.split(",")[0].trim()
    )}/${encodeURIComponent(nextTrack.name)}`;
    const res = await fetch(url);
    if (!res.ok) return "";
    const data = await res.json();
    return data?.lyrics || "";
  }

  async function loadLyrics(nextTrack: Track | null) {
    if (!nextTrack) {
      setSyncedLyrics([]);
      setPlainLyrics("");
      setActiveLineIndex(-1);
      setLeadLineIndex(-1);
      return;
    }

    setLyricsLoading(true);
    try {
      const lrcData = await fetchLrcLibLyrics(nextTrack);
      const parsed = lrcData.syncedLyrics ? parseSyncedLyrics(lrcData.syncedLyrics) : [];
      setSyncedLyrics(parsed);

      if (parsed.length > 0) {
        setPlainLyrics(lrcData.plainLyrics || "");
      } else {
        const fallback = lrcData.plainLyrics || (await fetchPlainLyricsFallback(nextTrack));
        setPlainLyrics(fallback || "Lyrics not found.");
      }
    } catch {
      setSyncedLyrics([]);
      const fallback = await fetchPlainLyricsFallback(nextTrack);
      setPlainLyrics(fallback || "Lyrics unavailable.");
    } finally {
      setLyricsLoading(false);
    }
  }

  async function togglePlayPause() {
    try {
      await ensureSdkActivated();
      if (isHost && playerRef.current && sdkStatus === "ready") {
        await playerRef.current.togglePlay();
      } else {
        await requestMusicControl("TOGGLE_PLAY_PAUSE");
      }
      setTimeout(loadCurrentTrack, 220);
    } catch (e: any) {
      setSearchError(e?.message || "Could not toggle playback.");
    }
  }

  async function nextTrack() {
    try {
      await ensureSdkActivated();
      if (isHost && playerRef.current && sdkStatus === "ready") {
        await playerRef.current.nextTrack();
      } else {
        await requestMusicControl("NEXT");
      }
      setTimeout(loadCurrentTrack, 220);
    } catch (e: any) {
      setSearchError(e?.message || "Could not go to next track.");
    }
  }

  async function previousTrack() {
    try {
      await ensureSdkActivated();
      if (isHost && playerRef.current && sdkStatus === "ready") {
        await playerRef.current.previousTrack();
      } else {
        await requestMusicControl("PREV");
      }
      setTimeout(loadCurrentTrack, 220);
    } catch (e: any) {
      setSearchError(e?.message || "Could not go to previous track.");
    }
  }

  async function searchSongs() {
    const q = searchQuery.trim();
    if (!q) {
      setSearchResults([]);
      return;
    }
    setSearchLoading(true);
    setSearchError("");
    try {
      const data = await requestMusicControl<SearchTrack[]>("SEARCH", { query: q });
      setSearchResults(data || []);
    } catch (e: any) {
      setSearchError(e?.message || "Search failed.");
      setSearchResults([]);
    } finally {
      setSearchLoading(false);
    }
  }

  async function playUri(uri: string) {
    try {
      await ensureSdkActivated();
      await requestMusicControl("PLAY_URI", { uri });
      setTimeout(loadCurrentTrack, 240);
    } catch (e: any) {
      setSearchError(e?.message || "Could not start playback.");
    }
  }

  function suggestTrack(item: SearchTrack) {
    if (!roomId) return;
    socket.emit("MUSIC_SUGGEST_TRACK", { roomId, track: item });
  }

  function addToQueue(item: SearchTrack) {
    if (!roomId) return;
    socket.emit("MUSIC_ADD_TO_QUEUE", { roomId, track: item });
  }

  function acceptSuggestion(suggestionId: string) {
    if (!roomId) return;
    socket.emit("MUSIC_ACCEPT_SUGGESTION", { roomId, suggestionId });
  }

  function rejectSuggestion(suggestionId: string) {
    if (!roomId) return;
    socket.emit("MUSIC_REJECT_SUGGESTION", { roomId, suggestionId });
  }

  async function playQueuedNext() {
    try {
      await ensureSdkActivated();
      await requestMusicControl("PLAY_QUEUED_NEXT");
      setTimeout(loadCurrentTrack, 260);
    } catch (e: any) {
      setSearchError(e?.message || "Could not play next queued track.");
    }
  }

  function claimHost() {
    if (!roomId) return;
    setSearchError("");
    socket.emit("CLAIM_MUSIC_HOST", { roomId });
  }

  function releaseHost() {
    if (!roomId) return;
    setSearchError("");
    socket.emit("RELEASE_MUSIC_HOST", { roomId });
  }

  useEffect(() => {
    const onMusicError = ({ message }: { message: string }) => {
      setSearchError(message || "Music action failed.");
    };
    socket.on("MUSIC_ERROR", onMusicError);
    return () => {
      socket.off("MUSIC_ERROR", onMusicError);
    };
  }, []);

  useEffect(() => {
    setSearchError("");
  }, [isHost, hasHost, hostReady]);

  useEffect(() => {
    setSessionReady((v) => !v);
    const saved = localStorage.getItem("spotify_karaoke_lead_in_ms");
    if (!saved) return;
    const parsed = Number(saved);
    if (!Number.isNaN(parsed)) {
      setLeadInMs(Math.max(300, Math.min(2000, parsed)));
    }
  }, []);

  useEffect(() => {
    localStorage.setItem("spotify_karaoke_lead_in_ms", String(leadInMs));
  }, [leadInMs]);

  useEffect(() => {
    if (!isHost || !connected) return;
    pushHostSession();
  }, [isHost, connected, sessionReady, roomId]);

  useEffect(() => {
    const shouldInitLocalSdk = !!connected && !!clientId && !!roomId && (isHost || guestAudioEnabled);
    if (!shouldInitLocalSdk) {
      if (playerRef.current) {
        playerRef.current.disconnect();
        playerRef.current = null;
      }
      setSdkStatus("idle");
      setSdkDeviceId("");
      setSdkActivated(false);
      syncedTrackRef.current = "";
      return;
    }

    let ignore = false;

    const initSdk = async () => {
      try {
        setSdkStatus("loading");
        await loadSpotifySdkScript();
        if (ignore || !window.Spotify) return;

        const player = new window.Spotify.Player({
          name: "Duo In-App Player",
          getOAuthToken: async (cb: (token: string) => void) => {
            try {
              const session = await ensureSession();
              cb(session?.accessToken || "");
            } catch {
              cb("");
            }
          },
          volume: 0.8
        });

        player.addListener("ready", ({ device_id }: { device_id: string }) => {
          if (ignore) return;
          setSdkDeviceId(device_id);
          setSdkStatus("ready");
          if (isHost) {
            socket.emit("SPOTIFY_HOST_DEVICE_UPDATE", { roomId, deviceId: device_id });
            transferToInAppDevice(device_id, true).catch(() => {
              setSearchError("Player ready, but failed to transfer playback.");
            });
          }
        });

        player.addListener("not_ready", () => {
          if (ignore) return;
          setSdkStatus("error");
          setSdkDeviceId("");
        });

        player.addListener("player_state_changed", (state: any) => {
          if (ignore || !state?.track_window?.current_track) return;
          const t = state.track_window.current_track;
          const artists = (t.artists || []).map((a: any) => a.name).join(", ");
          setTrack({
            id: t.id || `${t.name}-${artists}`,
            name: t.name,
            artists,
            album: t.album?.name,
            albumImage: t.album?.images?.[0]?.url,
            durationMs: state.duration || t.duration_ms || 0,
            progressMs: state.position || 0,
            isPlaying: !state.paused
          });
          setPlaybackMs(state.position || 0);
        });

        player.addListener("initialization_error", ({ message }: { message: string }) => {
          if (ignore) return;
          setSdkStatus("error");
          setSearchError(message || "Spotify SDK init failed.");
        });

        player.addListener("authentication_error", ({ message }: { message: string }) => {
          if (ignore) return;
          setSdkStatus("error");
          setSearchError(message || "Spotify SDK auth failed. Reconnect Spotify.");
        });

        const ok = await player.connect();
        if (!ok && !ignore) {
          setSdkStatus("error");
          setSearchError("Could not connect to Spotify in-app player.");
          return;
        }
        playerRef.current = player;
      } catch (e: any) {
        if (ignore) return;
        setSdkStatus("error");
        setSearchError(e?.message || "Failed to start Spotify in-app player.");
      }
    };

    initSdk();
    return () => {
      ignore = true;
      if (playerRef.current) {
        playerRef.current.disconnect();
        playerRef.current = null;
      }
      setSdkStatus("idle");
      setSdkDeviceId("");
      setSdkActivated(false);
      syncedTrackRef.current = "";
    };
  }, [isHost, guestAudioEnabled, connected, clientId, roomId, sessionReady]);

  useEffect(() => {
    if (isHost) return;
    if (!guestAudioEnabled) return;
    if (!sdkActivated || sdkStatus !== "ready" || !sdkDeviceId) return;
    if (!track?.id) return;
    if (syncedTrackRef.current === track.id) return;

    const uri = `spotify:track:${track.id}`;
    hostSpotifyFetch(`/me/player/play?device_id=${encodeURIComponent(sdkDeviceId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        uris: [uri],
        position_ms: Math.max(0, Math.floor(track.progressMs || 0))
      })
    })
      .then(() => {
        syncedTrackRef.current = track.id;
      })
      .catch((e: any) => {
        setSearchError(e?.message || "Could not sync guest audio.");
      });
  }, [isHost, guestAudioEnabled, sdkActivated, sdkStatus, sdkDeviceId, track?.id, track?.progressMs]);

  useEffect(() => {
    if (!hostReady) return;
    loadCurrentTrack();
    const id = setInterval(loadCurrentTrack, 5000);
    return () => clearInterval(id);
  }, [roomId, hostReady]);

  useEffect(() => {
    loadLyrics(track);
  }, [track?.id]);

  useEffect(() => {
    if (!track) return;
    setPlaybackMs(track.progressMs || 0);
  }, [track?.id, track?.progressMs]);

  useEffect(() => {
    if (!track?.isPlaying) return;
    const tick = setInterval(() => {
      setPlaybackMs((prev) => {
        const next = prev + 250;
        if (!track.durationMs) return next;
        return Math.min(next, track.durationMs);
      });
    }, 250);
    return () => clearInterval(tick);
  }, [track?.id, track?.isPlaying, track?.durationMs]);

  useEffect(() => {
    if (!syncedLyrics.length) {
      setActiveLineIndex(-1);
      setLeadLineIndex(-1);
      return;
    }

    let idx = -1;
    for (let i = 0; i < syncedLyrics.length; i += 1) {
      if (playbackMs >= syncedLyrics[i].timeMs) idx = i;
      else break;
    }
    setActiveLineIndex(idx);

    const nextIdx = idx + 1;
    if (nextIdx < syncedLyrics.length) {
      const delta = syncedLyrics[nextIdx].timeMs - playbackMs;
      if (delta > 0 && delta <= leadInMs) {
        setLeadLineIndex(nextIdx);
        return;
      }
    }
    setLeadLineIndex(-1);
  }, [playbackMs, syncedLyrics, leadInMs]);

  useEffect(() => {
    if (activeLineRef.current) {
      activeLineRef.current.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [activeLineIndex, track?.id]);

  const totalDurationMs = track?.durationMs || 0;
  const progressPercent =
    totalDurationMs > 0
      ? Math.max(0, Math.min(100, (playbackMs / totalDurationMs) * 100))
      : 0;

  return (
    <div className="spotify-panel">
      <h3>Spotify</h3>

      <div className="spotify-host-row">
        <div>
          Host: <b>{hostName}</b>
          {hostReady ? " (Ready)" : " (Not connected)"}
        </div>
        {!isHost && (
          <button disabled={!roomId} onClick={claimHost}>
            {hasHost ? "Take Host" : "Become Host"}
          </button>
        )}
        {isHost && <button onClick={releaseHost}>Release Host</button>}
      </div>

      {isHost && !clientId && (
        <p className="spotify-error">Set `NEXT_PUBLIC_SPOTIFY_CLIENT_ID` first.</p>
      )}

      {isHost && clientId && !connected && (
        <button
          onClick={() =>
            startSpotifyLogin(
              clientId,
              redirectUri,
              window.location.pathname + window.location.search
            )
          }
        >
          Connect Spotify (Host)
        </button>
      )}

      {isHost && connected && (
        <div className="spotify-host-row">
          <div>
            In-app player:{" "}
            {sdkStatus === "ready"
              ? "Ready"
              : sdkStatus === "loading"
                ? "Starting..."
                : sdkStatus === "error"
                  ? "Error"
                  : "Idle"}
            {sdkDeviceId ? ` (Device ${sdkDeviceId.slice(0, 6)}...)` : ""}
            {sdkStatus === "ready" && !sdkActivated ? " - Audio not enabled yet" : ""}
          </div>
          {sdkStatus === "ready" && !sdkActivated && (
            <button onClick={ensureSdkActivated}>Enable Audio</button>
          )}
          <button
            onClick={() => {
              clearSession();
              if (playerRef.current) {
                playerRef.current.disconnect();
                playerRef.current = null;
              }
              setSdkStatus("idle");
              setSdkDeviceId("");
              setSdkActivated(false);
              socket.emit("SPOTIFY_HOST_SESSION_UPDATE", {
                roomId,
                clientId,
                session: { accessToken: "", refreshToken: "", expiresAt: 0 }
              });
              setSessionReady((v) => !v);
            }}
          >
            Disconnect
          </button>
        </div>
      )}

      <div className="spotify-track">
        {track?.albumImage && <img src={track.albumImage} alt="album" />}
        <div>
          <strong>{track?.name || "No active track"}</strong>
          <div>{track?.artists || "Host needs to play a song"}</div>
        </div>
      </div>

      {!isHost && (
        <div className="spotify-host-row">
          <div>
            Listener audio: {guestAudioEnabled ? "Enabled" : "Off"}
          </div>
          {!connected && clientId && (
            <button
              onClick={() =>
                startSpotifyLogin(
                  clientId,
                  redirectUri,
                  window.location.pathname + window.location.search
                )
              }
            >
              Connect Spotify
            </button>
          )}
          {connected && (
            <button
              onClick={() => {
                clearSession();
                setGuestAudioEnabled(false);
                setSdkActivated(false);
                setSessionReady((v) => !v);
              }}
            >
              Disconnect
            </button>
          )}
          <button
            onClick={() => setGuestAudioEnabled((v) => !v)}
            disabled={!track?.id || !connected}
          >
            {guestAudioEnabled ? "Disable Audio" : "Enable Audio"}
          </button>
          {guestAudioEnabled && connected && sdkStatus === "ready" && !sdkActivated && (
            <button onClick={ensureSdkActivated}>Activate Audio</button>
          )}
        </div>
      )}

      {track && (
        <div className="spotify-progress">
          <div className="spotify-progress-track" aria-hidden="true">
            <div className="spotify-progress-fill" style={{ width: `${progressPercent}%` }} />
          </div>
          <div className="spotify-progress-time">
            <span>{formatTime(playbackMs)}</span>
            <span>{formatTime(totalDurationMs)}</span>
          </div>
        </div>
      )}

      <div className="spotify-controls">
        <button onClick={previousTrack} disabled={!hostReady}>Prev</button>
        <button onClick={togglePlayPause} disabled={!hostReady}>
          {track?.isPlaying ? "Pause" : "Play"}
        </button>
        <button onClick={nextTrack} disabled={!hostReady}>Next</button>
        {isHost && (
          <button onClick={playQueuedNext} disabled={!hostReady || queue.length === 0}>
            Play Queue Next ({queue.length})
          </button>
        )}
      </div>

      <div className="spotify-search">
        <div className="spotify-search-row">
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search songs..."
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                searchSongs();
              }
            }}
          />
          <button onClick={searchSongs} disabled={searchLoading || !hostReady}>
            {searchLoading ? "Searching..." : "Search"}
          </button>
        </div>

        {searchResults.length > 0 && (
          <div className="spotify-search-results">
            {searchResults.map((item) => (
              <div key={item.id} className="spotify-search-item">
                <div className="spotify-search-meta">
                  {item.albumImage && <img src={item.albumImage} alt={`${item.name} cover`} />}
                  <div>
                    <strong>{item.name}</strong>
                    <div>{item.artists}</div>
                  </div>
                </div>
                <div className="spotify-search-actions">
                  {isHost ? (
                    <>
                      <button onClick={() => playUri(item.uri)} disabled={!hostReady}>Play</button>
                      <button onClick={() => addToQueue(item)}>Queue</button>
                    </>
                  ) : (
                    <button onClick={() => suggestTrack(item)}>Suggest</button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="spotify-search">
        <div className="spotify-host-row">
          <strong>Suggestions ({suggestions.length})</strong>
        </div>
        {suggestions.length === 0 && <div className="spotify-sdk-status">No suggestions yet.</div>}
        {suggestions.length > 0 && (
          <div className="spotify-search-results">
            {suggestions.map((item) => (
              <div key={item.suggestionId} className="spotify-search-item">
                <div className="spotify-search-meta">
                  {item.albumImage && <img src={item.albumImage} alt={`${item.name} cover`} />}
                  <div>
                    <strong>{item.name}</strong>
                    <div>{item.artists}</div>
                    <div>by {item.suggestedByName || "Someone"}</div>
                  </div>
                </div>
                {isHost && (
                  <div className="spotify-search-actions">
                    <button onClick={() => acceptSuggestion(item.suggestionId)}>Accept</button>
                    <button onClick={() => rejectSuggestion(item.suggestionId)}>Reject</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="spotify-search">
        <div className="spotify-host-row">
          <strong>Queue ({queue.length})</strong>
        </div>
        {queue.length === 0 && <div className="spotify-sdk-status">Queue is empty.</div>}
        {queue.length > 0 && (
          <div className="spotify-search-results">
            {queue.map((item, idx) => (
              <div key={item.queueId} className="spotify-search-item">
                <div className="spotify-search-meta">
                  {item.albumImage && <img src={item.albumImage} alt={`${item.name} cover`} />}
                  <div>
                    <strong>{idx + 1}. {item.name}</strong>
                    <div>{item.artists}</div>
                    <div>from {item.suggestedByName || "Host"}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="spotify-lyrics">
        <div className="spotify-lyrics-head">
          <h4>Lyrics</h4>
          <label className="spotify-lead-control">
            Lead-in: {leadInMs}ms
            <input
              type="range"
              min={300}
              max={2000}
              step={100}
              value={leadInMs}
              onChange={(e) => setLeadInMs(Number(e.target.value))}
            />
          </label>
        </div>

        {lyricsLoading && <div className="spotify-lyrics-loading">Loading lyrics...</div>}
        {!lyricsLoading && syncedLyrics.length > 0 && (
          <div className="spotify-karaoke">
            {syncedLyrics.map((line, idx) => (
              <div
                key={`${line.timeMs}-${idx}`}
                ref={idx === activeLineIndex ? activeLineRef : null}
                className={`spotify-karaoke-line ${
                  idx === activeLineIndex
                    ? "spotify-karaoke-line-active"
                    : idx === leadLineIndex
                      ? "spotify-karaoke-line-lead"
                      : idx < activeLineIndex
                        ? "spotify-karaoke-line-past"
                        : ""
                }`}
              >
                {line.text}
              </div>
            ))}
          </div>
        )}

        {!lyricsLoading && syncedLyrics.length === 0 && (
          <pre>{plainLyrics || "No lyrics yet."}</pre>
        )}
      </div>

      {error && <p className="spotify-error">{error}</p>}
      {searchError && <p className="spotify-error">{searchError}</p>}
    </div>
  );
}
