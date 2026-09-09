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
    description: "Create a monitored or conditional trading rule proposal in Termeow. Read terminal state first, collect the target, time window, condition, and allocation, then open the passkey confirmation card. This tool cannot approve itself. Do not claim the strategy is armed until the client returns an approved state later.",
    parameters: objectParameters({
      strategy: scalar("string", "monitor_deployer or conditional_swap"), chain: scalar("string", "solana or robinhood"),
      target_address: scalar("string", "Exact deployer, funder, or token address to monitor"), token_symbol: scalar("string", "Related ticker without $"),
      side: scalar("string", "buy or sell at the trigger"), allocation_percent: scalar("number", "Percent of wallet allocated per execution, maximum 25"),
      duration_hours: scalar("number", "How long the rule remains active, maximum 720 hours"), condition: scalar("string", "Explicit machine-testable trigger in plain language"),
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
const guardrails = `\n\n${marker}\n- Call read_terminal_state before making any claim about the live chart or proposing a trade.\n- A spoken request is never approval. Use propose_swap or propose_automation to prepare a draft, then explicitly wait for the user to confirm the exact card with Privy passkey MFA.\n- Never claim a trade was sent or an automation was armed merely because a proposal tool succeeded.\n- Refuse to increase allocation beyond 25% per action. Restate chain, target, side, size, trigger and expiry before proposing.\n- Solana swaps use Jupiter by default; Robinhood Chain swaps use 0x.\n- Monitoring automations may be armed before unattended wallet execution is enabled; state that distinction accurately when reported by the tool.\n`;
const promptText = String(currentPrompt.prompt || "");
const knowledgeBase = [
  ...(currentPrompt.knowledge_base || []).filter((document) => document.id !== skill.id && document.name !== skillName),
  { type: "text", name: skillName, id: skill.id, usage_mode: "prompt" }
];
const nextPrompt = { ...currentPrompt, prompt: promptText.includes(marker) ? promptText : `${promptText}${guardrails}`, tool_ids: [...new Set([...(currentPrompt.tool_ids || []), ...toolIds])], knowledge_base: knowledgeBase };
delete nextPrompt.tools;
await request(`/agents/${agentId}`, { method: "PATCH", body: JSON.stringify({ conversation_config: { agent: { prompt: nextPrompt } }, version_description: "Register Termeow client tools and onchain trading skill" }) });
console.log(JSON.stringify({ agentId, skill: { name: skillName, id: skill.id, usageMode: "prompt" }, synced: definitions.map((item, index) => ({ name: item.name, id: toolIds[index] })) }, null, 2));
