import { getAccessToken, usePrivy, useWallets as useEvmWallets } from "@privy-io/react-auth";
import { AnimatePresence, motion, useDragControls } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import type { AutomationChain, AutomationIntent, AutomationRecord, UserAutomationPreferences } from "../../shared/automation";
import { api } from "../api/client";
import { AuthControls } from "../auth/AuthControls";
import { hasPrivy } from "../auth/WalletProviders";
import { AsciiPersona } from "../features/standalone-agent/AsciiPersona";
import { AgentConnectionCat } from "../features/standalone-agent/AgentConnectionCat";
import { AgentDock, type AgentDockView } from "../features/standalone-agent/AgentDock";
import { AgentVolumeSlider } from "../features/standalone-agent/AgentVolumeSlider";
import { AgentCredits } from "../features/standalone-agent/AgentCredits";
import { AgentChatActivity, MatrixActivityIcon, TypewriterText } from "../features/standalone-agent/AgentChatActivity";
import { AgentSignalRail } from "../features/standalone-agent/AgentSignalRail";
import { HandlePicker } from "../features/standalone-agent/HandlePicker";
import { MarketHud } from "../features/standalone-agent/MarketHud";
import { OrderFlowHud } from "../features/standalone-agent/OrderFlowHud";
import { TokenPicker } from "../features/standalone-agent/TokenPicker";
import { TokenLogo } from "../features/standalone-agent/TokenLogo";
import { useAgent } from "../features/voice-agent/context/AgentProvider";
import { useAgentStore } from "../features/voice-agent/store/agentStore";
import { AgentApproval, ApprovalEditor } from "../features/voice-agent/surfaces/AgentApproval";
import type { PublicConfig } from "../types";
import { AGENT_GREETINGS } from "../lib/agentMemory";
import "../components/agent-standalone.css";

type View = AgentDockView;

const promptSuggestions = ["Pull up the MON chart", "Set up an automated trade", "Teach me to trade better"];

const statusCopy: Record<string, string> = {
  dormant: "CHANNEL CLOSED", connecting: "TUNING CHANNEL", idle: "ONLINE", listening: "I'M LISTENING",
  thinking: "READING THE TAPE", speaking: "TERMEOW LIVE", executing: "EXECUTING", success: "DONE",
  warning: "CHECK THIS", error: "SIGNAL LOST"
};

type AutomationData = { records: AutomationRecord[]; error: string; loading: boolean };

function AutomationDataBridge({ onData }: { onData: (data: AutomationData) => void }) {
  const { authenticated } = usePrivy();
  useEffect(() => {
    if (!authenticated) { onData({ records: [], error: "", loading: false }); return; }
    let live = true;
    const load = async () => {
      try {
        const token = await getAccessToken();
        if (!token) return;
        const result = await api.automations(token);
        if (live) onData({ records: result.automations, error: "", loading: false });
      } catch (reason) { if (live) onData({ records: [], error: reason instanceof Error ? reason.message : String(reason), loading: false }); }
    };
    onData({ records: [], error: "", loading: true });
    void load();
    const timer = setInterval(load, 20_000);
    addEventListener("termeow:automation-approved", load);
    addEventListener("termeow:automations-changed", load);
    return () => { live = false; clearInterval(timer); removeEventListener("termeow:automation-approved", load); removeEventListener("termeow:automations-changed", load); };
  }, [authenticated, onData]);
  return null;
}

