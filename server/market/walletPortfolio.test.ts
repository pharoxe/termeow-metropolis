import { expect, it, vi } from "vitest";
import { walletPortfolio } from "./walletPortfolio";
import type { fetchJson } from "../lib/http";
const account=(amount:string)=>({account:{data:{parsed:{info:{mint:"MintA",tokenAmount:{uiAmountString:amount,decimals:9}}}}}});
it("queries the requested wallet and values its combined balances, never provider holdings", async () => {
  const rpc=vi.fn(async (method:string,params:unknown[])=>{
    expect(params[0]).toBe("owner");
    return method==="getBalance"?{value:2e9}:{value:[account("3")]};
  });
  const load=vi.fn(async()=>[{chainId:"solana",baseToken:{address:"MintA",symbol:"A"},priceUsd:"2",valueUsd:999999,liquidity:{usd:100}},{chainId:"solana",baseToken:{address:"So11111111111111111111111111111111111111112"},priceUsd:"100"}]) as unknown as typeof fetchJson;
  const result=await walletPortfolio("owner",rpc,load);
  expect(result.assets.find(a=>a.mint==="MintA")).toMatchObject({amount:6,valueUsd:12});
  expect(result.assets.find(a=>a.mint==="SOL")).toMatchObject({amount:2,valueUsd:200});
  expect(result.partial).toBe(false);
});
it("preserves balances and unknown prices on pricing failure, and labels partial RPC results", async () => {
  const rpc=async(method:string)=>{if(method!=="getBalance")throw new Error("offline");return {value:1e9};};
  const load=(async()=>{throw new Error("offline");}) as typeof fetchJson;
  expect(await walletPortfolio("owner",rpc,load)).toMatchObject({partial:true,valuationUnavailable:true,assets:[{amount:1,priceUsd:null,valueUsd:null}]});
  await expect(walletPortfolio("owner",async()=>{throw new Error("offline");},load)).rejects.toThrow("balances are unavailable");
});
