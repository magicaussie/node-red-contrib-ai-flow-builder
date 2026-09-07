const assert = require("assert");
const express = require("express");
const request = require("supertest");
const fs = require("fs");
const os = require("os");
const path = require("path");
const registerAiChat = require("../nodes/ai-chat");

describe("AI Chat HTTP routes", () => {
  let app;
  let userDir;
  let provider;

  beforeEach(() => {
    userDir = fs.mkdtempSync(path.join(os.tmpdir(), "nrafb-http-"));
    provider = { id: "provider", type: "ai-provider-config", provider: "openai" };
    app = express();
    const nodes = {
      eachNode(callback) { callback(provider); },
      getNode(id) { return id === provider.id ? provider : null; }
    };
    const RED = {
      settings: { userDir },
      httpAdmin: app,
      auth: { needsPermission: () => (req, res, next) => next() },
      nodes
    };
    registerAiChat(RED);
  });

  afterEach(() => fs.rmSync(userDir, { recursive: true, force: true }));

  it("creates, lists, exports, and deletes conversations", async () => {
    const created = await request(app)
      .post("/ai-flow-builder/conversations")
      .send({ title: "Route test" })
      .expect(200);
    assert.strictEqual(created.body.title, "Route test");

    const listed = await request(app).get("/ai-flow-builder/conversations").expect(200);
    assert.strictEqual(listed.body.length, 1);

    const exported = await request(app)
      .get(`/ai-flow-builder/conversations/${created.body.id}/export`)
      .expect(200);
    assert.strictEqual(exported.body.id, created.body.id);
    assert.match(exported.headers["content-disposition"], /attachment/);

    await request(app)
      .delete(`/ai-flow-builder/conversations/${created.body.id}`)
      .expect(200);
    assert.strictEqual((await request(app).get("/ai-flow-builder/conversations")).body.length, 0);
  });

  it("rejects invalid providers before opening an SSE stream", async () => {
    const created = await request(app).post("/ai-flow-builder/conversations").send({}).expect(200);
    const response = await request(app)
      .post(`/ai-flow-builder/conversations/${created.body.id}/messages`)
      .send({ content: "hello", providerId: "missing" })
      .expect(400);
    assert.strictEqual(response.body.error, "invalid providerId");
  });

  it("validates message size before persistence", async () => {
    const created = await request(app).post("/ai-flow-builder/conversations").send({}).expect(200);
    await request(app)
      .post(`/ai-flow-builder/conversations/${created.body.id}/messages`)
      .send({ content: "x".repeat(50001), providerId: "provider" })
      .expect(400);
  });

  it("returns provider failures as an SSE error event", async () => {
    provider.provider = "unsupported";
    const created = await request(app).post("/ai-flow-builder/conversations").send({}).expect(200);
    const response = await request(app)
      .post(`/ai-flow-builder/conversations/${created.body.id}/messages`)
      .send({ content: "hello", providerId: "provider" })
      .expect(200);
    assert.match(response.headers["content-type"], /text\/event-stream/);
    assert.match(response.text, /event: error/);
    assert.match(response.text, /unknown provider/);
  });

  it("creates, lists, and fetches AI flow backups", async () => {
    const created = await request(app)
      .post("/ai-flow-builder/backups")
      .send({ conversationId: "conv1", reason: "test", flowJson: [{ id: "n1", type: "inject" }] })
      .expect(200);
    assert.strictEqual(created.body.nodeCount, 1);

    const listed = await request(app).get("/ai-flow-builder/backups").expect(200);
    assert.strictEqual(listed.body.length, 1);
    assert.strictEqual(listed.body[0].id, created.body.id);

    const fetched = await request(app).get(`/ai-flow-builder/backups/${created.body.id}`).expect(200);
    assert.strictEqual(fetched.body.flowJson[0].id, "n1");
  });

  it("records and lists audit events", async () => {
    await request(app)
      .post("/ai-flow-builder/audit")
      .send({ type: "apply", detail: "unit-test" })
      .expect(200);

    const listed = await request(app).get("/ai-flow-builder/audit").expect(200);
    assert.strictEqual(listed.body[0].type, "apply");
    assert.strictEqual(listed.body[0].detail, "unit-test");
  });
});
