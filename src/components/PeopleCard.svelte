<script>
  let { people, addPerson, disabled = false } = $props();
  let name = $state("");
  let saving = $state(false);

  async function submit() {
    const value = name.trim();
    if (!value || saving) return;
    saving = true;
    try {
      if (!(await addPerson(value))) return;
      name = "";
    } finally {
      saving = false;
    }
  }
</script>

<section class="card people-card">
  <h2>People</h2>
  <form onsubmit={(event) => { event.preventDefault(); submit(); }}>
    <input bind:value={name} placeholder="Name" aria-label="Person name" disabled={disabled || saving}>
    <button type="submit" disabled={disabled || saving}>Add</button>
  </form>
  <ul class="people">
    {#if people.length}
      {#each people as person (person.id)}
        <li>{person.name}</li>
      {/each}
    {:else}
      <li>Add people to begin.</li>
    {/if}
  </ul>
</section>
