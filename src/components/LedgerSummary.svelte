<script>
  let { group, transfers, money, personName } = $props();
</script>

<section class="card">
  <h2>Settle up</h2>
  <ul>
    {#if transfers.length}
      {#each transfers as transfer}
        <li><strong>{personName(transfer.from)}</strong> pays <strong>{personName(transfer.to)}</strong> {money(transfer.amount)}</li>
      {/each}
    {:else}
      <li>Everyone is settled.</li>
    {/if}
  </ul>
</section>

<section class="card">
  <h2>History</h2>
  <ol>
    {#if group.events.length}
      {#each [...group.events].reverse() as event (event.id)}
        <li><strong>{event.description}</strong> — {money(event.amount)} paid by {personName(event.payerId)}<small>{new Date(event.createdAt).toLocaleString()}</small></li>
      {/each}
    {:else}
      <li>No expenses yet.</li>
    {/if}
  </ol>
</section>
