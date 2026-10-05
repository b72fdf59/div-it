<script>
  import { onMount } from "svelte";
  import ExpenseForm from "./components/ExpenseForm.svelte";
  import GroupSettings from "./components/GroupSettings.svelte";
  import LedgerSummary from "./components/LedgerSummary.svelte";
  import PeopleCard from "./components/PeopleCard.svelte";
  import { openGroup } from "./group.js";
  import { formatCents, settlementPlan } from "./ledger.js";
  import { projectGroup } from "./prototype-events.js";

  let group = $state.raw({ name: "My group", currency: "USD", people: [], events: [] });
  let ready = $state(false);
  let statusMessage = $state("");
  let activeView = $state("activity");
  let reversingEventId = $state("");
  let reversalReason = $state("");
  let groupController;
  let expenseDialog = $state();
  let projection = $derived(ready ? projectGroup(group) : { balances: {}, effective: [], pending: [], conflicting: [], quarantined: [], unsupported: [], readOnly: false });
  let readOnly = $derived(projection.readOnly || group.groupIdentityIssue);
  let balanceMap = $derived(Object.fromEntries(group.people.map(({ id }) => [id, projection.balances[id] || 0])));
  let transfers = $derived(readOnly ? [] : settlementPlan(balanceMap));
  let reversedSettlementIds = $derived(new Set(projection.effective.filter(({ type }) => type === "settlement-reversed").map(({ payload }) => payload.settlementId)));
  let recentEvents = $derived([...projection.effective].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  let money = (amount) => formatCents(amount, group.currency);
  let personName = (id) => group.people.find((person) => person.id === id)?.name || "Unknown";

  onMount(async () => {
    groupController = await openGroup((nextGroup) => {
      group = nextGroup;
      ready = true;
    });
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js");
  });

  function addPerson(name) {
    try {
      const person = groupController.addPerson(name);
      statusMessage = `${person.name} added.`;
      return true;
    } catch (cause) {
      statusMessage = cause.message;
      return false;
    }
  }

  function addExpense(input) {
    groupController.addExpense(input);
    statusMessage = "Expense saved locally.";
    expenseDialog.close();
    return true;
  }

  function recordSettlement(transfer) {
    try {
      groupController.recordSettlement({ fromParticipantId: transfer.from, toParticipantId: transfer.to, amount: transfer.amount });
      statusMessage = "Settlement saved locally. Prototype attribution is unsigned.";
      return true;
    } catch (cause) {
      statusMessage = cause.message;
      return false;
    }
  }

  function reverseSettlement(eventId) {
    try {
      groupController.reverseSettlement({ eventId, reason: reversalReason });
      statusMessage = "Settlement reversal saved locally. Prototype attribution is unsigned.";
      reversingEventId = "";
      reversalReason = "";
      return true;
    } catch (cause) {
      statusMessage = cause.message;
      return false;
    }
  }

  function saveSettings(input) {
    try {
      groupController.saveSettings(input);
      statusMessage = "Group saved locally.";
      return true;
    } catch (cause) {
      statusMessage = cause.message;
      return false;
    }
  }

  function exportBackup() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(group, null, 2)], { type: "application/json" }));
    const link = Object.assign(document.createElement("a"), { href: url, download: "div-it-backup.json" });
    link.click();
    URL.revokeObjectURL(url);
  }

  async function importBackup(event) {
    try {
      const imported = JSON.parse(await event.currentTarget.files[0].text());
      groupController.importBackup(imported);
      statusMessage = "Backup imported.";
    } catch (cause) {
      statusMessage = cause.message;
    }
  }
</script>

