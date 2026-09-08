import { expect, it } from "vitest";
import { QuoteCache, matchesOrder, matchesRoute } from "./quotes";
const order = { inputMint: "A", outputMint: "B", amount: "100", slippageBps: 50, walletAddress: "wallet" };
it("rejects changes to every order field and upstream route", () => {
  expect(matchesOrder(order, {...order})).toBe(true);
  for (const change of [{ inputMint:"C" }, { outputMint:"C" }, { amount:"99" }, { slippageBps:500 }, { walletAddress:"other" }]) expect(matchesOrder(order, {...order,...change})).toBe(false);
  expect(matchesRoute({...order,inAmount:"100"},order)).toBe(true);
  expect(matchesRoute({...order,inAmount:"99"},order)).toBe(false);
});
it("expires abandoned quotes, caps entries, and supports single use", () => {
  let now=0; const cache=new QuoteCache(2,60,()=>now);
  cache.set("a",{},order); cache.set("b",{},order); cache.set("c",{},order);
  expect(cache.size).toBe(2); expect(cache.get("a")).toBeUndefined();
  cache.delete("b"); expect(cache.get("b")).toBeUndefined();
  now=60; cache.prune(); expect(cache.size).toBe(0);
});
