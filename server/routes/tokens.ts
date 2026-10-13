import { Router } from "express";
import { z } from "zod";
import { getLaunchService } from "../launch/service.js";
import { tokenRegistry } from "../terminal/tokenStore.js";
import { fetchTokenBatches } from "../sources/dexscreenerTokens.js";

const chain = z.literal("monad");
let refreshWritable = true;
let refreshQueued = false;
let lastRefreshRequestedAt = 0;
const TOKEN_INDEX_REFRESH_MS = 15_000;

function refreshLocalIndex() {
  if (!refreshWritable) return;
  try { tokenRegistry.ingestLaunches(getLaunchService().index.snapshot().rows); }
  catch (error) {
    // The canonical in-memory/on-disk index remains readable when Railway's optional cache volume is full.
    refreshWritable = false;
    console.warn(`token index: launch refresh disabled; serving existing catalog (${error instanceof Error ? error.message : String(error)})`);
  }
}

/** Keep launch ingestion off the interactive ticker-resolution path. The
 * persistent/curated catalog answers immediately; fresh launches follow on the
 * next event-loop turn and are coalesced across bursts of agent requests. */
export function scheduleTokenIndexRefresh(now = Date.now()) {
  if (!refreshWritable || refreshQueued || now - lastRefreshRequestedAt < TOKEN_INDEX_REFRESH_MS) return;
  refreshQueued = true;
  lastRefreshRequestedAt = now;
  setImmediate(() => {
    try { refreshLocalIndex(); }
    finally { refreshQueued = false; }
  });
}

export const tokensRouter = Router();

tokensRouter.get("/resolve", (request, response, next) => {
  try {
    const query = z.string().trim().min(1).max(120).parse(request.query.q);
    const requestedChain = chain.optional().parse(request.query.chain);
    const result = tokenRegistry.resolve(query, requestedChain);
    response.json(result);
    scheduleTokenIndexRefresh();
  } catch (error) { next(error); }
});

tokensRouter.get("/index", (_request, response) => {
  response.json({ tokens: tokenRegistry.list(), source: "termeow-token-index", observedAt: Date.now() });
  scheduleTokenIndexRefresh();
});

tokensRouter.post("/logos", async (request, response, next) => {
  try {
    const items = z.array(z.object({ chain, address: z.string().trim().min(1).max(120) })).min(1).max(30).parse(request.body?.items);
    const groups = new Map<z.infer<typeof chain>, string[]>();
    for (const item of items) groups.set(item.chain, [...(groups.get(item.chain) || []), item.address]);
    const loaded = await Promise.all([...groups].map(async ([itemChain, addresses]) => [itemChain, await fetchTokenBatches(itemChain, addresses)] as const));
    const batches = new Map(loaded);
    const logos = items.map((item) => {
      const indexed = tokenRegistry.byAddress(item.chain, item.address);
      const remote = batches.get(item.chain)?.get(item.address.toLowerCase());
      if (remote && (!indexed?.imageUrl || indexed.symbol === indexed.address)) {
        try { tokenRegistry.upsert({ chain: item.chain, address: item.address, symbol: remote.symbol || indexed?.symbol || "TOKEN", name: remote.name || indexed?.name, imageUrl: remote.image || indexed?.imageUrl, aliases: indexed?.aliases, source: indexed?.source || "market", priority: Math.max(indexed?.priority || 0, 10), verified: indexed?.verified, verificationSource: indexed?.verificationSource }); }
        catch { /* Read-only response still works if the optional cache volume is full. */ }
      }
      return { chain: item.chain, address: item.address, symbol: remote?.symbol || indexed?.symbol || null, imageUrl: remote?.image || indexed?.imageUrl || null };
    });
    response.json({ logos, observedAt: Date.now(), source: "termeow-token-logo-cache" });
  } catch (error) { next(error); }
});
