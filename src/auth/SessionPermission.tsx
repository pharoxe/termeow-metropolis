import { useState } from "react";

type Session = { createdAt: number; expiresAt: number; scope: string[] };

export function SessionPermission() {
  const [session, setSession] = useState<Session | null>(() => {
    try {
      const value = JSON.parse(localStorage.getItem("tv_session_mock") || "null") as Session | null;
      return value && value.expiresAt > Date.now() ? value : null;
    } catch { return null; }
  });

  const authorize = () => {
    const value = {
      createdAt: Date.now(),
      expiresAt: Date.now() + 30 * 60_000,
      scope: ["quote", "populate-order", "simulate"]
    };
    localStorage.setItem("tv_session_mock", JSON.stringify(value));
    setSession(value);
  };
  const revoke = () => {
    localStorage.removeItem("tv_session_mock");
    setSession(null);
  };

  return (
    <section className="panel session-panel">
      <div className="panel-title"><span>SESSION PERMISSIONS</span><span className="tag">UX MOCK</span></div>
      <p>Scoped authorization flow reserved for MagicBlock Session Keys. Trading still requires the connected wallet.</p>
      <div className="scope-list">
        {(session?.scope || ["quote", "populate-order", "simulate"]).map((scope) => <span key={scope}>{scope}</span>)}
      </div>
      <button className={session ? "danger ghost" : "primary ghost"} onClick={session ? revoke : authorize}>
        {session ? "REVOKE MOCK SESSION" : "AUTHORIZE 30M SESSION"}
      </button>
      {session && <small>Expires {new Date(session.expiresAt).toLocaleTimeString()}</small>}
    </section>
  );
}
