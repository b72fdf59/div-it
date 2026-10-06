# DIV-034 delivery evidence

`event-store.test.mjs` exercises real Automerge replicas rather than passing permutations directly to the projector.

- Concurrent replicas append the same expense, independent malformed and foreign-group records, a future-schema record, a revision, and a settlement reversal. Merging in either direction, then saving/loading, produces the same canonical raw event set, diagnostics, effective history, balances, and audit entries.
- The present reversal remains pending while its referenced settlement record is missing from the domain event set. A separate replica later delivers that settlement; the reversal becomes effective and the settlement/reversal pair nets to zero. The test also asserts that a record absent from Automerge is absent from the raw set, rather than reported as a pending event.
- Concurrent revisions from opposite replicas remain conflicting in either merge direction. The uncontested base remains effective with independently asserted balances; branch values never win from transport or insertion order.
- Exact duplicate delivery is covered by the concurrent exact-duplicate test, which merges independently written replicas, preserves both raw copies, and asserts the expense projects once with a duplicate diagnostic.

Acceptance on this revision: `npm test` (94 passed), `npm run build` (passed), and `npm run test:browser` (16 passed). The browser suite is included as a regression check; DIV-034 changes no browser behavior.
