# DIV-035 two-tab evidence

`browser-tests/two-tab-convergence.spec.js` opens two pages in one browser context and disables the real Repo BroadcastChannel adapters before offline writes. The first tab exports its current Automerge binary; the second imports that exact history under the same document ID into an ephemeral Repo with no IndexedDB storage. This gives both tabs the same starting history while ensuring shared IndexedDB cannot imply convergence.

Each tab adds a separate expense and a competing revision while disconnected. The test exports both local event sets before reconnecting and asserts each contains only its own new records. Reconnection closes and replaces each BroadcastChannel adapter through the Repo network subsystem. Without reloading either page, the test verifies both tabs show both expenses and the conflict, export identical event arrays, report identical audit entries and balances, and retain the branches after one tab explicitly resolves the conflict. It checks the expected unsettled balance before resolution and the revised balance after resolution.

The test bridge is available only in Vite development mode when the explicit `testSync` or `testReplica` query parameter is present. It adds no UI and is excluded from production builds.

Acceptance on this revision: `npm test` (94 passed), `npm run build` (passed), and `npm run test:browser` (17 passed). The manual Phase 2 gate remains open; no supported-browser sign-off has been recorded.
