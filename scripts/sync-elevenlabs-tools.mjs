import "dotenv/config";
import { readFile } from "node:fs/promises";
import { clawpumpAgentTools } from "../shared/clawpumpAgentTools.mjs";

const apiKey = process.env.ELEVENLABS_API_KEY;
const agentId = process.env.ELEVENLABS_AGENT_ID;
if (!apiKey || !agentId) throw new Error("ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID are required");
const headers = { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "application/json" };
const base = "https://api.elevenlabs.io/v1/convai";
const skillName = "Termeow Onchain Trading Skill";
const skillText = await readFile(new URL("../docs/elevenlabs/onchain-trading-skill.md", import.meta.url), "utf8");

async function request(path, init = {}) {
  const response = await fetch(`${base}${path}`, { ...init, headers: { ...headers, ...(init.headers || {}) } });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${init.method || "GET"} ${path} failed (${response.status}): ${JSON.stringify(body).slice(0, 1200)}`);
  return body;
}
const scalar = (type, description) => ({ type, description });
const objectParameters = (properties = {}, required = []) => ({ type: "object", description: "Tool arguments", properties, required });
const definitions = [
  ...clawpumpAgentTools.map(({ upstream, ...definition }) => definition),
  {
    name: "read_terminal_state",
    description: "Read the focused Termeow token and fetch fresh market, candle, liquidity, flow, and recent-rally structure evidence directly through Termeow's gateway. This works on both the terminal and standalone agent page; it never requires the terminal chart to be open. Use chart.structure instead of asking the user for visible swing values.",
    parameters: objectParameters()
  },
  {
    name: "resolve_trader_handle",
    description: "Resolve an indexed Fomo handle such as frankdegods to its exact locally stored Solana and/or Robinhood wallets. Call this before proposing a wallet-tracking automation when the user gives a name rather than an address. This reads Termeow's gateway database and spends no FomoScan credits. Never guess on a miss or ambiguous result.",
    parameters: objectParameters({ handle: scalar("string", "Fomo handle, with or without @"), chain: scalar("string", "Optional solana or robinhood filter") }, ["handle"])
  },
  {
    name: "resolve_token",
    description: "Resolve a ticker, token name, or contract address against Termeow's local indexed token catalog. Use this when the user names a token but no exact contract is in context. It spends no upstream API credits. Use the returned chain and address; if ambiguous, ask the user to choose and never guess.",
    parameters: objectParameters({ query: scalar("string", "Ticker such as ANSEM or CASHCAT, token name, or exact contract address"), chain: scalar("string", "Optional solana or robinhood filter") }, ["query"])
  },
  {
    name: "analyze_token",
    description: "Fetch fresh token market, candles, liquidity, volume, price structure, flow, large prints, and Fomo activity directly from Termeow's chain/API gateway. Use after resolving a named token. This works on the standalone agent page and does not require the terminal chart to be open.",
    parameters: objectParameters({ query: scalar("string", "Ticker, token name, or contract address"), chain: scalar("string", "Optional solana or robinhood"), token_address: scalar("string", "Exact contract when already known"), token_symbol: scalar("string", "Ticker when known"), timeframe: scalar("string", "1m, 5m, 15m, 1h, 4h, or 1d") })
  },
  {
    name: "inspect_large_orders",
    description: "Fetch and display the filtered large-order tape for a token directly from Termeow's onchain flow gateway. Use for questions like big buys in the last 15 minutes. Opens a live widget with the same filters. Do not describe this DEX trade tape as a centralized limit order book.",
    parameters: objectParameters({ query: scalar("string", "Ticker, token name, or contract address"), chain: scalar("string", "Optional solana or robinhood"), token_address: scalar("string", "Exact contract when known"), token_symbol: scalar("string", "Ticker when known"), window_minutes: scalar("number", "Lookback from 1 to 240 minutes; default 15"), min_usd: scalar("number", "Minimum USD order size; minimum 1000"), side: scalar("string", "Optional buy or sell") })
  },
  {
    name: "analyze_wallet",
    description: "Analyze a supplied Solana or Robinhood wallet directly using chain portfolio data plus Termeow's local Fomo identity and recent-order gateway. Exact wallet addresses belong in tool arguments and UI, never spoken aloud.",
    parameters: objectParameters({ wallet_address: scalar("string", "Exact Solana or EVM wallet address"), chain: scalar("string", "Optional solana or robinhood") }, ["wallet_address"])
  },
  {
    name: "show_handle_picker",
    description: "Open the searchable tracked-Fomo-handle directory on the left when a person or handle is ambiguous, unknown, or the user asks to browse tracked traders. Let the user choose; do not guess identity.",
    parameters: objectParameters({ query: scalar("string", "Optional partial name or handle to prefill") })
  },
  {
    name: "read_automation_preferences",
    description: "Read the logged-in user's learned wallet-tracking preferences, including frequently tracked handles and default allocation, slippage, and duration. Use this to personalize a proposal without overriding explicit instructions.",
    parameters: objectParameters()
  },
  {
    name: "read_user_memory",
    description: "Refresh the logged-in user's private Termeow memory for this conversation: favorite and frequently tracked traders, regular tokens, trade defaults, and the latest completed trade. Use when the user asks what you remember or when fresh personalization would help. Explicit current instructions always win.",
    parameters: objectParameters()
  },
  {
    name: "update_automation_preferences",
    description: "Update explicit automation defaults after the user asks to remember them. Frequently tracked handles are learned automatically when a proposal is created. Never infer a riskier default from one trade.",
    parameters: objectParameters({ default_allocation_percent: scalar("number", "Default wallet allocation, maximum 25"), default_slippage_bps: scalar("number", "Default maximum slippage in basis points, 1-500"), default_duration_hours: scalar("number", "Default tracker lifetime, maximum 720 hours") })
  },
  {
    name: "propose_swap",
    description: "Create a non-executing swap proposal in the user's Termeow browser. Always call read_terminal_state first. This only opens an exact confirmation card; clearly tell the user the swap is pending and they must confirm with their Privy passkey. Never say it executed based on this tool response.",
    parameters: objectParameters({
      chain: scalar("string", "solana or robinhood; omit only when the selected chart makes it unambiguous"),
      token_address: scalar("string", "Exact token contract/mint; use the selected chart when appropriate"), token_symbol: scalar("string", "Ticker without $"),
      side: scalar("string", "buy or sell"), router: scalar("string", "jupiter for Solana or 0x for Robinhood"),
      amount_mode: scalar("string", "fixed or wallet_percent"), amount: scalar("string", "Human-readable funding-token amount when amount_mode is fixed"),
      allocation_percent: scalar("number", "Percent of the relevant wallet funding asset, maximum 25"), description: scalar("string", "Short plain-language action summary")
    }, ["side", "amount_mode", "description"])
  },
  {
    name: "propose_automation",
    description: "Create a monitored or conditional trading-rule draft and immediately open its editable confirmation overlay. Reuse indexed identities, the selected token, and saved user defaults instead of asking redundant questions. Supply explicit user constraints; omitted allocation, duration, and slippage use the user's saved defaults. This tool cannot approve itself or claim the rule is armed.",
    parameters: objectParameters({
      strategy: scalar("string", "monitor_wallet, monitor_deployer, monitor_x_launch, or conditional_swap"), chain: scalar("string", "solana or robinhood"),
      target_address: scalar("string", "Exact wallet address to monitor. Omit when tracked_wallet_username is supplied; the client resolves it from the indexed registry."),
      tracked_wallet_username: scalar("string", "Known Fomo, social, or terminal username tied to the tracked wallet; omit when unknown"),
      tracked_x_account: scalar("string", "X username to monitor for newly posted contract addresses when strategy is monitor_x_launch"),
      token_address: scalar("string", "Exact token contract/mint associated with the rule; use the selected chart when appropriate"),
      token_symbol: scalar("string", "Related ticker without $"),
      side: scalar("string", "buy or sell at the trigger"), allocation_percent: scalar("number", "Percent of wallet allocated per execution, maximum 25"),
      duration_hours: scalar("number", "How long the rule remains active, maximum 720 hours"), condition: scalar("string", "Explicit machine-testable trigger in plain language"),
      market_cap_min_usd: scalar("number", "Minimum token market cap in USD at which execution is allowed; omit for no lower bound"),
      market_cap_max_usd: scalar("number", "Maximum token market cap in USD at which execution is allowed; omit for no upper bound"),
      entry_price_tolerance_percent: scalar("number", "Maximum execution drift above the tracked trader's observed entry price, e.g. 25"),
      slippage_bps: scalar("number", "Maximum router slippage in basis points, 1-500"),
      exit_conditions: { type: "array", description: "Sell rules that remain dormant until the entry transaction is confirmed", items: { type: "object", properties: { id: scalar("string", "Stable short id"), type: scalar("string", "take_profit_pct, stop_loss_pct, trailing_stop_pct, market_cap, or custom"), value: scalar("number", "Numeric threshold when applicable"), condition: scalar("string", "Machine-testable sell trigger"), sell_percent: scalar("number", "Percent of acquired position to sell; all exits together max 100"), slippage_bps: scalar("number", "Exit slippage in basis points") }, required: ["type", "condition", "sell_percent"] } },
      description: scalar("string", "Concise summary shown on the passkey confirmation")
    }, ["strategy", "description"])
  },
  {
    name: "list_automations",
    description: "List this logged-in user's recent Termeow automation records and statuses. Use it to answer whether a proposal is pending, armed, executing, completed, cancelled, or failed.",
    parameters: objectParameters()
  },
  {
    name: "open_market_hud",
    description: "Open a compact live candle chart in the standalone Termeow interface. A known ticker or name is enough because Termeow resolves its indexed contract locally; pass an exact contract for unindexed or ambiguous low-liquidity tokens. The surface becomes active context for later reads.",
    parameters: objectParameters({
      query: scalar("string", "Ticker or token name, such as ANSEM or CASHCAT"),
      chain: scalar("string", "Optional solana or robinhood filter"),
      token_address: scalar("string", "Exact token contract or mint address when known"),
      token_symbol: scalar("string", "Ticker without $ when known"),
      timeframe: scalar("string", "One of 1m, 5m, 15m, 1h, 4h, or 1d; default 5m")
    })
  },
  {
    name: "dismiss_agent_ui",
    description: "Close the currently spawned Termeow market HUD when the user asks to hide, close, or clear it.",
    parameters: objectParameters()
  }
];

const listed = await request("/tools");
const existing = Array.isArray(listed) ? listed : listed.tools || [];
const toolIds = [];
for (const definition of definitions) {
  const toolConfig = { type: "client", ...definition, expects_response: true, execution_mode: "immediate", response_timeout_secs: 30 };
  const match = existing.find((item) => item.tool_config?.name === definition.name);
  const tool = match
    ? await request(`/tools/${match.id}`, { method: "PATCH", body: JSON.stringify({ tool_config: toolConfig }) })
    : await request("/tools", { method: "POST", body: JSON.stringify({ tool_config: toolConfig }) });
  toolIds.push(tool.id);
}

const listedKnowledge = await request("/knowledge-base?page_size=100");
const documents = Array.isArray(listedKnowledge) ? listedKnowledge : listedKnowledge.documents || [];
const existingSkill = documents.find((document) => document.name === skillName);
const skill = existingSkill
  ? await request(`/knowledge-base/${existingSkill.id}`, { method: "PATCH", body: JSON.stringify({ name: skillName, content: skillText }) })
  : await request("/knowledge-base/text", { method: "POST", body: JSON.stringify({ name: skillName, text: skillText }) });

const agent = await request(`/agents/${agentId}`);
const currentPrompt = agent.conversation_config?.agent?.prompt || {};
const marker = "TERMEOW TERMINAL CONTROL PLANE";
const privateMemoryRule = "- The authenticated user's private memory is supplied as {{termeow_user_memory}}. Use it for pleasant, subtle continuity, but never expose internal user IDs, full wallet addresses, or claim a preference that is absent. Explicit current instructions always override memory. Call read_user_memory when a refresh is needed.\n";
const guardrails = `\n\n${marker}\n- On the standalone agent page, when the user names a token or asks to see its chart, call resolve_token and then open_market_hud. Established indexed tickers need no pasted contract. Never ask the user to open or change the main terminal chart.\n- Use analyze_token or read_terminal_state to fetch fresh candles, price, volume, liquidity, structure, and flow directly from Termeow's API/chain gateway. The standalone page is a first-class data surface. If one upstream provider is backing off but local/RPC evidence is present, use the evidence and do not claim Termeow lacks chart or flow access.\n- For questions about big buys or sells in a recent window, call inspect_large_orders with the requested side, window, and threshold; summarize the returned tape and let its widget show the rows.\n- For a supplied wallet, call analyze_wallet. When a named person does not resolve exactly, call show_handle_picker and ask the user to choose from the visible indexed directory; never infer identity.\n- When a user names a trader, call resolve_trader_handle before propose_automation. Use only the exact indexed wallet on the requested chain; never invent or cross chains.\n- Read automation preferences when they would reduce questions, but explicit instructions always win. Frequently used tracked handles are learned automatically.\n- A spoken request is never approval. Use propose_swap or propose_automation to prepare a draft, then explicitly wait for the user to edit and confirm the exact card with Privy passkey MFA.\n- Never claim a trade was sent or an automation was armed merely because a proposal tool succeeded.\n- Refuse to increase allocation beyond 25% per action. Restate chain, target wallet and known username, side, size, entry-price tolerance, slippage, market-cap range, trigger, linked exits, and expiry before proposing.\n- Treat a trigger as permission to re-evaluate, not permission to force a fill. Immediately before execution, refresh the quote and revalidate identity, market cap, liquidity, price tolerance, slippage, token safety, destination/program policy, and portfolio exposure; skip and record the failing gate when any bound is breached.\n- A linked sell condition must have activate_after=entry_confirmed and can use only the position acquired by that successful entry. Never arm exits after a reverted or failed buy. Total linked sell allocation cannot exceed 100%.\n- Express automation execution bounds as market cap in USD, except an explicitly requested maximum distance from a tracked trader's entry, which uses entry_price_tolerance_percent.\n- Solana swaps use Jupiter by default; Robinhood Chain swaps use 0x.\n- For Fibonacci requests, use chart.structure.recentRally from read_terminal_state. Do not ask for swing values when present. Copy its exact 0.618 level into the condition; default expiry to 24h for intraday or 72h for 4h/1d when omitted.\n- Monitoring automations may be armed before unattended wallet execution is enabled; state that distinction accurately when reported by the tool.\n- Use dismiss_agent_ui when asked to close the current surface. Never invent a contract address.\n`;
const voiceStyleMarker = "TERMEOW SPOKEN STYLE";
const voiceStyle = `\n\n${voiceStyleMarker}\n- Speak like a casual, sharp trading partner, not a formal analyst.\n- Default chart reads to 35-55 words and never exceed 70 unless the user asks for a deep dive.\n- Lead with bias and confidence, synthesize only the strongest evidence, give the key level and invalidation, then stop.\n- Preserve information by combining related facts into contrasts; do not recite screen fields one by one.\n- Use compact figures and trader-natural phrasing. Avoid filler, formal transitions, generic disclaimers, recaps, and offers to explain more.\n- In speech, round decimal values to at most four places and use compact units such as K, M, and B. Never read machine-precision numbers digit by digit.\n- Detect EVM and Solana wallet or contract addresses. Never pronounce an address aloud; say “the wallet”, “the contract”, or the token ticker instead. Keep the exact address only in tool arguments and confirmation UI.\n- Workflow speech must be extremely brief. Do not narrate tool calls or repeat every field. Ask only for genuinely missing required inputs, in one compact question. After a proposal succeeds, say only “Draft ready—review and confirm.” unless the user asks for instructions or rationale.\n- Never read an automation confirmation card aloud. Let the visual overlay carry its details while the user reviews or edits them.\n`;
const promptText = String(currentPrompt.prompt || "");
const knowledgeBase = [
  ...(currentPrompt.knowledge_base || []).filter((document) => document.id !== skill.id && document.name !== skillName),
  { type: "text", name: skillName, id: skill.id, usage_mode: "prompt" }
];
const controlPrompt = promptText.includes(marker)
  ? promptText.replace(new RegExp(`${marker}[\\s\\S]*?(?=\\n\\n${voiceStyleMarker}|$)`), guardrails.trim())
  : `${promptText}${guardrails}`;
const styledPrompt = controlPrompt.includes(voiceStyleMarker)
  ? controlPrompt.replace(new RegExp(`${voiceStyleMarker}[\\s\\S]*$`), voiceStyle.trim())
  : `${controlPrompt}${voiceStyle}`;
const nextPrompt = { ...currentPrompt, prompt: styledPrompt, tool_ids: [...new Set([...(currentPrompt.tool_ids || []), ...toolIds])], knowledge_base: knowledgeBase };
nextPrompt.prompt = nextPrompt.prompt.replace(`${marker}\n`, `${marker}\n${privateMemoryRule}`);
delete nextPrompt.tools;
await request(`/agents/${agentId}`, { method: "PATCH", body: JSON.stringify({ conversation_config: { agent: { prompt: nextPrompt, first_message: "{{termeow_greeting}}" } }, version_description: "Brief workflows, resilient direct data, ClawPump tools" }) });
console.log(JSON.stringify({ agentId, skill: { name: skillName, id: skill.id, usageMode: "prompt" }, synced: definitions.map((item, index) => ({ name: item.name, id: toolIds[index] })) }, null, 2));
