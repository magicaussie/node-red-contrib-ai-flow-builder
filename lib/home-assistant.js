"use strict";

const MAX_ENTITIES = 300;
const MAX_CONTEXT_CHARS = 40000;
const CACHE_TTL_MS = 5000;
const stateCache = new Map();
const DEFAULT_ALLOWED_SERVICES = ["light.turn_on", "light.turn_off", "switch.turn_on", "switch.turn_off", "scene.turn_on", "script.turn_on"];

function prepareConfig(configNode) {
  const baseUrl = String(configNode.baseUrl || "").replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(baseUrl)) throw new Error("Home Assistant URL must start with http:// or https://");
  const parsedUrl = new URL(baseUrl);
  if (parsedUrl.username || parsedUrl.password) throw new Error("Home Assistant URL must not contain credentials");
  const allowedHosts = String(configNode.allowedHosts || parsedUrl.hostname).split(",").map(value => value.trim().toLowerCase()).filter(Boolean);
  if (!allowedHosts.includes(parsedUrl.hostname.toLowerCase())) throw new Error("Home Assistant host is not in the allowlist");
  if (!configNode.credentials || !configNode.credentials.token) throw new Error("Home Assistant access token is not configured");
  return { baseUrl, parsedUrl };
}

async function requestHomeAssistant(configNode, endpoint, options = {}, signal) {
  const { baseUrl } = prepareConfig(configNode);
  const controller = new AbortController();
  const abortExternal = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", abortExternal, { once: true });
  }
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(`${baseUrl}${endpoint}`, {
      ...options,
      headers: { Authorization: `Bearer ${configNode.credentials.token}`, Accept: "application/json", ...(options.headers || {}) },
      signal: controller.signal,
      redirect: "error"
    });
    if (!response.ok) throw new Error(`Home Assistant returned HTTP ${response.status}`);
    return response;
  } catch (error) {
    if (error.name === "AbortError") throw new Error("request timed out");
    throw error;
  } finally {
    clearTimeout(timeout);
    if (signal) signal.removeEventListener("abort", abortExternal);
  }
}

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

async function fetchHomeAssistantStates(configNode, signal) {
  const { baseUrl } = prepareConfig(configNode);
  const domains = String(configNode.domains || "").split(",").map(value => value.trim()).filter(Boolean);
  const entityIds = Array.isArray(configNode.entityIds) ? configNode.entityIds.filter(Boolean) : [];
  const cacheKey = `${configNode.id || "default"}:${baseUrl}:${domains.join(",")}:${entityIds.join(",")}`;
  const cached = stateCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.snapshot;
  if (!configNode.credentials || !configNode.credentials.token) throw new Error("Home Assistant access token is not configured");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await requestHomeAssistant(configNode, "/api/states", {}, signal || controller.signal);
    const states = await response.json();
    if (!Array.isArray(states)) throw new Error("Home Assistant returned an invalid states response");
    const filtered = entityIds.length
      ? states.filter(entity => entityIds.includes(entity.entity_id))
      : domains.length
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

async function fetchHomeAssistantServices(configNode, signal) {
  const response = await requestHomeAssistant(configNode, "/api/services", {}, signal);
  const domains = await response.json();
  if (!Array.isArray(domains)) throw new Error("Home Assistant returned an invalid services response");
  const services = [];
  domains.forEach(entry => {
    Object.entries(entry.services || {}).forEach(([service, meta]) => {
      services.push({
        domain: entry.domain,
        service,
        name: (meta && meta.name) || service,
        description: (meta && meta.description) || ""
      });
    });
  });
  return services;
}

async function callHomeAssistantService(configNode, { domain, service, target, data }, signal) {
  const serviceName = `${domain}.${service}`.toLowerCase();
  const allowed = String(configNode.allowedServices || DEFAULT_ALLOWED_SERVICES.join(","))
    .split(",").map(value => value.trim().toLowerCase()).filter(Boolean);
  if (!/^[a-z0-9_]+$/.test(domain) || !/^[a-z0-9_]+$/.test(service)) throw new Error("Invalid Home Assistant service name");
  if (!allowed.includes(serviceName)) throw new Error(`Home Assistant service is not allowlisted: ${serviceName}`);
  const response = await requestHomeAssistant(configNode, `/api/services/${encodeURIComponent(domain)}/${encodeURIComponent(service)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target: target || {}, ...(data ? { data } : {}) })
  }, signal);
  return response.json();
}

module.exports = { fetchHomeAssistantStates, fetchHomeAssistantServices, callHomeAssistantService, prepareConfig, compactStates, MAX_ENTITIES, MAX_CONTEXT_CHARS, CACHE_TTL_MS, DEFAULT_ALLOWED_SERVICES };