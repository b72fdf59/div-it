<script>
  let { group, save } = $props();
  let name = $state("");
  let currency = $state("USD");

  $effect(() => {
    name = group.name;
    currency = group.currency;
  });

  function submit() {
    save({ ...group, name: name.trim() || "My group", currency });
  }
</script>

<section class="card">
  <label>Group name <input bind:value={name}></label>
  <label>
    Currency
    <select bind:value={currency}>
      <option>USD</option><option>INR</option><option>EUR</option><option>GBP</option>
    </select>
  </label>
  <button type="button" onclick={submit}>Save group</button>
</section>
