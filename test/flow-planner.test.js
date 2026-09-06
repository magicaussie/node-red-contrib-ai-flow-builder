const assert = require("assert");
const {
  CONFIRM_THRESHOLDS,
  computeLayeredLayout,
  diffNodeAgainstSchema,
  decideConfirmation,
  buildMultiHistoryEntry,
  buildFlowDiagramSvg
} = require("../public/flow-planner.js");

describe("computeLayeredLayout", () => {
  it("places nodes into columns by wire dependency depth", () => {
    const nodes = [
      { id: "a", wires: [["b"]] },
      { id: "b", wires: [["c"]] },
      { id: "c", wires: [[]] },
      { id: "d", wires: [[]] }
    ];
    const positioned = computeLayeredLayout(nodes);
    const byId = Object.fromEntries(positioned.map(n => [n.id, n]));
    assert.ok(byId.a.x < byId.b.x);
    assert.ok(byId.b.x < byId.c.x);
    assert.strictEqual(byId.d.x, byId.a.x, "isolated node stays in the first column");
  });

  it("starts below existing nodes instead of overlapping them", () => {
    const nodes = [{ id: "n1", wires: [[]] }];
    const existingNodes = [{ id: "old", x: 100, y: 300 }];
    const [positioned] = computeLayeredLayout(nodes, { existingNodes });
    assert.ok(positioned.y > 300);
  });

  it("returns an empty array for no nodes", () => {
    assert.deepStrictEqual(computeLayeredLayout([]), []);
  });

  it("bounds cyclic wiring instead of looping forever", () => {
    const nodes = [
      { id: "a", wires: [["b"]] },
      { id: "b", wires: [["a"]] }
    ];
    const positioned = computeLayeredLayout(nodes);
    assert.strictEqual(positioned.length, 2);
  });
});

describe("diffNodeAgainstSchema", () => {
  it("flags unexpected properties and missing required ones", () => {
    const node = { id: "1", type: "template", name: "t", foo: 1 };
    const { unexpectedKeys, missingRequiredKeys } = diffNodeAgainstSchema(node, {
      properties: ["name", "template"],
      required: ["template"]
    });
    assert.deepStrictEqual(unexpectedKeys, ["foo"]);
    assert.deepStrictEqual(missingRequiredKeys, ["template"]);
  });

  it("allows Node-RED envelope keys even when not in the schema", () => {
    const node = { id: "1", type: "inject", z: "t1", x: 10, y: 20, wires: [[]], name: "n", d: true };
    const { unexpectedKeys } = diffNodeAgainstSchema(node, { properties: [], required: [] });
    assert.deepStrictEqual(unexpectedKeys, []);
  });
});

describe("decideConfirmation", () => {
  it("requires confirmation for unknown types regardless of size", () => {
    assert.strictEqual(decideConfirmation({ addedNodeCount: 1, unknownTypeCount: 1 }), true);
  });

  it("stays silent at or below the added-node threshold", () => {
    assert.strictEqual(decideConfirmation({ addedNodeCount: CONFIRM_THRESHOLDS.maxAddedNodes }), false);
    assert.strictEqual(decideConfirmation({ addedNodeCount: CONFIRM_THRESHOLDS.maxAddedNodes + 1 }), true);
  });

  it("checks changed-property and edge thresholds independently", () => {
    assert.strictEqual(decideConfirmation({ changedPropertyCount: CONFIRM_THRESHOLDS.maxChangedProperties + 1 }), true);
    assert.strictEqual(decideConfirmation({ edgeCount: CONFIRM_THRESHOLDS.maxEdges + 1 }), true);
    assert.strictEqual(decideConfirmation({}), false);
  });
});

describe("buildMultiHistoryEntry", () => {
  it("returns null when there is nothing to record", () => {
    assert.strictEqual(buildMultiHistoryEntry([], true), null);
    assert.strictEqual(buildMultiHistoryEntry([null, undefined], true), null);
  });

  it("passes a single change through unwrapped", () => {
    const entry = buildMultiHistoryEntry([{ t: "add", nodes: ["a"] }], false);
    assert.deepStrictEqual(entry, { t: "add", nodes: ["a"], dirty: false });
  });

  it("wraps multiple changes into one composite undo entry", () => {
    const entry = buildMultiHistoryEntry([{ t: "add", nodes: ["a"] }, { t: "delete", nodes: ["b"] }], true);
    assert.strictEqual(entry.t, "multi");
    assert.strictEqual(entry.changes.length, 2);
    assert.strictEqual(entry.dirty, true);
  });
});

describe("buildFlowDiagramSvg", () => {
  it("renders a box per node and a line per edge", () => {
    const nodes = computeLayeredLayout([
      { id: "a", label: "inject", wires: [["b"]] },
      { id: "b", label: "debug", wires: [[]] }
    ]);
    const svg = buildFlowDiagramSvg(nodes, [{ from: "a", to: "b" }]);
    assert.match(svg, /^<svg/);
    assert.strictEqual((svg.match(/<rect/g) || []).length, 2);
    assert.strictEqual((svg.match(/<line/g) || []).length, 1);
  });

  it("handles an empty node list without throwing", () => {
    const svg = buildFlowDiagramSvg([], []);
    assert.match(svg, /nothing to show/);
  });
});
