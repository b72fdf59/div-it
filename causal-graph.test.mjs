import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeCausalGraph, causalReachability, maximalCausalFrontier, planCausalCheckpoints, validateCausalFrontier } from "./src/causal-graph.js";

const group = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const id = (number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const record = (number, fields = {}) => ({ id: id(number), groupId: group, causalHeads: [], dependsOn: [], ...fields });

test("reachability follows both explicit edge types, never membershipHeads, and ignores input order", () => {
  const records = [
    record(3, { dependsOn: [id(2)] }),
    record(1),
    record(2, { causalHeads: [id(1)], membershipHeads: [id(999)] }),
    record(4, { membershipHeads: [id(3)] })
  ];
  const before = structuredClone(records);
  const graph = analyzeCausalGraph(records, { groupId: group });
  const reversed = analyzeCausalGraph([...records].reverse(), { groupId: group });
  assert.equal(causalReachability(graph, id(3), id(1)).reachable, true);
  assert.equal(causalReachability(graph, id(4), id(1)).reachable, false);
  assert.deepEqual(graph.diagnostics, reversed.diagnostics);
  assert.deepEqual(records, before);
});

test("missing causal parents stay pending and become valid when delayed records arrive", () => {
  const child = record(2, { dependsOn: [id(1)] });
  const pending = analyzeCausalGraph([child, record(3)], { groupId: group });
  const pendingReversed = analyzeCausalGraph([record(3), child], { groupId: group });
  assert.deepEqual(pending.diagnostics, pendingReversed.diagnostics);
  assert.deepEqual(pending.diagnostics, [{ recordId: id(2), status: "pending", reason: "missing-causal-parent" },
    { recordId: id(3), status: "valid", reason: "causal-record" }]);
  const complete = analyzeCausalGraph([child, record(1)], { groupId: group });
  assert.equal(complete.diagnostics.find((item) => item.recordId === id(2)).status, "valid");
});

test("10,000-record chains are stack-safe and order independent", () => {
  const records = Array.from({ length: 10_000 }, (_, index) => record(index + 1,
    index ? { causalHeads: [id(index)] } : {}));
  const shuffled = [...records].sort((left, right) => {
    const leftKey = (Number(left.id.slice(-12)) * 7_919) % 10_000;
    const rightKey = (Number(right.id.slice(-12)) * 7_919) % 10_000;
    return leftKey - rightKey;
  });
  const forward = analyzeCausalGraph(records, { groupId: group });
  const reverse = analyzeCausalGraph([...records].reverse(), { groupId: group });
  const randomOrder = analyzeCausalGraph(shuffled, { groupId: group });
  assert.equal(forward.nodes.length, 10_000);
  assert.deepEqual(forward.diagnostics, reverse.diagnostics);
  assert.deepEqual(forward.diagnostics, randomOrder.diagnostics);
  assert.ok(forward.diagnostics.every((item) => item.status === "valid"));
});

test("cycles, cross-group ancestry, and ID collisions fail closed independent of order", () => {
  const a = record(1, { causalHeads: [id(2)] });
  const b = record(2, { dependsOn: [id(1)] });
  const foreign = record(3, { groupId: id(80) });
  const cross = record(4, { causalHeads: [id(3)] });
  const collisionA = record(5);
  const collisionB = { ...record(5), payload: { changed: true } };
  const child = record(6, { dependsOn: [id(5)] });
  const first = analyzeCausalGraph([a, b, foreign, cross, collisionA, collisionB, child], { groupId: group });
  const second = analyzeCausalGraph([child, collisionB, collisionA, cross, foreign, b, a], { groupId: group });
  assert.deepEqual(first.diagnostics, second.diagnostics);
  assert.equal(first.diagnostics.find((item) => item.recordId === id(1)).reason, "causal-cycle");
  assert.equal(first.diagnostics.find((item) => item.recordId === id(3)).reason, "cross-group-record");
  assert.equal(first.diagnostics.find((item) => item.recordId === id(4)).reason, "cross-group-ancestry");
  assert.equal(first.diagnostics.find((item) => item.recordId === id(5)).reason, "causal-id-collision");
  assert.equal(first.diagnostics.find((item) => item.recordId === id(6)).reason, "causal-parent-id-collision");
});

test("frontiers are sorted, unique, bounded antichains and maxima use the observed set", () => {
  const graph = analyzeCausalGraph([record(1), record(2, { causalHeads: [id(1)] }), record(3)], { groupId: group });
  assert.deepEqual(validateCausalFrontier(graph, []), { ok: true, heads: [] });
  assert.equal(validateCausalFrontier(graph, [id(1), id(2)]).reason, "redundant-causal-heads");
  assert.equal(validateCausalFrontier(graph, [id(2), id(1)]).reason, "invalid-causal-frontier");
  assert.deepEqual(maximalCausalFrontier(graph, [id(1), id(2), id(3)]), { ok: true, heads: [id(2), id(3)] });
  assert.equal(validateCausalFrontier(graph, Array.from({ length: 65 }, (_, index) => id(index + 100))).reason, "causal-frontier-too-large");
  const redundant = analyzeCausalGraph([record(1), record(2, { causalHeads: [id(1)] }),
    record(3, { causalHeads: [id(1), id(2)] }), record(4, { dependsOn: [id(3)] })], { groupId: group });
  assert.equal(redundant.diagnostics.find((item) => item.recordId === id(3)).reason, "redundant-causal-heads");
  assert.equal(redundant.diagnostics.find((item) => item.recordId === id(4)).reason, "invalid-causal-ancestry");
});

test("staged checkpoints preserve every input head across 65, 127 and 128 heads", () => {
  for (const count of [65, 127, 128]) {
    const heads = Array.from({ length: count }, (_, index) => id(index + 1));
    const stepCount = 1 + Math.ceil((count - 64) / 63);
    const checkpointIds = Array.from({ length: stepCount }, (_, index) => id(20_000 + index));
    const plan = planCausalCheckpoints(heads, checkpointIds);
    assert.equal(plan.ok, true);
    assert.equal(plan.steps.length, stepCount);
    assert.ok(plan.steps.every((step) => step.causalHeads.length <= 64));
    assert.deepEqual(plan.steps[0].causalHeads, heads.slice(0, 64));
    for (let index = 1; index < plan.steps.length; index += 1) {
      assert.equal(plan.steps[index].causalHeads.includes(checkpointIds[index - 1]), true);
      assert.ok(plan.steps[index].causalHeads.length <= 64);
    }
    const graphRecords = [...heads.map((head) => ({ id: head, groupId: group, causalHeads: [], dependsOn: [] })),
      ...plan.steps.map((step) => ({ id: step.id, groupId: group, causalHeads: step.causalHeads, dependsOn: [] }))];
    const graph = analyzeCausalGraph(graphRecords, { groupId: group });
    assert.deepEqual(graph.diagnostics.filter((item) => item.status !== "valid"), []);
    assert.ok(heads.every((head) => causalReachability(graph, checkpointIds.at(-1), head).reachable));
    assert.ok(checkpointIds.slice(0, -1).every((checkpointId) => causalReachability(graph, checkpointIds.at(-1), checkpointId).reachable));
  }
});

test("zero-head plans are empty, and graph/planner input bounds are stable", () => {
  assert.deepEqual(planCausalCheckpoints([], []), { ok: true, steps: [], frontier: [] });
  assert.equal(planCausalCheckpoints([id(1)], [id(2)]).reason, "unexpected-checkpoint-ids");
  assert.equal(planCausalCheckpoints(Array.from({ length: 10_001 }, (_, index) => id(index + 1)), []).reason, "invalid-causal-frontier");
  assert.equal(analyzeCausalGraph(Array.from({ length: 10_001 }, (_, index) => record(index + 1)), { groupId: group }).reason, "causal-graph-too-large");
  assert.equal(analyzeCausalGraph([], {}).reason, "invalid-group-id");
  assert.deepEqual(analyzeCausalGraph([null, { id: "bad" }], { groupId: group }).diagnostics,
    [{ recordId: null, status: "quarantined", reason: "invalid-causal-record" },
      { recordId: "bad", status: "quarantined", reason: "invalid-causal-record" }]);
  const malformedEdges = analyzeCausalGraph([record(1, { causalHeads: "not-an-array" })], { groupId: group });
  assert.equal(malformedEdges.diagnostics[0].reason, "invalid-causal-edges");
});

test("aggregate canonical graph bytes are bounded", () => {
  const oversized = { ...record(1), payload: "x".repeat(16 * 1024 * 1024) };
  assert.deepEqual(analyzeCausalGraph([oversized], { groupId: group }), { ok: false, reason: "causal-graph-too-large" });
});