function AutomationList({ data }: { data: AutomationData }) {
  const { authenticated } = usePrivy();
  const [selected, setSelected] = useState<AutomationRecord | null>(null);
  const [draft, setDraft] = useState<AutomationIntent | null>(null);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    if (!selected) return;
    const fresh = data.records.find((record) => record.id === selected.id);
    if (!fresh) { setSelected(null); setDraft(null); return; }
    setSelected(fresh); setDraft(fresh.intent);
  }, [data.records, selected?.id]);
  const open = (record: AutomationRecord) => { setSelected(record); setDraft(record.intent); setMessage(""); setConfirmDelete(false); };
  const save = async () => {
    if (!selected || !draft) return;
    setWorking(true); setMessage("");
    try {
      const token = await getAccessToken();
      if (!token) throw new Error("Log in again to edit this automation.");
      const result = await api.reviseAutomation(token, selected.id, draft);
      setSelected(result.automation); setDraft(result.automation.intent); setMessage("SAVED · REAPPROVAL REQUIRED");
      dispatchEvent(new Event("termeow:automations-changed"));
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : String(reason)); }
    finally { setWorking(false); }
  };
  const remove = async () => {
    if (!selected) return;
    if (!confirmDelete) { setConfirmDelete(true); setMessage("PRESS DELETE AGAIN TO CONFIRM"); return; }
    setWorking(true); setMessage("");
    try {
      const token = await getAccessToken();
      if (!token) throw new Error("Log in again to delete this automation.");
      await api.deleteAutomation(token, selected.id);
      setSelected(null); setDraft(null); dispatchEvent(new Event("termeow:automations-changed"));
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : String(reason)); }
    finally { setWorking(false); }
  };
  if (!authenticated) return <p className="agent-empty">Log in to arm and review your rules.</p>;
  const { records, error, loading } = data;
  if (loading) return <p className="agent-empty">SYNCING RULES…</p>;
  if (error) return <p className="agent-empty danger">{error}</p>;
  if (!records.length) return <p className="agent-empty">No live rules yet. Ask me to watch a wallet or market setup.</p>;
  const detail = <AnimatePresence>{selected && draft ? <motion.div className="automation-detail-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
    <motion.section className="automation-detail" role="dialog" aria-modal="true" aria-label="Automation details" initial={{ opacity: 0, scale: .88, y: 24 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: .92, y: 14 }}>
      <header><span>AUTOMATION // {selected.status.replaceAll("_", " ")}</span><button type="button" onClick={() => setSelected(null)}>×</button></header>
      <strong>{draft.tokenSymbol ? `$${draft.tokenSymbol}` : draft.kind.replaceAll("_", " ")}</strong><p>{draft.description}</p>
      <div className="automation-detail-meta"><span>{draft.chain}</span><span>{draft.side || "watch"}</span><span>{draft.durationHours ? `${draft.durationHours}h window` : "no expiry"}</span></div>
      {draft.kind !== "transfer" ? <ApprovalEditor intent={draft} onChange={setDraft} /> : null}
      {message ? <p className="automation-detail-message">{message}</p> : null}
      <div className="automation-detail-actions"><button type="button" disabled={working || selected.status === "executing" || draft.kind === "transfer"} onClick={() => void save()}>{working ? "WORKING…" : "SAVE CHANGES"}</button><button className={confirmDelete ? "danger armed" : "danger"} type="button" disabled={working || selected.status === "executing"} onClick={() => void remove()}>{confirmDelete ? "CONFIRM DELETE" : "DELETE"}</button></div>
      <small>CREATED {new Date(selected.createdAt).toLocaleString()}</small>
    </motion.section>
  </motion.div> : null}</AnimatePresence>;
  return <><div className="standalone-rule-list">{records.slice(0, 8).map((record) => <button className="standalone-rule-card" type="button" key={record.id} onClick={() => open(record)}>
    <span className={`rule-state ${record.status}`}>{record.status.replaceAll("_", " ")}</span>
    <div className="rule-token"><TokenLogo symbol={record.intent.tokenSymbol} src={record.intent.tokenLogoUrl} /><strong>{record.intent.tokenSymbol ? `$${record.intent.tokenSymbol}` : record.intent.kind.replaceAll("_", " ")}</strong></div>
    <p>{record.intent.description}</p>
    <small>{record.intent.chain} · {record.intent.durationHours ? `${record.intent.durationHours}H` : "NO EXPIRY"} · EXPAND ↗</small>
  </button>)}</div>{createPortal(detail, document.body)}</>;
}

function AutomationSurface({ data }: { data: AutomationData }) {
  return hasPrivy ? <AutomationList data={data} /> : <p className="agent-empty">Privy is not configured in this build.</p>;
}

