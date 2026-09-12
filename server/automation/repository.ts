import { randomUUID } from "node:crypto";
import postgres, { type Sql } from "postgres";
import type { AutomationIntent, AutomationRecord } from "../../shared/automation.js";
import { AutomationDelegationStore, type AutomationDelegation } from "./delegations.js";
import { AutomationStore } from "./store.js";

type ExecutionResult = { transactionHash?: string; failure?: string };

function millis(value: Date | string | number | null | undefined) {
  return value == null ? undefined : new Date(value).getTime();
}

function recordFromRow(row: Record<string, any>): AutomationRecord {
  return {
    id: row.id,
    userId: row.user_id,
    intent: row.intent,
    status: row.status,
    source: row.source,
    conversationId: row.conversation_id ?? undefined,
    contextDigest: row.context_digest ?? undefined,
    approvalMethod: row.approval_method ?? undefined,
    failure: row.failure ?? undefined,
    transactionHash: row.transaction_hash ?? undefined,
    createdAt: millis(row.created_at)!,
    updatedAt: millis(row.updated_at)!,
    approvedAt: millis(row.approved_at),
    cancelledAt: millis(row.cancelled_at)
  };
}

function delegationFromRow(row: Record<string, any>): AutomationDelegation {
  return {
    userId: row.user_id,
    chain: row.chain,
    walletAddress: row.wallet_address,
    walletId: row.wallet_id,
    signerId: row.signer_id,
    policyId: row.policy_id,
    enabledAt: millis(row.enabled_at)!,
    updatedAt: millis(row.updated_at)!
  };
}

/**
 * Durable control-plane persistence. Production uses Neon; local development keeps
 * the existing ignored snapshots so contributors do not need a database.
 */
export class AutomationRepository {
  private sql?: Sql;
  private files: AutomationStore;
  private fileDelegations: AutomationDelegationStore;
  private localExecutionKeys = new Set<string>();

  constructor(databaseUrl: string | undefined, snapshotDirectory: string) {
    this.files = new AutomationStore(snapshotDirectory);
    this.fileDelegations = new AutomationDelegationStore(snapshotDirectory);
    if (databaseUrl) {
      this.sql = postgres(databaseUrl, {
        max: 5,
        idle_timeout: 20,
        connect_timeout: 15,
        connection: { application_name: "termeow-api" },
        prepare: false
      });
    }
  }

  get durable() { return Boolean(this.sql); }

  async health() {
    if (!this.sql) return { configured: false, connected: false };
    await this.sql`SELECT 1`;
    return { configured: true, connected: true };
  }

  async close() { await this.sql?.end({ timeout: 5 }); }

  async create(userId: string, intent: AutomationIntent, meta: { source?: AutomationRecord["source"]; conversationId?: string; contextDigest?: string } = {}) {
    if (!this.sql) return this.files.create(userId, intent, meta);
    const id = randomUUID();
    const source = meta.source ?? "terminal";
    const expiresAt = intent.durationHours ? new Date(Date.now() + intent.durationHours * 3_600_000) : null;
    const [row] = await this.sql`
      INSERT INTO termeow.automation_workflows
        (id, user_id, intent, status, source, conversation_id, context_digest, expires_at)
      VALUES
        (${id}, ${userId}, ${this.sql.json(intent as any)}, 'pending_approval', ${source}, ${meta.conversationId ?? null}, ${meta.contextDigest ?? null}, ${expiresAt})
      RETURNING *`;
    return recordFromRow(row);
  }

  async list(userId: string) {
    if (!this.sql) return this.files.list(userId);
    const rows = await this.sql`SELECT * FROM termeow.automation_workflows WHERE user_id = ${userId} ORDER BY updated_at DESC LIMIT 1000`;
    return rows.map(recordFromRow);
  }

  async get(userId: string, id: string) {
    if (!this.sql) return this.files.get(userId, id);
    const rows = await this.sql`SELECT * FROM termeow.automation_workflows WHERE id = ${id} AND user_id = ${userId} LIMIT 1`;
    return rows[0] ? recordFromRow(rows[0]) : null;
  }

  async getById(id: string) {
    if (!this.sql) return this.files.getById(id);
    const rows = await this.sql`SELECT * FROM termeow.automation_workflows WHERE id = ${id} LIMIT 1`;
    return rows[0] ? recordFromRow(rows[0]) : null;
  }

  async approve(userId: string, id: string) {
    if (!this.sql) return this.files.approve(userId, id);
    const rows = await this.sql`
      UPDATE termeow.automation_workflows
      SET status = 'armed', approval_method = 'privy_passkey_mfa', approved_at = now(), updated_at = now()
      WHERE id = ${id} AND user_id = ${userId} AND status = 'pending_approval'
      RETURNING *`;
    return rows[0] ? recordFromRow(rows[0]) : null;
  }

  async cancel(userId: string, id: string) {
    if (!this.sql) return this.files.cancel(userId, id);
    const rows = await this.sql`
      UPDATE termeow.automation_workflows
      SET status = 'cancelled', cancelled_at = now(), updated_at = now()
      WHERE id = ${id} AND user_id = ${userId} AND status NOT IN ('completed', 'cancelled')
      RETURNING *`;
    return rows[0] ? recordFromRow(rows[0]) : null;
  }

