"use strict";

const MAX_ENTITIES = 300;
const MAX_CONTEXT_CHARS = 40000;

function compactStates(states) {
  const compact = [];
  for (const entity of states) {
    const candidate = {
      entity_id: entity.entity_id,
      state: entity.state,
      attributes: {
        friendly_name: entity.attributes && entity.attributes.friendly_name,
        unit_of_measurement: entity.attributes && entity.attributes.unit_of_measurement,
        device_class: entity.attributes && entity.attributes.device_class
      },
      last_changed: entity.last_changed
    };
    const next = [...compact, candidate];
    if (compact.length >= MAX_ENTITIES || JSON.stringify(next).length > MAX_CONTEXT_CHARS) break;
    compact.push(candidate);
  }
  return {
    states: compact,
    truncated: compact.length < states.length
  };
}

async function fetchHomeAssistantStates(configNode) {
  const baseUrl = String(configNode.baseUrl || "").replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(baseUrl)) throw new Error("Home Assistant URL must start with http:// or https://");
  if (!configNode.credentials || !configNode.credentials.token) throw new Error("Home Assistant access token is not configured");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(`${baseUrl}/api/states`, {
      headers: { Authorization: `Bearer ${configNode.credentials.token}`, Accept: "application/json" },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Home Assistant returned HTTP ${response.status}`);
    const states = await response.json();
    if (!Array.isArray(states)) throw new Error("Home Assistant returned an invalid states response");
    return compactStates(states);
  } catch (error) {
    if (error.name === "AbortError") throw new Error("request timed out");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { fetchHomeAssistantStates, compactStates, MAX_ENTITIES, MAX_CONTEXT_CHARS };