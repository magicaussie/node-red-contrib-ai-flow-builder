(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.NRAFB_PLANNER = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const CONFIRM_THRESHOLDS = {
    maxAddedNodes: 3,
    maxChangedProperties: 2,
    maxEdges: 5
  };

  const BASE_NODE_KEYS = ["id", "type", "z", "x", "y", "wires", "name", "d", "info", "l", "outputs", "inputs"];

  function computeLayers(nodes) {
    const ids = new Set(nodes.map(n => n.id));
    const incoming = new Map(nodes.map(n => [n.id, []]));
    nodes.forEach(n => {
      (n.wires || []).forEach(port => {
        (port || []).forEach(targetId => {
          if (ids.has(targetId) && incoming.has(targetId)) {
            incoming.get(targetId).push(n.id);
          }
        });
      });
    });
    const layer = new Map(nodes.map(n => [n.id, 0]));
    // Bounded relaxation passes so cyclic wiring can't loop forever.
    for (let pass = 0; pass < nodes.length + 1; pass++) {
      let changed = false;
      nodes.forEach(n => {
        const preds = incoming.get(n.id) || [];
        if (!preds.length) return;
        const maxPred = Math.max(...preds.map(id => layer.get(id) || 0));
        if (maxPred + 1 > layer.get(n.id)) {
          layer.set(n.id, maxPred + 1);
          changed = true;
        }
      });
      if (!changed) break;
    }
    return layer;
  }

  // Positions new nodes left-to-right by wire dependency instead of trusting AI-guessed x/y,
  // and starts below/right of whatever already exists on the target tab to avoid overlap.
  function computeLayeredLayout(nodes, options = {}) {
    const columnWidth = options.columnWidth || 220;
    const rowHeight = options.rowHeight || 80;
    const baseX = options.baseX != null ? options.baseX : 160;
    const baseY = options.baseY != null ? options.baseY : 80;
    const existingNodes = options.existingNodes || [];

    if (!nodes.length) return [];

    const layer = computeLayers(nodes);
    const maxLayer = Math.max(...nodes.map(n => layer.get(n.id) || 0));
    const byLayer = Array.from({ length: maxLayer + 1 }, () => []);
    nodes.forEach(n => byLayer[layer.get(n.id) || 0].push(n));

    const existingXs = existingNodes.map(n => Number(n.x)).filter(Number.isFinite);
    const existingYs = existingNodes.map(n => Number(n.y)).filter(Number.isFinite);
    const startX = existingXs.length ? Math.min(...existingXs) : baseX;
    const startY = existingYs.length ? Math.max(...existingYs) + rowHeight * 1.5 : baseY;

    const positioned = [];
    byLayer.forEach((layerNodes, layerIndex) => {
      layerNodes.forEach((n, rowIndex) => {
        positioned.push({ ...n, x: startX + layerIndex * columnWidth, y: startY + rowIndex * rowHeight });
      });
    });
    return positioned;
  }

  // Compares a proposed node's properties against the installed node type's real schema
  // (caller extracts `properties`/`required` from RED.nodes.getType(type).defaults).
  function diffNodeAgainstSchema(node, schema) {
    const allowed = new Set([...BASE_NODE_KEYS, ...((schema && schema.properties) || [])]);
    const unexpectedKeys = Object.keys(node || {}).filter(k => !allowed.has(k));
    const missingRequiredKeys = ((schema && schema.required) || []).filter(k => {
      const value = node ? node[k] : undefined;
      return value === undefined || value === null || value === "";
    });
    return { unexpectedKeys, missingRequiredKeys };
  }

  function decideConfirmation(summary = {}) {
    const { addedNodeCount = 0, unknownTypeCount = 0, changedPropertyCount = 0, edgeCount = 0 } = summary;
    if (unknownTypeCount > 0) return true;
    if (addedNodeCount > CONFIRM_THRESHOLDS.maxAddedNodes) return true;
    if (changedPropertyCount > CONFIRM_THRESHOLDS.maxChangedProperties) return true;
    if (edgeCount > CONFIRM_THRESHOLDS.maxEdges) return true;
    return false;
  }

  // Collapses several independent RED.history entries into one so a single Ctrl+Z
  // undoes an entire multi-block AI response instead of leaving a partial state.
  function buildMultiHistoryEntry(changes, dirty) {
    const filtered = (changes || []).filter(Boolean);
    if (!filtered.length) return null;
    if (filtered.length === 1) return { ...filtered[0], dirty };
    return { t: "multi", changes: filtered, dirty };
  }

  function escapeSvgText(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  // Renders a compact box-and-arrow diagram of a proposed change for the Preview dialog.
  function buildFlowDiagramSvg(positionedNodes, edges, options = {}) {
    const boxWidth = options.boxWidth || 120;
    const boxHeight = options.boxHeight || 40;
    if (!positionedNodes.length) return "<svg width=\"200\" height=\"60\"><text x=\"10\" y=\"30\">(nothing to show)</text></svg>";

    const idToNode = new Map(positionedNodes.map(n => [n.id, n]));
    const xs = positionedNodes.map(n => n.x);
    const ys = positionedNodes.map(n => n.y);
    const minX = Math.min(...xs, 0);
    const minY = Math.min(...ys, 0);
    const maxX = Math.max(...xs.map(x => x + boxWidth));
    const maxY = Math.max(...ys.map(y => y + boxHeight));
    const offsetX = 20 - minX;
    const offsetY = 20 - minY;
    const width = maxX - minX + 40;
    const height = maxY - minY + 40;

    const lines = (edges || []).map(edge => {
      const from = idToNode.get(edge.from);
      const to = idToNode.get(edge.to);
      if (!from || !to) return "";
      const x1 = from.x + offsetX + boxWidth;
      const y1 = from.y + offsetY + boxHeight / 2;
      const x2 = to.x + offsetX;
      const y2 = to.y + offsetY + boxHeight / 2;
      const stroke = edge.removed ? "#c33" : "#4a9";
      const dash = edge.removed ? ' stroke-dasharray="4,3"' : "";
      return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="2"${dash} marker-end="url(#nrafb-arrow)" />`;
    }).join("");

    const boxes = positionedNodes.map(n => {
      const x = n.x + offsetX;
      const y = n.y + offsetY;
      return `<rect x="${x}" y="${y}" width="${boxWidth}" height="${boxHeight}" rx="6" fill="#2d2d2d" stroke="#666" />` +
        `<text x="${x + boxWidth / 2}" y="${y + boxHeight / 2 + 4}" fill="#eee" font-size="11" text-anchor="middle">${escapeSvgText(n.label)}</text>`;
    }).join("");

    return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">` +
      `<defs><marker id="nrafb-arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">` +
      `<path d="M0,0 L6,3 L0,6 Z" fill="#4a9" /></marker></defs>${lines}${boxes}</svg>`;
  }

  return {
    CONFIRM_THRESHOLDS,
    computeLayeredLayout,
    diffNodeAgainstSchema,
    decideConfirmation,
    buildMultiHistoryEntry,
    buildFlowDiagramSvg
  };
});
