import express from "express";
import type { Server } from "node:http";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
vi.mock("../config.js", () => ({ config: { executionEnabled: true, clawpump: {}, jupiter: { apiUrl: "https://mock.invalid" } } }));
vi.mock("../clawpump/mcp.js", () => ({ clawpumpMcp: { call: vi.fn() } }));
vi.mock("../clawpump/market.js", () => ({ getBoard: vi.fn(), getHolders: vi.fn(), getOnchainMarket: vi.fn(), getTrenches: vi.fn(), trenchSorts: [] }));
vi.mock("../market/walletPortfolio.js", () => ({ walletPortfolio: vi.fn(async(walletAddress) => ({walletAddress,assets:[]})) }));
vi.mock("../lib/http.js", () => ({ errorMessage: String, fetchJson: vi.fn(async() => ({swapTransaction:"unsigned"})) }));
import { onchainRouter } from "./onchain";
import { clawpumpMcp } from "../clawpump/mcp";
import { fetchJson } from "../lib/http";
let server: Server, base: string;
const order = { inputMint: "So11111111111111111111111111111111111111112", outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", amount: "1000000000", slippageBps: 50, walletAddress: "9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump" };
beforeAll(async()=>{ const app=express();app.use(express.json());app.use(onchainRouter);server=app.listen(0,"127.0.0.1");await new Promise<void>(r=>server.once("listening",r));base=`http://127.0.0.1:${(server.address() as {port:number}).port}`; });
afterAll(()=>new Promise<void>(r=>server.close(()=>r())));
const post=(path:string,body:unknown)=>fetch(base+path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
it("rejects changed order without consuming quote, then builds matching order only once",async()=>{
 vi.mocked(clawpumpMcp.call).mockResolvedValue({ok:true,tool:"swap_quote",data:{...order,inAmount:order.amount,routePlan:[]}});
 const q=await (await post("/quote",order)).json();
 expect(q.expiresAt).toBeGreaterThan(Date.now());
 for(const change of [{amount:"99"},{slippageBps:500},{inputMint:order.outputMint},{outputMint:order.inputMint},{walletAddress:order.inputMint}]) {
  expect((await post("/transaction",{...order,...change,quoteId:q.quoteId})).status).toBe(409);
 }
 expect(fetchJson).not.toHaveBeenCalled();
 expect((await post("/transaction",{...order,quoteId:q.quoteId})).status).toBe(200);
 expect(fetchJson).toHaveBeenCalledTimes(1);
 expect((await post("/transaction",{...order,quoteId:q.quoteId})).status).toBe(409);
});
it("rejects an upstream quote for a different amount",async()=>{
 vi.mocked(clawpumpMcp.call).mockResolvedValue({ok:true,tool:"swap_quote",data:{...order,inAmount:"999",routePlan:[]}});
 expect((await post("/quote",order)).status).toBe(502);
});
it("portfolio does not call the private agent tool",async()=>{
 vi.mocked(clawpumpMcp.call).mockClear();
 expect(await (await fetch(base+"/portfolio/"+order.walletAddress)).json()).toMatchObject({walletAddress:order.walletAddress});
 expect(clawpumpMcp.call).not.toHaveBeenCalled();
});
