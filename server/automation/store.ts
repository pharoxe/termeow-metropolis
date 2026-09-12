import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AutomationIntent, AutomationRecord } from "../../shared/automation.js";

const MAX_RECORDS = 10_000;

export class AutomationStore {
  private records = new Map<string, AutomationRecord>();
  private file: string;

  constructor(directory: string) {
    this.file = path.join(directory, "automations.v1.json");
    this.restore();
  }

  create(userId: string, intent: AutomationIntent, meta: { source?: AutomationRecord["source"]; conversationId?: string; contextDigest?: string } = {}) {
    const now = Date.now();
    const record: AutomationRecord = {
      id: randomUUID(), userId, intent, status: "pending_approval", source: meta.source ?? "terminal",
      conversationId: meta.conversationId, contextDigest: meta.contextDigest, createdAt: now, updatedAt: now
    };
    this.records.set(record.id, record);
    this.trim(); this.persist();
    return record;
  }

  list(userId: string) {
    return [...this.records.values()].filter((item) => item.userId === userId).sort((a, b) => b.createdAt - a.createdAt);
  }

  get(userId: string, id: string) {
    const record = this.records.get(id);
    return record?.userId === userId ? record : null;
  }

  getById(id: string) { return this.records.get(id) ?? null; }

  beginExecution(id: string) {
    const current = this.getById(id);
    if (!current || current.status !== "armed") return null;
    if (current.intent.durationHours && current.createdAt + current.intent.durationHours * 3_600_000 <= Date.now()) {
      const expired: AutomationRecord = { ...current, status: "failed", failure: "Automation expired before execution.", updatedAt: Date.now() };
      this.records.set(id, expired); this.persist(); return null;
    }
    const next: AutomationRecord = { ...current, status: "executing", failure: undefined, updatedAt: Date.now() };
    this.records.set(id, next); this.persist(); return next;
  }

  approve(userId: string, id: string) {
    const current = this.get(userId, id);
    if (!current || current.status !== "pending_approval") return null;
    const now = Date.now();
    const next: AutomationRecord = { ...current, status: "armed", approvalMethod: "privy_passkey_mfa", approvedAt: now, updatedAt: now };
    this.records.set(id, next); this.persist(); return next;
  }

  cancel(userId: string, id: string) {
    const current = this.get(userId, id);
    if (!current || ["completed", "cancelled"].includes(current.status)) return null;
    const now = Date.now();
    const next: AutomationRecord = { ...current, status: "cancelled", cancelledAt: now, updatedAt: now };
    this.records.set(id, next); this.persist(); return next;
  }

  report(userId: string, id: string, status: "executing" | "completed" | "failed", detail?: { transactionHash?: string; failure?: string }) {
    const current = this.get(userId, id);
    if (!current || !["armed", "executing"].includes(current.status)) return null;
    const next: AutomationRecord = { ...current, status, updatedAt: Date.now(), transactionHash: detail?.transactionHash, failure: detail?.failure };
    this.records.set(id, next); this.persist(); return next;
  }

  private trim() {
    if (this.records.size <= MAX_RECORDS) return;
    const oldest = [...this.records.values()].sort((a, b) => a.updatedAt - b.updatedAt).slice(0, this.records.size - MAX_RECORDS);
    oldest.forEach((item) => this.records.delete(item.id));
  }

  private restore() {
    try {
      const rows = JSON.parse(readFileSync(this.file, "utf8"));
      if (Array.isArray(rows)) rows.forEach((row) => { if (row?.id && row?.userId) this.records.set(row.id, row); });
    } catch { /* first boot or a discarded corrupt cache */ }
  }

  private persist() {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify([...this.records.values()]), "utf8");
    renameSync(tmp, this.file);
  }
}
