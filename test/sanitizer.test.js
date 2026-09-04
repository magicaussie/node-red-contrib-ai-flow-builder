const assert = require("assert");
const { sanitizeFlows, REDACTED } = require("../lib/sanitizer");
const { buildSystemPrompt } = require("../lib/context-builder");
const { compactStates, MAX_ENTITIES, MAX_CONTEXT_CHARS } = require("../lib/home-assistant");
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
});
