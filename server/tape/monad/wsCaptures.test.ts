import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_MONAD_WS_URLS } from "../../config.js";
import { MAX_SUBSCRIPTIONS_PER_CONNECTION, MAX_TOPICS_PER_POSITION } from "./wsLegs.js";
import { KEEPALIVE_MS, SILENCE_LIMIT_MS } from "./wsLogs.js";

/**
 * Pins the transport's constants to the measurements they came from (2026-09-07, publicnode + pocket), so a constant
 * cannot drift away from its capture unnoticed. The captures are probe output, not synthetic.
 */
const read = <T>(name: string) => JSON.parse(readFileSync(new URL(`./__fixtures__/r7/${name}`, import.meta.url), "utf8")) as T;

type Limits = { url: string; subscriptionsPerConnection: { accepted: number; firstFailure: number | null }; topicListSizes: Record<string, { ok: boolean; error?: { message: string } }> };
type Measure = { url: string; window: { ms: number }; newHeads: { count: number; nonConsecutiveCount: number; timestampIsSeconds: boolean }; httpCompare: Record<string, { http: number; ws: number; missingFromWs: number; extraInWs: number }>; reconnect: { gapBlocks: number } };
type Idle = { closes: Array<{ atMs: number; code: number }>; stillOpen: boolean; clientPingAtMs: number };
type Keepalive = { periodMs: number; runMs: number; pongs: number[]; stillOpenAtEnd: boolean };
type BlockTimes = { results: Record<string, { wsLogBlockTimestamp: string; officialBlockTimestamp: string; match: boolean }> };

const NODES = ["publicnode", "pocket"] as const;

describe("r7 websocket captures back the transport constants", () => {
  it("both default urls are the measured nodes", () => {
    const measured = NODES.map((node) => read<Measure>(`ws-measure-${node}.json`).url);
    expect([...DEFAULT_MONAD_WS_URLS]).toEqual(measured);
  });

  it("per-connection subscription ceiling and topic-list limit match what both nodes accepted and refused", () => {
    for (const node of NODES) {
      const limits = read<Limits>(`ws-limits-${node}.json`);
      expect(limits.subscriptionsPerConnection).toMatchObject({ accepted: MAX_SUBSCRIPTIONS_PER_CONNECTION, firstFailure: null });
      expect(limits.topicListSizes[String(MAX_TOPICS_PER_POSITION)]?.ok).toBe(true);
      expect(limits.topicListSizes[String(MAX_TOPICS_PER_POSITION * 2)]?.ok).toBe(false);
    }
    // publicnode refuses by silence (the probe timed out), pocket by an explicit error: why a missing ack is a rejection, not a wait
    expect(read<Limits>("ws-limits-publicnode.json").topicListSizes["2000"]?.error?.message).toBe("timeout");
    expect(read<Limits>("ws-limits-pocket.json").topicListSizes["2000"]?.error?.message).toContain("exceed max topics");
  });

  it("frames matched HTTP eth_getLogs log-for-log on every leg over a 60 s window, and a reconnect left a gap only HTTP can fill", () => {
    for (const node of NODES) {
      const measure = read<Measure>(`ws-measure-${node}.json`);
      expect(measure.window.ms).toBe(60_000);
      expect(Object.keys(measure.httpCompare).length).toBeGreaterThanOrEqual(8);
      for (const [leg, compare] of Object.entries(measure.httpCompare)) {
        expect({ leg, missingFromWs: compare.missingFromWs, extraInWs: compare.extraInWs }).toEqual({ leg, missingFromWs: 0, extraInWs: 0 });
        expect(compare.ws).toBe(compare.http);
      }
      expect(measure.reconnect.gapBlocks).toBeGreaterThan(0);
      expect(measure.newHeads).toMatchObject({ nonConsecutiveCount: 0, timestampIsSeconds: true });
      // ~10 heads/s: a socket silent for SILENCE_LIMIT_MS has missed hundreds of them
      expect(measure.newHeads.count / (measure.window.ms / 1000)).toBeGreaterThan(5);
      expect(SILENCE_LIMIT_MS / 1000).toBeGreaterThan(10);
    }
  });

  it("publicnode drops an idle socket at ~90 s (1006) and a client ping every KEEPALIVE_MS kept it open for the whole run", () => {
    const idle = read<Idle>("ws-idle-publicnode.json");
    expect(idle.stillOpen).toBe(false);
    expect(idle.closes[0]).toMatchObject({ code: 1006 });
    expect(idle.closes[0]!.atMs).toBeGreaterThan(KEEPALIVE_MS * 4);
    const keepalive = read<Keepalive>("ws-keepalive-publicnode-ping.json");
    expect(keepalive.periodMs).toBe(KEEPALIVE_MS);
    expect(keepalive.stillOpenAtEnd).toBe(true);
    expect(keepalive.runMs).toBeGreaterThan(idle.closes[0]!.atMs);
    expect(keepalive.pongs.length).toBeGreaterThanOrEqual(Math.floor(keepalive.runMs / keepalive.periodMs) - 1);
    // an RPC call every 30 s also kept it open: the ping-less fallback in keepalive()
    expect(read<Keepalive & { rpcAcks: number[] }>("ws-keepalive-publicnode-b-rpc.json")).toMatchObject({ stillOpenAtEnd: true });
    expect(read<Idle>("ws-idle-pocket.json").stillOpen).toBe(true);
  });

  it("the log frame's blockTimestamp equals the official node's block timestamp on every sampled block", () => {
    const samples = Object.entries(read<BlockTimes>("ws-blocktimestamp-vs-official-block.json").results);
    expect(samples.length).toBeGreaterThanOrEqual(3);
    for (const [block, sample] of samples) {
      expect({ block, match: sample.match, equal: sample.wsLogBlockTimestamp === sample.officialBlockTimestamp }).toEqual({ block, match: true, equal: true });
      expect(Number.parseInt(sample.wsLogBlockTimestamp, 16)).toBeGreaterThan(1_700_000_000);
    }
  });
});
