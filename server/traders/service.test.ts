import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { FlowPrint, TraderKind } from "../../shared/wire.js";
import { FlowLedger } from "../flow/ledger.js";
import { HANDLES_POPULATION, type HandleBookStats, type HandleEntry } from "./handles.js";
import { normalizeReceipt, type Receipt } from "./receipts.js";
import { DISCOVER_MAX_PENDING, SMART_POPULATION_LABEL, TraderService, dexFromPair, toSmartFill, type PrintMeta } from "./service.js";

const FIXTURES = new URL("./__fixtures__/", import.meta.url);
const NOW = 1_800_000_000_000;
const AVG_JOES = "0x06de9c48b1e639ed5c13ec8fbd4080a38e39f2d1";
const MEAD_GOD = "0xf89f3858bc7bac05a83ec284e3e9acdb58bf892a";
const USEROP = {
  tx: "0x51e1a0bca3072577dbd2f6ef85088f0462181d5676a70833a2fc2c66659d3d3f",
  token: "0x39dbed3a2bd333467115de45665cc57f813c4571",
  side: "sell" as const,
  amount: 1181251181251100000000n
};
const TRANSFER = { tx: "0x1a408fc334d5748a75528e30018c856b181b3fbd95e498b8446288a0288dfb72", token: "0x39dbed3a2bd333467115de45665cc57f813c4571", side: "buy" as const };
const BUNDLED = { tx: "0xc13a06f4f5a38e15dd345febf1c7ae586256f82e3d56d968b53fb3c74f720b07", token: "0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea", side: "buy" as const };

function receiptOf(file: string): Receipt {
  const raw = JSON.parse(readFileSync(new URL(file, FIXTURES), "utf8")) as { receipt: unknown };
  return normalizeReceipt(raw.receipt);
}

const RECEIPTS = new Map<string, Receipt>([
  [USEROP.tx, receiptOf("receipt-AvgJoesCrypto-51e1a0bc.json")],
  [TRANSFER.tx, receiptOf("receipt-MEADGod-1a408fc3.json")],
  [BUNDLED.tx, receiptOf("receipt-unipcs-c13a06f4.json")]
]);

class FakeReceipts {
  calls: string[] = [];
  constructor(private readonly hang = false) {}
  get(tx: string): Promise<Receipt | null> {
    this.calls.push(tx);
    if (this.hang) return new Promise(() => undefined);
    return Promise.resolve(RECEIPTS.get(tx.toLowerCase()) ?? null);
  }
  stats(): unknown {
    return { calls: this.calls.length };
  }
}

class FakeClassifier {
  calls: string[] = [];
  priorities: Array<"high" | "low"> = [];
  pending = 0;
  constructor(private readonly kinds: Record<string, TraderKind | null>) {}
  known: Record<string, TraderKind> = {};
  classify(address: string, opts: { priority?: "high" | "low" } = {}): Promise<TraderKind | null> {
    this.calls.push(address);
    this.priorities.push(opts.priority ?? "high");
    return Promise.resolve(this.kinds[address.toLowerCase()] ?? null);
  }
  peek(address: string): TraderKind | undefined {
    return this.known[address.toLowerCase()];
  }
  stats(): unknown {
    return { calls: this.calls.length, pending: this.pending };
  }
}

class FakeHandles {
  constructor(private readonly entries: Record<string, HandleEntry> = {}) {}
  get(address: string): HandleEntry | null {
    return this.entries[address.toLowerCase()] ?? null;
  }
  stats(): HandleBookStats {
    const status = { rows: 0, lastOkAt: null, lastError: null };
    return { entries: Object.keys(this.entries).length, population: HANDLES_POPULATION, nansen: { ...status, configured: false }, watchlist: 0, learned: 0 };
  }
}

function print(tx: string, side: FlowPrint["side"], pair = "0xPOOL", chain: FlowPrint["chain"] = "monad"): FlowPrint {
  return { chain, pair, tx, time: NOW - 1000, side, usd: 100, source: "own" };
}

const KINDS: Record<string, TraderKind | null> = { [AVG_JOES]: "smart", [MEAD_GOD]: "other" };
const AVG_JOES_HANDLE: HandleEntry = { handle: "AvgJoesCrypto", followers: 1200, profileUrl: "https://app.nansen.ai/profiler?chain=monad&address=AvgJoesCrypto", source: "nansen" };

