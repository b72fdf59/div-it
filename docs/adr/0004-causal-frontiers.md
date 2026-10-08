# ADR 0004: Bounded causal graph and frontiers

- Status: Utility contract accepted by root technical review on 2026-10-08; pending root review
- Scope: Pure causal graph validation for records already authenticated and structurally parsed by their caller
- Related contracts: [ADR-0001 event format](./0001-event-format.md), [ADR-0003 signed ledger envelope](./0003-signed-ledger-envelope.md)

## Decision

Add `src/causal-graph.js` with `analyzeCausalGraph(records, { groupId })`, `causalReachability(graph, descendantId, ancestorId)`, `validateCausalFrontier(graph, headIds)`, `maximalCausalFrontier(graph, observedIds)`, and `planCausalCheckpoints(headIds, checkpointIds)`. These helpers do not authenticate records, verify signatures, decide membership, apply financial semantics, or choose conflict winners. The caller must pass records whose signatures and envelope schemas have already been verified.

The graph uses only each record's signed `causalHeads` and `dependsOn` IDs as parent edges. It never treats `membershipHeads`, timestamps, record array position, or sort order as event-causal edges. Both edge lists must be sorted, unique canonical UUIDs; `causalHeads` is limited to 64 and `dependsOn` to 256. A record whose `causalHeads` include an ancestor of another listed head is invalid as `redundant-causal-heads`.

`analyzeCausalGraph` requires an explicit canonical `groupId`, accepts at most 10,000 records and 16 MiB of canonical input bytes, and returns detached graph data plus diagnostics sorted by record ID and reason. It stores direct parent edges rather than materializing every transitive ancestor set. Exact duplicate records with one ID fold once. Different contents under one ID quarantine that ID and records that depend on it. Missing parents are pending; cross-group records/edges, malformed frontiers, cycles, and invalid ancestry fail closed. Adding a delayed parent and rerunning analysis can move pending descendants to valid. Returned diagnostics are independent of input ordering.

`causalReachability` reports whether one known record is the same as or an ancestor of another through either explicit edge type. `validateCausalFrontier` accepts zero to 64 sorted unique, valid IDs and rejects any pair where one is an ancestor of another. This proves the supplied set is an antichain; completeness is only claimed relative to an explicit observation set. `maximalCausalFrontier` takes that set of observed IDs and returns its sorted maximal members, rejecting invalid or missing input records and more than 64 maxima. An empty observed set has an empty frontier.

## Lossless checkpoint plan

`planCausalCheckpoints` normalizes a supplied set of at most 10,000 canonical IDs to sorted unique heads. Up to 64 heads need no checkpoint. For larger sets, the caller supplies exactly `1 + ceil((N - 64) / 63)` unique checkpoint IDs, none equal to an input head. The first planned checkpoint has the first 64 original heads in `causalHeads`. Every later checkpoint has the immediately preceding checkpoint ID plus at most 63 additional original heads. Each step has an empty `dependsOn` list; the final frontier is the last checkpoint ID. This staged construction preserves reachability to every original head and every prior checkpoint without changing any underlying conflict.

The later signer integration is expected to represent a checkpoint as a normal signed protocol-v2 envelope with `type: "causal-checkpoint"`, exact payload `{}`, ordinary group/author/membership fields, planned `causalHeads`, and `dependsOn: []`. Each checkpoint ID is assigned before signing and each step is independently verified. For 65 heads this takes two checkpoints; 127 heads take two; 128 heads take three. Checkpoint records do not resolve conflicts, authorize their signer, or erase input records. This ADR only plans their signed parent edges; it does not construct or accept checkpoint signatures.

## Stable diagnostic names

Graph-level failures: `invalid-group-id`, `invalid-record-list`, and `causal-graph-too-large`. Per-record diagnostics include `invalid-causal-record`, `invalid-causal-edges`, `cross-group-record`, `cross-group-ancestry`, `missing-causal-parent`, `causal-cycle`, `causal-id-collision`, `causal-parent-id-collision`, `invalid-causal-ancestry`, and `redundant-causal-heads`. Query/planning failures include `invalid-causal-query`, `invalid-causal-frontier`, `causal-frontier-too-large`, `missing-causal-head`, `invalid-causal-graph`, `invalid-checkpoint-ids`, and `unexpected-checkpoint-ids`.

## Acceptance checks

- Causal reachability follows either explicit edge list and ignores membership heads.
- Reordered and exact-duplicate input gives the same valid graph and diagnostics.
- Missing ancestry is pending and becomes valid when the parent arrives.
- Cross-group ancestry, cycles, same-ID collisions, malformed/unsorted edges, and redundant heads fail closed.
- Frontier utilities support zero heads, reject unsorted/duplicate/redundant/oversized heads, and compute maxima only within an explicit observed set.
- Checkpoint plans for 65, 127, and 128 heads use at most 64 inputs per step and retain reachability to all originals.
- Input count and byte bounds reject deterministically without mutating caller records.
