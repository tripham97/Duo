"use client";

export type SpotifySession = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
};

const STORAGE_KEY = "spotify_session";
const PKCE_VERIFIER_KEY = "spotify_pkce_verifier";
const OAUTH_STATE_KEY = "spotify_oauth_state";
const RETURN_TO_KEY = "spotify_return_to";

const SCOPES = [
  "user-read-playback-state",
  "user-read-currently-playing",
  "user-modify-playback-state"
].join(" ");

function randomString(length = 64) {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

async function sha256(plain: string) {
  const encoder = new TextEncoder();
  const data = encoder.encode(plain);
  return window.crypto.subtle.digest("SHA-256", data);
}

function base64UrlEncode(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function startSpotifyLogin(
  clientId: string,
  redirectUri: string,
  returnTo: string
) {
  const verifier = randomString(96);
  const challenge = base64UrlEncode(await sha256(verifier));
  const state = randomString(24);

  localStorage.setItem(PKCE_VERIFIER_KEY, verifier);
  localStorage.setItem(OAUTH_STATE_KEY, state);
  localStorage.setItem(RETURN_TO_KEY, returnTo);

  const authUrl = new URL("https://accounts.spotify.com/authorize");
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("scope", SCOPES);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("code_challenge", challenge);

  window.location.href = authUrl.toString();
}

function saveSession(session: SpotifySession) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

export function getSession(): SpotifySession | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed?.accessToken || !parsed?.expiresAt) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearSession() {
  localStorage.removeItem(STORAGE_KEY);
}

export function getReturnTo(defaultPath = "/") {
  const value = localStorage.getItem(RETURN_TO_KEY);
  localStorage.removeItem(RETURN_TO_KEY);
  return value || defaultPath;
}

export function isExpired(session: SpotifySession) {
  return Date.now() > session.expiresAt - 30_000;
}

export async function exchangeCode(clientId: string, code: string, redirectUri: string) {
  const verifier = localStorage.getItem(PKCE_VERIFIER_KEY);
  if (!verifier) throw new Error("Missing PKCE verifier.");

  const params = new URLSearchParams();
  params.set("client_id", clientId);
  params.set("grant_type", "authorization_code");
  params.set("code", code);
  params.set("redirect_uri", redirectUri);
  params.set("code_verifier", verifier);

  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params
  });
  if (!res.ok) throw new Error("Spotify token exchange failed.");

  const data = await res.json();
  const session: SpotifySession = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000
  };
  saveSession(session);
  localStorage.removeItem(PKCE_VERIFIER_KEY);
  localStorage.removeItem(OAUTH_STATE_KEY);
  return session;
}

export async function refreshSession(clientId: string, refreshToken: string) {
  const params = new URLSearchParams();
  params.set("client_id", clientId);
  params.set("grant_type", "refresh_token");
  params.set("refresh_token", refreshToken);

  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params
  });
  if (!res.ok) throw new Error("Spotify refresh failed.");

  const data = await res.json();
  const current = getSession();
  const session: SpotifySession = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || current?.refreshToken || refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000
  };
  saveSession(session);
  return session;
}

export function verifyState(state: string | null) {
  const expected = localStorage.getItem(OAUTH_STATE_KEY);
  return !!state && !!expected && state === expected;
}
