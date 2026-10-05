<script>
  let { reviews, people, money, resolve, disabled = false } = $props();
  let choices = $state({});
  let error = $state("");
  const names = (id) => people.find((person) => person.id === id)?.name || "Unknown";
  const same = (left, right) => left?.length === right.length && left.every((id, index) => id === right[index]);

  function choose(review, eventId) {
    choices[review.key] = {
      branchIds: [...review.branchIds],
      resolutionIds: [...review.resolutionIds],
      branchPreviewIds: [...review.branchPreviewIds],
      branchPreviewSnapshots: [...review.branchPreviewSnapshots],
      chosenEventId: eventId
    };
    error = "";
  }

  function isStale(review, choice) {
    return choice && (!same(choice.branchIds, review.branchIds)
      || !same(choice.resolutionIds, review.resolutionIds)
      || !same(choice.branchPreviewIds, review.branchPreviewIds)
      || !same(choice.branchPreviewSnapshots, review.branchPreviewSnapshots));
  }

  function describe(event) {
    if (event.type === "expense-voided") return `Voids this expense. Reason: ${event.payload.reason}`;
    const payload = event.payload;
    const splitText = payload.splits.map((split) => `${names(split.participantId)} ${money(split.amount)}`).join(", ");
    return `${payload.description}: ${money(payload.amount)}, paid by ${names(payload.payerId)}; split ${splitText}`;
  }

  async function submit(review) {
    const choice = choices[review.key];
    if (!choice || isStale(review, choice)) return;
    error = await resolve({
      expenseId: review.expenseId,
      parentId: review.parentId,
      resolvesEventIds: choice.branchIds,
      chosenEventId: choice.chosenEventId,
      supersedesResolutionEventIds: choice.resolutionIds,
      branchPreviewIds: choice.branchPreviewIds,
      branchPreviewSnapshots: choice.branchPreviewSnapshots
    }) ? "" : "This conflict changed before the choice was saved. Review the current options.";
  }
</script>

{#if reviews.length}
  <section class="conflict-inbox" aria-labelledby="conflict-title">
    <h3 id="conflict-title">Expense changes need review</h3>
    <p>The current uncontested amount stays in balances until you choose which change to keep.</p>
    {#each reviews as review (review.key)}
      {@const choice = choices[review.key]}
      {@const stale = isStale(review, choice)}
      <article class="conflict-card">
        <h4>Competing changes</h4>
        {#if review.resolutionIds.length}
          <p>Earlier choices disagree. This choice will supersede all {review.resolutionIds.length} current choices.</p>
        {/if}
        <fieldset>
          <legend>Choose one expense change to keep</legend>
          {#each review.branches as branch, index (branch.id)}
            <label class="conflict-choice">
              <input type="radio" name={`conflict-${review.key}`} value={branch.id} checked={choice?.chosenEventId === branch.id} onchange={() => choose(review, branch.id)} disabled={disabled}>
              <span><strong>Change {index + 1}</strong> — {describe(branch.preview)}
                {#if branch.preview.id !== branch.id}<small>Latest uncontested value after: {describe(branch.event)}</small>{/if}
              </span>
            </label>
          {/each}
        </fieldset>
        {#if stale}<p role="alert">New competing changes arrived. Review the updated options and choose again.</p>{/if}
        {#if error}<p role="alert">{error}</p>{/if}
        <button type="button" disabled={disabled || !choice || stale} onclick={() => submit(review)}>Keep selected change</button>
      </article>
    {/each}
  </section>
{/if}
