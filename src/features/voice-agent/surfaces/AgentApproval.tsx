import { useEffect, useState, type CSSProperties } from "react";
import { getAccessToken, useLinkWithPasskey, useMfa, useMfaEnrollment, usePrivy } from "@privy-io/react-auth";
import { useWallets as useSolanaWallets } from "@privy-io/react-auth/solana";
import type { AutomationIntent, LinkedExitCondition } from "../../../../shared/automation";
import { api } from "../../../api/client";
import { hasPrivy } from "../../../auth/WalletProviders";
import { money, shortAddress } from "../../../lib/format";
import { useAgentStore } from "../store/agentStore";
import { useAutomationDelegation } from "../../../auth/useAutomationDelegation";

function marketCapRange(min?: number, max?: number) {
  if (min != null && max != null) return `${money(min, true)} – ${money(max, true)}`;
  if (min != null) return `≥ ${money(min, true)}`;
  if (max != null) return `≤ ${money(max, true)}`;
  return "ANY MARKET CAP";
}

function humanPrecision(value: string) {
  return value.replace(/-?\d+\.\d{5,}/g, (raw) => {
    const number = Number(raw);
    return Number.isFinite(number) ? number.toFixed(4).replace(/0+$/, "").replace(/\.$/, "") : raw;
  });
}

