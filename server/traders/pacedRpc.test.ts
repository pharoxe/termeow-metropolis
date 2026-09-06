import { afterEach, describe, expect, it, vi } from "vitest";
import { PacedRpc } from "./pacedRpc.js";

const RPC = "https://rpc.example.test/";

/** Records the address of every eth_getCode in arrival order and answers "0x". */
function fakeRpc() {
  const order: string[] = [];
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { params: unknown[] };
    order.push(String(body.params[0]));
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" }), { status: 200 });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, order };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("PacedRpc priority", () => {
  it("lets a high-priority call take the next slot ahead of low-priority calls already waiting", async () => {
    vi.useFakeTimers();
    const rpc = fakeRpc();
    const client = new PacedRpc({ rpcUrl: RPC, label: "eth_getCode", fetchImpl: rpc.fetchImpl, rps: 4 });
    const low = ["low-1", "low-2", "low-3"].map((address) => client.call("eth_getCode", [address, "latest"], "low"));
    const high = client.call("eth_getCode", ["high-1", "latest"], "high");
    await vi.advanceTimersByTimeAsync(2_000);
    await Promise.all([...low, high]);
    // low-1 was alone when it arrived and took the free slot; every later slot goes to the high call first.
    expect(rpc.order).toEqual(["low-1", "high-1", "low-2", "low-3"]);
  });

  it("keeps low-priority calls flowing at the paced rate when nothing high is waiting", async () => {
    vi.useFakeTimers();
    const rpc = fakeRpc();
    const client = new PacedRpc({ rpcUrl: RPC, label: "eth_getCode", fetchImpl: rpc.fetchImpl, rps: 4 });
    const calls = ["a", "b"].map((address) => client.call("eth_getCode", [address, "latest"], "low"));
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.all(calls);
    expect(rpc.order).toEqual(["a", "b"]);
  });
});
