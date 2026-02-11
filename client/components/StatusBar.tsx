export default function StatusBar({
  users,
  showPoints = true,
  gameState = {}
}: any) {
  function statusForUser(u: any) {
    if (!u.socketId || u.status === "DISCONNECTED") {
      return { label: "Offline", tone: "disconnected" };
    }

    if (u.currentGame === "WHEEL") {
      if (u.userKey === gameState.wheelTurnUserKey) {
        return { label: "Wheel Turn", tone: "drawing" };
      }
      return { label: "In Wheel", tone: "waiting" };
    }

    if (u.currentGame === "LOBBY") {
      return { label: "In Lobby", tone: "waiting" };
    }

    if (u.userKey === gameState.drawerUserKey) {
      return { label: "Drawing", tone: "drawing" };
    }
    if (u.userKey === gameState.guesserUserKey) {
      return { label: "Guessing", tone: "guessing" };
    }

    return { label: "In Drawing", tone: "waiting" };
  }

  function gameLabel(game: string) {
    if (game === "WHEEL") return "Wheel";
    if (game === "LOBBY") return "Lobby";
    return "Drawing";
  }

  return (
    <div className="status-bar">
      {users.map((u: any) => (
        <div className="status-chip" key={u.userKey}>
          <div
            className="status-avatar"
            style={{ backgroundColor: u.color || "#94a3b8" }}
          >
            {(u.name || "?").slice(0, 1).toUpperCase()}
          </div>

          <div className="status-user">
            <span className="status-name">{u.name}</span>
            <span className="status-role">
              {statusForUser(u).label}
              {` • ${gameLabel(u.currentGame)}`}
              {showPoints ? ` • ${u.points || 0}/5 pts` : ""}
            </span>
          </div>

          <span
            className={`status-dot status-dot-${statusForUser(u).tone}`}
            title={u.status}
          />
        </div>
      ))}
    </div>
  );
}
