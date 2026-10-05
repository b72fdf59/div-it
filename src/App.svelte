<script>
  import { onMount } from "svelte";
  import ExpenseForm from "./components/ExpenseForm.svelte";
  import GroupSettings from "./components/GroupSettings.svelte";
  import LedgerSummary from "./components/LedgerSummary.svelte";
  import PeopleCard from "./components/PeopleCard.svelte";
  import { openGroup } from "./group.js";
  import { balances, formatCents, settlementPlan } from "./ledger.js";

  let group = $state.raw({ name: "My group", currency: "USD", people: [], events: [] });
  let ready = $state(false);
  let statusMessage = $state("");
  let activeView = $state("activity");
  let groupController;
  let expenseDialog = $state();
  let balanceMap = $derived(balances(group.events, group.people));
  let transfers = $derived(settlementPlan(balanceMap));
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
      <p id="notice" aria-live="polite">{statusMessage}</p>
    </header>

    {#if activeView === "activity"}
      <section aria-labelledby="activity-title" class="view">
        <h2 id="activity-title">Recent activity</h2>
        <ol class="activity-list">
          {#if group.events.length}
            {#each [...group.events].reverse() as event (event.id)}
              <li><strong>{event.description}</strong> — {money(event.amount)} paid by {personName(event.payerId)}<small>{new Date(event.createdAt).toLocaleString()}</small></li>
            {/each}
          {:else}
            <li>No expenses yet.</li>
          {/if}
        </ol>
      </section>
    {:else if activeView === "balances"}
      <section aria-labelledby="balances-title" class="view">
        <h2 id="balances-title">Balances</h2>
        <LedgerSummary {transfers} {money} {personName} {balanceMap} />
      </section>
    {:else}
      <section aria-labelledby="group-title" class="view">
        <h2 id="group-title">Group</h2>
        <GroupSettings {group} save={saveSettings} />
        <PeopleCard people={group.people} {addPerson} />
        <section class="card" aria-label="Group backup">
          <h3>Backup</h3>
          <button type="button" onclick={exportBackup}>Export backup</button>
          <label class="import">Import backup <input type="file" accept="application/json" onchange={importBackup}></label>
        </section>
      </section>
    {/if}

    <button class="expense-fab" type="button" onclick={() => expenseDialog.showModal()}><span aria-hidden="true">＋</span> Add expense</button>
    <nav class="bottom-nav" aria-label="Primary">
      {#each [["activity", "Activity"], ["balances", "Balances"], ["group", "Group"]] as [view, label]}
        <button type="button" aria-current={activeView === view ? "page" : undefined} onclick={() => activeView = view}>{label}</button>
      {/each}
    </nav>

    <dialog bind:this={expenseDialog} aria-labelledby="expense-title">
      <h2 id="expense-title">Add expense</h2>
      <form method="dialog"><button class="dialog-close" aria-label="Close">Close</button></form>
      <ExpenseForm people={group.people} {addExpense} />
    </dialog>
  </main>
{:else}
  <main><p>Loading local group…</p></main>
{/if}