  async report(userId: string, id: string, status: "executing" | "completed" | "failed", detail: ExecutionResult = {}) {
    if (!this.sql) return this.files.report(userId, id, status, detail);
    const rows = await this.sql`
      UPDATE termeow.automation_workflows
      SET status = ${status}, transaction_hash = ${detail.transactionHash ?? null}, failure = ${detail.failure ?? null}, updated_at = now()
      WHERE id = ${id} AND user_id = ${userId} AND status IN ('armed', 'executing')
      RETURNING *`;
    return rows[0] ? recordFromRow(rows[0]) : null;
  }

  async claimExecution(id: string, sourceEventId: string, observedMarketCapUsd?: number) {
    if (!this.sql) {
      const key = `${id}:${sourceEventId}`;
      if (this.localExecutionKeys.has(key)) return { automation: null, duplicate: true };
      const automation = this.files.beginExecution(id);
      if (!automation) return { automation: null, duplicate: false };
      this.localExecutionKeys.add(key);
      return { automation, duplicate: false };
    }
    return this.sql.begin(async (tx) => {
      const claimed = await tx`
        UPDATE termeow.automation_workflows
        SET status = 'executing', failure = NULL, updated_at = now()
        WHERE id = ${id} AND status = 'armed' AND (expires_at IS NULL OR expires_at > now())
        RETURNING *`;
      if (!claimed[0]) {
        const duplicate = await tx`SELECT 1 FROM termeow.automation_execution_events WHERE automation_id = ${id} AND source_event_id = ${sourceEventId}`;
        await tx`UPDATE termeow.automation_workflows SET status = 'failed', failure = 'Automation expired before execution.', updated_at = now() WHERE id = ${id} AND status = 'armed' AND expires_at <= now()`;
        return { automation: null, duplicate: duplicate.length > 0 };
      }
      const inserted = await tx`
        INSERT INTO termeow.automation_execution_events
          (automation_id, source_event_id, observed_market_cap_usd, status)
        VALUES (${id}, ${sourceEventId}, ${observedMarketCapUsd ?? null}, 'claimed')
        ON CONFLICT (automation_id, source_event_id) DO NOTHING
        RETURNING id`;
      if (!inserted[0]) {
        await tx`UPDATE termeow.automation_workflows SET status = 'armed', updated_at = now() WHERE id = ${id} AND status = 'executing'`;
        return { automation: null, duplicate: true };
      }
      return { automation: recordFromRow(claimed[0]), duplicate: false };
    });
  }

  async finishExecution(userId: string, id: string, sourceEventId: string, status: "completed" | "failed", detail: ExecutionResult = {}) {
    if (!this.sql) return this.files.report(userId, id, status, detail);
    return this.sql.begin(async (tx) => {
      await tx`
        UPDATE termeow.automation_execution_events
        SET status = ${status}, transaction_hash = ${detail.transactionHash ?? null}, failure = ${detail.failure ?? null}, updated_at = now()
        WHERE automation_id = ${id} AND source_event_id = ${sourceEventId}`;
      const rows = await tx`
        UPDATE termeow.automation_workflows
        SET status = ${status}, transaction_hash = ${detail.transactionHash ?? null}, failure = ${detail.failure ?? null}, updated_at = now()
        WHERE id = ${id} AND user_id = ${userId} AND status = 'executing'
        RETURNING *`;
      return rows[0] ? recordFromRow(rows[0]) : null;
    });
  }

  async getDelegation(userId: string, chain: "solana" = "solana") {
    if (!this.sql) return this.fileDelegations.get(userId, chain);
    const rows = await this.sql`SELECT * FROM termeow.automation_delegations WHERE user_id = ${userId} AND chain = ${chain} LIMIT 1`;
    return rows[0] ? delegationFromRow(rows[0]) : null;
  }

  async setDelegation(input: Omit<AutomationDelegation, "enabledAt" | "updatedAt">) {
    if (!this.sql) return this.fileDelegations.set(input);
    const rows = await this.sql`
      INSERT INTO termeow.automation_delegations
        (user_id, chain, wallet_address, wallet_id, signer_id, policy_id)
      VALUES (${input.userId}, ${input.chain}, ${input.walletAddress}, ${input.walletId}, ${input.signerId}, ${input.policyId})
      ON CONFLICT (user_id, chain) DO UPDATE SET
        wallet_address = EXCLUDED.wallet_address,
        wallet_id = EXCLUDED.wallet_id,
        signer_id = EXCLUDED.signer_id,
        policy_id = EXCLUDED.policy_id,
        updated_at = now()
      RETURNING *`;
    return delegationFromRow(rows[0]);
  }

  async removeDelegation(userId: string, chain: "solana" = "solana") {
    if (!this.sql) return this.fileDelegations.remove(userId, chain);
    const rows = await this.sql`DELETE FROM termeow.automation_delegations WHERE user_id = ${userId} AND chain = ${chain} RETURNING user_id`;
    return rows.length > 0;
  }
}
