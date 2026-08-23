<script>
  import { onMount } from "svelte";
  import ExpenseForm from "./components/ExpenseForm.svelte";
  import GroupSettings from "./components/GroupSettings.svelte";
  import LedgerSummary from "./components/LedgerSummary.svelte";
  import PeopleCard from "./components/PeopleCard.svelte";
  import { openGroup } from "./group.js";
  import { balances, formatCents, makeExpense, settlementPlan } from "./ledger.js";

  let group = $state.raw({ name: "My group", currency: "USD", people: [], events: [] });
  let ready = $state(false);
  let statusMessage = $state("");
  let groupController;
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

  function change(mutator, message) {
    statusMessage = message;
    groupController.change(mutator);
  }

  function addPerson(name) {
    change((document) => document.people.push({ id: crypto.randomUUID(), name }), `${name} added.`);
  }

  function addExpense(input) {
    const expense = makeExpense(input);
    change((document) => document.events.push(expense), "Expense saved locally.");
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
      if (!Array.isArray(imported.people) || !Array.isArray(imported.events)) throw new Error("Not a Div It backup.");
      groupController.replace(imported);
      statusMessage = "Backup imported.";
    } catch (cause) {
      statusMessage = cause.message;
    }
  }
</script>

{#if ready}
  <main>
    <header><p class="eyebrow">LOCAL-FIRST EXPENSE SHARING</p><h1>Div It</h1><p id="notice" aria-live="polite">{statusMessage}</p></header>
    <GroupSettings {group} save={(nextGroup) => change((document) => { document.name = nextGroup.name; document.currency = nextGroup.currency; }, "Group saved locally.")} />
    <div class="grid">
      <PeopleCard people={group.people} {balanceMap} {money} {addPerson} />
      <ExpenseForm people={group.people} {addExpense} />
    </div>
    <LedgerSummary {group} {transfers} {money} {personName} />
    <footer><button type="button" onclick={exportBackup}>Export backup</button><label class="import">Import backup <input type="file" accept="application/json" onchange={importBackup}></label></footer>
  </main>
{:else}
  <main><p>Loading local group…</p></main>
{/if}
