# Phase 2 manual browser review (DIV-036)

**Status: Pending human run and sign-off; deferred by the owner on 2026-10-07 until first-release implementation is complete. This is a release requirement and does not block implementation.** Automated DIV-034 and DIV-035 evidence is linked below; it does not count as manual verification.

## Scope and automated evidence

The roadmap lists current and previous major versions of Safari/iOS, Chrome/Android, desktop Chrome, Edge, and Firefox. Record the browser name, full version, operating system, and device for every run. Playwright's Chromium, Firefox, and WebKit projects below are engine coverage; they do not count as runs in branded Chrome, Edge, Safari, iOS Safari, or Android Chrome, or as current/previous stable-version coverage.

- [DIV-034 delivery evidence](./div-034-delivery.md): Automerge replica delivery order, delayed/missing dependencies, malformed and unsupported entries, and conflict neutrality.
- [DIV-035 two-tab evidence](./div-035-two-tab.md): automated offline BroadcastChannel disconnect/reconnect, isolated Repo storage, live convergence, conflict resolution, balances, and audit equality.
- Automated suite on the reviewed revision: `npm test` (94 passed), `npm run build` (passed), `npm run test:browser` (17 passed; Playwright's configured Firefox runtime).
- Playwright engine matrix, full browser regression suite (2026-10-07): `npm run test:browser:matrix -- --project=chromium --project=firefox` passed 34 tests: 17 in Chromium and 17 in Firefox. Environment: Arch Linux, Playwright 1.63.0, Chrome for Testing 153.0.8010.12 (Chromium engine), Mozilla Firefox 155.0. A fresh WebKit launch probe could not start the downloaded Playwright runtime (revision 2359) because host libraries `libicu74`, `libxml2`, and `libflite1` are missing. WebKit tests are unavailable in this host environment; they have no scenario result. No system packages were installed. The matrix covers Playwright engines, not branded-browser/device rows or current/previous stable versions below.

## Run setup

1. Start a new browser profile or test account so existing prototype data stays intact. Do not clear or reset a profile that contains user data.
2. In the repository, run `npm install`, then `npm run dev -- --host 127.0.0.1`. Open `http://127.0.0.1:5173/?testSync=1` in tab 1.
3. In tab 1, create a new group named `DIV-036 Manual Gate`. Add Alice and Bob. Add a `$20.00` equal-split expense named `Shared dinner`, paid by Alice.
4. Open the same URL in tab 2, using the same browser profile. Wait for it to show the new group, participants, and expense before disconnecting either tab.

The `testSync` URL enables a development-only console bridge. In each tab's DevTools console, run:

```js
window.__divItTestSync.disconnect()
```

This calls `Repo.networkSubsystem.disconnect()` and closes the actual BroadcastChannel adapter; browser offline mode alone does not sever BroadcastChannel. The test bridge's `reconnect()` replaces the closed adapter with a fresh one:

```js
window.__divItTestSync.reconnect()
```

The bridge is only present in Vite development mode with the explicit query parameter; it is excluded from the production build.

## Two-tab scenario and expected results

1. Disconnect both tabs using the console command above.
2. In tab 1, add an equal-split `$4.00` expense named `Offline tab A expense`, paid by Alice. Revise `Shared dinner` to `$30.00`, paid by Alice, with an equal split. Confirm the revision saved locally.
3. In tab 2, add an equal-split `$6.00` expense named `Offline tab B expense`, paid by Alice. Revise the same original `Shared dinner` to `$40.00`, paid by Bob, with an equal split. Confirm the revision saved locally.
4. Before reconnecting, export each tab's backup and confirm tab 1 has its `$4.00` expense but not tab 2's `$6.00` expense, while tab 2 has its `$6.00` expense but not tab 1's `$4.00` expense. This confirms the edits were local while transport was down.
5. Reconnect each tab with the console command. Return each tab to Activity. Do not refresh either page. Confirm both tabs display both independent expenses and both competing dinner revisions, with a visible conflict choice and no branch selected automatically.
6. Open Balances in both tabs. The conflicting dinner keeps its original uncontested value; together with the independent expenses, Alice should be owed `$15.00` and Bob should owe `$15.00`.
7. In tab 1, explicitly choose Alice's `$30.00` dinner revision. Confirm tab 1 and tab 2 both remove the conflict prompt without refresh. Balances should show Alice owed `$20.00` and Bob owing `$20.00`.
8. Open Complete audit history in both tabs. Confirm both branches, the chosen resolution, and the independent expenses appear with matching statuses and references. Export a backup from each tab and compare event IDs and full event contents; both exports should match, retaining the rejected revision as audit data.

## Reviewer record

Complete one row per browser/device run. Leave it pending when not observed; do not infer a pass from automated tests.

| Browser and full version | OS/device | Reviewer | Result (pass/fail/not run) | Notes or defect link |
| --- | --- | --- | --- | --- |
| Current desktop Chrome |  |  | Not run |  |
| Previous major desktop Chrome |  |  | Not run |  |
| Current desktop Edge |  |  | Not run |  |
| Previous major desktop Edge |  |  | Not run |  |
| Current desktop Firefox |  |  | Not run |  |
| Previous major desktop Firefox |  |  | Not run |  |
| Current major Safari on iOS |  |  | Not run |  |
| Previous major Safari on iOS |  |  | Not run |  |
| Current major Chrome on Android |  |  | Not run |  |
| Previous major Chrome on Android |  |  | Not run |  |

**Human sign-off:** Pending. Reviewer: ______. Date: ______. Approval: ______. Phase 2 stays incomplete until a human reviewer records observed browser versions, results, defects (if any), and approval here and marks DIV-036 complete in `TASKS.md` and `ROADMAP.md`.
