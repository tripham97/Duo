"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { socket } from "@/lib/socket";
import Canvas from "@/components/Canvas";
import GuessInput from "@/components/GuessInput";
import StatusBar from "@/components/StatusBar";
import Wheel from "@/components/Wheel";
import LobbyNotes from "@/components/LobbyNotes";
import SpotifyPanel from "@/components/SpotifyPanel";

export default function Room() {
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const roomId = params?.id;
  const pin = searchParams.get("pin");

  const [room, setRoom] = useState<any>(null);
  const [secretWord, setSecretWord] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"DRAWING" | "WHEEL" | "MUSIC" | "LOBBY">("DRAWING");
  const [brushSize, setBrushSize] = useState(3);
  const [winnerText, setWinnerText] = useState<string | null>(null);
  const [wrongGuessMessage, setWrongGuessMessage] = useState<string | null>(null);
  const [wordInput, setWordInput] = useState("");
  const [wordError, setWordError] = useState<string | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [confettiPieces, setConfettiPieces] = useState<any[]>([]);
  const confettiTimer = useRef<any>(null);
  const wrongGuessTimer = useRef<any>(null);

  useEffect(() => {
    if (!roomId || !pin) return;

    const onRoomState = (nextRoom: any) => {
      setJoinError(null);
      setRoom(nextRoom);
    };
    const onJoinError = ({ message }: { message: string }) => {
      setJoinError(message || "Unable to join room.");
    };
    const onAssignWord = ({ word }: { word: string }) => setSecretWord(word);
    const onWordError = ({ message }: { message: string }) => {
      setWordError(message || "Unable to set word.");
    };
    const onClearCanvas = () => {
      window.dispatchEvent(new Event("clearCanvas"));
      setWrongGuessMessage(null);
    };
    const onWrongGuess = ({ message }: { message: string }) => {
      setWrongGuessMessage(message || "Wrong guess.");
      if (wrongGuessTimer.current) clearTimeout(wrongGuessTimer.current);
      wrongGuessTimer.current = setTimeout(() => {
        setWrongGuessMessage(null);
      }, 1800);
    };
    const onWinner = ({ name, points, maxScore }: any) => {
      setWinnerText(`🏆 ${name} wins (${points}/${maxScore})`);
      const palette = ["#60a5fa", "#f472b6", "#34d399", "#fbbf24", "#c084fc"];
      const pieces = Array.from({ length: 80 }, (_, i) => ({
        id: `${Date.now()}-${i}`,
        left: `${Math.random() * 100}%`,
        delay: `${Math.random() * 0.5}s`,
        duration: `${2.2 + Math.random() * 1.8}s`,
        color: palette[Math.floor(Math.random() * palette.length)],
        drift: `${-30 + Math.random() * 60}px`,
        rotate: `${Math.random() * 360}deg`
      }));
      setConfettiPieces(pieces);
      if (confettiTimer.current) clearTimeout(confettiTimer.current);
      confettiTimer.current = setTimeout(() => {
        setConfettiPieces([]);
      }, 4500);
    };
    const onRestarted = () => {
      setWinnerText(null);
      setConfettiPieces([]);
      setSecretWord(null);
      if (confettiTimer.current) clearTimeout(confettiTimer.current);
    };

    socket.on("ROOM_STATE", onRoomState);
    socket.on("ASSIGN_WORD", onAssignWord);
    socket.on("WORD_ERROR", onWordError);
    socket.on("CLEAR_CANVAS", onClearCanvas);
    socket.on("JOIN_ERROR", onJoinError);
    socket.on("WRONG_GUESS", onWrongGuess);
    socket.on("GAME_WINNER", onWinner);
    socket.on("GAME_RESTARTED", onRestarted);

    socket.connect();
    socket.emit("JOIN_ROOM", {
      roomId,
      pin,
      name: localStorage.getItem("userName"),
      color: localStorage.getItem("userColor"),
      userKey: localStorage.getItem("userKey")
    });

    return () => {
      socket.off("ROOM_STATE", onRoomState);
      socket.off("ASSIGN_WORD", onAssignWord);
      socket.off("WORD_ERROR", onWordError);
      socket.off("CLEAR_CANVAS", onClearCanvas);
      socket.off("JOIN_ERROR", onJoinError);
      socket.off("WRONG_GUESS", onWrongGuess);
      socket.off("GAME_WINNER", onWinner);
      socket.off("GAME_RESTARTED", onRestarted);
      if (confettiTimer.current) clearTimeout(confettiTimer.current);
      if (wrongGuessTimer.current) clearTimeout(wrongGuessTimer.current);
      socket.disconnect();
    };
  }, [roomId, pin]);

  useEffect(() => {
    if (!room) return;
    const currentUserKey = localStorage.getItem("userKey");
    const currentMe = room.users.find((u: any) => u.userKey === currentUserKey);
    const amDrawer =
      currentMe?.userKey === room.game.drawerUserKey ||
      currentMe?.socketId === room.game.drawerId;

    if (!amDrawer) {
      setSecretWord(null);
      setWordError(null);
      setWordInput("");
      return;
    }

    if (!room.game.currentWord) {
      setSecretWord(null);
    } else if (!secretWord) {
      setSecretWord(room.game.currentWord);
    }
  }, [room, secretWord]);

  useEffect(() => {
    if (!roomId) return;
    socket.emit("SET_ACTIVE_GAME", { roomId, game: activeTab });
  }, [activeTab, roomId]);

  if (!room) {
    if (joinError) return <p>{joinError}</p>;
    return <p>Loading...</p>;
  }

  const me = room.users.find(
    (u: any) => u.userKey === localStorage.getItem("userKey")
  );
  const drawingUsers = room.users.filter((u: any) => u.currentGame === "DRAWING");
  const wheelUsers = room.users.filter((u: any) => u.currentGame === "WHEEL");
  const musicUsers = room.users.filter((u: any) => u.currentGame === "MUSIC");
  const lobbyUsers = room.users.filter((u: any) => u.currentGame === "LOBBY");

  const isDrawer =
    me?.userKey === room.game.drawerUserKey ||
    me?.socketId === room.game.drawerId;
  const clearCanvas = () => {
    if (!roomId) return;
    socket.emit("CLEAR_CANVAS_REQUEST", { roomId });
  };
  const restartGame = () => {
    if (!roomId) return;
    socket.emit("RESTART_GAME", { roomId });
  };
  const screenshotCanvas = () => {
    const canvas = document.querySelector("canvas.canvas-full") as HTMLCanvasElement | null;
    if (!canvas) return;
    const link = document.createElement("a");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    link.href = canvas.toDataURL("image/png");
    link.download = `drawing-${roomId || "room"}-${stamp}.png`;
    link.click();
  };
  const leaveCurrentGame = () => {
    setActiveTab("LOBBY");
  };
  const submitWord = () => {
    if (!roomId) return;
    setWordError(null);
    socket.emit("SET_DRAW_WORD", { roomId, word: wordInput });
  };

  return (
    <div className="canvas-wrapper">
      {activeTab === "DRAWING" && (
        <Canvas
          roomId={roomId}
          isDrawer={isDrawer}
          color={me?.color}
          brushSize={brushSize}
        />
      )}

      <div className="overlay top-center-ui">
        <div className="tabs-shell">
          <div className="game-tabs">
            <button
              className={`game-tab ${activeTab === "DRAWING" ? "game-tab-active" : ""}`}
              onClick={() => setActiveTab("DRAWING")}
            >
              Drawing Game ({drawingUsers.length})
            </button>
            <button
              className={`game-tab ${activeTab === "WHEEL" ? "game-tab-active" : ""}`}
              onClick={() => setActiveTab("WHEEL")}
            >
              Wheel of Fortune ({wheelUsers.length})
            </button>
            <button
              className={`game-tab ${activeTab === "MUSIC" ? "game-tab-active" : ""}`}
              onClick={() => setActiveTab("MUSIC")}
            >
              Music ({musicUsers.length})
            </button>
            <button
              className={`game-tab ${activeTab === "LOBBY" ? "game-tab-active" : ""}`}
              onClick={() => setActiveTab("LOBBY")}
            >
              Lobby ({lobbyUsers.length})
            </button>
          </div>

          <div className="tab-presence">
            <div>Drawing: {drawingUsers.map((u: any) => u.name).join(", ") || "-"}</div>
            <div>Wheel: {wheelUsers.map((u: any) => u.name).join(", ") || "-"}</div>
            <div>Music: {musicUsers.map((u: any) => u.name).join(", ") || "-"}</div>
          </div>

          <div className="room-panel">
            <StatusBar
              users={room.users}
              showPoints={activeTab === "DRAWING"}
              gameState={room.game}
            />

            {activeTab !== "LOBBY" && (
              <button className="leave-btn" onClick={leaveCurrentGame}>
                Leave This Game
              </button>
            )}

            {activeTab === "DRAWING" && (
              <>
                {winnerText && <div className="winner-banner">{winnerText}</div>}
                {winnerText && (
                  <button className="restart-btn" onClick={restartGame}>
                    Restart Game
                  </button>
                )}

                {isDrawer && secretWord && (
                  <div className="secret-word">
                    ✏️ Draw: <b>{secretWord}</b>
                    <label className="brush-control">
                      <span>Brush: {brushSize}px</span>
                      <input
                        type="range"
                        min={2}
                        max={16}
                        step={1}
                        value={brushSize}
                        onChange={(e) => setBrushSize(Number(e.target.value))}
                      />
                    </label>
                    <button className="clear-btn" onClick={clearCanvas}>
                      Clear Canvas
                    </button>
                    <button className="screenshot-btn" onClick={screenshotCanvas}>
                      Screenshot
                    </button>
                  </div>
                )}

                {isDrawer && !secretWord && (
                  <div className="word-entry">
                    <span>Enter your word for this round:</span>
                    <div className="word-entry-row">
                      <input
                        value={wordInput}
                        onChange={(e) => setWordInput(e.target.value)}
                        maxLength={40}
                        placeholder="Type a word..."
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            submitWord();
                          }
                        }}
                      />
                      <button className="clear-btn" onClick={submitWord}>
                        Set Word
                      </button>
                    </div>
                    {wordError && <div className="guess-error">{wordError}</div>}
                  </div>
                )}

                {!isDrawer && (
                  <div className="guess-wrap">
                    <GuessInput roomId={roomId} />
                    <button className="screenshot-btn" onClick={screenshotCanvas}>
                      Screenshot
                    </button>
                    {wrongGuessMessage && (
                      <div className="guess-error">{wrongGuessMessage}</div>
                    )}
                  </div>
                )}
              </>
            )}

            {activeTab === "WHEEL" && (
              <div className="wheel-wrap">
                <Wheel
                  roomId={roomId}
                  options={room.game.wheelOptions || []}
                />
              </div>
            )}

            {activeTab === "MUSIC" && (
              <div className="music-wrap">
                <SpotifyPanel
                  roomId={roomId}
                  myUserKey={me?.userKey || ""}
                  musicState={room.music || null}
                />
              </div>
            )}

            {activeTab === "LOBBY" && (
              <div className="lobby-note">
                <p>You are in Lobby. Join a game tab above anytime.</p>
                <LobbyNotes
                  roomId={roomId}
                  notes={room.lobbyNotes || []}
                  myUserKey={me?.userKey || ""}
                />
              </div>
            )}
          </div>
        </div>
      </div>

      {confettiPieces.length > 0 && (
        <div className="confetti-layer" aria-hidden="true">
          {confettiPieces.map((piece) => (
            <span
              key={piece.id}
              className="confetti-piece"
              style={{
                left: piece.left,
                animationDelay: piece.delay,
                animationDuration: piece.duration,
                backgroundColor: piece.color,
                ["--drift" as any]: piece.drift,
                ["--spin" as any]: piece.rotate
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
