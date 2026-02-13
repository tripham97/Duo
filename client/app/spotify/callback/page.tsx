"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  exchangeCode,
  getReturnTo,
  verifyState
} from "@/lib/spotify";

export default function SpotifyCallbackPage() {
  const router = useRouter();
  const [message, setMessage] = useState("Connecting Spotify...");

  useEffect(() => {
    const clientId = process.env.NEXT_PUBLIC_SPOTIFY_CLIENT_ID || "";
    const redirectUri =
      process.env.NEXT_PUBLIC_SPOTIFY_REDIRECT_URI ||
      `${window.location.origin}/spotify/callback`;
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const state = params.get("state");

    if (!clientId) {
      setMessage("Missing NEXT_PUBLIC_SPOTIFY_CLIENT_ID.");
      return;
    }
    if (!code) {
      setMessage("Missing Spotify code.");
      return;
    }
    if (!verifyState(state)) {
      setMessage("Spotify state mismatch.");
      return;
    }

    exchangeCode(clientId, code, redirectUri)
      .then(() => {
        router.replace(getReturnTo("/"));
      })
      .catch(() => {
        setMessage("Spotify connection failed.");
      });
  }, [router]);

  return (
    <main className="home-shell">
      <section className="home-card">
        <h1 className="home-title">Spotify</h1>
        <p className="home-subtitle">{message}</p>
      </section>
    </main>
  );
}
