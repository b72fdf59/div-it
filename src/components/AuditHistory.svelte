<script>
  import { auditSummary } from "../audit.js";

  let { entries, filtered = false, personName, money, onBack, onAll } = $props();
</script>

<section class="view audit-view" aria-labelledby="audit-title">
  <div class="audit-heading">
    <div>
      <p class="eyebrow">AUDIT</p>
      <h2 id="audit-title">{filtered ? "Audit chain" : "Complete audit history"}</h2>
    </div>
    <div class="audit-actions">
      {#if filtered}<button type="button" onclick={onAll}>View all events</button>{/if}
      <button type="button" onclick={onBack}>Back to Activity</button>
    </div>
  </div>
  <p class="audit-note">All stored entries appear here, including entries that do not affect balances. Timestamps describe events; references and validation determine balances.</p>
  {#if entries.length}
    <ol class="audit-list">
      {#each entries as entry (`${entry.id}-${entry.index}`)}
        <li class="audit-entry">
          <div class="audit-entry-heading">
            <strong>{entry.event?.type || "Stored event"}</strong>
            <span>Status: {entry.status}</span>
          </div>
          <p>{auditSummary(entry.event, personName, money)}</p>
          <dl>
            <dt>Event ID</dt><dd>{entry.id}</dd>
            {#if entry.event?.author}
              <dt>Attributed to</dt><dd>{entry.event.author.participantId} · {entry.event.author.deviceId} · key {entry.event.author.keyId}</dd>
            {/if}
            <dt>References</dt><dd>{entry.refs.length ? entry.refs.join(", ") : "None"}</dd>
            {#if entry.missingDependencies.length}<dt>Missing dependencies</dt><dd>{entry.missingDependencies.join(", ")}</dd>{/if}
            <dt>Diagnostics</dt><dd>{entry.reasons.length ? entry.reasons.join(", ") : "None"}</dd>
            {#if entry.event?.createdAt}<dt>Recorded at</dt><dd>{entry.event.createdAt}</dd>{/if}
          </dl>
          <details>
            <summary>Stored event data</summary>
            <pre>{JSON.stringify(entry.raw, null, 2)}</pre>
          </details>
        </li>
      {/each}
    </ol>
  {:else}
    <p>No events in this audit chain.</p>
  {/if}
</section>
