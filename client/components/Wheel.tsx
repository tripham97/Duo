"use client";

import { useEffect, useRef, useState } from "react";
import { socket } from "@/lib/socket";

export default function Wheel({
  roomId,
  canSpin = true,
  turnLabel = "",
  options = []
}: {
  roomId: string;
  canSpin?: boolean;
  turnLabel?: string;
  options?: string[];
}) {
  const [newOption, setNewOption] = useState("");
  const [spinning, setSpinning] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [pendingResult, setPendingResult] = useState<string | null>(null);
  const [turnWarning, setTurnWarning] = useState<string | null>(null);
  const [rotation, setRotation] = useState(0);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const tickIntervalRef = useRef<any>(null);
  const colorForIndex = (index: number) =>
    `hsl(${Math.round((index * 360) / (options.length || 1))} 72% 52% / 0.92)`;

  const wheelBackground = (() => {
    if (!options.length) return "rgba(255,255,255,0.08)";
    const segment = 360 / options.length;
    const stops = options.map((_, index) => {
      const start = index * segment;
      const end = (index + 1) * segment;
      return `${colorForIndex(index)} ${start}deg ${end}deg`;
    });
    return `conic-gradient(${stops.join(", ")})`;
  })();

  function getAudioContext() {
    if (audioCtxRef.current) return audioCtxRef.current;
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return null;
    audioCtxRef.current = new Ctx();
    return audioCtxRef.current;
  }

  function playTone(
    frequency: number,
    duration = 0.05,
    type: OscillatorType = "square",
    gainValue = 0.04
  ) {
    const ctx = getAudioContext();
    if (!ctx) return;
    if (ctx.state === "suspended") ctx.resume();

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = frequency;
    gain.gain.value = gainValue;

    osc.connect(gain);
    gain.connect(ctx.destination);

    const now = ctx.currentTime;
    gain.gain.setValueAtTime(gainValue, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

    osc.start(now);
    osc.stop(now + duration);
  }

  function startTickLoop() {
    stopTickLoop();
    tickIntervalRef.current = setInterval(() => {
      playTone(1050, 0.02, "square", 0.025);
    }, 95);
  }

  function stopTickLoop() {
    if (tickIntervalRef.current) {
      clearInterval(tickIntervalRef.current);
      tickIntervalRef.current = null;
    }
  }

  function playResultChime() {
    playTone(660, 0.08, "triangle", 0.05);
    setTimeout(() => playTone(880, 0.08, "triangle", 0.05), 90);
    setTimeout(() => playTone(1100, 0.12, "triangle", 0.05), 180);
  }

  function spin() {
    if (spinning || !canSpin) return;
    if (!options.length) return;
    startTickLoop();
    setSpinning(true);
    setResult(null);
    setPendingResult(null);
    setTurnWarning(null);

    socket.emit("SPIN_WHEEL", { roomId });
  }

  function addOption() {
    const value = newOption.trim();
    if (!value) return;
    socket.emit("SET_WHEEL_OPTIONS", {
      roomId,
      options: [...options, value]
    });
    setNewOption("");
  }

  function removeOption(index: number) {
    const next = options.filter((_, i) => i !== index);
    if (!next.length) return;
    socket.emit("SET_WHEEL_OPTIONS", {
      roomId,
      options: next
    });
  }

  useEffect(() => {
    const onResult = ({
      prompt,
      winnerIndex
    }: {
      prompt: string;
      winnerIndex?: number;
    }) => {
      const count = options.length || 1;
      const segment = 360 / count;
      const safeIndex =
        typeof winnerIndex === "number" && winnerIndex >= 0 && winnerIndex < count
          ? winnerIndex
          : Math.max(0, options.indexOf(prompt));
      const centerAngle = safeIndex * segment + segment / 2;

      setRotation((prev) => {
        const currentNorm = ((prev % 360) + 360) % 360;
        const targetNorm = ((360 - centerAngle) % 360 + 360) % 360;
        const alignDelta = (targetNorm - currentNorm + 360) % 360;
        return prev + 1440 + alignDelta;
      });

      setPendingResult(prompt);
      setTimeout(() => {
        stopTickLoop();
        playResultChime();
        setResult(prompt);
        setPendingResult(null);
        setSpinning(false);
      }, 2200);
      setTurnWarning(null);
    };
    const onDenied = ({ message }: { message: string }) => {
      stopTickLoop();
      setSpinning(false);
      setPendingResult(null);
      setTurnWarning(message || "Wait for your turn.");
    };
    socket.on("WHEEL_RESULT", onResult);
    socket.on("WHEEL_TURN_DENIED", onDenied);
    return () => {
      stopTickLoop();
      socket.off("WHEEL_RESULT", onResult);
      socket.off("WHEEL_TURN_DENIED", onDenied);
    };
  }, [options]);

  return (
    <div style={{ textAlign: "center", marginTop: 20 }}>
      <h3>🎡 Wheel of Fortune</h3>
      {turnLabel && <p>{turnLabel}</p>}

      <div className="wheel-option-editor">
        <input
          value={newOption}
          placeholder="Add wheel option..."
          onChange={(e) => setNewOption(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") addOption();
          }}
        />
        <button onClick={addOption}>Add</button>
      </div>

      <div className="wheel-option-list">
        {options.map((item, index) => (
          <div
            className="wheel-option-item"
            key={`${item}-${index}`}
            style={{ ["--option-color" as any]: colorForIndex(index) }}
          >
            <span className="wheel-option-color" />
            <span>{item}</span>
            <button onClick={() => removeOption(index)}>x</button>
          </div>
        ))}
      </div>

      <div className="wheel-stage">
        <div className="wheel-pointer">▼</div>
        <div
          className="wheel-disc"
          style={{
            background: wheelBackground,
            transform: `rotate(${rotation}deg)`,
            transition: spinning ? "transform 2.2s cubic-bezier(0.2, 0.9, 0.15, 1)" : "none"
          }}
        >
          <div className="wheel-center-dot" />
        </div>
      </div>

      <button onClick={spin} disabled={spinning || !canSpin}>
        {spinning ? "Spinning..." : "Spin"}
      </button>

      {turnWarning && <p>{turnWarning}</p>}
      {pendingResult && <p>Choosing...</p>}

      {result && (
        <p style={{ marginTop: 15, fontSize: 18 }} className="wheel-result">
          👉 <b>{result}</b>
        </p>
      )}
    </div>
  );
}