function harness(opts: { hang?: boolean; kinds?: Record<string, TraderKind | null>; now?: () => number; discoverCap?: number } = {}) {
  const receipts = new FakeReceipts(opts.hang);
  const classifier = new FakeClassifier(opts.kinds ?? KINDS);
  const handles = new FakeHandles({ [AVG_JOES]: AVG_JOES_HANDLE });
  const log = vi.fn();
  const service = new TraderService({ rpcUrl: "https://rpc.test", receipts, classifier, handles, now: opts.now ?? (() => NOW), deadlineMs: 30, discoverCap: opts.discoverCap, log });
  return { service, receipts, classifier, handles, log };
}

const metaOf =
  (token: string, amount?: bigint, trader?: string | null): ((print: FlowPrint) => PrintMeta | null) =>
  () => ({ token, dex: "uniswap", ...(amount === undefined ? {} : { amount }), ...(trader === undefined ? {} : { trader }) });

describe("TraderService.annotate", () => {
  it("resolves the EntryPoint fill through UserOperationEvent.sender, classifies it SMART and attaches the handle", async () => {
    const h = harness();
    const out = await h.service.annotate([print(USEROP.tx, USEROP.side)], { pools: ["0xPOOL"], meta: metaOf(USEROP.token, USEROP.amount) });
    expect(out[0].trader).toEqual({ address: AVG_JOES, kind: "smart", handle: "AvgJoesCrypto", followers: 1200 });
    expect(h.service.population.has(AVG_JOES)).toBe(true);
    expect(h.classifier.calls).toEqual([AVG_JOES]);
    expect(h.service.status().counters).toMatchObject({ annotated: 1, deadlined: 0 });
  });

  it("resolves a relay-B fill through the token Transfer endpoint; a non-SMART wallet is labelled other and never joins the population", async () => {
    const h = harness();
    const [out] = await h.service.annotate([print(TRANSFER.tx, TRANSFER.side)], { meta: metaOf(TRANSFER.token) });
    expect(out.trader).toEqual({ address: MEAD_GOD, kind: "other", handle: null, followers: null });
    expect(h.service.population.size).toBe(0);
  });

  it("refuses to guess on a bundled multi-trader tx without an amount hint", async () => {
    const h = harness();
    const [out] = await h.service.annotate([print(BUNDLED.tx, BUNDLED.side)], { meta: metaOf(BUNDLED.token) });
    expect(out.trader).toBeUndefined();
    expect(h.service.status().counters).toMatchObject({ ambiguous: 1, annotated: 0 });
    expect(h.classifier.calls).toEqual([]);
  });

  it("passes prints through unannotated once the deadline fires and counts them", async () => {
    const h = harness({ hang: true });
    const input = [print(USEROP.tx, USEROP.side), print(TRANSFER.tx, TRANSFER.side)];
    const out = await h.service.annotate(input, { meta: metaOf(USEROP.token) });
    expect(out.map((p) => p.trader)).toEqual([undefined, undefined]);
    expect(out.map((p) => p.tx)).toEqual(input.map((p) => p.tx));
    expect(h.service.status().counters.deadlined).toBe(2);
  });

  it("records a fill whose receipt lands after the deadline in the book and the SMART ledger; the returned print stays unannotated", async () => {
    const h = harness();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const eventual = h.receipts.get.bind(h.receipts);
    h.receipts.get = (tx) => gate.then(() => eventual(tx));
    const meta = metaOf(USEROP.token, USEROP.amount);
    const out = await h.service.annotate([print(USEROP.tx, USEROP.side)], { pools: ["0xPOOL"], meta });
    expect(out[0].trader).toBeUndefined();
    expect(h.service.record(out, meta)).toEqual({ smart: 0, other: 0 });
    expect(h.service.book.size().fills).toBe(0);
    expect(h.service.status().counters).toMatchObject({ deadlined: 1, late: 0, annotated: 0 });
    release();
    await vi.waitFor(() => expect(h.service.book.size().fills).toBe(1));
    expect(h.service.book.tape("all", 10, { kind: "smart" })).toMatchObject([{ trader: AVG_JOES, tx: USEROP.tx, token: USEROP.token, handle: "AvgJoesCrypto", kind: "smart" }]);
    expect(h.service.smartLedger.recentPrints("monad", "0xPOOL").map((p) => p.tx)).toEqual([USEROP.tx]);
    expect(h.service.population.has(AVG_JOES)).toBe(true);
    expect(h.service.status().counters).toMatchObject({ deadlined: 1, late: 1, annotated: 0 });
    h.service.record([{ ...out[0], trader: { address: AVG_JOES, kind: "smart", handle: "AvgJoesCrypto", followers: 1200 } }], meta);
    expect(h.service.book.size().fills).toBe(1);
    expect(h.service.smartLedger.recentPrints("monad", "0xPOOL")).toHaveLength(1);
  });

  it("classifies a wallet the log already names without touching receipts, and skips prints meta declares unattributable", async () => {
    const h = harness();
    const out = await h.service.annotate([print("0xcurve1", "buy", "pons:0xabc"), print("0xcurve2", "buy", "pons:0xabc")], {
      meta: (p) => (p.tx === "0xcurve1" ? { token: "0xTOKEN", dex: "pons", trader: AVG_JOES } : { token: "0xTOKEN", dex: "pons", trader: null })
    });
    expect(out[0].trader?.address).toBe(AVG_JOES);
    expect(out[1].trader).toBeUndefined();
    expect(h.receipts.calls).toEqual([]);
    expect(h.service.status().counters).toMatchObject({ unattributed: 1, annotated: 1 });
  });

  it("counts prints without meta and a failed classification, never throwing", async () => {
    const h = harness({ kinds: {} });
    const out = await h.service.annotate([print(USEROP.tx, USEROP.side), print("0xnometa", "buy")], { meta: (p) => (p.tx === USEROP.tx ? { token: USEROP.token, dex: "x" } : null) });
    expect(out.every((p) => p.trader === undefined)).toBe(true);
    expect(h.service.status().counters).toMatchObject({ noMeta: 1, classifyFailed: 1 });
  });
});

