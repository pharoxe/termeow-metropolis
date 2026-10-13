import { expect, it } from "vitest";
import { QuoteCache, matchesOrder } from "./quotes";
const order = { inputMint: "0xAAAA000000000000000000000000000000000001", outputMint: "0xbbbb000000000000000000000000000000000002", amount: "100", slippageBps: 50, walletAddress: "0xcccc000000000000000000000000000000000003", router: "kuru" as const };
it("rejects changes to every order field and the router, ignoring address case", () => {
  expect(matchesOrder(order, {...order})).toBe(true);
  expect(matchesOrder(order, {...order, inputMint: order.inputMint.toLowerCase(), chain: "monad"})).toBe(true);
  for (const change of [{ inputMint:"0x01" }, { outputMint:"0x01" }, { amount:"99" }, { slippageBps:500 }, { walletAddress:"0x02" }, { router:"0x" as const }]) expect(matchesOrder(order, {...order,...change})).toBe(false);
});
it("expires abandoned quotes, caps entries, and supports single use", () => {
  let now=0; const cache=new QuoteCache(2,60,()=>now);
  cache.set("a",{},order,"kuru"); cache.set("b",{},order,"kuru"); cache.set("c",{},order,"0x");
  expect(cache.size).toBe(2); expect(cache.get("a")).toBeUndefined();
  cache.delete("b"); expect(cache.get("b")).toBeUndefined();
  now=60; cache.prune(); expect(cache.size).toBe(0);
});
it("remembers which router priced a quote, so the wrong one cannot execute it", () => {
  const cache=new QuoteCache(4,60,()=>0);
  cache.set("a",{},order,"0x");
  expect(cache.get("a")?.router).toBe("0x");
  cache.set("b",{},order,"kuru");
  expect(cache.get("b")?.router).toBe("kuru");
  expect(cache.get("b")?.chain).toBe("monad");
});
