"use strict";

const MAX_ENTITIES = 300;
const MAX_CONTEXT_CHARS = 40000;
const CACHE_TTL_MS = 5000;
const stateCache = new Map();

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
  const parsedUrl = new URL(baseUrl);
  if (parsedUrl.username || parsedUrl.password) throw new Error("Home Assistant URL must not contain credentials");
  const domains = String(configNode.domains || "").split(",").map(value => value.trim()).filter(Boolean);
  const cacheKey = `${configNode.id || "default"}:${baseUrl}:${domains.join(",")}`;
  const cached = stateCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.snapshot;
  if (!configNode.credentials || !configNode.credentials.token) throw new Error("Home Assistant access token is not configured");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(`${baseUrl}/api/states`, {
      headers: { Authorization: `Bearer ${configNode.credentials.token}`, Accept: "application/json" },
      signal: controller.signal,
      redirect: "error"
    });
    if (!response.ok) throw new Error(`Home Assistant returned HTTP ${response.status}`);
    const states = await response.json();
    if (!Array.isArray(states)) throw new Error("Home Assistant returned an invalid states response");
    const filtered = domains.length
      ? states.filter(entity => domains.includes(String(entity.entity_id || "").split(".")[0]))
      : states;
    const snapshot = compactStates(filtered);
    stateCache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, snapshot });
    return snapshot;
  } catch (error) {
    if (error.name === "AbortError") throw new Error("request timed out");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { fetchHomeAssistantStates, compactStates, MAX_ENTITIES, MAX_CONTEXT_CHARS, CACHE_TTL_MS };