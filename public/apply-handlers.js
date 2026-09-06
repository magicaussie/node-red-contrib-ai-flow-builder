(function () {
  "use strict";

  function parseLang(lang) {
    if (/^json:delete$/.test(lang || "")) return { kind: "delete", target: null };
    if (/^json:connect$/.test(lang || "")) return { kind: "connect", target: null };
    if (/^json:disconnect$/.test(lang || "")) return { kind: "disconnect", target: null };
    if (/^json:ha-service$/.test(lang || "")) return { kind: "ha-service", target: null };
    const m = /^json:(flow|node|subflow):([\w-]+)$/.exec(lang || "");
    return m ? { kind: m[1], target: m[2] } : null;
  }

  function parseJSON(code) {
    try { return JSON.parse(code); }
    catch (e) { alert(`Invalid JSON: ${e.message}`); return null; }
  }

  function ensureArray(v) { return Array.isArray(v) ? v : [v]; }

  // Recursively strip any "[REDACTED]" value so existing secrets are preserved on Apply.
  // Returns { value, stripped: string[] } where `stripped` collects JSON paths that were dropped.
  function stripRedacted(v, path, acc) {
    if (v === "[REDACTED]") { acc.push(path || "(root)"); return undefined; }
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) {
      const out = [];
      v.forEach((item, i) => {
        const r = stripRedacted(item, `${path}[${i}]`, acc);
        if (r !== undefined) out.push(r);
      });
      return out;
    }
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      const r = stripRedacted(val, path ? `${path}.${k}` : k, acc);
      if (r !== undefined) out[k] = r;
    }
    return out;
  }

  function sanitizeIncoming(data) {
    const dropped = [];
    const clean = stripRedacted(data, "", dropped);
    if (dropped.length) {
      RED.notify(
        `Kept existing secrets for: ${dropped.join(", ")}`,
        { type: "info", timeout: 4000 }
      );
    }
    return clean;
  }

  // When set, apply* functions accumulate history entries here instead of pushing them
  // immediately, so applyBatch() can combine an entire AI response into one undo step.
  let batchChanges = null;

  function commitHistory(entry) {
    if (!entry) return;
    if (batchChanges) { batchChanges.push(entry); return; }
    if (RED.history && typeof RED.history.push === "function") {
      RED.history.push({ ...entry, dirty: RED.nodes.dirty() });
    }
  }

  function applyFlow(tabTarget, nodesJson, options = {}) {
    let incoming = ensureArray(sanitizeIncoming(nodesJson));
    let tabId = tabTarget;

    if (tabTarget === "new") {
      try {
        const newTab = RED.workspaces.add();
        if (!newTab || !newTab.id) throw new Error("RED.workspaces.add() returned no tab");
        tabId = newTab.id;
        const incomingTab = incoming.find(n => n && n.type === "tab");
        if (incomingTab && incomingTab.label) {
          const existing = RED.nodes.workspace(tabId);
          if (existing) {
            existing.label = incomingTab.label;
            if (incomingTab.info) existing.info = incomingTab.info;
            RED.events.emit("workspace:change", { workspace: existing });
          }
        }
      } catch (e) {
        RED.notify(`Could not create tab: ${e.message}`, "error");
        return;
      }
    }

    // Drop any tab definitions from the payload — they're handled above.
    incoming = incoming.filter(n => n && n.type !== "tab");
    // Reassign z on every node so imports land in the target tab.
    incoming.forEach(n => { n.z = tabId; });

    // Position by wire dependency instead of trusting AI-guessed x/y, avoiding overlap
    // with whatever already exists on the target tab.
    const planner = window.NRAFB_PLANNER;
    if (planner) {
      const existingNodes = [];
      RED.nodes.eachNode(n => { if (n.z === tabId) existingNodes.push({ x: n.x, y: n.y }); });
      const laidOut = planner.computeLayeredLayout(incoming, { existingNodes });
      const byId = new Map(laidOut.map(n => [n.id, n]));
      incoming.forEach(n => {
        const placed = byId.get(n.id);
        if (placed) { n.x = placed.x; n.y = placed.y; }
      });
    }

    // Imported nodes stay disabled until the user reviews and enables them, unless
    // they've opted into immediate activation via the sidebar toggle.
    const autoEnable = !!(window.NRAFB && window.NRAFB.state.autoEnableNewNodes);
    if (!autoEnable) incoming.forEach(n => { n.d = true; });

    try {
      const imported = RED.nodes.import(incoming, { generateIds: true, addFlow: false });
      const importedNodes = imported.nodes || [];

      // Make the target tab the active one so the user sees the result immediately.
      if (RED.workspaces.active() !== tabId) RED.workspaces.show(tabId);

      commitHistory(importedNodes.length ? { t: "add", nodes: importedNodes.map(n => n.id) } : null);

      // Notify the editor that new nodes exist, then force a full redraw.
      importedNodes.forEach(n => RED.events.emit("nodes:add", n));
      RED.nodes.dirty(true);
      if (RED.view && typeof RED.view.redraw === "function") RED.view.redraw(true);

      RED.notify(`Applied ${importedNodes.length} node(s)${autoEnable ? "" : " (disabled — review then enable + deploy)"}.`, "success");
    } catch (e) {
      RED.notify(`Apply failed: ${e.message}`, "error");
    }
  }

  function applyNode(nodeId, patch) {
    const node = RED.nodes.node(nodeId);
    if (!node) { RED.notify(`Node ${nodeId} not found.`, "error"); return; }
    patch = sanitizeIncoming(patch) || {};
    const changes = {};
    Object.keys(patch).forEach(k => {
      if (k === "id" || k === "type" || k === "z" || /password|token|secret|api[-_]?key|credential|authorization/i.test(k)) return;
      changes[k] = node[k];
      node[k] = patch[k];
    });
    commitHistory(Object.keys(changes).length ? { t: "edit", node, changes } : null);
    node.changed = true;
    RED.nodes.dirty(true);
    RED.events.emit("nodes:change", node);
    RED.view.redraw();
    RED.notify(`Patched node ${nodeId}.`, "success");
  }

  function applySubflow(target, data) {
    data = sanitizeIncoming(data);
    try {
      if (target === "new") {
        RED.nodes.import(ensureArray(data), { generateIds: true, addFlow: true });
      } else {
        RED.nodes.import(ensureArray(data), { generateIds: false, addFlow: true });
      }
      RED.view.redraw();
      RED.nodes.dirty(true);
      RED.notify(`Applied subflow changes.`, "success");
    } catch (e) {
      RED.notify(`Subflow apply failed: ${e.message}`, "error");
    }
  }

  function applyDelete(idsJson) {
    const ids = ensureArray(idsJson).filter(x => typeof x === "string");
    if (!ids.length) { RED.notify("Nothing to delete (expected an array of node IDs).", "warning"); return; }
    const removed = [];
    const removedLinks = [];
    const removedTabs = [];
    const wireChanges = [];
    ids.forEach(id => {
      let n = RED.nodes.node(id);
      if (n) {
        // Remove inbound wires referencing this node.
        RED.nodes.eachNode(other => {
          if (!other.wires) return;
          other.wires.forEach(portWires => {
            const idx = portWires.indexOf(id);
            if (idx !== -1) {
              const sourcePort = other.wires.indexOf(portWires);
              wireChanges.push({ source: other, sourcePort, target: n });
              portWires.splice(idx, 1);
              other.dirty = true;
            }
          });
        });
        RED.nodes.remove(id);
        removed.push(n);
        return;
      }
      const tab = RED.nodes.workspace(id);
      if (tab) {
        // Remove the tab + all nodes on it.
        const onTab = [];
        RED.nodes.eachNode(x => { if (x.z === id) onTab.push(x.id); });
        onTab.forEach(nid => { const node = RED.nodes.node(nid); if (node) { removed.push(node); RED.nodes.remove(nid); } });
        RED.nodes.removeWorkspace(id);
        removedTabs.push(tab);
      }
    });
    commitHistory((removed.length || removedTabs.length) ? { t: "delete", nodes: removed, workspaces: removedTabs, links: wireChanges } : null);
    removed.forEach(n => RED.events.emit("nodes:remove", n));
    RED.nodes.dirty(true);
    if (RED.view && typeof RED.view.redraw === "function") RED.view.redraw(true);
    RED.notify(`Deleted ${removed.length} node(s)` + (removedTabs.length ? ` and ${removedTabs.length} tab(s)` : "") + ".", "success");
  }

  function normalizeEdges(data) {
    return ensureArray(data)
      .map(e => (typeof e === "object" && e) ? { from: e.from, port: Number(e.port) || 0, to: e.to } : null)
      .filter(e => e && e.from && e.to);
  }

  function applyConnect(edgesJson) {
    const edges = normalizeEdges(edgesJson);
    const touched = new Set();
    const addedLinks = [];
    let skippedMissing = 0, skippedDup = 0;
    edges.forEach(({ from, port, to }) => {
      const src = RED.nodes.node(from);
      const dst = RED.nodes.node(to);
      if (!src || !dst) { skippedMissing++; return; }
      if (!Array.isArray(src.wires)) src.wires = [];
      while (src.wires.length <= port) src.wires.push([]);
      if (src.wires[port].includes(to)) { skippedDup++; return; }
      src.wires[port].push(to);
      touched.add(src);
      const link = { source: src, sourcePort: port, target: dst };
      if (typeof RED.nodes.addLink === "function") RED.nodes.addLink(link);
      addedLinks.push(link);
    });
    touched.forEach(n => {
      n.changed = true;
      n.dirty = true;
      RED.events.emit("nodes:change", n);
    });
    commitHistory(addedLinks.length ? { t: "add", links: addedLinks } : null);
    RED.nodes.dirty(true);
    if (RED.view && typeof RED.view.redraw === "function") RED.view.redraw(true);
    const msgs = [`Added ${addedLinks.length} wire(s)`];
    if (skippedMissing) msgs.push(`${skippedMissing} skipped (node not found)`);
    if (skippedDup) msgs.push(`${skippedDup} skipped (already connected)`);
    RED.notify(msgs.join(", ") + ".", addedLinks.length ? "success" : "warning");
  }

  function findExistingLink(from, port, to) {
    // Search through all known links regardless of how they're exposed (eachLink, links array, filterLinks).
    let found = null;
    const match = (l) => l && l.source && l.target && l.source.id === from && l.target.id === to && (l.sourcePort === port || l.sourcePort === undefined);
    if (typeof RED.nodes.eachLink === "function") {
      RED.nodes.eachLink(l => { if (!found && match(l)) found = l; });
      if (found) return found;
    }
    if (typeof RED.nodes.filterLinks === "function") {
      const res = RED.nodes.filterLinks({ source: { id: from }, sourcePort: port, target: { id: to } });
      if (Array.isArray(res) && res.length) return res[0];
    }
    if (Array.isArray(RED.nodes.links)) {
      found = RED.nodes.links.find(match);
      if (found) return found;
    }
    return null;
  }

  function applyDisconnect(edgesJson) {
    const edges = normalizeEdges(edgesJson);
    const touched = new Set();
    const removedLinks = [];
    let skippedMissing = 0, skippedAbsent = 0;
    edges.forEach(({ from, port, to }) => {
      const src = RED.nodes.node(from);
      const dst = RED.nodes.node(to);
      if (!src || !dst) { skippedMissing++; return; }

      // 1) Remove ID from source node's wires array (source of truth for serialization).
      let wireRemoved = false;
      if (Array.isArray(src.wires) && Array.isArray(src.wires[port])) {
        const idx = src.wires[port].indexOf(to);
        if (idx !== -1) { src.wires[port].splice(idx, 1); wireRemoved = true; touched.add(src); }
      }

      // 2) Remove the editor's in-memory link object using the *existing* reference.
      const existingLink = findExistingLink(from, port, to);
      console.log("[NRAFB_APPLY] disconnect search", { from, port, to, wireRemoved, foundLink: !!existingLink });
      if (existingLink && typeof RED.nodes.removeLink === "function") {
        try { RED.nodes.removeLink(existingLink); removedLinks.push(existingLink); }
        catch (e) { console.warn("[NRAFB_APPLY] removeLink failed", e); }
      } else if (wireRemoved) {
        // Wire gone but no link object to remove — redraw alone.
        removedLinks.push({ source: src, sourcePort: port, target: dst });
      } else {
        skippedAbsent++;
      }
    });
    touched.forEach(n => {
      n.changed = true;
      n.dirty = true;
      RED.events.emit("nodes:change", n);
    });
    commitHistory(removedLinks.length ? { t: "delete", links: removedLinks } : null);
    RED.nodes.dirty(true);
    if (RED.view && typeof RED.view.redraw === "function") RED.view.redraw(true);
    const msgs = [`Removed ${removedLinks.length} wire(s)`];
    if (skippedMissing) msgs.push(`${skippedMissing} skipped (node not found)`);
    if (skippedAbsent) msgs.push(`${skippedAbsent} skipped (not connected)`);
    RED.notify(msgs.join(", ") + ".", removedLinks.length ? "success" : "warning");
  }

  // Builds a human confirm message when a change is large/risky enough to ask first;
  // returns null when it's small enough to apply without interrupting the user.
  function buildConfirmMessage(parsed, data) {
    const planner = window.NRAFB_PLANNER;
    if (!planner) return null;
    if (parsed.kind === "delete") {
      return `Delete ${ensureArray(data).length} node or tab item(s) from the canvas?`;
    }
    if (parsed.kind === "flow") {
      const nodes = ensureArray(data).filter(n => n && n.type !== "tab");
      const unknownTypeCount = nodes.filter(n => !RED.nodes.getType(n.type)).length;
      if (!planner.decideConfirmation({ addedNodeCount: nodes.length, unknownTypeCount })) return null;
      return `Add ${nodes.length} node(s)${unknownTypeCount ? ` (${unknownTypeCount} unknown type(s))` : ""} to the canvas?`;
    }
    if (parsed.kind === "node") {
      const changedPropertyCount = Object.keys(data || {}).filter(k => k !== "id" && k !== "type" && k !== "z").length;
      if (!planner.decideConfirmation({ changedPropertyCount })) return null;
      return `Patch node ${parsed.target} \u2014 change ${changedPropertyCount} propert${changedPropertyCount === 1 ? "y" : "ies"}?`;
    }
    if (parsed.kind === "connect" || parsed.kind === "disconnect") {
      const edgeCount = normalizeEdges(data).length;
      if (!planner.decideConfirmation({ edgeCount })) return null;
      return `${parsed.kind === "connect" ? "Add" : "Remove"} ${edgeCount} wire(s)?`;
    }
    return null;
  }

  function apply(lang, code, options = {}) {
    console.log("[NRAFB_APPLY] apply", { lang, codeLength: (code || "").length, inBatch: !!options.inBatch });
    const parsed = parseLang(lang);
    if (!parsed) { RED.notify(`Unknown apply target: ${lang}`, "error"); return; }
    const data = parseJSON(code);
    if (!data) return;

    // The outer "Apply all" confirm already covers batched changes; skip the per-block
    // confirm there, but Home Assistant actions always confirm individually regardless.
    if (!options.inBatch) {
      const confirmMessage = buildConfirmMessage(parsed, data);
      if (confirmMessage && !confirm(confirmMessage)) return;
    }
    if (parsed.kind === "ha-service") {
      if (!window.NRAFB || !window.NRAFB.state.homeAssistantId) {
        RED.notify("Select a Home Assistant connection before applying this action.", "error");
        return;
      }
      if (!confirm(`Run Home Assistant service ${data.domain}.${data.service}?`)) return;
      fetch(`ai-flow-builder/home-assistant/${window.NRAFB.state.homeAssistantId}/service`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...data,
          entityIds: window.NRAFB.state.entityIds,
          serviceIds: window.NRAFB.state.serviceIds
        })
      }).then(async response => {
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
        RED.notify("Home Assistant action completed.", "success");
      }).catch(error => RED.notify(`Home Assistant action failed: ${error.message}`, "error"));
      return;
    }
    console.log("[NRAFB_APPLY] dispatching", parsed.kind, data);
    if (parsed.kind === "flow") return applyFlow(parsed.target, data, options);
    if (parsed.kind === "node") return applyNode(parsed.target, data, options);
    if (parsed.kind === "subflow") return applySubflow(parsed.target, data, options);
    if (parsed.kind === "delete") return applyDelete(data, options);
    if (parsed.kind === "connect") return applyConnect(data, options);
    if (parsed.kind === "disconnect") return applyDisconnect(data, options);
    RED.notify(`Nothing to do for ${lang}`, "warning");
  }

  // Applies every block from one AI response as a single undo step, instead of leaving
  // a partial canvas state if the user only clicks Apply on some of the blocks.
  function applyBatch(blocks) {
    if (!blocks || !blocks.length) return;
    const planner = window.NRAFB_PLANNER;
    const dirtyBefore = RED.nodes.dirty();
    batchChanges = [];
    try {
      blocks.forEach(({ lang, code }) => apply(lang, code, { inBatch: true }));
    } finally {
      const collected = batchChanges;
      batchChanges = null;
      if (planner && RED.history && typeof RED.history.push === "function") {
        const merged = planner.buildMultiHistoryEntry(collected, dirtyBefore);
        if (merged) RED.history.push(merged);
      }
    }
  }

  // Builds a small box-and-arrow diagram for the Preview dialog so wiring can be checked
  // visually instead of only reading a node/type count summary.
  function buildDiagramSvg(parsed, data) {
    const planner = window.NRAFB_PLANNER;
    if (!planner) return null;
    if (parsed.kind === "flow") {
      const flowNodes = ensureArray(data).filter(n => n && n.type !== "tab" && n.id);
      if (!flowNodes.length) return null;
      const diagramNodes = flowNodes.map(n => ({ id: n.id, label: n.name || n.type, wires: n.wires }));
      const positioned = planner.computeLayeredLayout(diagramNodes);
      const edges = [];
      flowNodes.forEach(n => (n.wires || []).forEach(port => (port || []).forEach(to => edges.push({ from: n.id, to }))));
      return planner.buildFlowDiagramSvg(positioned, edges);
    }
    if (parsed.kind === "connect" || parsed.kind === "disconnect") {
      const edges = normalizeEdges(data);
      if (!edges.length) return null;
      const ids = [...new Set(edges.flatMap(e => [e.from, e.to]))];
      const wiresByFrom = new Map(ids.map(id => [id, []]));
      edges.forEach(e => wiresByFrom.get(e.from).push(e.to));
      const diagramNodes = ids.map(id => ({ id, label: id, wires: [wiresByFrom.get(id) || []] }));
      const positioned = planner.computeLayeredLayout(diagramNodes);
      return planner.buildFlowDiagramSvg(positioned, edges.map(e => ({ ...e, removed: parsed.kind === "disconnect" })));
    }
    return null;
  }

  function preview(lang, code) {
    const parsed = parseLang(lang);
    if (!parsed) return apply(lang, code);
    const data = parseJSON(code);
    if (!data) return;
    const nodes = ensureArray(data);
    let summary = "";
    if (parsed.kind === "flow") {
      const targetLabel = parsed.target === "new" ? "a NEW tab" : `tab ${parsed.target}`;
      const types = nodes.reduce((acc, n) => { acc[n.type] = (acc[n.type] || 0) + 1; return acc; }, {});
      summary = `Add ${nodes.length} node(s) to ${targetLabel}:\n` +
        Object.entries(types).map(([t, n]) => `  • ${n} × ${t}`).join("\n");
    } else if (parsed.kind === "node") {
      summary = `Patch node ${parsed.target} with keys: ${Object.keys(data).filter(k => k !== "id").join(", ")}`;
    } else if (parsed.kind === "delete") {
      const ids = ensureArray(data);
      summary = `Delete ${ids.length} item(s):\n` + ids.map(id => `  • ${id}`).join("\n");
    } else if (parsed.kind === "connect" || parsed.kind === "disconnect") {
      const edges = normalizeEdges(data);
      summary = `${parsed.kind === "connect" ? "Add" : "Remove"} ${edges.length} wire(s):\n` +
        edges.map(e => `  • ${e.from}[${e.port}] → ${e.to}`).join("\n");
    } else {
      summary = `Apply subflow (target: ${parsed.target})`;
    }

    const diagramSvg = buildDiagramSvg(parsed, data);
    const $overlay = $(`<div class="nrafb-viewer-overlay"></div>`);
    const $body = $(`
      <div class="nrafb-viewer-body" style="max-width:700px;min-width:360px;">
        <h4 style="margin-top:0">Preview</h4>
        <div class="nrafb-preview-diagram" style="overflow:auto;max-height:280px;background:#1e1e1e;border-radius:4px;margin-bottom:8px;"></div>
        <pre style="background:#f5f5f5;color:#333;padding:8px;border-radius:4px;white-space:pre-wrap;"></pre>
        <div style="text-align:right;margin-top:8px">
          <button class="nrafb-btn nrafb-preview-cancel">Cancel</button>
          <button class="nrafb-btn nrafb-preview-confirm" style="background:#4a9;color:#fff;">Apply</button>
        </div>
      </div>
    `);
    if (diagramSvg) $body.find(".nrafb-preview-diagram").html(diagramSvg);
    else $body.find(".nrafb-preview-diagram").remove();
    $body.find("pre").text(summary);
    $overlay.append($body);
    $("body").append($overlay);
    $overlay.on("click", e => {
      if (e.target === $overlay[0] || $(e.target).hasClass("nrafb-preview-cancel")) $overlay.remove();
      if ($(e.target).hasClass("nrafb-preview-confirm")) { apply(lang, code); $overlay.remove(); }
    });
  }

  window.NRAFB_APPLY = { apply, preview, applyBatch };
})();
