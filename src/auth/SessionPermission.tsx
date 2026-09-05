import { useState } from "react";

type Session = { createdAt: number; expiresAt: number; scope: string[] };

export function SessionPermission() {
  const [session, setSession] = useState<Session | null>(() => {
    try {
      const value = JSON.parse(localStorage.getItem("termeow_session") || "null") as Session | null;
      return value && value.expiresAt > Date.now() ? value : null;
    } catch { return null; }
  });

  const authorize = () => {
    const value = {
      createdAt: Date.now(),
      expiresAt: Date.now() + 30 * 60_000,
      scope: ["quote", "populate-order", "simulate"]
    };
    localStorage.setItem("termeow_session", JSON.stringify(value));
    setSession(value);
  };
  const revoke = () => {
    localStorage.removeItem("termeow_session");
    setSession(null);
  };

  return (
    <section className="panel session-panel">
      <div className="panel-title"><span>SESSION PREFERENCES</span><span className="tag">30 MIN</span></div>
      <p>Save your preferred scope for this browser session. Wallet approval is required for every trade.</p>
      <div className="scope-list">
        {(session?.scope || ["quote", "populate-order", "simulate"]).map((scope) => <span key={scope}>{scope}</span>)}
      </div>
      <button className={session ? "danger ghost" : "primary ghost"} onClick={session ? revoke : authorize}>
        {session ? "CLEAR PREFERENCES" : "SAVE FOR 30 MIN"}
      </button>
      {session && <small>Expires {new Date(session.expiresAt).toLocaleTimeString()}</small>}
    </section>
  );
}