function numberOrUndefined(value: string) {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function ApprovalDetails({ intent, editable = false }: { intent: AutomationIntent; editable?: boolean }) {
  if (intent.kind === "transfer") return <div className="agent-approval-copy transfer-approval-copy">
    <span>ONE-TIME SOL TRANSFER · SOLANA MAINNET</span>
    <strong>{humanPrecision(intent.description)}</strong>
    <dl>
      <div><dt>SEND EXACTLY</dt><dd>{intent.transferAmountSol} SOL</dd></div>
      <div><dt>USD AT QUOTE</dt><dd>{intent.transferAmountUsd == null ? "—" : money(intent.transferAmountUsd)}</dd></div>
      <div className="wide"><dt>RECIPIENT WALLET</dt><dd className="full-address">{intent.recipientAddress}</dd></div>
      <div><dt>SOL / USD</dt><dd>{intent.transferPriceUsd == null ? "—" : money(intent.transferPriceUsd)}</dd></div>
      <div><dt>NETWORK FEE</dt><dd>ADDED SEPARATELY</dd></div>
    </dl>
  </div>;
  return <div className="agent-approval-copy">
    <span>{intent.kind.replaceAll("_", " ")} · {intent.chain}</span>
    <strong>{humanPrecision(intent.description)}</strong>
    <dl>
      <div><dt>TARGET</dt><dd>{intent.tokenSymbol || (intent.tokenAddress ? intent.tokenAddress.slice(0, 10) : "ANY TOKEN BOUGHT")}</dd></div>
      {intent.side && <div><dt>ACTION</dt><dd>{intent.side.toUpperCase()} · {(intent.router || "AUTO").toUpperCase()}</dd></div>}
      {!editable && <div><dt>SIZE</dt><dd>{intent.amountMode === "wallet_percent" ? `${intent.allocationPercent}% OF WALLET` : intent.amount || "—"}</dd></div>}
      {!editable && intent.kind !== "swap" && <div><dt>MARKET CAP</dt><dd>{marketCapRange(intent.marketCapMinUsd, intent.marketCapMaxUsd)}</dd></div>}
      {intent.trackedWallet && <div><dt>TRACKED</dt><dd>{intent.trackedWalletUsername ? `@${intent.trackedWalletUsername.replace(/^@/, "")} · ` : ""}{shortAddress(intent.trackedWallet)}</dd></div>}
      {intent.trackedXAccount && <div><dt>X ACCOUNT</dt><dd>@{intent.trackedXAccount.replace(/^@/, "")}</dd></div>}
      {!editable && intent.entryPriceTolerancePct != null && <div><dt>MAX ENTRY DRIFT</dt><dd>{intent.entryPriceTolerancePct}%</dd></div>}
      {!editable && intent.slippageBps != null && <div><dt>SLIPPAGE</dt><dd>{(intent.slippageBps / 100).toFixed(2)}%</dd></div>}
      {!editable && intent.durationHours && <div><dt>WINDOW</dt><dd>{intent.durationHours} HOURS</dd></div>}
    </dl>
    {intent.condition && <p><b>WHEN · </b>{humanPrecision(intent.condition)}</p>}
    {intent.exitConditions?.map((exit) => <p key={exit.id}><b>THEN SELL {exit.sellPercent}% · </b>{humanPrecision(exit.condition)}</p>)}
  </div>;
}

export function ApprovalEditor({ intent, onChange }: { intent: AutomationIntent; onChange: (next: AutomationIntent) => void }) {
  const set = <K extends keyof AutomationIntent>(key: K, value: AutomationIntent[K]) => onChange({ ...intent, [key]: value });
  const exits = intent.exitConditions ?? [];
  const updateExit = (index: number, patch: Partial<LinkedExitCondition>) => set("exitConditions", exits.map((item, offset) => offset === index ? { ...item, ...patch } : item));
  const addExit = () => set("exitConditions", [...exits, { id: crypto.randomUUID(), type: "take_profit_pct", condition: "Take profit when position gains 25%", value: 25, sellPercent: 100, slippageBps: intent.slippageBps ?? 50, activateAfter: "entry_confirmed" }]);
  const allocation = intent.allocationPercent ?? 10;
  const slippage = (intent.slippageBps ?? 50) / 100;
  return <div className="agent-approval-editor">
    <div className="agent-primary-sliders">
      <label><span><b>ORDER SIZE</b><output>{allocation.toFixed(allocation < 1 ? 2 : 1)}%</output></span><input type="range" min="0.1" max="25" step="0.1" value={allocation} style={{ "--range-progress": `${(allocation / 25) * 100}%` } as CSSProperties} onChange={(event) => onChange({ ...intent, amountMode: "wallet_percent", allocationPercent: Number(event.target.value) })} /></label>
      <label><span><b>SLIPPAGE</b><output>{slippage.toFixed(2)}%</output></span><input type="range" min="0.01" max="5" step="0.01" value={slippage} style={{ "--range-progress": `${(slippage / 5) * 100}%` } as CSSProperties} onChange={(event) => set("slippageBps", Math.round(Number(event.target.value) * 100))} /></label>
    </div>
    <details className="agent-advanced-fields">
      <summary>ADVANCED CONDITIONS</summary>
      <div className="agent-edit-grid">
      <label>MAX ENTRY DRIFT %<input type="number" min="0.01" max="100" step="0.01" value={intent.entryPriceTolerancePct ?? ""} onChange={(event) => set("entryPriceTolerancePct", numberOrUndefined(event.target.value))} /></label>
      <label>EXPIRY HOURS<input type="number" min="1" max="720" step="1" value={intent.durationHours ?? ""} onChange={(event) => set("durationHours", numberOrUndefined(event.target.value))} /></label>
      <label>MIN MARKET CAP<input type="number" min="0" step="1000" value={intent.marketCapMinUsd ?? ""} onChange={(event) => set("marketCapMinUsd", numberOrUndefined(event.target.value))} /></label>
      <label>MAX MARKET CAP<input type="number" min="0" step="1000" value={intent.marketCapMaxUsd ?? ""} onChange={(event) => set("marketCapMaxUsd", numberOrUndefined(event.target.value))} /></label>
      </div>
      <label>ENTRY CONDITION<textarea rows={2} value={intent.condition ?? ""} onChange={(event) => set("condition", event.target.value)} /></label>
    {exits.map((exit, index) => <fieldset className="agent-exit-editor" key={exit.id}>
      <legend>EXIT {index + 1} · AFTER CONFIRMED ENTRY</legend>
      <label>SELL %<input type="number" min="0.01" max="100" value={exit.sellPercent} onChange={(event) => updateExit(index, { sellPercent: numberOrUndefined(event.target.value) ?? 0 })} /></label>
      <label>SLIPPAGE %<input type="number" min="0.01" max="5" step="0.01" value={(exit.slippageBps ?? intent.slippageBps ?? 50) / 100} onChange={(event) => updateExit(index, { slippageBps: Math.round((numberOrUndefined(event.target.value) ?? 0.5) * 100) })} /></label>
      <label className="wide">CONDITION<input value={exit.condition} onChange={(event) => updateExit(index, { condition: event.target.value })} /></label>
      <button type="button" onClick={() => set("exitConditions", exits.filter((_, offset) => offset !== index))}>REMOVE EXIT</button>
    </fieldset>)}
      {intent.side === "buy" && exits.length < 8 && <button type="button" className="add-exit" onClick={addExit}>+ ADD LINKED EXIT</button>}
    </details>
  </div>;
}

function LiveApproval() {
  const pending = useAgentStore((state) => state.pendingApproval)!;
  const { authenticated, login, user } = usePrivy();
  const { linkWithPasskey } = useLinkWithPasskey();
  const { promptMfa, mfaMethods } = useMfa();
  const { initEnrollmentWithPasskey, submitEnrollmentWithPasskey } = useMfaEnrollment();
  const { wallets: solanaWallets } = useSolanaWallets();
  const { ensureDelegated } = useAutomationDelegation(solanaWallets[0]?.address);
  const [draft, setDraft] = useState(pending.intent);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => setDraft(pending.intent), [pending.id]);

  const cancel = async () => {
    setWorking(true);
    try {
      const token = await getAccessToken();
      if (token) await api.cancelAutomation(token, pending.id);
      useAgentStore.getState().setPendingApproval(undefined);
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : String(reason)); }
    finally { setWorking(false); }
  };
  const approve = async () => {
    if (!authenticated) { login(); return; }
    setWorking(true); setMessage("");
    try {
      const immediateWalletAction = ["swap", "transfer"].includes(pending.intent.kind);
      if (!immediateWalletAction) {
        const passkeys = user?.linkedAccounts.filter((account) => account.type === "passkey") ?? [];
        if (!passkeys.length) {
          await linkWithPasskey({ name: "Termeow trade approvals" });
          setMessage("PASSKEY LINKED · PRESS CONFIRM AGAIN TO ENROLL MFA");
          return;
        }
        if (!mfaMethods.includes("passkey")) {
          await initEnrollmentWithPasskey();
          await submitEnrollmentWithPasskey({ credentialIds: passkeys.map((account) => account.credentialId) });
        }
        await promptMfa();
      }
      if (pending.intent.chain === "solana" && !["swap", "transfer"].includes(pending.intent.kind)) await ensureDelegated();
      const token = await getAccessToken();
      if (!token) throw new Error("Privy session expired. Log in again.");
      const edited = await api.updateAutomation(token, pending.id, draft);
      const result = await api.approveAutomation(token, edited.automation.id);
      useAgentStore.getState().setPendingApproval(undefined);
      useAgentStore.getState().addMessage({ role: "system", text: `${result.automation.intent.description} approved with Privy passkey MFA.` });
      window.dispatchEvent(new CustomEvent("termeow:automation-approved", { detail: result.automation }));
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : String(reason)); }
    finally { setWorking(false); }
  };

  return <div className="automation-approval-backdrop" role="presentation"><section className="agent-approval" role="dialog" aria-modal="true" aria-label="Passkey transaction confirmation">
    <div className="agent-approval-head"><b>{draft.kind === "transfer" ? "TRANSFER CONFIRMATION" : "PASSKEY CONFIRMATION"}</b><span>PENDING · NOT EXECUTED</span></div>
    <ApprovalDetails intent={draft} editable={draft.kind !== "transfer"} />
    {draft.kind !== "transfer" && <ApprovalEditor intent={draft} onChange={setDraft} />}
    <p>This approval is bound to the exact action above. Voice alone cannot arm or submit it.{draft.kind === "transfer" ? " Verify the full recipient address before confirming." : ""}</p>
    {message && <small role="status">{message}</small>}
    <div className="agent-approval-actions"><button type="button" disabled={working} onClick={() => void cancel()}>CANCEL</button><button className="confirm" type="button" disabled={working} onClick={() => void approve()}>{working ? "PREPARING…" : authenticated ? (["swap", "transfer"].includes(draft.kind) ? "CONTINUE TO WALLET" : "CONFIRM WITH PASSKEY") : "LOG IN TO CONFIRM"}</button></div>
  </section></div>;
}

export function AgentApproval() {
  const pending = useAgentStore((state) => state.pendingApproval);
  if (!pending) return null;
  if (!hasPrivy) return <div className="automation-approval-backdrop" role="presentation"><section className="agent-approval" role="dialog" aria-modal="true"><div className="agent-approval-head"><b>PASSKEY CONFIRMATION</b><span>PRIVY REQUIRED</span></div><ApprovalDetails intent={pending.intent} /><p>Add VITE_PRIVY_APP_ID to enable authenticated passkey approval.</p></section></div>;
  return <LiveApproval />;
}
