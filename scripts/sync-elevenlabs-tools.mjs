import "dotenv/config";
import { readFile } from "node:fs/promises";

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
  {
    name: "read_terminal_state",
    description: "Read the user's currently focused Termeow chart and terminal state. Call this before discussing current price, candles, indicators, order flow, market cap, support/resistance, or before proposing a trade. Treat the response as point-in-time data.",
    parameters: objectParameters()
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
    description: "Create a monitored or conditional trading rule proposal in Termeow. Read terminal state first, collect the tracked wallet, token, time window, exact condition, wallet allocation, and market-cap execution range, then open the passkey confirmation card. This tool cannot approve itself. Do not claim the strategy is armed until the client returns an approved state later.",
    parameters: objectParameters({
      strategy: scalar("string", "monitor_deployer or conditional_swap"), chain: scalar("string", "solana or robinhood"),
      target_address: scalar("string", "Exact deployer or funded wallet address to monitor"),
      tracked_wallet_username: scalar("string", "Known Fomo, social, or terminal username tied to the tracked wallet; omit when unknown"),
      token_address: scalar("string", "Exact token contract/mint associated with the rule; use the selected chart when appropriate"),
      token_symbol: scalar("string", "Related ticker without $"),
      side: scalar("string", "buy or sell at the trigger"), allocation_percent: scalar("number", "Percent of wallet allocated per execution, maximum 25"),
      duration_hours: scalar("number", "How long the rule remains active, maximum 720 hours"), condition: scalar("string", "Explicit machine-testable trigger in plain language"),
      market_cap_min_usd: scalar("number", "Minimum token market cap in USD at which execution is allowed; omit for no lower bound"),
      market_cap_max_usd: scalar("number", "Maximum token market cap in USD at which execution is allowed; omit for no upper bound"),
      description: scalar("string", "Concise summary shown on the passkey confirmation")
    }, ["strategy", "allocation_percent", "duration_hours", "condition", "description"])
  },
  {
    name: "list_automations",
    description: "List this logged-in user's recent Termeow automation records and statuses. Use it to answer whether a proposal is pending, armed, executing, completed, cancelled, or failed.",
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
const guardrails = `\n\n${marker}\n- Call read_terminal_state before making any claim about the live chart or proposing a trade.\n- A spoken request is never approval. Use propose_swap or propose_automation to prepare a draft, then explicitly wait for the user to confirm the exact card with Privy passkey MFA.\n- Never claim a trade was sent or an automation was armed merely because a proposal tool succeeded.\n- Refuse to increase allocation beyond 25% per action. Restate chain, target wallet and known username, side, size, market-cap execution range, trigger and expiry before proposing.\n- Express automation execution bounds as market cap in USD, never token price. If the user gives no bound, state that the rule has no market-cap guardrail.\n- Solana swaps use Jupiter by default; Robinhood Chain swaps use 0x.\n- Monitoring automations may be armed before unattended wallet execution is enabled; state that distinction accurately when reported by the tool.\n`;
const voiceStyleMarker = "TERMEOW SPOKEN STYLE";
const voiceStyle = `\n\n${voiceStyleMarker}\n- Speak like a casual, sharp trading partner, not a formal analyst.\n- Default chart reads to 35-55 words and never exceed 70 unless the user asks for a deep dive.\n- Lead with bias and confidence, synthesize only the strongest evidence, give the key level and invalidation, then stop.\n- Preserve information by combining related facts into contrasts; do not recite screen fields one by one.\n- Use compact figures and trader-natural phrasing. Avoid filler, formal transitions, generic disclaimers, recaps, and offers to explain more.\n`;
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
delete nextPrompt.tools;
await request(`/agents/${agentId}`, { method: "PATCH", body: JSON.stringify({ conversation_config: { agent: { prompt: nextPrompt } }, version_description: "Enrich Termeow automation context and execution bounds" }) });
console.log(JSON.stringify({ agentId, skill: { name: skillName, id: skill.id, usageMode: "prompt" }, synced: definitions.map((item, index) => ({ name: item.name, id: toolIds[index] })) }, null, 2));
