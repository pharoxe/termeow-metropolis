import { config } from "../../config.js";
import { blockHintStats } from "./blockHints.js";
import type { WsTransportStatus } from "./wsLogs.js";

/**
 * Per-poller transport view, published on /api/health. `mode` is what is delivering prints right now: "ws" while the
 * socket is open and every wanted leg is subscribed, "http" while the HTTP tick is the only complete transport (socket
 * down, a leg rejected or unacked, or websockets disabled). Socket detail lives in `ws` (null when disabled).
 */
export type PollerTransport = {
  mode: "ws" | "http";
  wsEnabled: boolean;
  /** Last block the HTTP sweep verified; the next sweep starts here whatever the socket has seen since. */
  httpCursor: number | null;
  /** HTTP ticks run while every leg was subscribed (the slow catch-up cadence plus gap fills). */
  catchUpTicks: number;
  /** Logs delivered to the handler from websocket frames. */
  wsLogs: number;
  lastWsBlock: number | null;
  ws: WsTransportStatus | null;
};

export type RobinhoodTransportStatus = {
  /** One word for the desk status line: "WS" only when every poller is fully subscribed, "HTTP" when none is, "MIXED" otherwise (the pollers list says which). */
  label: "WS" | "HTTP" | "MIXED";
  mode: "ws" | "http" | "mixed";
  wsEnabled: boolean;
  wsUrls: string[];
  pollers: Array<{ name: string } & PollerTransport>;
  blockHints: { size: number; stored: number; served: number };
};

const providers = new Map<() => PollerTransport, string>();

/** Every poller registers on start (websocket or not, so the HTTP-only fallback is visible too) and leaves on stop; the health route reads the live set. Keyed by the provider, so two unnamed pollers never shadow each other. */
export function registerTransport(name: string, provider: () => PollerTransport): void {
  providers.set(provider, name);
}

export function unregisterTransport(provider: () => PollerTransport): void {
  providers.delete(provider);
}

export function robinhoodTransportStatus(): RobinhoodTransportStatus {
  const pollers = [...providers].map(([provider, name]) => ({ name, ...provider() }));
  const live = pollers.filter((poller) => poller.mode === "ws").length;
  const mode = live === 0 ? "http" : live === pollers.length ? "ws" : "mixed";
  return {
    label: mode === "ws" ? "WS" : mode === "http" ? "HTTP" : "MIXED",
    mode,
    wsEnabled: config.robinhood.ws.enabled,
    wsUrls: config.robinhood.ws.urls,
    pollers,
    blockHints: blockHintStats()
  };
}

/** Test seam. */
export function resetTransportRegistry(): void {
  providers.clear();
}
