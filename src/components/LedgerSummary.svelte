<script>
  import { cents } from "../ledger.js";

  let { transfers, money, personName, balanceMap, people, recordSettlement, disabled = false } = $props();
  let from = $state("");
  let to = $state("");
  let amount = $state("");
  let error = $state("");

  $effect(() => {
    const ids = people.map(({ id }) => id);
    if (!ids.includes(from)) from = ids[0] || "";
    if (!ids.includes(to) || to === from) to = ids.find((id) => id !== from) || "";
  });

  function submit() {
    try {
      if (!recordSettlement({ from, to, amount: cents(amount) })) return;
      amount = "";
      error = "";
    } catch (cause) {
      error = cause.message;
    }
  }
</script>

<section class="card" aria-labelledby="settle-title">
  <h3 id="settle-title">Suggested settlements</h3>
  <ul>
      {#if disabled}
        <li>Settlement suggestions are unavailable while the ledger is incomplete.</li>
      {:else if transfers.length}
      {#each transfers as transfer}
        <li><strong>{personName(transfer.from)}</strong> pays <strong>{personName(transfer.to)}</strong> {money(transfer.amount)} <button type="button" disabled={disabled} onclick={() => recordSettlement(transfer)}>Record suggested payment</button></li>
      {/each}
    {:else}
      <li>Everyone is settled.</li>
    {/if}
  </ul>
</section>

<section class="card" aria-labelledby="record-settlement-title">
  <h3 id="record-settlement-title">Record a manual payment</h3>
  <form onsubmit={(event) => { event.preventDefault(); submit(); }}>
    <label>Paid by <select bind:value={from} disabled={disabled || people.length < 2}>{#each people as person (person.id)}<option value={person.id}>{person.name}</option>{/each}</select></label>
    <label>Paid to <select bind:value={to} disabled={disabled || people.length < 2}>{#each people.filter(({ id }) => id !== from) as person (person.id)}<option value={person.id}>{person.name}</option>{/each}</select></label>
    <label>Amount <input bind:value={amount} inputmode="decimal" min="0.01" step="0.01" disabled={disabled || people.length < 2}></label>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <button type="submit" disabled={disabled || people.length < 2}>Record payment</button>
  </form>
  <small>Recorded locally with prototype attribution; signatures are not active.</small>
</section>

<section class="card" aria-labelledby="everyone-title">
  <h3 id="everyone-title">Everyone</h3>
  <ul class="balances">
    {#each Object.entries(balanceMap) as [personId, balance] (personId)}
      <li><strong>{personName(personId)}</strong><span>{disabled ? "Incomplete" : balance === 0 ? "Settled" : `${balance > 0 ? "Owed" : "Owes"} ${money(Math.abs(balance))}`}</span></li>
    {:else}
      <li>Add people to see balances.</li>
    {/each}
  </ul>
</section>
