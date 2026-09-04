"use strict";

const { sanitizeFlows } = require("./sanitizer");

const MAX_FLOW_CHARS = 50000;
const MAX_PALETTE_CHARS = 12000;

function limitArrayJson(items, maxChars) {
  const kept = [];
  for (const item of items) {
    const next = JSON.stringify([...kept, item]);
    if (next.length > maxChars) break;
    kept.push(item);
  }
  return { value: kept, truncated: kept.length < items.length };
}

const BASE_SYSTEM_PROMPT = `You are an AI assistant embedded in the Node-RED editor via the sidebar panel "AI Chat".

You have read-only access to the user's current flow JSON (sanitized — credentials and env references are redacted) and to the list of installed palette modules.

When you propose changes to the flows, wrap each change in a fenced code block using one of these language labels:

- \`\`\`json:flow:<tabId>\`\`\`      → JSON array of nodes to add/merge into that tab
- \`\`\`json:flow:new\`\`\`           → JSON array of nodes for a NEW tab
- \`\`\`json:node:<nodeId>\`\`\`       → partial JSON to patch an existing single node
- \`\`\`json:subflow:<id|new>\`\`\`    → JSON of a subflow
- \`\`\`json:delete\`\`\`              → JSON array of node (or tab) IDs to DELETE. Incoming wires pointing to deleted nodes are cleaned up automatically. Deleting a tab id also removes every node inside it.
- \`\`\`json:connect\`\`\`             → JSON array of edges \`[{ "from": "<srcId>", "port": 0, "to": "<dstId>" }, …]\`. ADDS wires without disturbing existing ones. Prefer this over editing the \`wires\` field of a node when you just want to link two nodes.
- \`\`\`json:disconnect\`\`\`          → same shape as json:connect, REMOVES the specified wires.
- \`\`\`json:ha-service\`\`\`       → a confirmed, allowlisted Home Assistant action: {"domain":"light","service":"turn_on","target":{"entity_id":"light.kitchen"},"data":{}}.

Each block gets its own Copy and Apply buttons in the UI. The user can accept, reject, or preview each independently.

Node JSON must follow Node-RED's flow format (id, type, z, wires, x, y, etc.). Prefer reusing already-installed palette modules listed in the context.

For normal prose or explanations just write markdown as usual — those blocks only get a Copy button.`;

/**
 * Build the system prompt string sent to the LLM.
 * @param {object} ctx
 * @param {string} ctx.activeTabId
 * @param {Array} ctx.flowJson    — full flow JSON (array of node objects)
 * @param {Array<string>} ctx.extraTabIds
 * @param {Array<{module:string,version:string}>} ctx.palette
 * @param {Array<string>} ctx.nodeIds
 * @param {{states?: Array, error?: string, note?: string}} ctx.homeAssistant
 */
function buildSystemPrompt(ctx = {}) {
  const selectedNodeIds = new Set(Array.isArray(ctx.nodeIds) ? ctx.nodeIds : []);
  const flowInput = Array.isArray(ctx.flowJson) ? ctx.flowJson : [];
  const selectedFlow = selectedNodeIds.size
    ? flowInput.filter(node => node && (node.type === "tab" || selectedNodeIds.has(node.id)))
    : flowInput;
  const flowResult = limitArrayJson(sanitizeFlows(selectedFlow), MAX_FLOW_CHARS);
  const sanitized = flowResult.value;
  const paletteLines = (ctx.palette || []).map(p => {
    const head = `- ${p.module}${p.version ? "@" + p.version : ""}${p.core ? " (core)" : ""}`;
    const types = (p.types || []).length ? ` → ${p.types.join(", ")}` : "";
    return head + types;
  });
  const paletteResult = limitArrayJson(paletteLines, MAX_PALETTE_CHARS);
  const palette = paletteResult.value.join("\n");
  const tabs = [ctx.activeTabId, ...(ctx.extraTabIds || [])].filter(Boolean).join(", ");
  const homeAssistant = ctx.homeAssistant;
  const homeAssistantText = homeAssistant
    ? homeAssistant.error
      ? homeAssistant.error
      : JSON.stringify({
        entities: homeAssistant.states || [],
        ...(homeAssistant.note ? { note: homeAssistant.note } : {})
      }, null, 2)
    : "Not connected for this message.";

  return [
    BASE_SYSTEM_PROMPT,
    "",
    `Active tab: ${ctx.activeTabId || "(none)"}`,
    `Tabs in context: ${tabs || "(none)"}`,
    flowResult.truncated ? "Flow context note: flow JSON was truncated to fit the request budget." : "",
    "",
    "# Available node types (module → types; `core` means built into Node-RED itself)",
    paletteResult.truncated ? `${palette}\n- [palette truncated]` : (palette || "(none reported)"),
    "",
    "# Current flow JSON (sanitized)",
    "```json",
    JSON.stringify(sanitized, null, 2),
    "```",
    "",
    "# Home Assistant entities (read-only snapshot)",
    "```json",
    homeAssistantText,
    "```"
  ].join("\n");
}

module.exports = { buildSystemPrompt, BASE_SYSTEM_PROMPT, MAX_FLOW_CHARS, MAX_PALETTE_CHARS, limitArrayJson };
