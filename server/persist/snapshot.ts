import { errorMessage } from "../lib/http.js";
import type { ComponentSpec } from "./components.js";
import { readSnapshot, writeSnapshot, type ReadReason, SNAPSHOT_MAX_BYTES } from "./store.js";

export type RestoreReport = {
  component: string;
  /** ms epoch when restore ran (null when nothing was applied). */
  restoredAt: number | null;
  savedAt: number | null;
  /** Age of the file at restore time; the label every restored dataset carries. */
  ageMs: number | null;
  counts: Record<string, number> | null;
  truncated: number;
  skipped: ReadReason | "no-owner" | "error" | null;
  detail: string | null;
};

export type SaveReport = { component: string; savedAt: number; bytes: number; truncated: number; skipped: "no-owner" | "too-large" | "io" | "error" | null; detail: string | null };

export type SnapshotStatus = {
  /** When the first component was restored in this process; null when nothing has been restored (yet). */
  restoredAt: number | null;
  /** Largest file age among the restored components, ms at restore time; null when nothing was restored. */
  snapshotAge: number | null;
  snapshot: {
    dir: string;
    intervalMs: number;
    fingerprint: string;
    components: RestoreReport[];
    lastSaveAt: number | null;
    lastSave: SaveReport[];
  };
};

export type SnapshotManagerOptions = {
  dir: string;
  intervalMs: number;
  fingerprint: string;
  now?: () => number;
  log?: (message: string) => void;
  maxBytes?: number;
};

const IST = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });

export function formatIst(ms: number): string {
  return `${IST.format(new Date(ms))} IST`;
}

function ageLabel(ms: number): string {
  return ms < 120_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`;
}

function counts(record: Record<string, number>): string {
  return Object.entries(record).map(([key, value]) => `${key} ${value}`).join(", ");
}

/**
 * Drives the registered components: restore each once (when asked, typically the moment its owner exists), save all on
 * an unref'd interval and on shutdown. Every outcome is a report on status(); nothing here throws to the caller.
 */
export class SnapshotManager {
  private readonly components: ComponentSpec<unknown>[] = [];
  private readonly restored = new Map<string, RestoreReport>();
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly maxBytes: number;
  private lastSave: SaveReport[] = [];
  private lastSaveAt: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: SnapshotManagerOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log ?? ((message) => console.warn(message));
    this.maxBytes = opts.maxBytes ?? SNAPSHOT_MAX_BYTES;
  }

  register<T>(spec: ComponentSpec<T>): this {
    this.components.push(spec as ComponentSpec<unknown>);
    return this;
  }

  /** Restores one component from its file; a second call for the same name is a no-op (the first report stands). */
  restore(name: string): RestoreReport {
    const existing = this.restored.get(name);
    if (existing) return existing;
    const spec = this.components.find((component) => component.name === name);
    const report = spec ? this.restoreSpec(spec) : this.skipped(name, "error", "unknown component");
    this.restored.set(name, report);
    if (report.skipped === null) {
      this.log(`snapshot: restored ${name} saved ${formatIst(report.savedAt ?? 0)} (aged ${ageLabel(report.ageMs ?? 0)}): ${counts(report.counts ?? {})}${report.truncated ? `; file was truncated by ${report.truncated}` : ""}`);
    } else if (report.skipped !== "missing") {
      this.log(`snapshot: skipped ${name}: ${report.skipped}${report.detail ? ` (${report.detail})` : ""}`);
    }
    return report;
  }

  /** Every registered component whose owner exists; synchronous so the shutdown path can call it before process.exit. */
  saveAll(reason: string): SaveReport[] {
    const savedAt = this.now();
    const reports = this.components.map((spec) => this.saveSpec(spec, savedAt));
    this.lastSave = reports;
    this.lastSaveAt = savedAt;
    const written = reports.filter((report) => report.skipped === null);
    const failed = reports.filter((report) => report.skipped !== null && report.skipped !== "no-owner");
    const truncated = reports.filter((report) => report.truncated > 0);
    for (const report of truncated) this.log(`snapshot: ${report.component} truncated by ${report.truncated} before writing`);
    for (const report of failed) this.log(`snapshot: ${report.component} not written: ${report.skipped}${report.detail ? ` (${report.detail})` : ""}`);
    if (reason === "shutdown") this.log(`snapshot: ${reason} wrote ${written.length}/${reports.length} components, ${written.reduce((sum, report) => sum + report.bytes, 0)} bytes`);
    return reports;
  }

  start(): this {
    if (this.timer) return this;
    this.timer = setInterval(() => void this.saveAll("interval"), this.opts.intervalMs);
    this.timer.unref?.();
    return this;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status(): SnapshotStatus {
    const components = [...this.restored.values()];
    const applied = components.filter((report) => report.restoredAt !== null);
    return {
      restoredAt: applied.length ? Math.min(...applied.map((report) => report.restoredAt as number)) : null,
      snapshotAge: applied.length ? Math.max(...applied.map((report) => report.ageMs ?? 0)) : null,
      snapshot: { dir: this.opts.dir, intervalMs: this.opts.intervalMs, fingerprint: this.opts.fingerprint, components, lastSaveAt: this.lastSaveAt, lastSave: this.lastSave }
    };
  }

  private restoreSpec(spec: ComponentSpec<unknown>): RestoreReport {
    try {
      const read = readSnapshot(this.opts.dir, spec.name, { version: spec.version, fingerprint: this.opts.fingerprint, maxAgeMs: spec.maxAgeMs, now: this.now(), parse: spec.parse });
      if (!read.ok) return this.skipped(spec.name, read.reason, read.detail);
      const applied = spec.restore(read.data);
      if (applied === null) return this.skipped(spec.name, "no-owner", null);
      return { component: spec.name, restoredAt: this.now(), savedAt: read.savedAt, ageMs: read.ageMs, counts: applied, truncated: read.truncated, skipped: null, detail: null };
    } catch (error) {
      return this.skipped(spec.name, "error", errorMessage(error));
    }
  }

  private saveSpec(spec: ComponentSpec<unknown>, savedAt: number): SaveReport {
    try {
      const collected = spec.collect();
      if (!collected) return { component: spec.name, savedAt, bytes: 0, truncated: 0, skipped: "no-owner", detail: null };
      const written = writeSnapshot(this.opts.dir, { component: spec.name, version: spec.version, savedAt, fingerprint: this.opts.fingerprint, truncated: collected.truncated, data: collected.data }, this.maxBytes);
      if (!written.ok) return { component: spec.name, savedAt, bytes: written.bytes, truncated: collected.truncated, skipped: written.reason, detail: written.detail };
      return { component: spec.name, savedAt, bytes: written.bytes, truncated: collected.truncated, skipped: null, detail: null };
    } catch (error) {
      return { component: spec.name, savedAt, bytes: 0, truncated: 0, skipped: "error", detail: errorMessage(error) };
    }
  }

  private skipped(component: string, reason: RestoreReport["skipped"], detail: string | null): RestoreReport {
    return { component, restoredAt: null, savedAt: null, ageMs: null, counts: null, truncated: 0, skipped: reason, detail };
  }
}
