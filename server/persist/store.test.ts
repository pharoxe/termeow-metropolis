import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configFingerprint, readSnapshot, snapshotFile, writeSnapshot } from "./store.js";

const T0 = 1_788_788_395_478; // 2026-09-07 19:09:55 IST, the capture's observedAt
const FP = "abcdef0123456789";
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "termeow-store-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const parse = (data: unknown) => (Array.isArray(data) ? (data as number[]) : null);
const read = (over: Partial<Parameters<typeof readSnapshot<number[]>>[2]> = {}) =>
  readSnapshot<number[]>(dir, "nums", { version: 1, fingerprint: FP, maxAgeMs: 3_600_000, now: T0 + 60_000, parse, ...over });

describe("writeSnapshot / readSnapshot", () => {
  it("round-trips an envelope through a versioned file and leaves no .tmp behind", () => {
    const written = writeSnapshot(dir, { component: "nums", version: 1, savedAt: T0, fingerprint: FP, truncated: 2, data: [1, 2, 3] });
    expect(written.ok).toBe(true);
    expect(readdirSync(dir)).toEqual(["nums.v1.json"]);
    expect(existsSync(`${snapshotFile(dir, "nums", 1)}.tmp`)).toBe(false);
    const outcome = read();
    expect(outcome).toEqual({ ok: true, data: [1, 2, 3], savedAt: T0, ageMs: 60_000, truncated: 2 });
  });

  it("answers missing when no file exists and corrupt when the file is not JSON or not an envelope", () => {
    expect(read()).toEqual({ ok: false, reason: "missing", detail: null });
    writeFileSync(snapshotFile(dir, "nums", 1), "{not json");
    expect(read().ok).toBe(false);
    expect((read() as { reason: string }).reason).toBe("corrupt");
    writeFileSync(snapshotFile(dir, "nums", 1), JSON.stringify({ hello: "world" }));
    expect((read() as { reason: string }).reason).toBe("corrupt");
  });

  it("skips a version mismatch even when the file name matches, and never reads another version's file", () => {
    writeSnapshot(dir, { component: "nums", version: 2, savedAt: T0, fingerprint: FP, truncated: 0, data: [9] });
    expect((read() as { reason: string }).reason).toBe("missing");
    writeFileSync(snapshotFile(dir, "nums", 1), JSON.stringify({ component: "nums", version: 2, savedAt: T0, fingerprint: FP, truncated: 0, data: [9] }));
    expect((read() as { reason: string }).reason).toBe("version");
  });

  it("skips a fingerprint mismatch (chain / RPC / config change) and an expired file", () => {
    writeSnapshot(dir, { component: "nums", version: 1, savedAt: T0, fingerprint: "other", truncated: 0, data: [1] });
    expect((read() as { reason: string }).reason).toBe("fingerprint");
    writeSnapshot(dir, { component: "nums", version: 1, savedAt: T0, fingerprint: FP, truncated: 0, data: [1] });
    expect((read({ now: T0 + 3_600_001 }) as { reason: string }).reason).toBe("expired");
    expect(read({ now: T0 + 3_600_000 }).ok).toBe(true);
  });

  it("rejects data the component parser does not accept", () => {
    writeSnapshot(dir, { component: "nums", version: 1, savedAt: T0, fingerprint: FP, truncated: 0, data: { rows: [] } });
    expect((read() as { reason: string }).reason).toBe("invalid");
  });

  it("refuses to write past the byte cap and keeps the previous file intact", () => {
    writeSnapshot(dir, { component: "nums", version: 1, savedAt: T0, fingerprint: FP, truncated: 0, data: [1] });
    const big = writeSnapshot(dir, { component: "nums", version: 1, savedAt: T0 + 1, fingerprint: FP, truncated: 0, data: Array.from({ length: 5000 }, (_, i) => i) }, 1024);
    expect(big.ok).toBe(false);
    expect((big as { reason: string }).reason).toBe("too-large");
    expect(read()).toMatchObject({ ok: true, data: [1], savedAt: T0 });
  });
});

describe("configFingerprint", () => {
  it("is stable for the same endpoints, changes with the Monad RPC, chain id and env, and never embeds an RPC API key", () => {
    const base = { monadRpcUrl: "https://rpc.monad.xyz/?api-key=SECRET", chainId: 143, nodeEnv: "development" };
    const a = configFingerprint(base);
    expect(a).toBe(configFingerprint({ ...base }));
    expect(a).toHaveLength(16);
    expect(a).not.toBe(configFingerprint({ ...base, monadRpcUrl: "https://monad-rpc.publicnode.com" }));
    expect(a).not.toBe(configFingerprint({ ...base, nodeEnv: "production" }));
    expect(a).not.toBe(configFingerprint({ ...base, chainId: 10143 }));
    // the query string (where the key lives) is not part of the material
    expect(a).toBe(configFingerprint({ ...base, monadRpcUrl: "https://rpc.monad.xyz/?api-key=OTHER" }));
  });
});
