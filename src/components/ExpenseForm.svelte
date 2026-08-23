<script>
  import { cents } from "../ledger.js";

  let { people, addExpense } = $props();
  let description = $state("");
  let amountText = $state("");
  let payerId = $state("");
  let participantIds = $state([]);
  let splitType = $state("equal");
  let exactAmounts = $state({});
  let error = $state("");

  $effect(() => {
    const ids = people.map((person) => person.id);
    if (!ids.includes(payerId)) payerId = ids[0] || "";
    const retainedIds = participantIds.filter((id) => ids.includes(id));
    if (retainedIds.length !== participantIds.length) participantIds = retainedIds;
    if (!retainedIds.length && ids.length) participantIds = ids;
  });

  function splits(amount) {
    if (splitType === "exact") return participantIds.map((personId) => ({ personId, amount: cents(exactAmounts[personId]) }));
    if (!participantIds.length) throw new Error("Choose at least one participant.");
    return participantIds.map((personId, index) => ({ personId, amount: Math.floor(amount / participantIds.length) + (index < amount % participantIds.length ? 1 : 0) }));
  }

  function submit() {
    try {
      const amount = cents(amountText);
      addExpense({ description, amount, payerId, splits: splits(amount) });
      description = "";
      amountText = "";
      exactAmounts = {};
      error = "";
    } catch (cause) {
      error = cause.message;
    }
  }
</script>

<section class="card">
  <h2>Add expense</h2>
  <form onsubmit={(event) => { event.preventDefault(); submit(); }}>
    <label>Description <input bind:value={description} placeholder="Dinner"></label>
    <label>Amount <input bind:value={amountText} inputmode="decimal" min="0.01" step="0.01"></label>
    <label>
      Paid by
      <select bind:value={payerId} disabled={!people.length}>
        {#each people as person (person.id)}<option value={person.id}>{person.name}</option>{/each}
      </select>
    </label>
    <fieldset>
      <legend>Split with</legend>
      {#if people.length}
        {#each people as person (person.id)}
          <label><input type="checkbox" value={person.id} bind:group={participantIds}> {person.name}</label>
        {/each}
      {:else}
        Add people first.
      {/if}
    </fieldset>
    <label>Split type <select bind:value={splitType}><option value="equal">Equal</option><option value="exact">Exact amounts</option></select></label>
    {#if splitType === "exact"}
      <div class="exact-splits">
        {#each people.filter((person) => participantIds.includes(person.id)) as person (person.id)}
          <label>{person.name}<input bind:value={exactAmounts[person.id]} inputmode="decimal" min="0.01" step="0.01"></label>
        {/each}
      </div>
    {/if}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <button type="submit" disabled={!people.length}>{people.length ? "Add expense" : "Add people first"}</button>
  </form>
</section>
