/**
 * Ambient typing for the server half of the `ws` runtime dependency, merged with the client half declared in
 * server/tape/solana/ws.d.ts; only what the websocket transport tests touch. Delete if `@types/ws` is ever installed.
 */
declare module "ws" {
  export class WebSocketServer {
    constructor(options: { port?: number; host?: string });
    on(event: string, listener: (...args: any[]) => void): this;
    close(callback?: () => void): void;
    address(): { port: number } | string | null;
    readonly clients: Set<{ send(data: string): void; close(code?: number, reason?: string): void; terminate(): void }>;
  }
}