{#if ready}
  <main class="app-shell">
    <header class="app-header">
      <p class="eyebrow">GROUP</p>
      <h1>{group.name}</h1>
      <p class="prototype-attribution">Local prototype only: participant attribution is a placeholder and signatures are not active.</p>
      <p id="notice" aria-live="polite">{statusMessage}</p>
    </header>

    {#if readOnly || projection.pending.length || projection.conflicting.length || projection.quarantined.length}
      <aside class="ledger-warning" role="alert">
        {#if readOnly}<p>This ledger is incomplete or has an ambiguous group identity. Balances may be incomplete and editing is disabled until the group is restored or the app is updated.</p>{/if}
        {#if projection.pending.length}<p>{projection.pending.length} ledger {projection.pending.length === 1 ? "entry is" : "entries are"} waiting for missing dependencies.</p>{/if}
        {#if projection.conflicting.length}<p>{projection.conflicting.length} ledger {projection.conflicting.length === 1 ? "entry needs" : "entries need"} conflict review.</p>{/if}
        {#if projection.quarantined.length}<p>{projection.quarantined.length} invalid ledger {projection.quarantined.length === 1 ? "entry was" : "entries were"} ignored.</p>{/if}
      </aside>
    {/if}

    {#if activeView === "activity"}
      <section aria-labelledby="activity-title" class="view">
        <h2 id="activity-title">Recent activity</h2>
        <ol class="activity-list">
          {#if recentEvents.length}
            {#each recentEvents as event (event.id)}
              <li>
                {#if event.type === "expense-created" || event.type === "expense-revised"}
                  <strong>{event.payload.description}</strong> — {money(event.payload.amount)} paid by {personName(event.payload.payerId)}
                {:else if event.type === "settlement-recorded"}
                  <strong>{personName(event.payload.fromParticipantId)} paid {personName(event.payload.toParticipantId)}</strong> — {money(event.payload.amount)}
                  {#if reversedSettlementIds.has(event.payload.settlementId)}
                    <small>Reversed</small>
                  {:else}
                    <button type="button" disabled={readOnly} onclick={() => { reversingEventId = event.id; reversalReason = ""; }}>Reverse settlement</button>
                    {#if reversingEventId === event.id}
                      <form onsubmit={(e) => { e.preventDefault(); reverseSettlement(event.id); }}>
                        <label>Reason for reversal <input bind:value={reversalReason} maxlength="500" required></label>
                        <button type="submit" disabled={readOnly}>Confirm reversal</button>
                      </form>
                    {/if}
                  {/if}
                {:else if event.type === "settlement-reversed"}
                  <strong>Settlement reversed</strong> — {event.payload.reason}
                {:else if event.type === "expense-voided"}
                  <strong>Expense voided</strong> — {event.payload.reason}
                {:else}
                  <strong>Ledger entry</strong>
                {/if}
                <small>{new Date(event.createdAt).toLocaleString()}</small>
              </li>
            {/each}
          {:else}
            <li>No expenses yet.</li>
          {/if}
        </ol>
      </section>
    {:else if activeView === "balances"}
      <section aria-labelledby="balances-title" class="view">
        <h2 id="balances-title">Balances</h2>
        <LedgerSummary {transfers} {money} {personName} {balanceMap} people={group.people} recordSettlement={recordSettlement} disabled={readOnly} />
      </section>
    {:else}
      <section aria-labelledby="group-title" class="view">
        <h2 id="group-title">Group</h2>
        <GroupSettings {group} save={saveSettings} disabled={readOnly} />
        <PeopleCard people={group.people} {addPerson} disabled={readOnly} />
        <section class="card" aria-label="Group backup">
          <h3>Backup</h3>
          <button type="button" onclick={exportBackup}>Export backup</button>
          <label class="import">Import backup <input type="file" accept="application/json" onchange={importBackup}></label>
        </section>
      </section>
    {/if}

    <button class="expense-fab" type="button" disabled={readOnly} onclick={() => expenseDialog.showModal()}><span aria-hidden="true">＋</span> Add expense</button>
    <nav class="bottom-nav" aria-label="Primary">
      {#each [["activity", "Activity"], ["balances", "Balances"], ["group", "Group"]] as [view, label]}
        <button type="button" aria-current={activeView === view ? "page" : undefined} onclick={() => activeView = view}>{label}</button>
      {/each}
    </nav>

    <dialog bind:this={expenseDialog} aria-labelledby="expense-title">
      <h2 id="expense-title">Add expense</h2>
      <form method="dialog"><button class="dialog-close" aria-label="Close">Close</button></form>
      <ExpenseForm people={group.people} {addExpense} disabled={readOnly} />
    </dialog>
  </main>
{:else}
  <main><p>Loading local group…</p></main>
{/if}
