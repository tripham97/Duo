"use client";

import { useMemo, useState } from "react";
import { socket } from "@/lib/socket";

type LobbyNote = {
  id: string;
  userKey: string;
  name: string;
  color?: string;
  text: string;
  createdAt: number;
};

export default function LobbyNotes({
  roomId,
  notes,
  myUserKey
}: {
  roomId: string;
  notes: LobbyNote[];
  myUserKey: string;
}) {
  const [draft, setDraft] = useState("");
  const sortedNotes = useMemo(
    () => [...(notes || [])].sort((a, b) => b.createdAt - a.createdAt),
    [notes]
  );

  function addNote() {
    if (!draft.trim()) return;
    socket.emit("ADD_LOBBY_NOTE", { roomId, text: draft });
    setDraft("");
  }

  function removeNote(noteId: string) {
    socket.emit("DELETE_LOBBY_NOTE", { roomId, noteId });
  }

  return (
    <div className="lobby-notes">
      <div className="lobby-note-editor">
        <textarea
          value={draft}
          placeholder="Leave a note for others..."
          onChange={(e) => setDraft(e.target.value)}
        />
        <button onClick={addNote}>Post Note</button>
      </div>

      <div className="sticky-grid">
        {sortedNotes.length === 0 && (
          <div className="lobby-empty-note">No notes yet. Leave the first one.</div>
        )}

        {sortedNotes.map((note) => (
          <article className="sticky-note" key={note.id}>
            <header className="sticky-note-head">
              <strong style={{ color: note.color || "#93c5fd" }}>{note.name}</strong>
              {note.userKey === myUserKey && (
                <button
                  className="sticky-note-delete"
                  onClick={() => removeNote(note.id)}
                  title="Delete my note"
                >
                  x
                </button>
              )}
            </header>
            <p>{note.text}</p>
          </article>
        ))}
      </div>
    </div>
  );
}
