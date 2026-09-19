import { describe, expect, it, vi } from "vitest";
import { dispatchAutomationSignal } from "./dispatch.js";

const signal = {
  source: "wallet" as const,
  eventId: "tx-1234:buy:mint",
  tokenAddress: "mint",
  observedAt: 1,
  observedMarketCapUsd: 2_500_000
};

describe("automation signal dispatch", () => {
  it("authenticates and passes execution context to the durable ingress", async () => {
    let requestedUrl = "";
    let requestedInit: RequestInit | undefined;
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requestedUrl = String(url);
      requestedInit = init;
      return new Response(JSON.stringify({ queued: true }), { status: 202 });
    });
    await expect(dispatchAutomationSignal("automation-id", signal, {
      url: "https://queue.example", secret: "ingress-secret", fetcher: fetcher as typeof fetch
    })).resolves.toBe(true);
    expect(requestedUrl).toBe("https://queue.example/v1/automations/automation-id/fire");
    expect(requestedInit?.headers).toMatchObject({ Authorization: "Bearer ingress-secret" });
    expect(JSON.parse(String(requestedInit?.body))).toEqual({ sourceEventId: signal.eventId, observedMarketCapUsd: 2_500_000 });
  });

  it("retries transient ingress failures", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(new Response("queued", { status: 202 }));
    await expect(dispatchAutomationSignal("automation-id", signal, {
      url: "https://queue.example", secret: "ingress-secret", fetcher: fetcher as typeof fetch, retries: 2
    })).resolves.toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("fails closed when no ingress credential is configured", async () => {
    await expect(dispatchAutomationSignal("automation-id", signal, {
      url: "https://queue.example", secret: "", fetcher: vi.fn() as unknown as typeof fetch
    })).rejects.toThrow(/INGRESS_SECRET/);
  });
});