describe("TraderService.record", () => {
  const smartTrader = { address: AVG_JOES, kind: "smart" as const, handle: "AvgJoesCrypto", followers: 1200 };
  const otherTrader = { address: MEAD_GOD, kind: "other" as const, handle: null, followers: null };
  const meta = metaOf("0xTOKEN");

  it("routes SMART fills to the SMART ledger and book and keeps other-kind fills out unless asked", () => {
    const h = harness();
    const smart = { ...print("0xa", "buy"), trader: smartTrader };
    const other = { ...print("0xb", "sell"), trader: otherTrader };
    expect(h.service.record([smart, other, print("0xc", "buy")], meta)).toEqual({ smart: 1, other: 0 });
    expect(h.service.smartLedger.recentPrints("monad", "0xPOOL").map((p) => p.tx)).toEqual(["0xa"]);
    expect(h.service.book.size()).toEqual({ wallets: 1, fills: 1 });
    expect(h.service.book.tape("all", 10, { kind: "smart" })).toMatchObject([{ trader: AVG_JOES, token: "0xtoken", handle: "AvgJoesCrypto", kind: "smart" }]);
    expect(h.service.record([other], meta, { includeOther: true })).toEqual({ smart: 0, other: 1 });
    expect(h.service.book.size().wallets).toBe(2);
    expect(h.service.book.tape("all", 10, { kind: "smart" })).toHaveLength(1);
    expect(h.service.dexOf("monad", "0xPOOL")).toBe("uniswap");
  });

  it("derives a dex from a launchpad pseudo-pair when nothing was recorded", () => {
    expect(dexFromPair("pons:0xabc")).toBe("pons");
    expect(dexFromPair("0xabc")).toBe("");
    expect(harness().service.dexOf("monad", "flap:0x1")).toBe("flap");
  });
});

