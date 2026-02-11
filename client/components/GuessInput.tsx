"use client";

import { useState } from "react";
import { socket } from "@/lib/socket";

export default function GuessInput({ roomId }: any) {
  const [guess, setGuess] = useState("");
  const submitGuess = () => {
    if (!guess.trim()) return;
    socket.emit("GUESS", { roomId, guess });
    setGuess("");
  };

  const skipRound = () => {
    socket.emit("SKIP_ROUND", { roomId });
    setGuess("");
  };

  return (
    <div className="guess-controls">
      <input
        placeholder="Your guess..."
        value={guess}
        onChange={e => setGuess(e.target.value)}
        onKeyDown={e => {
          if (e.key === "Enter") {
            submitGuess();
          }
        }}
      />
      <button className="skip-btn" onClick={skipRound}>
        Skip
      </button>
    </div>
  );
}
