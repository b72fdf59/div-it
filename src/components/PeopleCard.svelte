<script>
  let { people, balanceMap, money, addPerson } = $props();
  let name = $state("");

  function submit() {
    const value = name.trim();
    if (!value) return;
    addPerson(value);
    name = "";
  }
</script>

<section class="card">
  <h2>People</h2>
  <form onsubmit={(event) => { event.preventDefault(); submit(); }}>
    <input bind:value={name} placeholder="Name" aria-label="Person name">
    <button type="submit">Add</button>
  </form>
  <ul class="people">
    {#if people.length}
      {#each people as person (person.id)}
        <li>{person.name} <span>{money(balanceMap[person.id])}</span></li>
      {/each}
    {:else}
      <li>Add people to begin.</li>
    {/if}
  </ul>
</section>
