/** The slice of a `ws` socket the log transport touches; tests inject a fake through `makeSocket`. */
export type WebSocketLike = {
  send(data: string): void;
  close(): void;
  terminate?(): void;
  ping?(): void;
  on(event: string, listener: (...args: any[]) => void): unknown;
};

/** Text of one inbound `ws` frame whatever form the library handed it in. */
export function frameText(data: unknown): string {
  if (typeof data === "string") return data;
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return String(data);
}