function PrivyPortfolio() {
  const { authenticated } = usePrivy();
  const { wallets: evmWallets } = useEvmWallets();
  type Row = { chain: string; symbol: string; imageUrl?: string | null; amount: number; value: number | null };
  type Linked = NonNullable<UserAutomationPreferences["linkedWallets"]>[number];
  const [rows, setRows] = useState<Row[]>([]);
  const [linkedWallets, setLinkedWallets] = useState<Linked[]>([]);
  const [linkedRows, setLinkedRows] = useState<Array<{ wallet: Linked; rows: Row[]; total: number }>>([]);
  const [showLink, setShowLink] = useState(false);
  const [linkAddress, setLinkAddress] = useState("");
  const [linkMessage, setLinkMessage] = useState("");
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!authenticated) { setRows([]); return; }
    let live = true;
    const requests = [
      evmWallets[0]?.address ? api.monadPortfolio(evmWallets[0].address).then((portfolio) => ({ chain: "MON", portfolio })) : null
    ].filter(Boolean) as Array<Promise<{ chain: string; portfolio: Awaited<ReturnType<typeof api.monadPortfolio>> }>>;
    Promise.allSettled(requests).then((results) => {
      if (!live) return;
      const fulfilled = results.filter((item): item is PromiseFulfilledResult<{ chain: string; portfolio: Awaited<ReturnType<typeof api.monadPortfolio>> }> => item.status === "fulfilled");
      setRows(fulfilled.flatMap(({ value }) => value.portfolio.assets.map((asset) => ({ chain: value.chain, symbol: asset.symbol, imageUrl: asset.imageUrl, amount: asset.amount, value: asset.valueUsd }))));
      setError(!fulfilled.length && requests.length ? "Portfolio data is temporarily unavailable." : "");
    });
    void getAccessToken().then(async (token) => {
      if (!token) return;
      const preferences = (await api.automationPreferences(token)).preferences;
      if (!live) return;
      const linked = preferences.linkedWallets || [];
      setLinkedWallets(linked);
      const results = await Promise.allSettled(linked.map(async (wallet) => {
        const portfolio = await api.monadPortfolio(wallet.address);
        const walletRows = portfolio.assets.map((asset) => ({ chain: "MON", symbol: asset.symbol, imageUrl: asset.imageUrl, amount: asset.amount, value: asset.valueUsd }));
        return { wallet, rows: walletRows, total: walletRows.reduce((sum, row) => sum + (row.value || 0), 0) };
      }));
      if (live) setLinkedRows(results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []));
    }).catch(() => undefined);
    return () => { live = false; };
  }, [authenticated, evmWallets[0]?.address]);
  const addLinkedWallet = async (event: React.FormEvent) => {
    event.preventDefault();
    const address = linkAddress.trim();
    const chain: AutomationChain | null = /^0x[a-fA-F0-9]{40}$/.test(address) ? "monad" : null;
    if (!chain) { setLinkMessage("ENTER A VALID 0x MONAD ADDRESS"); return; }
    if (linkedWallets.some((wallet) => wallet.address.toLowerCase() === address.toLowerCase())) { setLinkMessage("WALLET ALREADY LINKED"); return; }
    setLinking(true); setLinkMessage("VERIFYING WALLET…");
    try {
      const portfolio = await api.monadPortfolio(address);
      const token = await getAccessToken();
      if (!token) throw new Error("Log in again to link a wallet.");
      const wallet: Linked = { address, chain, addedAt: Date.now() };
      const next = [...linkedWallets, wallet];
      await api.updateAutomationPreferences(token, { linkedWallets: next });
      const walletRows = portfolio.assets.map((asset) => ({ chain: "MON", symbol: asset.symbol, imageUrl: asset.imageUrl, amount: asset.amount, value: asset.valueUsd }));
      setLinkedWallets(next);
      setLinkedRows((current) => [...current, { wallet, rows: walletRows, total: walletRows.reduce((sum, row) => sum + (row.value || 0), 0) }]);
      setLinkAddress(""); setShowLink(false); setLinkMessage("");
    } catch (reason) { setLinkMessage(reason instanceof Error ? reason.message : String(reason)); }
    finally { setLinking(false); }
  };
  if (!authenticated) return <div className="agent-portfolio"><strong>$0.00</strong><small>CONNECTED WALLET VALUE</small><p className="agent-empty">Log in to inspect your connected wallets.</p></div>;
  if (error) return <p className="agent-empty danger">{error}</p>;
  const total = rows.reduce((sum, row) => sum + (row.value || 0), 0);
  const funded = rows.filter((row) => row.amount > 0 || (row.value ?? 0) > 0).sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  return <div className="agent-portfolio"><strong>${total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong><small>CONNECTED WALLET VALUE</small>
    <div className="agent-portfolio-actions"><Link to="/onchain?view=portfolio">MANAGE</Link><button type="button" onClick={() => window.dispatchEvent(new CustomEvent("termeow:add-funds"))}>ADD FUNDS</button></div>
    {funded.slice(0, 5).map((row, index) => <article key={`${row.chain}:${row.symbol}:${index}`}><TokenLogo symbol={row.symbol} src={row.imageUrl} /><b>{row.symbol}</b><span>{row.amount.toLocaleString(undefined, { maximumFractionDigits: 4 })}</span><em>{row.value == null ? "—" : `$${row.value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`}</em></article>)}
    {!funded.length ? <p className="agent-empty">Wallet connected · no funded assets yet.</p> : null}{funded.length > 5 ? <Link className="agent-portfolio-expand" to="/onchain?view=portfolio">VIEW ALL {funded.length} ASSETS →</Link> : null}
    <div className="linked-wallets"><div className="linked-wallet-heading"><span>ADDITIONAL WALLETS</span><button type="button" aria-label="Link another wallet" onClick={() => { setShowLink((value) => !value); setLinkMessage(""); }}>+</button></div>
      <AnimatePresence>{showLink ? <motion.form className="wallet-link-popover" onSubmit={(event) => void addLinkedWallet(event)} initial={{ opacity: 0, y: -8, scale: .96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -6, scale: .97 }}><input value={linkAddress} onChange={(event) => setLinkAddress(event.target.value)} placeholder="0x MONAD ADDRESS" autoFocus /><button type="submit" disabled={linking || !linkAddress.trim()}>{linking ? "LINKING…" : "LINK WALLET"}</button>{linkMessage ? <small>{linkMessage}</small> : null}</motion.form> : null}</AnimatePresence>
      {linkedRows.map(({ wallet, rows: assets, total: linkedTotal }) => <section className="linked-wallet-card" key={`${wallet.chain}:${wallet.address}`}><header><b>{wallet.label || `${wallet.address.slice(0, 5)}…${wallet.address.slice(-4)}`}</b><em>${linkedTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</em></header>{assets.filter((asset) => asset.amount > 0 || (asset.value || 0) > 0).slice(0, 3).map((asset, index) => <article key={`${asset.symbol}:${index}`}><TokenLogo symbol={asset.symbol} src={asset.imageUrl} /><b>{asset.symbol}</b><span>{asset.amount.toLocaleString(undefined, { maximumFractionDigits: 4 })}</span><em>{asset.value == null ? "—" : `$${asset.value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`}</em></article>)}</section>)}
      {!linkedRows.length ? <small className="linked-wallet-empty">Link a read-only wallet to track its holdings separately.</small> : null}
    </div>
  </div>;
}

function PortfolioSurface() {
  return hasPrivy ? <PrivyPortfolio /> : <p className="agent-empty">Privy is not configured in this build.</p>;
}

function PrivyVoiceStart() {
  const { authenticated, login, ready } = usePrivy();
  const agent = useAgent();
  const connecting = agent.status === "connecting";
  return <button className="voice-main" data-tour="voice-start" type="button" disabled={!ready || connecting} onClick={() => authenticated ? void agent.start() : login()}>
    <span>◉</span>{connecting ? "TUNING…" : authenticated ? "TALK TO TERMEOW" : "LOG IN TO TALK"}
  </button>;
}

function VoiceStart() {
  const agent = useAgent();
  return hasPrivy ? <PrivyVoiceStart /> : <button className="voice-main" data-tour="voice-start" type="button" disabled={agent.status === "connecting"} onClick={() => void agent.start()}>
    <span>◉</span>{agent.status === "connecting" ? "TUNING…" : "TALK TO TERMEOW"}
  </button>;
}

type TutorialTarget = { selector: string; label: string; copy: string };
const AGENT_TUTORIAL: TutorialTarget[] = [
  { selector: '[data-tour="mode-toggle"]', label: "PERSONA / WORKSPACE", copy: "Switch the main display between Termeow and your live workspace." },
  { selector: '[data-tour="portfolio"]', label: "PORTFOLIO", copy: "Toggle your connected wallet and linked holdings window." },
  { selector: '[data-tour="automations"]', label: "AUTOMATIONS", copy: "Open the rules desk to inspect and manage automated trades." },
  { selector: '[data-tour="voice-start"]', label: "VOICE CHANNEL", copy: "Start a private voice session when you’re ready." }
];

function PrivyWelcomeTutorial() {
  const { authenticated, login, ready, user } = usePrivy();
  const [step, setStep] = useState<number | null>(null);
  const [rect, setRect] = useState<{ top: number; left: number; width: number; height: number }>();
  const tutorialKey = `termeow:agent-tutorial:${user?.id || "pending"}`;

  useEffect(() => {
    if (!ready || authenticated) return;
    const key = "termeow:privy-welcome-seen";
    if (localStorage.getItem(key)) return;
    localStorage.setItem(key, "true");
    const timer = window.setTimeout(() => void login(), 850);
    return () => window.clearTimeout(timer);
  }, [authenticated, login, ready]);

  useEffect(() => {
    if (!authenticated || !user?.id || localStorage.getItem(tutorialKey)) return;
    setStep(0);
  }, [authenticated, tutorialKey, user?.id]);

  useEffect(() => {
    if (step == null) return;
    const target = AGENT_TUTORIAL[step];
    const update = () => {
      const element = document.querySelector<HTMLElement>(target.selector);
      if (!element) { setRect(undefined); return; }
      const bounds = element.getBoundingClientRect();
      setRect({ top: bounds.top, left: bounds.left, width: bounds.width, height: bounds.height });
    };
    const advance = (event: PointerEvent) => {
      if (!(event.target as Element | null)?.closest(target.selector)) return;
      window.setTimeout(() => {
        if (step >= AGENT_TUTORIAL.length - 1) {
          localStorage.setItem(tutorialKey, "true");
          setStep(null);
        } else setStep(step + 1);
      }, 260);
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("pointerdown", advance, true);
    const timer = window.setInterval(update, 500);
    return () => { window.removeEventListener("resize", update); window.removeEventListener("pointerdown", advance, true); window.clearInterval(timer); };
  }, [step, tutorialKey]);

  if (step == null || !rect) return null;
  const item = AGENT_TUTORIAL[step];
  const tooltipTop = rect.top > 150 ? rect.top - 112 : rect.top + rect.height + 14;
  const finish = () => { localStorage.setItem(tutorialKey, "true"); setStep(null); };
  return createPortal(<div className="agent-tutorial" role="dialog" aria-label="Termeow tutorial">
    <motion.div className="agent-tutorial-focus" initial={{ opacity: 0, scale: .9 }} animate={{ opacity: 1, scale: 1, top: rect.top - 7, left: rect.left - 7, width: rect.width + 14, height: rect.height + 14 }} transition={{ type: "spring", stiffness: 320, damping: 28 }} />
    <motion.aside className="agent-tutorial-card" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0, top: tooltipTop, left: Math.min(window.innerWidth - 292, Math.max(12, rect.left + rect.width / 2 - 140)) }}>
      <header><span>QUICK TOUR · {step + 1}/{AGENT_TUTORIAL.length}</span><button type="button" onClick={finish}>SKIP</button></header>
      <strong>{item.label}</strong><p>{item.copy}</p><small>USE THE HIGHLIGHTED CONTROL TO CONTINUE</small>
    </motion.aside>
  </div>, document.body);
}

