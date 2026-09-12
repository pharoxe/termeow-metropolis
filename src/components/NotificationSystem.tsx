import { AnimatePresence, MotionConfig, animate, motion } from "motion/react";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type PropsWithChildren } from "react";

export type NotificationTone = "info" | "success" | "warning";
export type NotificationInput = { title: string; message: string; tone?: NotificationTone };
type NotificationItem = NotificationInput & { id: number; tone: NotificationTone; closing: boolean };

const AUDIO: Record<NotificationTone, string> = {
  info: "/audio/notify-info.mp3",
  success: "/audio/notify-success.mp3",
  warning: "/audio/notify-warning.mp3"
};
const SFX_KEY = "termeow-sfx-enabled";
const NotificationContext = createContext<{
  notify: (input: NotificationInput) => void;
  soundEnabled: boolean;
  setSoundEnabled: (enabled: boolean) => void;
}>({ notify: () => {}, soundEnabled: true, setSoundEnabled: () => {} });

function readSoundPreference() {
  try { return localStorage.getItem(SFX_KEY) !== "false"; } catch { return true; }
}

function GlobalMotionFeedback() {
  useEffect(() => {
    const target = (event: Event) => (event.target as HTMLElement | null)?.closest<HTMLElement>("button:not(:disabled), a[href], [role='button']");
    const spring = { type: "spring" as const, stiffness: 520, damping: 28, mass: 0.45 };
    const enter = (event: PointerEvent) => { const node = target(event); if (node && event.pointerType !== "touch" && !node.contains(event.relatedTarget as Node | null)) void animate(node, { scale: 1.018, y: -1 }, spring); };
    const leave = (event: PointerEvent) => { const node = target(event); if (node && !node.contains(event.relatedTarget as Node | null)) void animate(node, { scale: 1, y: 0 }, spring); };
    const down = (event: PointerEvent) => { const node = target(event); if (node) void animate(node, { scale: 0.965, y: 1 }, { ...spring, stiffness: 650 }); };
    const up = (event: PointerEvent) => { const node = target(event); if (node) void animate(node, { scale: event.pointerType === "touch" ? 1 : 1.018, y: event.pointerType === "touch" ? 0 : -1 }, spring); };
    document.addEventListener("pointerover", enter);
    document.addEventListener("pointerout", leave);
    document.addEventListener("pointerdown", down);
    document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", leave);
    return () => {
      document.removeEventListener("pointerover", enter);
      document.removeEventListener("pointerout", leave);
      document.removeEventListener("pointerdown", down);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", leave);
    };
  }, []);
  return null;
}

export function NotificationProvider({ children }: PropsWithChildren) {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [soundEnabled, setSoundEnabledState] = useState(readSoundPreference);
  const counter = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const fadeTimers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const remove = useCallback((id: number) => {
    setItems((current) => current.filter((item) => item.id !== id));
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
    const fadeTimer = fadeTimers.current.get(id);
    if (fadeTimer) clearTimeout(fadeTimer);
    fadeTimers.current.delete(id);
  }, []);

  const notify = useCallback((input: NotificationInput) => {
    const id = ++counter.current;
    const tone = input.tone || "info";
    setItems((current) => [...current, { ...input, id, tone, closing: false }].slice(-3));
    if (soundEnabled) {
      const audio = new Audio(AUDIO[tone]);
      audio.volume = tone === "warning" ? 0.1125 : 0.15;
      void audio.play().catch(() => undefined);
    }
    fadeTimers.current.set(id, setTimeout(() => setItems((current) => current.map((item) => item.id === id ? { ...item, closing: true } : item)), 4000));
    timers.current.set(id, setTimeout(() => remove(id), 4600));
  }, [remove, soundEnabled]);

  const setSoundEnabled = useCallback((enabled: boolean) => {
    setSoundEnabledState(enabled);
    try { localStorage.setItem(SFX_KEY, String(enabled)); } catch { /* keep the in-memory choice */ }
  }, []);

  useEffect(() => () => { timers.current.forEach(clearTimeout); fadeTimers.current.forEach(clearTimeout); timers.current.clear(); fadeTimers.current.clear(); }, []);

  return <NotificationContext.Provider value={{ notify, soundEnabled, setSoundEnabled }}>
    <MotionConfig reducedMotion="user">
      <GlobalMotionFeedback />
      {children}
      <div className="notification-stack" aria-live="polite" aria-label="Notifications">
        <AnimatePresence initial={false} mode="popLayout">
          {items.map((item) => <motion.article
            layout
            key={item.id}
            className={`terminal-notification ${item.tone}`}
            initial={{ opacity: 0, x: 72, scale: 0.82, rotate: 1.5 }}
            animate={item.closing ? { opacity: 0, x: 56, scale: 0.88, rotate: 0 } : { opacity: 1, x: 0, scale: 1, rotate: 0 }}
            transition={item.closing ? { duration: 0.55, ease: "easeIn" } : { type: "spring", stiffness: 480, damping: 30, mass: 0.65 }}
          >
            <div className="notification-pixel" aria-hidden="true"><i /><i /><i /><i /></div>
            <div className="notification-copy"><b>{item.title}</b><p>{item.message}</p></div>
            <button type="button" aria-label={`Dismiss ${item.title}`} onClick={() => remove(item.id)}>×</button>
            <motion.i className="notification-life" initial={{ scaleX: 1 }} animate={{ scaleX: 0 }} transition={{ duration: 4.6, ease: "linear" }} />
          </motion.article>)}
        </AnimatePresence>
      </div>
    </MotionConfig>
  </NotificationContext.Provider>;
}

