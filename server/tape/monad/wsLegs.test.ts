import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MAX_TOPICS_PER_POSITION,
  diffLegs,
  legKey,
  legWithinLimits,
  logBlockNumber,
  logBlockTimestampMs,
  parseHead,
  parseWsFrame,
  type LegFilter
} from "./wsLegs.js";

type Capture = { logSamples: Record<string, Array<Record<string, any>>>; newHeadsSamples: Array<Record<string, any>> };
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./__fixtures__/r7/${name}`, import.meta.url), "utf8")) as Capture;
const publicnode = fixture("ws-frames-publicnode.json");
const pocket = fixture("ws-frames-pocket.json");

const USEROP: LegFilter = { address: ["0x4337084d9e255ff0702461cf8895ce9e3b5ff108"], topics: [["0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f"]] };
const XFER: LegFilter = { topics: [["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"], null, ["0x" + "1".repeat(64)]] };

describe("wsLegs", () => {
  it("keys a leg by its address list and topic positions, so address-less legs and wildcard positions stay distinct", () => {
    expect(legKey(USEROP)).toBe(legKey({ ...USEROP }));
    expect(legKey(USEROP)).not.toBe(legKey({ ...USEROP, address: [] }));
    expect(legKey(XFER)).not.toBe(legKey({ topics: [XFER.topics[0], XFER.topics[2]!, null] }));
    expect(legKey({ topics: [["0xa"]] })).toBe(legKey({ address: [], topics: [["0xa"]] }));
  });

  it("diffs a leg set into subscribes and unsubscribes", () => {
    const current = [legKey(USEROP), legKey(XFER)];
    const next: LegFilter = { address: ["0xabc"], topics: [["0xdef"]] };
    expect(diffLegs(current, [USEROP, next])).toEqual({ add: [next], remove: [legKey(XFER)] });
    expect(diffLegs(current, [USEROP, XFER])).toEqual({ add: [], remove: [] });
    expect(diffLegs([], [])).toEqual({ add: [], remove: [] });
  });

  it("accepts topic lists up to the measured 1000 and refuses larger ones (pocket: exceed max topics; publicnode: silence)", () => {
    const topics = (n: number) => Array.from({ length: n }, (_, i) => `0x${i.toString(16).padStart(64, "0")}`);
    expect(legWithinLimits({ topics: [["0xa"], null, topics(MAX_TOPICS_PER_POSITION)] })).toBe(true);
    expect(legWithinLimits({ topics: [["0xa"], topics(MAX_TOPICS_PER_POSITION + 1)] })).toBe(false);
  });

  it("classifies captured frames: subscription notifications, replies with and without errors, noise", () => {
    const frame = publicnode.logSamples.userop![0]!;
    expect(parseWsFrame(JSON.stringify(frame))).toEqual({ kind: "notification", subscription: frame.params.subscription, result: frame.params.result });
    expect(parseWsFrame(Buffer.from(JSON.stringify(frame)))).toMatchObject({ kind: "notification" });
    expect(parseWsFrame('{"jsonrpc":"2.0","id":3,"result":"0xfc41a3cd6201c94bde4859be41443dd0"}')).toEqual({ kind: "reply", id: 3, result: "0xfc41a3cd6201c94bde4859be41443dd0", error: null });
    expect(parseWsFrame('{"jsonrpc":"2.0","id":9,"error":{"code":-32602,"message":"invalid argument 1: exceed max topics"}}')).toEqual({
      kind: "reply",
      id: 9,
      result: undefined,
      error: { code: -32602, message: "invalid argument 1: exceed max topics" }
    });
    expect(parseWsFrame('{"jsonrpc":"2.0","method":"other"}')).toEqual({ kind: "other" });
    expect(parseWsFrame("not json")).toBeNull();
    expect(parseWsFrame("[]")).toEqual({ kind: "other" });
  });

  it("reads newHeads headers from both nodes: block number and a 1 s-resolution timestamp in ms", () => {
    const head = publicnode.newHeadsSamples[0]!.params.result;
    expect(parseHead(head)).toEqual({ number: 0x366182b, timestampMs: 0x6a9ef827 * 1000 });
    expect(parseHead(pocket.newHeadsSamples[0]!.params.result)).toEqual({ number: 0x3661d15, timestampMs: 0x6a9ef8a6 * 1000 });
    expect(parseHead({ ...head, timestamp: "0x0" })).toEqual({ number: 0x366182b, timestampMs: null });
    expect(parseHead({ hash: "0x1" })).toBeNull();
    expect(parseHead(null)).toBeNull();
  });

  it("takes a log frame's blockTimestamp only when it is non-zero: publicnode/pocket carry it, the official RPC sends 0x0", () => {
    const log = pocket.logSamples.userop![0]!.params.result;
    expect(logBlockTimestampMs(log)).toBe(0x6a9ef8a2 * 1000);
    expect(logBlockNumber(log)).toBe(0x3661cf4);
    const official = JSON.parse(readFileSync(new URL("./__fixtures__/r7/http-getlogs-blocktimestamp.json", import.meta.url), "utf8")) as Record<string, any>;
    const officialStamps = official.results["https://rpc.mainnet.chain.robinhood.com"] /* captured on the pre-fork node */.blockTimestamps as string[];
    expect(officialStamps).toEqual(["0x0"]);
    for (const stamp of officialStamps) expect(logBlockTimestampMs({ ...log, blockTimestamp: stamp })).toBeNull();
    expect(logBlockTimestampMs({ ...log, blockTimestamp: undefined })).toBeNull();
    expect(logBlockNumber({})).toBeNull();
  });
});
