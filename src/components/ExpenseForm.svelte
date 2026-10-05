<script>
  import { cents } from "../ledger.js";

  let { people, addExpense, initialExpense = null, title = "Add expense", submitLabel = "Add expense", disabled = false } = $props();
  let description = $state("");
  let amountText = $state("");
  let payerId = $state("");
  let participantIds = $state([]);
  let splitType = $state("equal");
  let exactAmounts = $state({});
  let error = $state("");

  $effect(() => {
    if (!initialExpense) return;
    description = initialExpense.description;
    amountText = (initialExpense.amount / 100).toFixed(2);
    payerId = initialExpense.payerId;
    participantIds = initialExpense.splits.map((split) => split.participantId);
    exactAmounts = Object.fromEntries(initialExpense.splits.map((split) => [split.participantId, (split.amount / 100).toFixed(2)]));
    splitType = "exact";
  });

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
      if (!addExpense({ description, amount, payerId, splits: splits(amount) })) return;
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
  <h2>{title}</h2>
  <form onsubmit={(event) => { event.preventDefault(); submit(); }}>
    <label>Description <input bind:value={description} placeholder="Dinner" disabled={disabled}></label>
    <label>Amount <input bind:value={amountText} inputmode="decimal" min="0.01" step="0.01" disabled={disabled}></label>
    <label>
      Paid by
      <select bind:value={payerId} disabled={disabled || !people.length}>
        {#each people as person (person.id)}<option value={person.id}>{person.name}</option>{/each}
      </select>
    </label>
    <fieldset>
      <legend>Split with</legend>
      {#if people.length}
        {#each people as person (person.id)}
          <label><input type="checkbox" value={person.id} bind:group={participantIds} disabled={disabled}> {person.name}</label>
        {/each}
      {:else}
        Add people first.
      {/if}
    </fieldset>
    <label>Split type <select bind:value={splitType} disabled={disabled}><option value="equal">Equal</option><option value="exact">Exact amounts</option></select></label>
    {#if splitType === "exact"}
      <div class="exact-splits">
        {#each people.filter((person) => participantIds.includes(person.id)) as person (person.id)}
          <label>{person.name}<input bind:value={exactAmounts[person.id]} inputmode="decimal" min="0.01" step="0.01" disabled={disabled}></label>
        {/each}
      </div>
    {/if}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <button type="submit" disabled={disabled || !people.length}>{people.length ? submitLabel : "Add people first"}</button>
  </form>
</section>