describe("TraderService.discover", () => {
  const wallets = ["0x1111111111111111111111111111111111111111", "0x2222222222222222222222222222222222222222", "0x3333333333333333333333333333333333333333", "0x4444444444444444444444444444444444444444", "0x5555555555555555555555555555555555555555"];

  it("classifies at most the per-minute cap of new senders, drops the rest, and resets on the next minute", async () => {
    let now = NOW;
    const h = harness({ discoverCap: 3, now: () => now, kinds: { [wallets[0]]: "smart", [wallets[1]]: "other", [wallets[2]]: "smart", [wallets[3]]: "smart" } });
    expect(await h.service.discover([...wallets, wallets[0].toUpperCase(), "not-an-address"])).toEqual({ checked: 3, dropped: 2, smart: 2 });
    expect(h.classifier.calls).toEqual(wallets.slice(0, 3));
    expect(await h.service.discover(wallets)).toEqual({ checked: 0, dropped: 2, smart: 0 });
    now += 60_000;
    expect(await h.service.discover(wallets)).toEqual({ checked: 2, dropped: 0, smart: 1 });
    expect(h.classifier.calls).toEqual(wallets);
    expect([...h.service.population.values()]).toHaveLength(3);
    expect(h.service.status()).toMatchObject({ population: { classified: 3, seeded: 0 }, populationLabel: SMART_POPULATION_LABEL, transfers: null, counters: { discoverChecked: 5, discoverDropped: 4 } });
  });

  it("answers a wallet the classifier already knows without a lookup", async () => {
    const h = harness({ kinds: {} });
    h.classifier.known[AVG_JOES] = "smart";
    const out = await h.service.annotate([print(USEROP.tx, USEROP.side)], { pools: ["0xPOOL"], meta: metaOf(USEROP.token, USEROP.amount) });
    expect(out[0].trader?.kind).toBe("smart");
    expect(h.classifier.calls).toEqual([]);
  });

  it("defers an unknown wallet instead of queueing behind a backed-up eth_getCode lane", async () => {
    const h = harness();
    h.classifier.pending = DISCOVER_MAX_PENDING;
    const out = await h.service.annotate([print(USEROP.tx, USEROP.side)], { pools: ["0xPOOL"], meta: metaOf(USEROP.token, USEROP.amount) });
    expect(out[0].trader).toBeUndefined();
    expect(h.classifier.calls).toEqual([]);
    expect(h.service.status().counters).toMatchObject({ classifyDeferred: 1, annotated: 0, deadlined: 0 });
  });

  it("classifies discovered senders on the low-priority lane while per-print lookups stay high", async () => {
    const h = harness({ discoverCap: 10, kinds: { [wallets[0]]: "smart" } });
    await h.service.discover([wallets[0]]);
    await h.service.annotate([print(USEROP.tx, USEROP.side)], { pools: ["0xPOOL"], meta: metaOf(USEROP.token, USEROP.amount) });
    expect(h.classifier.calls).toEqual([wallets[0], AVG_JOES]);
    expect(h.classifier.priorities).toEqual(["low", "high"]);
  });

  it("drops a discovery batch without spending budget while the classifier lane is already backed up", async () => {
    const h = harness({ discoverCap: 10, kinds: { [wallets[0]]: "smart" } });
    h.classifier.pending = DISCOVER_MAX_PENDING;
    expect(await h.service.discover([wallets[0], wallets[1]])).toEqual({ checked: 0, dropped: 2, smart: 0 });
    expect(h.classifier.calls).toEqual([]);
    h.classifier.pending = DISCOVER_MAX_PENDING - 1;
    expect(await h.service.discover([wallets[0], wallets[1]])).toEqual({ checked: 2, dropped: 0, smart: 1 });
  });

  it("forgets a sender whose lookup failed so it can be retried, and keeps SMART wallets bounded", async () => {
    const h = harness({ discoverCap: 10, kinds: {} });
    await h.service.discover([wallets[0]]);
    await h.service.discover([wallets[0]]);
    expect(h.classifier.calls).toEqual([wallets[0], wallets[0]]);
    const bounded = new TraderService({ rpcUrl: "https://rpc.test", receipts: new FakeReceipts(), classifier: new FakeClassifier({ [wallets[0]]: "smart", [wallets[1]]: "smart" }), handles: new FakeHandles(), populationMax: 1, now: () => NOW, log: vi.fn() });
    await bounded.discover([wallets[0], wallets[1]]);
    expect(bounded.population.size).toBe(1);
  });
});

describe("toSmartFill", () => {
  it("maps a book tape row onto the wire shape without inventing a symbol", () => {
    const fill = toSmartFill({ chain: "monad", trader: AVG_JOES, handle: "AvgJoesCrypto", kind: "smart", token: "0xt", pair: "0xp", tx: "0x1", side: "buy", usd: null, time: NOW, price: null }, "uniswap", 1200);
    expect(fill).toEqual({ chain: "monad", token: "0xt", pair: "0xp", dex: "uniswap", tx: "0x1", time: NOW, side: "buy", usd: null, trader: { address: AVG_JOES, kind: "smart", handle: "AvgJoesCrypto", followers: 1200 } });
    expect("symbol" in fill).toBe(false);
    expect(toSmartFill({ chain: "monad", trader: AVG_JOES, handle: null, kind: "smart", token: "0xt", pair: "0xp", tx: "0x1", side: "buy", usd: 1, time: NOW, price: null }, "", null, "MEME").symbol).toBe("MEME");
  });

  it("keeps a FlowLedger usable as the SMART ledger seam", () => {
    const ledger = new FlowLedger({ now: () => NOW });
    const service = new TraderService({ rpcUrl: "https://rpc.test", receipts: new FakeReceipts(), classifier: new FakeClassifier({}), handles: new FakeHandles(), smartLedger: ledger, now: () => NOW, log: vi.fn() });
    expect(service.smartLedger).toBe(ledger);
  });
});
