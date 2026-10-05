<script>
  let { transfers, money, personName, balanceMap } = $props();
</script>

<section class="card" aria-labelledby="settle-title">
  <h3 id="settle-title">Suggested settlements</h3>
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

<section class="card" aria-labelledby="everyone-title">
  <h3 id="everyone-title">Everyone</h3>
  <ul class="balances">
    {#each Object.entries(balanceMap) as [personId, balance] (personId)}
      <li><strong>{personName(personId)}</strong><span>{balance === 0 ? "Settled" : `${balance > 0 ? "Owed" : "Owes"} ${money(Math.abs(balance))}`}</span></li>
    {:else}
      <li>Add people to see balances.</li>
    {/each}
  </ul>
</section>
