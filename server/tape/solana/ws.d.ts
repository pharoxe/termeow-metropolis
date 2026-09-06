/**
 * Minimal ambient typing for the `ws` runtime dependency (8.x, declared in package.json) used by subscribe.ts; only the members the
 * subscriber touches. Delete this file if `@types/ws` is ever installed.
 */
declare module "ws" {
  export default class WebSocket {
    constructor(url: string);
    send(data: string): void;
    close(): void;
    terminate(): void;
    ping(): void;
    on(event: string, listener: (...args: any[]) => void): this;
  }
}