function PrivyTextWarmup() {
  const { authenticated, ready } = usePrivy();
  const agent = useAgent();
  const conversationId = useAgentStore((state) => state.conversationId);
  const warmed = useRef(false);
  useEffect(() => {
    if (!authenticated) { warmed.current = false; return; }
    if (!ready || conversationId || warmed.current) return;
    warmed.current = true;
    void agent.startText();
  }, [agent, authenticated, conversationId, ready]);
  return null;
}

export function AgentPage({ config }: { config: PublicConfig }) {
  const agent = useAgent();
  const transcript = useAgentStore((state) => state.transcript);
  const toolActivity = useAgentStore((state) => state.toolActivity);
  const conversationId = useAgentStore((state) => state.conversationId);
  const muted = useAgentStore((state) => state.muted);
  const pending = useAgentStore((state) => state.pendingApproval);
  const voiceError = useAgentStore((state) => state.error);
  const leftWidget = useAgentStore((state) => state.leftWidget);
  const setLeftWidget = useAgentStore((state) => state.setLeftWidget);
  const sessionMode = useAgentStore((state) => state.sessionMode);
  const [view, setView] = useState<View>("ask");
  const desktopRef = useRef<HTMLElement>(null);
  const leftWidgetDrag = useDragControls();
  const portfolioDrag = useDragControls();
  const automationDrag = useDragControls();
  const personaDrag = useDragControls();
  const personaStageRef = useRef<HTMLDivElement>(null);
  const [canvasMode, setCanvasMode] = useState<"persona" | "workspace">("persona");
  const [compactPersona, setCompactPersona] = useState(false);
  const [personaSize, setPersonaSize] = useState<{ width: number; height: number } | undefined>(undefined);
  const personaResize = useRef<{ x: number; y: number; width: number; height: number } | undefined>(undefined);
  const [text, setText] = useState("");
  const transcriptRef = useRef<HTMLDivElement>(null);
  const [portraitMinimized, setPortraitMinimized] = useState(false);
  const [showPortfolio, setShowPortfolio] = useState(true);
  const [showAutomations, setShowAutomations] = useState(false);
  const [automationCount, setAutomationCount] = useState(0);
  const [automationData, setAutomationData] = useState<AutomationData>({ records: [], error: "", loading: false });
  const receiveAutomationData = useCallback((data: AutomationData) => {
    setAutomationData(data);
    if (!data.loading) setAutomationCount(data.records.length);
  }, []);
  const [idleGreeting] = useState(() => AGENT_GREETINGS[Math.floor(Math.random() * AGENT_GREETINGS.length)]);
  const latest = useMemo(() => transcript.slice(-5), [transcript]);

  useEffect(() => {
    const element = transcriptRef.current;
    if (!element) return;
    requestAnimationFrame(() => { element.scrollTop = element.scrollHeight; });
  }, [agent.status, latest, toolActivity]);

  useEffect(() => {
    const stage = personaStageRef.current;
    if (!stage) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setCompactPersona(width < 540 || height < 270 || width * height < 175_000);
    });
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const start = personaResize.current;
      if (!start) return;
      const maxWidth = Math.max(440, window.innerWidth - 24);
      const maxHeight = Math.max(270, window.innerHeight - 250);
      setPersonaSize({
        width: Math.min(maxWidth, Math.max(440, start.width + event.clientX - start.x)),
        height: Math.min(maxHeight, Math.max(180, start.height + event.clientY - start.y))
      });
    };
    const stop = () => { personaResize.current = undefined; document.body.classList.remove("resizing-agent-canvas"); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", stop); window.removeEventListener("pointercancel", stop); };
  }, []);

  useEffect(() => {
    const selectPanel = (event: PointerEvent) => {
      const panel = (event.target as Element | null)?.closest<HTMLElement>("[data-agent-panel]");
      if (!panel) return;
      document.querySelectorAll("[data-agent-panel][data-panel-active]").forEach((item) => item.removeAttribute("data-panel-active"));
      panel.setAttribute("data-panel-active", "true");
    };
    document.addEventListener("pointerdown", selectPanel, true);
    return () => document.removeEventListener("pointerdown", selectPanel, true);
  }, []);

  useEffect(() => {
    document.body.classList.add("standalone-agent-body");
    agent.open("surface");
    return () => { document.body.classList.remove("standalone-agent-body"); agent.close(); };
  }, []); // The standalone route owns this hidden runtime surface.

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const message = text.trim();
    if (!message) return;
    if (await agent.sendText(message)) setText("");
  };

  return <main className={`agent-app status-${agent.status}`} ref={desktopRef}>
    {hasPrivy ? <><AutomationDataBridge onData={receiveAutomationData} /><PrivyTextWarmup /><PrivyWelcomeTutorial /></> : null}
    <div className="agent-crt" aria-hidden="true" />
    <header className="standalone-head">
      <Link className="standalone-brand" to="/agent"><span>TERMEOW</span><small>VOICE OS / 0.1</small></Link>
      <div className="agent-network"><i /> {config.network.toUpperCase()} INTELLIGENCE ONLINE</div>
      <div className="agent-head-actions"><AgentCredits /><Link to="/onchain">OPEN TERMINAL ↗</Link><AuthControls /></div>
    </header>

    <AgentSignalRail />
    <MarketHud />
    <OrderFlowHud />

    <section className="agent-command-deck">
      <div className="agent-left-widget-anchor">
        <AnimatePresence>{showPortfolio ? <motion.section data-agent-panel="portfolio" className="agent-left-widget agent-left-widget-portfolio" initial={{ opacity: 0, x: -28, scale: .86 }} animate={{ opacity: 1, x: 0, scale: 1 }} exit={{ opacity: 0, x: -18, scale: .92 }} transition={{ type: "spring", stiffness: 290, damping: 28 }} drag dragControls={portfolioDrag} dragListener={false} dragConstraints={desktopRef} dragMomentum={false} dragElastic={0.04} whileDrag={{ scale: 1.01 }}>
          <header className="desktop-window-handle" onPointerDown={(event) => portfolioDrag.start(event)}><span>CONNECTED PORTFOLIO</span><small>MOVE · RESIZE ↘</small><button type="button" onPointerDown={(event) => event.stopPropagation()} onClick={() => setShowPortfolio(false)}>×</button></header>
          <PortfolioSurface />
        </motion.section> : null}</AnimatePresence>
        <AnimatePresence>{showAutomations ? <motion.section data-agent-panel="automations" className="agent-left-widget agent-left-widget-automations" initial={{ opacity: 0, x: -28, scale: .86 }} animate={{ opacity: 1, x: 0, scale: 1 }} exit={{ opacity: 0, x: -18, scale: .92 }} transition={{ type: "spring", stiffness: 290, damping: 28 }} drag dragControls={automationDrag} dragListener={false} dragConstraints={desktopRef} dragMomentum={false} dragElastic={0.04} whileDrag={{ scale: 1.01 }}>
          <header className="desktop-window-handle" onPointerDown={(event) => automationDrag.start(event)}><span>AUTOMATION CONTROL</span><small>MOVE · RESIZE ↘</small><button type="button" onPointerDown={(event) => event.stopPropagation()} onClick={() => { setShowAutomations(false); if (view === "automations") setView("ask"); }}>×</button></header>
          <AutomationSurface data={automationData} />
        </motion.section> : null}</AnimatePresence>
        <AnimatePresence>{leftWidget && ["tokens", "handles"].includes(leftWidget.type) ? <motion.section data-agent-panel={leftWidget.type} className={`agent-left-widget agent-left-widget-${leftWidget.type}`} initial={{ opacity: 0, x: -28, scale: .86 }} animate={{ opacity: 1, x: 0, scale: 1 }} exit={{ opacity: 0, x: -18, scale: .92 }} transition={{ type: "spring", stiffness: 290, damping: 28 }} drag dragControls={leftWidgetDrag} dragListener={false} dragConstraints={desktopRef} dragMomentum={false} dragElastic={0.04} whileDrag={{ scale: 1.01 }}>
          <header className="desktop-window-handle" onPointerDown={(event) => leftWidgetDrag.start(event)}><span>{leftWidget.type === "tokens" ? "CHOOSE AN INDEXED TOKEN" : "CHOOSE A TRACKED HANDLE"}</span><small>MOVE · RESIZE ↘</small><button type="button" onPointerDown={(event) => event.stopPropagation()} onClick={() => setLeftWidget()}>×</button></header>
          {leftWidget.type === "tokens" ? <TokenPicker query={leftWidget.query} onChoose={(token) => { if (conversationId) agent.send(`Use the verified indexed ${token.chain} token $${token.symbol} at ${token.address}.`); setLeftWidget(); }} /> : leftWidget.type === "handles" ? <HandlePicker initialQuery={leftWidget.query} onChoose={(choice) => { if (conversationId) agent.send(`Use the labelled wallet ${choice.wallet} (${choice.label}).`); setLeftWidget(); }} /> : null}
        </motion.section> : null}</AnimatePresence>
      </div>

      <motion.section data-agent-panel="persona" className={`persona-console ${portraitMinimized ? "persona-minimized" : ""}`} style={{ width: personaSize?.width }} drag dragControls={personaDrag} dragListener={false} dragConstraints={desktopRef} dragMomentum={false} dragElastic={.025}>
        <div className="persona-stage" ref={personaStageRef} style={portraitMinimized ? undefined : { height: personaSize?.height }}>
          {canvasMode === "workspace" ? <div className="persona-workspace">
            <header><span>SESSION WORKSPACE</span><small>{conversationId ? "LINK ACTIVE" : "LOCAL STANDBY"}</small></header>
            <div className="persona-workspace-grid">
              <button type="button" onClick={() => setShowPortfolio(true)}><small>PORTFOLIO</small><strong>CONNECTED ASSETS</strong><span>OPEN WINDOW ↗</span></button>
              <button type="button" onClick={() => setShowAutomations(true)}><small>AUTOMATIONS</small><strong>{automationData.loading ? "SYNCING" : `${automationCount} RULE${automationCount === 1 ? "" : "S"}`}</strong><span>OPEN CONTROL ↗</span></button>
              <button type="button" onClick={() => setView("activity")}><small>TOOL STREAM</small><strong>{toolActivity.at(-1)?.name.replaceAll("_", " ") || "QUIET"}</strong><span>{toolActivity.at(-1)?.summary || "No active calls"}</span></button>
              <button type="button" onClick={() => setCanvasMode("persona")}><small>TERMEOW</small><strong>{statusCopy[agent.status]}</strong><span>RETURN TO PERSONA ↗</span></button>
            </div>
          </div> : agent.status === "connecting" || compactPersona ? <AgentConnectionCat /> : <AsciiPersona status={agent.status} />}
          <div className="persona-noise" aria-hidden="true" />
          <div className="persona-crt-glass" aria-hidden="true" />
          <button className="persona-minimize" type="button" aria-label={portraitMinimized ? "Restore Termeow portrait" : "Minimize Termeow portrait"} onClick={() => setPortraitMinimized((value) => !value)}>{portraitMinimized ? "□" : "─"}</button>
          <button className="persona-drag-handle" type="button" aria-label="Move agent canvas" onPointerDown={(event) => personaDrag.start(event)}>⠿</button>
          <div className="persona-mode-toggle" role="group" aria-label="Agent canvas mode">
            <button type="button" className={canvasMode === "persona" ? "active" : ""} aria-label="Show persona" aria-pressed={canvasMode === "persona"} onClick={() => setCanvasMode("persona")}><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M5 9 4 3l5 3a10 10 0 0 1 6 0l5-3-1 6v6c0 4-3 6-7 6s-7-2-7-6Z"/><path d="m8 13 2 1m6-1-2 1m-4 3h4"/></svg></button>
            <button type="button" data-tour="mode-toggle" className={canvasMode === "workspace" ? "active" : ""} aria-label="Show workspace" aria-pressed={canvasMode === "workspace"} onClick={() => setCanvasMode("workspace")}><svg aria-hidden="true" viewBox="0 0 24 24"><rect x="3" y="3" width="8" height="8"/><rect x="13" y="3" width="8" height="8"/><rect x="3" y="13" width="8" height="8"/><rect x="13" y="13" width="8" height="8"/></svg></button>
          </div>
          <span className="persona-mini-brand" aria-hidden="true">/\_/\\</span>
          {!portraitMinimized ? <button className="persona-resize-grip" type="button" aria-label="Resize agent canvas" onPointerDown={(event) => {
            event.preventDefault(); event.stopPropagation();
            const stage = personaStageRef.current?.getBoundingClientRect();
            if (!stage) return;
            personaResize.current = { x: event.clientX, y: event.clientY, width: stage.width + 14, height: stage.height };
            document.body.classList.add("resizing-agent-canvas");
          }}>⌟</button> : null}
        </div>
        <div className="voice-console">
          <div className="voice-status"><span>{["connecting", "thinking", "executing", "speaking"].includes(agent.status) ? <MatrixActivityIcon /> : <i />}<b>{statusCopy[agent.status]}</b></span><small>{conversationId ? "ENCRYPTED VOICE SESSION" : "MIC ACCESS ON START"}</small></div>
          {agent.status === "error" && voiceError && <p className="agent-voice-error" role="alert">VOICE LINK FAILED · {voiceError}</p>}
          <div className="agent-chat-preview">
            <div className="standalone-transcript" ref={transcriptRef} aria-live="polite">
              {latest.length ? latest.map((message, index) => <p key={message.id} className={message.role}><b>{message.role === "agent" ? "TM // OUT" : message.role === "user" ? "YOU" : "SYSTEM"}</b><TypewriterText text={message.text} animate={message.role === "agent" && index === latest.length - 1} /></p>) : <p className="system"><b>TM // OUT</b><span>{idleGreeting}</span></p>}
            </div>
            <AgentChatActivity status={agent.status} events={toolActivity} />
          </div>
          <div className="agent-prompt-chips" aria-label="Suggested prompts">{promptSuggestions.map((prompt) => <button key={prompt} type="button" onClick={() => conversationId ? agent.send(prompt) : setText(prompt)}>{prompt}</button>)}</div>
          <form onSubmit={(event) => void submit(event)}>
            <input value={text} onChange={(event) => setText(event.target.value)} placeholder={conversationId ? "MESSAGE TERMEOW…" : agent.status === "connecting" ? "OPENING TEXT CHANNEL…" : "TYPE TO START A PRIVATE CHAT…"} />
            <button type="submit" disabled={!text.trim() || agent.status === "connecting"}>SEND ↵</button>
          </form>
          <div className="standalone-voice-controls">
            {sessionMode !== "voice" ? <VoiceStart /> : <>
              <button type="button" onClick={() => agent.setMuted(!muted)}>{muted ? "UNMUTE MIC" : "MUTE MIC"}</button>
              <button className="voice-stop" type="button" onClick={agent.stop}>END CHANNEL</button>
            </>}
          </div>
        </div>
      </motion.section>

    </section>

    <section data-agent-panel="activity" className={`agent-drawer ${view !== "activity" ? "collapsed" : ""}`}>
      {view === "activity" && <><header><span>SESSION TAPE</span><small>CONVERSATION + TOOL EVIDENCE</small><button type="button" aria-label="Close activity" onClick={() => setView("ask")}>×</button></header><div className="tool-tape"><h3>TOOL EVIDENCE</h3>{toolActivity.length ? toolActivity.slice().reverse().map((event) => <article key={event.id} className={event.status}><time>{new Date(event.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time><div><b>{event.name.replaceAll("_", " ")}</b>{event.input && <small>{event.input}</small>}<span>{event.summary || "Working…"}</span></div></article>) : <p className="agent-empty">No tools used in this session.</p>}</div><div className="activity-tape">{transcript.length ? transcript.slice().reverse().map((message) => <p key={message.id}><time>{new Date(message.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time><b>{message.role}</b><span>{message.text}</span></p>) : <p className="agent-empty">No conversation yet.</p>}</div></>}
    </section>

    <AgentDock view={view} automationCount={automationCount} onPortfolio={() => setShowPortfolio((value) => !value)} onSelect={(item) => { setView(item); if (item === "automations") setShowAutomations((value) => !value); }} />
    <AgentVolumeSlider />

    {pending && <div className="standalone-approval-backdrop" role="presentation"><div className="standalone-approval-modal"><div className="approval-modal-label">ACTION REQUIRES YOU</div><AgentApproval /></div></div>}
  </main>;
}
