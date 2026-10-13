import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface AutomationDelegation {
  userId: string;
  chain: "monad";
  walletAddress: string;
  walletId: string;
  signerId: string;
  policyId: string;
  enabledAt: number;
  updatedAt: number;
}

export class AutomationDelegationStore {
  private records = new Map<string, AutomationDelegation>();
  private file: string;

  constructor(directory: string) {
    this.file = path.join(directory, "automation-delegations.v1.json");
    this.restore();
  }

  get(userId: string, chain: "monad" = "monad") { return this.records.get(`${userId}:${chain}`) ?? null; }

  set(input: Omit<AutomationDelegation, "enabledAt" | "updatedAt">) {
    const now = Date.now();
    const existing = this.get(input.userId, input.chain);
    const record: AutomationDelegation = { ...input, enabledAt: existing?.enabledAt ?? now, updatedAt: now };
    this.records.set(`${input.userId}:${input.chain}`, record);
    this.persist();
    return record;
  }

  remove(userId: string, chain: "monad" = "monad") {
    const removed = this.records.delete(`${userId}:${chain}`);
    if (removed) this.persist();
    return removed;
  }

  private restore() {
    try {
      const rows = JSON.parse(readFileSync(this.file, "utf8"));
      if (Array.isArray(rows)) rows.forEach((row) => {
        if (row?.userId && row?.chain === "monad" && row?.walletId) this.records.set(`${row.userId}:${row.chain}`, row);
      });
    } catch { /* first boot */ }
  }

  private persist() {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify([...this.records.values()]), "utf8");
    renameSync(tmp, this.file);
  }
}
