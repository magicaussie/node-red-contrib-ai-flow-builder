const path = require("path");
const express = require("express");
const multer = require("multer");
const fs = require("fs").promises;
const { Storage } = require("../lib/storage");
const { streamProvider } = require("../lib/providers");
const { buildSystemPrompt } = require("../lib/context-builder");
const { fetchHomeAssistantStates, fetchHomeAssistantServices, callHomeAssistantService, prepareConfig } = require("../lib/home-assistant");
const { limitMessages } = require("../lib/context-budget");

module.exports = function (RED) {
  const publicDir = path.join(__dirname, "..", "public");
  const storage = new Storage(RED.settings.userDir || process.cwd());

  if (!RED.httpAdmin._nrafbStaticMounted) {
    RED.httpAdmin.use("/ai-flow-builder/static", express.static(publicDir));
    RED.httpAdmin._nrafbStaticMounted = true;
  }

  const readPerm = RED.auth.needsPermission("flows.read");
  const writePerm = RED.auth.needsPermission("flows.write");

  RED.httpAdmin.get("/ai-flow-builder/providers", readPerm, (req, res) => {
    const providers = [];
    RED.nodes.eachNode(n => {
      if (n.type === "ai-provider-config") {
        providers.push({ id: n.id, label: n.name || n.label || `${n.provider}:${n.model}`, provider: n.provider, model: n.model });
      }
    });
    res.json(providers);
  });

  RED.httpAdmin.get("/ai-flow-builder/home-assistant", readPerm, (req, res) => {
    const configs = [];
    RED.nodes.eachNode(n => {
      if (n.type === "ai-home-assistant-config") {
        configs.push({ id: n.id, label: n.name || n.label || n.baseUrl });
      }
    });
    res.json(configs);
  });

  RED.httpAdmin.post("/ai-flow-builder/home-assistant/test", writePerm, express.json(), async (req, res) => {
    try {
      const config = {
        baseUrl: req.body && req.body.baseUrl,
        allowedHosts: req.body && req.body.allowedHosts,
        credentials: { token: req.body && req.body.token }
      };
      prepareConfig(config);
      const snapshot = await fetchHomeAssistantStates(config);
      res.json({ ok: true, entityCount: snapshot.states.length, truncated: snapshot.truncated });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });

  RED.httpAdmin.get("/ai-flow-builder/home-assistant/:id/entities", readPerm, async (req, res) => {
    const node = RED.nodes.getNode(req.params.id);
    if (!node || node.type !== "ai-home-assistant-config") return res.status(400).json({ error: "invalid homeAssistantId" });
    try {
      const snapshot = await fetchHomeAssistantStates(node);
      res.json(snapshot);
    } catch (error) { res.status(400).json({ error: error.message }); }
  });

  RED.httpAdmin.post("/ai-flow-builder/home-assistant/services", writePerm, express.json(), async (req, res) => {
    try {
      const node = req.body && req.body.id ? RED.nodes.getNode(req.body.id) : null;
      const config = (node && node.type === "ai-home-assistant-config") ? node : {
        baseUrl: req.body && req.body.baseUrl,
        allowedHosts: req.body && req.body.allowedHosts,
        credentials: { token: req.body && req.body.token }
      };
      res.json({ services: await fetchHomeAssistantServices(config) });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });

  RED.httpAdmin.post("/ai-flow-builder/home-assistant/:id/service", writePerm, express.json({ limit: "100kb" }), async (req, res) => {
    const node = RED.nodes.getNode(req.params.id);
    if (!node || node.type !== "ai-home-assistant-config") return res.status(400).json({ error: "invalid homeAssistantId" });
    try {
      const { domain, service, target, data, entityIds, serviceIds } = req.body || {};
      res.json({
        ok: true,
        result: await callHomeAssistantService(node, { domain, service, target, data, allowedEntities: entityIds, allowedServices: serviceIds })
      });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });

  RED.httpAdmin.get("/ai-flow-builder/conversations", readPerm, async (req, res) => {
    try { res.json(await storage.listConversations()); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  RED.httpAdmin.post("/ai-flow-builder/conversations", writePerm, express.json(), async (req, res) => {
    try { res.json(await storage.createConversation({ title: req.body && req.body.title })); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  RED.httpAdmin.get("/ai-flow-builder/conversations/:id", readPerm, async (req, res) => {
    try { res.json(await storage.getConversation(req.params.id)); }
    catch (e) { res.status(404).json({ error: "not found" }); }
  });

  RED.httpAdmin.get("/ai-flow-builder/conversations/:id/export", readPerm, async (req, res) => {
    try {
      const conversation = await storage.getConversation(req.params.id);
      res.set("Content-Disposition", `attachment; filename="ai-conversation-${req.params.id}.json"`);
      res.json(conversation);
    } catch (e) { res.status(404).json({ error: "not found" }); }
  });

  RED.httpAdmin.post("/ai-flow-builder/conversations/cleanup", writePerm, express.json(), async (req, res) => {
    try {
      const days = Math.max(1, Math.min(Number(req.body && req.body.days) || 30, 3650));
      res.json({ deleted: await storage.cleanupConversations(days) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  RED.httpAdmin.delete("/ai-flow-builder/conversations/:id", writePerm, async (req, res) => {
    try { await storage.deleteConversation(req.params.id); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  RED.httpAdmin.post("/ai-flow-builder/conversations/:id/messages", writePerm, express.json({ limit: "25mb" }), async (req, res) => {
    const { id } = req.params;
    const { content, attachments = [], flowContext = {}, providerId, homeAssistantId } = req.body || {};
    if (typeof content !== "string" || content.length > 50000) {
      return res.status(400).json({ error: "message content must be text of at most 50000 characters" });
    }

    const providerNode = RED.nodes.getNode(providerId);
    if (!providerNode || providerNode.type !== "ai-provider-config") {
      return res.status(400).json({ error: "invalid providerId" });
    }
    const homeAssistantNode = homeAssistantId ? RED.nodes.getNode(homeAssistantId) : null;
    if (homeAssistantId && (!homeAssistantNode || homeAssistantNode.type !== "ai-home-assistant-config")) {
      return res.status(400).json({ error: "invalid homeAssistantId" });
    }

    let conv;
    try { conv = await storage.getConversation(id); }
    catch (e) { return res.status(404).json({ error: "conversation not found" }); }

    // Resolve attachment storedName → filesystem path
    if (!Array.isArray(attachments) || attachments.length > 5) {
      return res.status(400).json({ error: "attachments must be an array of at most 5 files" });
    }
    const resolvedAttachments = [];
    for (const attachment of attachments) {
      if (!attachment || typeof attachment.storedName !== "string") {
        return res.status(400).json({ error: "invalid attachment reference" });
      }
      const attachmentPath = storage.attachmentPath(id, attachment.storedName);
      let stat;
      try { stat = await fs.stat(attachmentPath); }
      catch (_) { return res.status(400).json({ error: "attachment not found" }); }
      if (stat.size > 10 * 1024 * 1024) return res.status(400).json({ error: "attachment is too large" });
      const mimeType = String(attachment.mimeType || "application/octet-stream").toLowerCase();
      if (!/^(image\/(png|jpeg|gif|webp)|application\/pdf|application\/json|text\/plain|text\/csv|text\/yaml|application\/yaml)$/i.test(mimeType)) {
        return res.status(400).json({ error: "unsupported attachment type" });
      }
      resolvedAttachments.push({
        id: attachment.id,
        storedName: attachment.storedName,
        originalName: String(attachment.originalName || attachment.storedName).slice(0, 200),
        mimeType,
        size: stat.size,
        path: attachmentPath
      });
    }

    await storage.appendMessage(id, {
      role: "user",
      content,
      attachments: resolvedAttachments.map(({ path, ...metadata }) => metadata)
    });

    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no"
    });
    res.flushHeaders();

    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    const history = limitMessages((await storage.getConversation(id)).messages.map(m => ({
      role: m.role, content: m.content || "",
      attachments: (m.attachments || []).map(a => ({ ...a, path: storage.attachmentPath(id, a.storedName) }))
    })));
    // Ensure current message is present with resolved paths.
    history[history.length - 1].attachments = resolvedAttachments;

    const requestController = new AbortController();
    const abortRequest = () => {
      if (!res.writableEnded) requestController.abort();
    };
    req.on("aborted", abortRequest);
    res.on("close", abortRequest);

    let homeAssistantContext;
    if (homeAssistantId) {
      try {
        const snapshot = await fetchHomeAssistantStates({ ...homeAssistantNode, entityIds: flowContext.entityIds || [] }, requestController.signal);
        homeAssistantContext = {
          states: snapshot.states,
          note: snapshot.truncated ? "Snapshot truncated to keep the AI request within its context budget." : undefined
        };
      } catch (e) {
        homeAssistantContext = { error: `Could not read Home Assistant entities: ${e.message}` };
      }
    }
    const systemPrompt = buildSystemPrompt({ ...flowContext, homeAssistant: homeAssistantContext });
    let assistantBuffer = "";

    try {
      for await (const evt of streamProvider({ configNode: providerNode, systemPrompt, messages: history, signal: requestController.signal })) {
        if (evt.type === "delta") {
          assistantBuffer += evt.text;
          send("delta", { text: evt.text });
        } else if (evt.type === "error") {
          send("error", { error: evt.error });
        } else if (evt.type === "done") {
          send("done", {});
        }
      }
    } catch (e) {
      if (requestController.signal.aborted) return res.end();
      send("error", { error: e.message || String(e) });
    }

    if (assistantBuffer) {
      await storage.appendMessage(id, { role: "assistant", content: assistantBuffer });
    }
    res.end();
  });

  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => cb(null, storage.tmpDir),
      filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.random().toString(16).slice(2)}.upload`)
    }),
    limits: { fileSize: 10 * 1024 * 1024, files: 5, fields: 20 },
    fileFilter: (req, file, cb) => {
      const allowed = /^(image\/(png|jpeg|gif|webp)|application\/pdf|application\/json|text\/plain|text\/csv|text\/yaml|application\/yaml)$/i;
      cb(null, allowed.test(file.mimetype));
    }
  });

  RED.httpAdmin.post("/ai-flow-builder/conversations/:id/attachments", writePerm, upload.array("files", 10), async (req, res) => {
    try {
      const { id } = req.params;
      await storage.getConversation(id); // existence check
      const out = [];
      for (const f of req.files || []) {
        const saved = await storage.saveAttachmentFile(id, {
          sourcePath: f.path,
          originalName: f.originalname,
          mimeType: f.mimetype,
          size: f.size
        });
        out.push(saved);
      }
      res.json(out);
    } catch (e) { res.status(500).json({ error: e.message }); }
    finally {
      for (const file of req.files || []) await fs.unlink(file.path).catch(() => {});
    }
  });

  RED.httpAdmin.get("/ai-flow-builder/conversations/:id/attachments/:storedName", readPerm, async (req, res) => {
    try {
      const p = storage.attachmentPath(req.params.id, req.params.storedName);
      res.sendFile(p);
    } catch (e) { res.status(404).json({ error: "not found" }); }
  });

  RED._nrafbStorage = storage;
};
