import { useState } from "react";
import { getAccessToken, useLinkWithPasskey, useMfa, useMfaEnrollment, usePrivy } from "@privy-io/react-auth";
import { api } from "../../../api/client";
import { hasPrivy } from "../../../auth/WalletProviders";
import { money, shortAddress } from "../../../lib/format";
import { useAgentStore } from "../store/agentStore";

function marketCapRange(min?: number, max?: number) {
  if (min != null && max != null) return `${money(min, true)} – ${money(max, true)}`;
  if (min != null) return `≥ ${money(min, true)}`;
  if (max != null) return `≤ ${money(max, true)}`;
  return "ANY MARKET CAP";
}

function ApprovalDetails() {
  const pending = useAgentStore((state) => state.pendingApproval)!;
  const intent = pending.intent;
  return <div className="agent-approval-copy">
    <span>{intent.kind.replaceAll("_", " ")} · {intent.chain}</span>
    <strong>{intent.description}</strong>
    <dl>
      <div><dt>TARGET</dt><dd>{intent.tokenSymbol || intent.tokenAddress.slice(0, 10)}</dd></div>
      {intent.side && <div><dt>ACTION</dt><dd>{intent.side.toUpperCase()} · {(intent.router || "AUTO").toUpperCase()}</dd></div>}
      <div><dt>SIZE</dt><dd>{intent.amountMode === "wallet_percent" ? `${intent.allocationPercent}% OF WALLET` : intent.amount || "—"}</dd></div>
      {intent.kind !== "swap" && <div><dt>MARKET CAP</dt><dd>{marketCapRange(intent.marketCapMinUsd, intent.marketCapMaxUsd)}</dd></div>}
      {intent.trackedWallet && <div><dt>TRACKED</dt><dd>{intent.trackedWalletUsername ? `@${intent.trackedWalletUsername.replace(/^@/, "")} · ` : ""}{shortAddress(intent.trackedWallet)}</dd></div>}
      {intent.durationHours && <div><dt>WINDOW</dt><dd>{intent.durationHours} HOURS</dd></div>}
    </dl>
    {intent.condition && <p><b>WHEN · </b>{intent.condition}</p>}
  </div>;
}

function LiveApproval() {
  const pending = useAgentStore((state) => state.pendingApproval)!;
  const { authenticated, login, user } = usePrivy();
  const { linkWithPasskey } = useLinkWithPasskey();
  const { promptMfa, mfaMethods } = useMfa();
  const { initEnrollmentWithPasskey, submitEnrollmentWithPasskey } = useMfaEnrollment();
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState("");

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
      const token = await getAccessToken();
      if (!token) throw new Error("Privy session expired. Log in again.");
      const result = await api.approveAutomation(token, pending.id);
      useAgentStore.getState().setPendingApproval(undefined);
      useAgentStore.getState().addMessage({ role: "system", text: `${result.automation.intent.description} approved with Privy passkey MFA.` });
      window.dispatchEvent(new CustomEvent("termeow:automation-approved", { detail: result.automation }));
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : String(reason)); }
    finally { setWorking(false); }
  };

  return <section className="agent-approval" aria-label="Passkey trade confirmation">
    <div className="agent-approval-head"><b>PASSKEY CONFIRMATION</b><span>PENDING · NOT EXECUTED</span></div>
    <ApprovalDetails />
    <p>This approval is bound to the exact action above. Voice alone cannot arm or submit it.</p>
    {message && <small role="status">{message}</small>}
    <div className="agent-approval-actions"><button type="button" disabled={working} onClick={() => void cancel()}>CANCEL</button><button className="confirm" type="button" disabled={working} onClick={() => void approve()}>{working ? "VERIFYING…" : authenticated ? "CONFIRM WITH PASSKEY" : "LOG IN TO CONFIRM"}</button></div>
  </section>;
}

export function AgentApproval() {
  const pending = useAgentStore((state) => state.pendingApproval);
  if (!pending) return null;
  if (!hasPrivy) return <section className="agent-approval"><div className="agent-approval-head"><b>PASSKEY CONFIRMATION</b><span>PRIVY REQUIRED</span></div><ApprovalDetails /><p>Add VITE_PRIVY_APP_ID to enable authenticated passkey approval.</p></section>;
  return <LiveApproval />;
}
