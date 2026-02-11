"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function Home() {
  const router = useRouter();
  const [roomId, setRoomId] = useState("");
  const [pin, setPin] = useState("");
  const [name, setName] = useState("");
  const [color, setColor] = useState("#ff69b4");

  function enterRoom() {
    if (!roomId || !pin || !name) return;

    localStorage.setItem("userName", name);
    localStorage.setItem("userColor", color);

    let userKey = localStorage.getItem("userKey");
    if (!userKey) {
      userKey = crypto.randomUUID();
      localStorage.setItem("userKey", userKey);
    }

    router.push(`/room/${roomId}?pin=${pin}`);
  }

  return (
    <main className="home-shell">
      <section className="home-card">
        <p className="home-kicker">Game Night</p>
        <h1 className="home-title">DUO Room</h1>
        <p className="home-subtitle">Create or join a private room in seconds.</p>

        <form
          className="home-form"
          onSubmit={(e) => {
            e.preventDefault();
            enterRoom();
          }}
        >
          <label className="home-field">
            <span>Room ID</span>
            <input
              placeholder="ex: test"
              value={roomId}
              onChange={(e) => setRoomId(e.target.value)}
            />
          </label>

          <label className="home-field">
            <span>PIN</span>
            <input
              placeholder="4 digits"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
            />
          </label>

          <label className="home-field">
            <span>Your name</span>
            <input
              placeholder="ex: Alex"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>

          <label className="home-field">
            <span>Pick your color</span>
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
            />
          </label>

          <button type="submit" className="home-submit">
            Enter Room
          </button>
        </form>
      </section>
    </main>
  );
}
