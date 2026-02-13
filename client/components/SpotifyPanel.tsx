"use client";

import { useEffect, useRef, useState } from "react";
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

type LrcLibGetResponse = {
  syncedLyrics?: string;
  plainLyrics?: string;
};

declare global {
  interface Window {
    Spotify?: any;
    onSpotifyWebPlaybackSDKReady?: () => void;
  }
}

export default function SpotifyPanel() {
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
  const [sdkStatus, setSdkStatus] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [sdkDeviceId, setSdkDeviceId] = useState("");
  const [lyricsLoading, setLyricsLoading] = useState(false);
  const [error, setError] = useState<string>("");
  const activeLineRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<any>(null);

  const clientId = process.env.NEXT_PUBLIC_SPOTIFY_CLIENT_ID || "";
  const redirectUri =
    process.env.NEXT_PUBLIC_SPOTIFY_REDIRECT_URI ||
    (typeof window !== "undefined"
      ? `${window.location.origin}/spotify/callback`
      : "");

  function formatTime(ms: number) {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return `${min}:${String(sec).padStart(2, "0")}`;
  }

  async function ensureSession() {
    const current = getSession();
    if (!current) return null;
    if (!isExpired(current)) return current;
    if (!clientId || !current.refreshToken) return null;
    try {
      return await refreshSession(clientId, current.refreshToken);
    } catch {
      clearSession();
      return null;
    }
  }

  async function spotifyFetch(path: string, init?: RequestInit) {
    const session = await ensureSession();
    if (!session) throw new Error("Not connected to Spotify.");
    const res = await fetch(`https://api.spotify.com/v1${path}`, {
      ...init,
      headers: {
        ...(init?.headers || {}),
        Authorization: `Bearer ${session.accessToken}`
      }
    });
    if (res.status === 204) return null;
    if (!res.ok) {
      if (res.status === 401) {
        clearSession();
        setSessionReady((v) => !v);
      }
      throw new Error("Spotify API request failed.");
    }
    return res.json();
  }

  async function loadSpotifySdkScript() {
    if (window.Spotify) return;
    await new Promise<void>((resolve, reject) => {
      const existing = document.getElementById("spotify-player-sdk");
      if (existing) {
        const onReady = () => resolve();
        window.onSpotifyWebPlaybackSDKReady = onReady;
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

  async function transferToInAppDevice(deviceId: string, keepPaused = true) {
    await spotifyFetch("/me/player", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        device_ids: [deviceId],
        play: !keepPaused
      })
    });
  }

  async function loadCurrentTrack() {
    try {
      const data = await spotifyFetch("/me/player/currently-playing");
      if (!data?.item) {
        setTrack(null);
        setPlaybackMs(0);
        return;
      }
      const artists = (data.item.artists || []).map((a: any) => a.name).join(", ");
      setTrack({
        id: data.item.id || `${data.item.name}-${artists}`,
        name: data.item.name,
        artists,
        album: data.item.album?.name,
        albumImage: data.item.album?.images?.[0]?.url,
        durationMs: data.item.duration_ms || 0,
        progressMs: data.progress_ms || 0,
        isPlaying: !!data.is_playing
      });
      setPlaybackMs(data.progress_ms || 0);
    } catch (e: any) {
      setError(e?.message || "Failed to load Spotify playback.");
    }
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
    const data = (await res.json()) as LrcLibGetResponse;
    return data;
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
    if (!track) return;
    const basePath = track.isPlaying ? "/me/player/pause" : "/me/player/play";
    const path = sdkDeviceId ? `${basePath}?device_id=${sdkDeviceId}` : basePath;
    await spotifyFetch(path, { method: "PUT" });
    await loadCurrentTrack();
  }

  async function nextTrack() {
    const path = sdkDeviceId ? `/me/player/next?device_id=${sdkDeviceId}` : "/me/player/next";
    await spotifyFetch(path, { method: "POST" });
    setTimeout(loadCurrentTrack, 350);
  }

  async function previousTrack() {
    const path = sdkDeviceId
      ? `/me/player/previous?device_id=${sdkDeviceId}`
      : "/me/player/previous";
    await spotifyFetch(path, { method: "POST" });
    setTimeout(loadCurrentTrack, 350);
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
      const data = await spotifyFetch(
        `/search?type=track&limit=8&q=${encodeURIComponent(q)}`
      );
      const items = data?.tracks?.items || [];
      const nextResults: SearchTrack[] = items.map((item: any) => ({
        id: item.id,
        uri: item.uri,
        name: item.name,
        artists: (item.artists || []).map((a: any) => a.name).join(", "),
        albumImage: item.album?.images?.[2]?.url || item.album?.images?.[0]?.url
      }));
      setSearchResults(nextResults);
    } catch (e: any) {
      setSearchError(e?.message || "Search failed.");
      setSearchResults([]);
    } finally {
      setSearchLoading(false);
    }
  }

  async function playOnSpotifyDevice(uri: string) {
    try {
      const path = sdkDeviceId ? `/me/player/play?device_id=${sdkDeviceId}` : "/me/player/play";
      await spotifyFetch(path, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uris: [uri] })
      });
      setTimeout(loadCurrentTrack, 350);
    } catch (e: any) {
      setSearchError(
        e?.message || "Could not start playback on Spotify device."
      );
    }
  }

  async function playHere(item: SearchTrack) {
    setSearchError("");
    try {
      if (!sdkDeviceId) {
        setSearchError("In-app player not ready yet. Wait a moment and try again.");
        return;
      }
      await transferToInAppDevice(sdkDeviceId, true);
      await spotifyFetch(`/me/player/play?device_id=${sdkDeviceId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uris: [item.uri] })
      });
      setTimeout(loadCurrentTrack, 300);
    } catch (e: any) {
      setSearchError(e?.message || "Could not play track in app.");
    }
  }

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
    const hasSession = !!getSession();
    if (!hasSession || !clientId) return;
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

        player.addListener("ready", async ({ device_id }: { device_id: string }) => {
          if (ignore) return;
          setSdkDeviceId(device_id);
          setSdkStatus("ready");
          try {
            await transferToInAppDevice(device_id, true);
          } catch {
            setSearchError("In-app player ready, but device transfer failed.");
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
    };
  }, [sessionReady, clientId]);

  useEffect(() => {
    const hasSession = !!getSession();
    if (!hasSession) return;
    loadCurrentTrack();
    const id = setInterval(loadCurrentTrack, 5000);
    return () => clearInterval(id);
  }, [sessionReady]);

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

  const connected = !!getSession();
  const totalDurationMs = track?.durationMs || 0;
  const progressPercent =
    totalDurationMs > 0
      ? Math.max(0, Math.min(100, (playbackMs / totalDurationMs) * 100))
      : 0;

  return (
    <div className="spotify-panel">
      <h3>Spotify</h3>

      {!clientId && (
        <p className="spotify-error">Set `NEXT_PUBLIC_SPOTIFY_CLIENT_ID` first.</p>
      )}

      {clientId && !connected && (
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
        <>
          <div className="spotify-track">
            {track?.albumImage && <img src={track.albumImage} alt="album" />}
            <div>
              <strong>{track?.name || "No active track"}</strong>
              <div>{track?.artists || "Open Spotify and play a song"}</div>
            </div>
          </div>
          <div className="spotify-sdk-status">
            In-app player:{" "}
            {sdkStatus === "ready"
              ? "Ready"
              : sdkStatus === "loading"
                ? "Starting..."
                : sdkStatus === "error"
                  ? "Error"
                  : "Idle"}
          </div>
          {track && (
            <div className="spotify-progress">
              <div className="spotify-progress-track" aria-hidden="true">
                <div
                  className="spotify-progress-fill"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
              <div className="spotify-progress-time">
                <span>{formatTime(playbackMs)}</span>
                <span>{formatTime(totalDurationMs)}</span>
              </div>
            </div>
          )}

          <div className="spotify-controls">
            <button onClick={previousTrack}>Prev</button>
            <button onClick={togglePlayPause}>{track?.isPlaying ? "Pause" : "Play"}</button>
            <button onClick={nextTrack}>Next</button>
            <button
              onClick={() => {
                clearSession();
                setTrack(null);
                setSyncedLyrics([]);
                setPlainLyrics("");
                setPlaybackMs(0);
                setActiveLineIndex(-1);
                setLeadLineIndex(-1);
                if (playerRef.current) {
                  playerRef.current.disconnect();
                  playerRef.current = null;
                }
                setSdkStatus("idle");
                setSdkDeviceId("");
                setSessionReady((v) => !v);
              }}
            >
              Disconnect
            </button>
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
              <button onClick={searchSongs} disabled={searchLoading}>
                {searchLoading ? "Searching..." : "Search"}
              </button>
            </div>

            {searchResults.length > 0 && (
              <div className="spotify-search-results">
                {searchResults.map((item) => (
                  <div key={item.id} className="spotify-search-item">
                    <div className="spotify-search-meta">
                      {item.albumImage && (
                        <img src={item.albumImage} alt={`${item.name} cover`} />
                      )}
                      <div>
                        <strong>{item.name}</strong>
                        <div>{item.artists}</div>
                      </div>
                    </div>
                    <div className="spotify-search-actions">
                      <button onClick={() => playHere(item)}>Play Here</button>
                      <button onClick={() => playOnSpotifyDevice(item.uri)}>
                        Play on Spotify
                      </button>
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
        </>
      )}

      {error && <p className="spotify-error">{error}</p>}
      {searchError && <p className="spotify-error">{searchError}</p>}
    </div>
  );
}