export function useNotifications() {
  return useContext(NotificationContext);
}

/** A short, local execution cue. It runs only after a wallet submission succeeds and respects the global SFX switch. */
export function useTradeFeedback() {
  const { soundEnabled } = useNotifications();
  return useCallback((side: "buy" | "sell") => {
    const shell = document.querySelector<HTMLElement>(".app-shell");
    const name = `trade-impact-${side}`;
    shell?.classList.remove("trade-impact-buy", "trade-impact-sell");
    void shell?.offsetWidth;
    shell?.classList.add(name);
    setTimeout(() => shell?.classList.remove(name), 420);
    if (!soundEnabled) return;
    try {
      const AudioContextCtor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextCtor) return;
      const audio = new AudioContextCtor();
      const gain = audio.createGain();
      const oscillator = audio.createOscillator();
      oscillator.type = side === "buy" ? "square" : "sawtooth";
      oscillator.frequency.setValueAtTime(side === "buy" ? 170 : 310, audio.currentTime);
      oscillator.frequency.exponentialRampToValueAtTime(side === "buy" ? 540 : 95, audio.currentTime + .16);
      gain.gain.setValueAtTime(.0001, audio.currentTime);
      gain.gain.exponentialRampToValueAtTime(.07, audio.currentTime + .015);
      gain.gain.exponentialRampToValueAtTime(.0001, audio.currentTime + .2);
      oscillator.connect(gain).connect(audio.destination);
      oscillator.start(); oscillator.stop(audio.currentTime + .21);
      oscillator.addEventListener("ended", () => void audio.close(), { once: true });
    } catch { /* wallet submission remains successful even when audio is unavailable */ }
  }, [soundEnabled]);
}

export function SfxToggle() {
  const { soundEnabled, setSoundEnabled, notify } = useNotifications();
  return <button type="button" className="sfx-toggle" aria-pressed={soundEnabled} onClick={() => {
    const next = !soundEnabled;
    setSoundEnabled(next);
    if (next) notify({ title: "SFX ONLINE", message: "Arcade cues are enabled at a restrained volume.", tone: "success" });
  }}><span className="pixel-speaker" aria-hidden="true"><svg viewBox="0 0 16 16" shapeRendering="crispEdges"><path d="M1 6h3V4h2V2h3v12H6v-2H4v-2H1zM11 5h2v2h1v2h-1v2h-2V9h1V7h-1z" />{!soundEnabled && <path className="speaker-slash" d="M1 1h2v2h2v2h2v2h2v2h2v2h2v2h2v2h-3v-2h-2v-2H8V9H6V7H4V5H2V3H1z" />}</svg></span> SFX</button>;
}
