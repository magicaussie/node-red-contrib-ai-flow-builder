const assert = require("assert");
const { sanitizeFlows, REDACTED } = require("../lib/sanitizer");
const { buildSystemPrompt } = require("../lib/context-builder");
const { compactStates, MAX_ENTITIES, MAX_CONTEXT_CHARS } = require("../lib/home-assistant");
const { prepareConfig, fetchHomeAssistantServices, callHomeAssistantService, listAllHomeAssistantEntities } = require("../lib/home-assistant");
const { limitMessages, MAX_HISTORY_MESSAGES, MAX_MESSAGE_CHARS } = require("../lib/context-budget");

describe("sanitizeFlows", () => {
  it("strips top-level sensitive keys", () => {
    const r = sanitizeFlows([{ id: "1", type: "inject", password: "p", apiKey: "k", x_api_key: "z" }]);
    assert.strictEqual(r[0].password, REDACTED);
    assert.strictEqual(r[0].apiKey, REDACTED);
    assert.strictEqual(r[0]["x_api_key"], REDACTED);
    assert.strictEqual(r[0].type, "inject");
  });

  it("strips nested credentials", () => {
    const r = sanitizeFlows([{ id: "1", type: "mqtt", credentials: { user: "u", password: "p" } }]);
    assert.strictEqual(r[0].credentials, REDACTED);
  });

  it("leaves env references intact (only names, not actual secrets)", () => {
    const url = "https://api.example.com/${env.SECRET}";
    const r = sanitizeFlows([{ id: "1", type: "x", url }]);
    assert.strictEqual(r[0].url, url);
  });

  it("removes ai-provider-config nodes entirely", () => {
    const r = sanitizeFlows([
      { id: "a", type: "ai-provider-config", apiKey: "secret" },
      { id: "b", type: "inject" }
    ]);
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].id, "b");
  });

  it("handles deeply nested arrays and objects", () => {
    const r = sanitizeFlows([{
      id: "1", type: "x",
      nested: { arr: [{ token: "t", ok: "keep" }] }
    }]);
    assert.strictEqual(r[0].nested.arr[0].token, REDACTED);
    assert.strictEqual(r[0].nested.arr[0].ok, "keep");
  });

  it("does not mutate the input", () => {
    const input = [{ id: "1", type: "x", password: "p" }];
    const copy = JSON.parse(JSON.stringify(input));
    sanitizeFlows(input);
    assert.deepStrictEqual(input, copy);
  });
});

