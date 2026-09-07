import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { errorMessage } from "../lib/http.js";

/** A serialized component past this is not written (the SIGTERM->SIGKILL budget is 5 s; 16 MB of JSON writes in well under 1 s). */
export const SNAPSHOT_MAX_BYTES = 16 * 1024 * 1024;

/** One file per component: `<dir>/<component>.v<version>.json`, written to `.tmp` and renamed into place. */
export type SnapshotEnvelope<T> = {
  component: string;
  version: number;
  /** ms epoch when the data was collected. */
  savedAt: number;
  /** configFingerprint() of the process that wrote it; a different chain/RPC/config never restores. */
  fingerprint: string;
  /** Items dropped by the component cap before writing. */
  truncated: number;
  data: T;
};

const envelopeSchema = z.object({
  component: z.string().min(1),
  version: z.number().int().positive(),
  savedAt: z.number().finite(),
  fingerprint: z.string().min(1),
  truncated: z.number().int().nonnegative(),
  data: z.unknown()
});

export type ReadReason = "missing" | "corrupt" | "version" | "fingerprint" | "expired" | "invalid";
export type ReadOutcome<T> =
  | { ok: true; data: T; savedAt: number; ageMs: number; truncated: number }
  | { ok: false; reason: ReadReason; detail: string | null };
export type WriteOutcome = { ok: true; bytes: number; file: string } | { ok: false; reason: "too-large" | "io"; detail: string; bytes: number };

export type ReadOptions<T> = {
  version: number;
  fingerprint: string;
  maxAgeMs: number;
  now: number;
  /** Validates the untrusted `data`; return null when the shape is wrong. */
  parse: (data: unknown) => T | null;
};

export type FingerprintInput = { robinhoodRpcUrl: string; solanaRpcUrl: string; nodeEnv: string };

export function snapshotFile(dir: string, component: string, version: number): string {
  return path.join(dir, `${component}.v${version}.json`);
}

/** Host + path only for the Solana URL: a keyed Helius/Alchemy URL must never reach the file even hashed with a guessable prefix. */
function rpcIdentity(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return url;
  }
}

/** Short stable hash of the parts of config that decide what the in-memory stores mean (chains + RPC endpoints + env). */
export function configFingerprint(input: FingerprintInput): string {
  const material = JSON.stringify([rpcIdentity(input.robinhoodRpcUrl), rpcIdentity(input.solanaRpcUrl), input.nodeEnv]);
  return createHash("sha256").update(material).digest("hex").slice(0, 16);
}

/** Synchronous on purpose: it must finish inside the SIGTERM handler before process.exit. Never throws. */
export function writeSnapshot<T>(dir: string, envelope: SnapshotEnvelope<T>, maxBytes = SNAPSHOT_MAX_BYTES): WriteOutcome {
  const file = snapshotFile(dir, envelope.component, envelope.version);
  let body: string;
  try {
    body = JSON.stringify(envelope);
  } catch (error) {
    return { ok: false, reason: "io", detail: `serialize: ${errorMessage(error)}`, bytes: 0 };
  }
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes > maxBytes) return { ok: false, reason: "too-large", detail: `${bytes} bytes > ${maxBytes}`, bytes };
  try {
    mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, body, "utf8");
    renameSync(tmp, file);
    return { ok: true, bytes, file };
  } catch (error) {
    return { ok: false, reason: "io", detail: errorMessage(error), bytes };
  }
}

/** Reads and validates one component file; every failure is a reason, never a throw. */
export function readSnapshot<T>(dir: string, component: string, opts: ReadOptions<T>): ReadOutcome<T> {
  const file = snapshotFile(dir, component, opts.version);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return code === "ENOENT" ? { ok: false, reason: "missing", detail: null } : { ok: false, reason: "corrupt", detail: errorMessage(error) };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { ok: false, reason: "corrupt", detail: errorMessage(error) };
  }
  const envelope = envelopeSchema.safeParse(raw);
  if (!envelope.success) return { ok: false, reason: "corrupt", detail: "envelope shape" };
  const { data, version, fingerprint, savedAt, truncated } = envelope.data;
  if (envelope.data.component !== component || version !== opts.version) {
    return { ok: false, reason: "version", detail: `${envelope.data.component} v${version}, wanted ${component} v${opts.version}` };
  }
  if (fingerprint !== opts.fingerprint) return { ok: false, reason: "fingerprint", detail: `${fingerprint} != ${opts.fingerprint}` };
  const ageMs = opts.now - savedAt;
  if (ageMs > opts.maxAgeMs) return { ok: false, reason: "expired", detail: `aged ${Math.round(ageMs / 1000)}s > ${Math.round(opts.maxAgeMs / 1000)}s` };
  const parsed = opts.parse(data);
  if (parsed === null) return { ok: false, reason: "invalid", detail: "data shape" };
  return { ok: true, data: parsed, savedAt, ageMs: Math.max(0, ageMs), truncated };
}
