import type { AutomationRecord } from "../../shared/automation.js";
import { config } from "../config.js";

type Signal = NonNullable<AutomationRecord["lastSignal"]>;
type Fetcher = typeof fetch;

export type AutomationDispatchOptions = {
  url?: string;
  secret?: string;
  fetcher?: Fetcher;
  retries?: number;
};

/** Hand a recorded signal to the durable queue. A successful response means Cloudflare owns all later retries. */
export async function dispatchAutomationSignal(automationId: string, signal: Signal, options: AutomationDispatchOptions = {}) {
  const url = options.url ?? config.automationIngress.url;
  const secret = options.secret ?? config.automationIngress.secret;
  const fetcher = options.fetcher ?? fetch;
  const retries = options.retries ?? 3;
  if (!secret) throw new Error("AUTOMATION_INGRESS_SECRET is not configured.");

  let lastError: Error | undefined;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const response = await fetcher(`${url}/v1/automations/${encodeURIComponent(automationId)}/fire`, {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
        body: JSON.stringify({ sourceEventId: signal.eventId, observedMarketCapUsd: signal.observedMarketCapUsd }),
        signal: AbortSignal.timeout(10_000)
      });
      if (response.ok) return true;
      lastError = new Error(`Automation ingress rejected the signal (${response.status}).`);
      if (response.status < 500 && response.status !== 429) break;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    if (attempt + 1 < retries) await new Promise((resolve) => setTimeout(resolve, 150 * 2 ** attempt));
  }
  throw lastError ?? new Error("Automation ingress did not accept the signal.");
}

export async function currentMarketCap(chain: AutomationRecord["intent"]["chain"], tokenAddress: string) {
  try {
    const { fetchTokenBatch } = await import("../sources/dexscreenerTokens.js");
    const rows = await fetchTokenBatch(chain, [tokenAddress]);
    return rows.get(tokenAddress.toLowerCase())?.marketCapUsd ?? undefined;
  } catch {
    return undefined;
  }
}