describe("buildSystemPrompt", () => {
  it("includes Home Assistant entity context without connection secrets", () => {
    const prompt = buildSystemPrompt({
      homeAssistant: {
        states: [{ entity_id: "light.kitchen", state: "on", attributes: { friendly_name: "Kitchen" } }]
      }
    });
    assert.match(prompt, /light\.kitchen/);
    assert.match(prompt, /Kitchen/);
    assert.doesNotMatch(prompt, /token|Bearer|secret/i);
  });

  it("limits large Home Assistant snapshots", () => {
    const result = compactStates(Array.from({ length: MAX_ENTITIES + 50 }, (_, index) => ({
      entity_id: `sensor.test_${index}`,
      state: "0",
      attributes: { friendly_name: `Test ${index}` }
    })));
    assert.strictEqual(result.truncated, true);
    assert.ok(result.states.length <= MAX_ENTITIES);
    assert.ok(JSON.stringify(result.states).length <= MAX_CONTEXT_CHARS);
  });

  it("limits conversation history and message size", () => {
    const messages = Array.from({ length: MAX_HISTORY_MESSAGES + 3 }, (_, index) => ({
      role: "user", content: "x".repeat(MAX_MESSAGE_CHARS + 100), attachments: []
    }));
    const limited = limitMessages(messages);
    assert.strictEqual(limited.length, MAX_HISTORY_MESSAGES);
    assert.ok(limited.every(message => message.content.length <= MAX_MESSAGE_CHARS + 12));
  });

  it("keeps only explicitly selected flow nodes", () => {
    const prompt = buildSystemPrompt({
      nodeIds: ["keep"],
      flowJson: [{ type: "tab", id: "tab" }, { id: "keep", type: "inject" }, { id: "drop", type: "debug" }]
    });
    assert.match(prompt, /keep/);
    assert.doesNotMatch(prompt, /"drop"/);
  });

  it("includes real node type schemas so the AI stops guessing property names", () => {
    const prompt = buildSystemPrompt({
      typeSchemas: [{ type: "template", properties: ["name", "template"], required: ["template"] }]
    });
    assert.match(prompt, /Known node type schemas/);
    assert.match(prompt, /template: name, template \(required: template\)/);
  });

  it("includes captured runtime debug output for the AI to review after a test run", () => {
    const prompt = buildSystemPrompt({
      debugCapture: [{ name: "kitchen light debug", topic: "light.kitchen", payload: "on" }]
    });
    assert.match(prompt, /Captured debug output/);
    assert.match(prompt, /\[kitchen light debug\] topic=light\.kitchen: on/);
  });

  it("enforces the Home Assistant host allowlist", () => {
    assert.doesNotThrow(() => prepareConfig({
      baseUrl: "http://homeassistant.local:8123",
      allowedHosts: "homeassistant.local",
      credentials: { token: "x" }
    }));
    assert.throws(() => prepareConfig({
      baseUrl: "http://127.0.0.1:8123",
      allowedHosts: "homeassistant.local",
      credentials: { token: "x" }
    }), /allowlist/);
  });

  it("flattens Home Assistant services grouped by domain", async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      json: async () => ([
        { domain: "light", services: { turn_on: { name: "Turn on", description: "Turn on a light" } } },
        { domain: "switch", services: { turn_off: {} } }
      ])
    });
    try {
      const services = await fetchHomeAssistantServices({
        baseUrl: "http://homeassistant.local:8123",
        allowedHosts: "homeassistant.local",
        credentials: { token: "x" }
      });
      assert.deepStrictEqual(services.map(s => `${s.domain}.${s.service}`), ["light.turn_on", "switch.turn_off"]);
      assert.strictEqual(services[0].name, "Turn on");
      assert.strictEqual(services[1].name, "turn_off");
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("blocks Home Assistant service calls not selected for the conversation", async () => {
    await assert.rejects(
      () => callHomeAssistantService(
        { baseUrl: "http://homeassistant.local:8123", allowedHosts: "homeassistant.local", credentials: { token: "x" } },
        { domain: "light", service: "turn_on", target: { entity_id: "light.kitchen" }, allowedServices: [], allowedEntities: ["light.kitchen"] }
      ),
      /not selected/
    );
  });

  it("blocks Home Assistant service calls targeting an unselected entity", async () => {
    await assert.rejects(
      () => callHomeAssistantService(
        { baseUrl: "http://homeassistant.local:8123", allowedHosts: "homeassistant.local", credentials: { token: "x" } },
        { domain: "light", service: "turn_on", target: { entity_id: "light.bedroom" }, allowedServices: ["light.turn_on"], allowedEntities: ["light.kitchen"] }
      ),
      /Entity not selected/
    );
  });

  it("allows Home Assistant service calls when both service and entity are selected", async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => ({ ok: true, json: async () => ({ result: "ok" }) });
    try {
      const result = await callHomeAssistantService(
        { baseUrl: "http://homeassistant.local:8123", allowedHosts: "homeassistant.local", credentials: { token: "x" } },
        { domain: "light", service: "turn_on", target: { entity_id: "light.kitchen" }, allowedServices: ["light.turn_on"], allowedEntities: ["light.kitchen"] }
      );
      assert.deepStrictEqual(result, { result: "ok" });
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("lists every entity for the picker, unlike the capped prompt snapshot", async () => {
    const originalFetch = global.fetch;
    const bulk = Array.from({ length: MAX_ENTITIES + 50 }, (_, index) => ({
      entity_id: `sensor.filler_${index}`,
      state: "0",
      attributes: {}
    }));
    global.fetch = async () => ({
      ok: true,
      json: async () => [...bulk, { entity_id: "camera.front_door", state: "idle", attributes: { friendly_name: "Front Door" } }]
    });
    try {
      const entities = await listAllHomeAssistantEntities({
        baseUrl: "http://homeassistant.local:8123",
        allowedHosts: "homeassistant.local",
        credentials: { token: "x" }
      });
      assert.strictEqual(entities.length, bulk.length + 1);
      assert.ok(entities.some(entity => entity.entity_id === "camera.front_door"));
    } finally {
      global.fetch = originalFetch;
    }
  });
});
