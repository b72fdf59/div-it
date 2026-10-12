<script>
  import { onMount } from "svelte";
  import ExpenseForm from "./components/ExpenseForm.svelte";
  import ConflictReview from "./components/ConflictReview.svelte";
  import AuditHistory from "./components/AuditHistory.svelte";
  import GroupSettings from "./components/GroupSettings.svelte";
  import LedgerSummary from "./components/LedgerSummary.svelte";
  import PeopleCard from "./components/PeopleCard.svelte";
  import { openGroup } from "./group.js";
  import { formatCents, settlementPlan } from "./ledger.js";
  import { auditEntries } from "./audit.js";
  import { expenseConflictReviews, projectGroup } from "./prototype-events.js";

  let group = $state.raw({ name: "My group", currency: "USD", people: [], events: [] });
  let localGroups = $state([]);
  let activeDocumentId = $state("");
  let selectedGroupId = $state("");
  let switchingGroup = $state(false);
  let ready = $state(false);
  let statusMessage = $state("");
  let activeView = $state("activity");
  let showAudit = $state(false);
  let auditFilter = $state(null);
  let reversingEventId = $state("");
  let reversalReason = $state("");
  let editingEventId = $state("");
  let editingPayload = $state(null);
  let voidingEventId = $state("");
  let voidReason = $state("");
  let groupController;
  let expenseDialog = $state();
  let revisionDialog = $state();
  let createGroupDialog = $state();
  let newGroupName = $state("");
  let newOwnerName = $state("");
  let newGroupCurrency = $state("USD");
  let legacyActivationDialog = $state();
  let legacyActivationReview = $state.raw(null);
  let legacyActivationPlan = $state.raw(null);
  let legacyActivationOwner = $state("");
  let legacyActivationOwnerName = $state("");
  let legacyActivationDigest = $state("");
  let legacyActivationError = $state("");
  let stagingLegacyActivation = $state(false);
  let legacyReviewRequest = 0;
  let legacyStageRequest = 0;
  let projection = $derived(ready ? (group.signedMode ? group.authenticatedProjection : projectGroup(group))
    : { balances: {}, effective: [], pending: [], conflicting: [], quarantined: [], unsupported: [], readOnly: false });
  let conflictReviews = $derived(ready ? expenseConflictReviews(group, projection) : []);
  let auditItems = $derived(ready ? auditEntries(group, projection, auditFilter) : []);
  let readOnly = $derived(projection.readOnly || group.groupIdentityIssue);
  let balanceMap = $derived(Object.fromEntries(group.people.map(({ id }) => [id, projection.balances[id] || 0])));
  let transfers = $derived(readOnly ? [] : settlementPlan(balanceMap));
  let reversedSettlementIds = $derived(new Set(projection.effective.filter(({ type }) => type === "settlement-reversed").map(({ payload }) => payload.settlementId)));
  let recentEvents = $derived([...projection.effective].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  let effectiveExpenses = $derived(projection.effective.filter((event) => ["expense-created", "expense-revised"].includes(event.type)));
  let editingExpense = $derived(effectiveExpenses.find((event) => event.id === editingEventId));
  let conflictIds = $derived(new Set(projection.conflicting.map(({ id }) => id)));
  let money = (amount) => formatCents(amount, group.currency);
  let personName = (id) => group.people.find((person) => person.id === id)?.name || "Unknown";
  let auditMoney = (amount, currency) => {
    try { return formatCents(amount, currency || group.currency); }
    catch { return `${amount ?? "Invalid amount"} ${currency || "unknown currency"}`; }
  };

  function openAudit(filter = null) {
    auditFilter = filter;
    showAudit = true;
    activeView = "activity";
  }

  onMount(async () => {
    groupController = await openGroup((nextGroup, registryState) => {
      if (activeDocumentId && registryState.activeDocumentId !== activeDocumentId) {
        if (expenseDialog?.open) expenseDialog.close();
        if (revisionDialog?.open) revisionDialog.close();
        if (createGroupDialog?.open) createGroupDialog.close();
        if (legacyActivationDialog?.open) legacyActivationDialog.close();
        discardLegacyPlan();
        activeView = "activity";
        showAudit = false;
        auditFilter = null;
        editingEventId = "";
        editingPayload = null;
        voidingEventId = "";
        voidReason = "";
        reversingEventId = "";
        reversalReason = "";
        statusMessage = "";
      }
      group = nextGroup;
      localGroups = registryState.groups;
      activeDocumentId = registryState.activeDocumentId;
      selectedGroupId = registryState.activeDocumentId;
      ready = true;
    });
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js");
  });

  async function switchGroup(event) {
    selectedGroupId = event.currentTarget.value;
    switchingGroup = true;
    ready = false;
    try {
      await groupController.switchGroup(selectedGroupId);
    } catch (cause) {
      statusMessage = cause.message;
      selectedGroupId = activeDocumentId;
      ready = true;
    } finally {
      switchingGroup = false;
    }
  }

  function openNewGroup() {
    newGroupName = "";
    newOwnerName = "";
    newGroupCurrency = "USD";
    statusMessage = "";
    createGroupDialog.showModal();
  }

  async function createGroup() {
    switchingGroup = true;
    try {
      await groupController.createGroup({ name: newGroupName, currency: newGroupCurrency, ownerName: newOwnerName });
      createGroupDialog.close();
      ready = false;
      newGroupName = "";
      newOwnerName = "";
      newGroupCurrency = "USD";
    } catch (cause) {
      statusMessage = cause.message;
    } finally {
      switchingGroup = false;
    }
  }

  async function openLegacyActivation() {
    const request = ++legacyReviewRequest;
    const sourceDocumentId = groupController.getActiveDocumentId();
    try {
      legacyActivationError = "";
      legacyActivationPlan = null;
      legacyActivationOwner = "";
      legacyActivationOwnerName = group.people[0]?.name || "";
      legacyActivationDigest = "";
      const review = await groupController.reviewLegacyActivation();
      if (request !== legacyReviewRequest || review.sourceDocumentId !== sourceDocumentId
          || groupController.getActiveDocumentId() !== sourceDocumentId) return;
      legacyActivationReview = review;
      legacyActivationDialog.showModal();
    } catch (cause) { if (request === legacyReviewRequest) statusMessage = cause.message; }
  }

  async function stageLegacyActivation() {
    if (stagingLegacyActivation) return;
    const request = ++legacyStageRequest;
    const review = legacyActivationReview;
    stagingLegacyActivation = true;
    legacyActivationError = "";
    try {
      if (legacyActivationDigest !== legacyActivationReview.review.digest?.value) throw new Error("Enter the displayed digest exactly to approve this source snapshot.");
      legacyActivationPlan = await groupController.stageLegacyActivation({
        sourceDocumentId: review.sourceDocumentId,
        source: review.source,
        approvedDigest: review.review.digest,
        selectedOwnerSourceParticipantId: review.review.participants.length ? legacyActivationOwner : undefined,
        emptySourceOwnerName: legacyActivationOwnerName
      });
      if (request !== legacyStageRequest || !legacyActivationDialog?.open || legacyActivationReview !== review) {
        groupController.cancelLegacyActivation(legacyActivationPlan.activationId);
        legacyActivationPlan = null;
      }
    } catch (cause) { if (request === legacyStageRequest && legacyActivationDialog?.open) legacyActivationError = cause.message; }
    finally { stagingLegacyActivation = false; }
  }

  async function activateLegacyGroup() {
    switchingGroup = true;
    try {
      await groupController.activateLegacyGroup(legacyActivationPlan.activationId);
      legacyActivationDialog.close();
      legacyActivationReview = null;
      legacyActivationPlan = null;
      statusMessage = "Verified signed group activated. The original group is preserved.";
    } catch (cause) { legacyActivationError = cause.message; }
    finally { switchingGroup = false; }
  }

  function discardLegacyPlan() {
    legacyStageRequest++;
    legacyReviewRequest++;
    if (legacyActivationPlan?.activationId) groupController.cancelLegacyActivation(legacyActivationPlan.activationId);
    legacyActivationPlan = null;
  }

  async function addPerson(name) {
    try {
      const person = await groupController.addPerson(name);
      statusMessage = `${person.name} added.`;
      return true;
    } catch (cause) {
      statusMessage = cause.message;
      return false;
    }
  }

  async function addExpense(input) {
    try {
      await groupController.addExpense(input);
      statusMessage = group.signedMode ? "Signed expense saved locally." : "Expense saved locally.";
      expenseDialog.close();
      return true;
    } catch (cause) {
      statusMessage = cause.message;
      return false;
    }
  }

  async function changeExpense(input) {
    try {
      await groupController.reviseExpense({ ...input, eventId: editingEventId });
      statusMessage = group.signedMode ? "Signed expense revision saved locally. Previous entries remain in the backup." : "Expense revision saved locally. Previous entries remain in the backup.";
      editingEventId = "";
      revisionDialog.close();
      return true;
    } catch (cause) {
      statusMessage = cause.message;
      return false;
    }
  }

  async function voidExpense(eventId) {
    try {
      await groupController.voidExpense({ eventId, reason: voidReason });
      statusMessage = group.signedMode ? "Signed expense void saved locally. Previous entries remain in the backup." : "Expense void saved locally. Previous entries remain in the backup.";
      voidingEventId = "";
      voidReason = "";
      return true;
    } catch (cause) {
      statusMessage = cause.message;
      return false;
    }
  }

  async function resolveConflict(input) {
    try {
      await groupController.resolveExpenseConflict(input);
      statusMessage = group.signedMode ? "Signed conflict choice saved locally. Other branches remain in backup history." : "Conflict choice saved locally. Other branches remain in backup history.";
      return true;
    } catch (cause) {
      statusMessage = cause.message;
      return false;
    }
  }

  function canChangeExpense(event) {
    const expenseId = event.payload.expenseId;
    return !group.events.some((item) => conflictIds.has(item?.id) && item?.payload?.expenseId === expenseId);
  }

  function openRevision(event) {
    editingEventId = event.id;
    editingPayload = structuredClone(event.payload);
    revisionDialog.showModal();
  }

  async function recordSettlement(transfer) {
    try {
      await groupController.recordSettlement({ fromParticipantId: transfer.from, toParticipantId: transfer.to, amount: transfer.amount });
      statusMessage = group.signedMode ? "Signed settlement saved locally." : "Settlement saved locally. Prototype attribution is unsigned.";
      return true;
    } catch (cause) {
      statusMessage = cause.message;
      return false;
    }
  }

  async function reverseSettlement(eventId) {
    try {
      await groupController.reverseSettlement({ eventId, reason: reversalReason });
      statusMessage = group.signedMode ? "Signed settlement reversal saved locally." : "Settlement reversal saved locally. Prototype attribution is unsigned.";
      reversingEventId = "";
      reversalReason = "";
      return true;
    } catch (cause) {
      statusMessage = cause.message;
      return false;
    }
  }

  function saveSettings(input) {
    try {
      groupController.saveSettings(input);
      statusMessage = "Group saved locally.";
      return true;
    } catch (cause) {
      statusMessage = cause.message;
      return false;
    }
  }

  function exportBackup() {
    const backup = group.signedMode ? { format: "div-it-signed-group-backup-v1", groupId: group.groupId, name: group.name,
      currency: group.currency, membershipRecords: group.membershipRecords, ledgerRecords: group.ledgerRecords,
      legacyAttestations: group.legacyAttestations || [] } : group;
    const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" }));
    const link = Object.assign(document.createElement("a"), { href: url, download: "div-it-backup.json" });
    link.click();
    URL.revokeObjectURL(url);
  }

  async function importBackup(event) {
    try {
      const imported = JSON.parse(await event.currentTarget.files[0].text());
      groupController.importBackup(imported);
      statusMessage = "Backup imported.";
    } catch (cause) {
      statusMessage = cause.message;
    }
  }
</script>

{#if ready}
  <main class="app-shell">
    {#key activeDocumentId}
    <header class="app-header">
      <p class="eyebrow">GROUP</p>
      <h1>{group.name}</h1>
      <div class="group-switcher">
        <label>Current group
          <select aria-label="Current group" value={selectedGroupId} onchange={switchGroup} disabled={switchingGroup}>
            {#each localGroups as item (item.documentId)}<option value={item.documentId}>{item.name}</option>{/each}
          </select>
        </label>
        <button type="button" class="secondary-action" aria-label="Create new" onclick={openNewGroup} disabled={switchingGroup}>New</button>
      </div>
      {#if group.signedMode}
        <p class="prototype-attribution">Signed local group · membership and ledger changes are verified on this device.</p>
      {:else}
        <p class="prototype-attribution">Local prototype only: participant attribution is a placeholder and signatures are not active.</p>
      {/if}
      <p id="notice" aria-live="polite">{statusMessage}</p>
    </header>

    {#if readOnly || projection.pending.length || projection.conflicting.length || projection.quarantined.length}
      <aside class="ledger-warning" role="alert">
        {#if readOnly}<p>This ledger is incomplete or has an ambiguous group identity. Balances may be incomplete and editing is disabled until the group is restored or the app is updated.</p>{/if}
        {#if projection.pending.length}<p>{projection.pending.length} ledger {projection.pending.length === 1 ? "entry is" : "entries are"} waiting for missing dependencies.</p>{/if}
        {#if projection.conflicting.length}<p>{projection.conflicting.length} ledger {projection.conflicting.length === 1 ? "entry needs" : "entries need"} conflict review.</p>{/if}
        {#if projection.quarantined.length}<p>{projection.quarantined.length} invalid ledger {projection.quarantined.length === 1 ? "entry was" : "entries were"} ignored.</p>{/if}
      </aside>
    {/if}

    {#if activeView === "activity"}
      {#if showAudit}
        <AuditHistory entries={auditItems} filtered={Boolean(auditFilter)} {personName} money={auditMoney}
          onBack={() => { showAudit = false; auditFilter = null; }} onAll={() => auditFilter = null} />
      {:else}
      <section aria-labelledby="activity-title" class="view">
        <h2 id="activity-title">Recent activity</h2>
        <button type="button" class="secondary-action" onclick={() => openAudit()}>Open audit history</button>
        <ConflictReview reviews={conflictReviews} people={group.people} {money} resolve={resolveConflict} onAudit={(expenseId) => openAudit({ expenseId })} disabled={readOnly} />
        <ol class="activity-list">
          {#if recentEvents.length}
            {#each recentEvents as event (event.id)}
              <li>
                {#if event.type === "expense-created" || event.type === "expense-revised"}
                  <strong>{event.payload.description}</strong> — {money(event.payload.amount)} paid by {personName(event.payload.payerId)}
                  {#if event.type === "expense-revised"}<small>Effective revision</small>{/if}
                  {#if canChangeExpense(event)}
                    <button type="button" disabled={readOnly} onclick={() => openRevision(event)}>Revise expense</button>
                    <button type="button" disabled={readOnly} onclick={() => { voidingEventId = event.id; voidReason = ""; }}>Void expense</button>
                  {:else}
                    <small>Changes need conflict review</small>
                  {/if}
                  {#if voidingEventId === event.id}
                    <form onsubmit={(e) => { e.preventDefault(); voidExpense(event.id); }}>
                      <label>Reason for voiding <input bind:value={voidReason} maxlength="500" required></label>
                      <button type="submit" disabled={readOnly}>Confirm void</button>
                      <button type="button" onclick={() => voidingEventId = ""}>Cancel</button>
                    </form>
                  {/if}
                {:else if event.type === "settlement-recorded"}
                  <strong>{personName(event.payload.fromParticipantId)} paid {personName(event.payload.toParticipantId)}</strong> — {money(event.payload.amount)}
                  {#if reversedSettlementIds.has(event.payload.settlementId)}
                    <small>Reversed</small>
                  {:else}
                    <button type="button" disabled={readOnly} onclick={() => { reversingEventId = event.id; reversalReason = ""; }}>Reverse settlement</button>
                    {#if reversingEventId === event.id}
                      <form onsubmit={(e) => { e.preventDefault(); reverseSettlement(event.id); }}>
                        <label>Reason for reversal <input bind:value={reversalReason} maxlength="500" required></label>
                        <button type="submit" disabled={readOnly}>Confirm reversal</button>
                      </form>
                    {/if}
                  {/if}
                {:else if event.type === "settlement-reversed"}
                  <strong>Settlement reversed</strong> — {event.payload.reason}
                {:else if event.type === "expense-voided"}
                  <strong>Expense voided</strong> — {event.payload.reason}
                {:else if event.type === "conflict-resolved"}
                  <strong>Expense change selected</strong>
                {:else}
                  <strong>Ledger entry</strong>
                {/if}
                {#if event.payload?.expenseId}
                  <button type="button" class="secondary-action" onclick={() => openAudit({ expenseId: event.payload.expenseId })}>View audit chain</button>
                {:else if event.payload?.settlementId}
                  <button type="button" class="secondary-action" onclick={() => openAudit({ settlementId: event.payload.settlementId })}>View audit chain</button>
                {/if}
                <small>{new Date(event.createdAt).toLocaleString()}</small>
              </li>
            {/each}
          {:else}
            <li>No expenses yet.</li>
          {/if}
        </ol>
      </section>
      {/if}
    {:else if activeView === "balances"}
      <section aria-labelledby="balances-title" class="view">
        <h2 id="balances-title">Balances</h2>
        <LedgerSummary {transfers} {money} {personName} {balanceMap} people={group.people} recordSettlement={recordSettlement} disabled={readOnly} signedMode={group.signedMode} />
      </section>
    {:else}
      <section aria-labelledby="group-title" class="view">
        <h2 id="group-title">Group</h2>
        {#if !group.signedMode}
          <section class="card" aria-label="Activate legacy group">
            <h3>Activate as a signed group</h3>
            <p>This creates a separate signed group. The current group and its history remain unchanged.</p>
            <button type="button" onclick={openLegacyActivation} disabled={switchingGroup}>Review legacy activation</button>
          </section>
        {/if}
        <GroupSettings {group} save={saveSettings} disabled={readOnly || group.signedMode} />
        <PeopleCard people={group.people} {addPerson} disabled={readOnly} />
        <section class="card" aria-label="Group backup">
          <h3>Backup</h3>
          <button type="button" onclick={exportBackup}>Export backup</button>
          <label class="import">Import backup <input type="file" accept="application/json" onchange={importBackup}></label>
        </section>
      </section>
    {/if}

    <button class="expense-fab" type="button" disabled={readOnly} onclick={() => expenseDialog.showModal()}><span aria-hidden="true">＋</span> Add expense</button>
    <nav class="bottom-nav" aria-label="Primary">
      {#each [["activity", "Activity"], ["balances", "Balances"], ["group", "Group"]] as [view, label]}
        <button type="button" aria-current={activeView === view ? "page" : undefined} onclick={() => activeView = view}>{label}</button>
      {/each}
    </nav>

    <dialog bind:this={expenseDialog} aria-labelledby="expense-title">
      <h2 id="expense-title">Add expense</h2>
      <form method="dialog"><button class="dialog-close" aria-label="Close">Close</button></form>
      <ExpenseForm people={group.people} {addExpense} disabled={readOnly} />
    </dialog>
    <dialog bind:this={createGroupDialog} aria-labelledby="new-group-title">
      <h2 id="new-group-title">Create signed group</h2>
      <form method="dialog"><button class="dialog-close" aria-label="Close">Close</button></form>
      <form onsubmit={(event) => { event.preventDefault(); createGroup(); }}>
        <label>Name for new group <input bind:value={newGroupName} required maxlength="128" disabled={switchingGroup}></label>
        <label>Your name <input bind:value={newOwnerName} required maxlength="128" disabled={switchingGroup}></label>
        <label>Currency
          <select bind:value={newGroupCurrency} disabled={switchingGroup}>
            <option>USD</option><option>INR</option><option>EUR</option><option>GBP</option>
          </select>
        </label>
        <button type="submit" disabled={switchingGroup}>Create signed group</button>
      </form>
    </dialog>
    <dialog bind:this={legacyActivationDialog} aria-labelledby="legacy-activation-title" onclose={discardLegacyPlan} oncancel={(event) => { if (switchingGroup) event.preventDefault(); }}>
      <h2 id="legacy-activation-title">Review legacy activation</h2>
      <form method="dialog"><button class="dialog-close" aria-label="Close" onclick={discardLegacyPlan} disabled={switchingGroup}>Close</button></form>
      {#if legacyActivationReview}
        {#if legacyActivationError}<p role="alert">{legacyActivationError}</p>{/if}
        <p><strong>Legacy history is unverified.</strong> The original events are retained for audit; they cannot prove individual authorship.</p>
        <p>Source group: {legacyActivationReview.source.name} ({legacyActivationReview.source.groupId || "no group ID"})</p>
        <p>Currency: {legacyActivationReview.review.currency || "unavailable"}</p>
        <p>Source digest: <code>{legacyActivationReview.review.digest?.value || "unavailable"}</code></p>
        <h3>Reviewed opening balances</h3>
        {#if legacyActivationReview.review.openingBalances.length}
          <ul>{#each legacyActivationReview.review.openingBalances as item (item.participantId)}
            <li>{legacyActivationReview.review.participants.find(({ participantId }) => participantId === item.participantId)?.name || item.participantId}: {formatCents(item.amount, legacyActivationReview.review.currency)}</li>
          {/each}
          </ul>
        {:else}<p>No opening balances.</p>{/if}
        {#if !legacyActivationReview.review.activationReady}
          <p role="alert">This source cannot be activated: {legacyActivationReview.review.blockers.map(({ reason }) => reason).join(", ")}</p>
        {:else if !legacyActivationPlan}
          {#if legacyActivationReview.review.participants.length}
            <label>Choose the current source owner
              <select bind:value={legacyActivationOwner} required disabled={stagingLegacyActivation}>
                <option value="" disabled>Select owner</option>
                {#each legacyActivationReview.review.participants as person (person.participantId)}
                  <option value={person.participantId}>{person.name}</option>
                {/each}
              </select>
            </label>
          {:else}
            <label>Name for the new owner <input bind:value={legacyActivationOwnerName} required maxlength="128" disabled={stagingLegacyActivation}></label>
          {/if}
          <label>Type the source digest to approve <input bind:value={legacyActivationDigest} required autocomplete="off" disabled={stagingLegacyActivation}></label>
          <button type="button" onclick={stageLegacyActivation} disabled={stagingLegacyActivation || (legacyActivationReview.review.participants.length ? !legacyActivationOwner : !legacyActivationOwnerName.trim())}>Approve digest and review mapping</button>
        {:else}
          <h3>Exact participant mapping</h3>
          {#if legacyActivationPlan.mapping.length}
            <ul>{#each legacyActivationPlan.mapping as item (item.sourceParticipantId)}
              <li>{legacyActivationReview.review.participants.find(({ participantId }) => participantId === item.sourceParticipantId)?.name || item.sourceParticipantId} → {item.participantId}</li>
            {/each}
            </ul>
          {:else}<p>No source participants; a new owner is created.</p>{/if}
          <h3>Opening balances ({legacyActivationPlan.currency})</h3>
          {#if legacyActivationPlan.balances.length}
            <ul>{#each legacyActivationPlan.balances as item (item.participantId)}
              <li>{legacyActivationPlan.mapping.find(({ participantId }) => participantId === item.participantId)?.sourceParticipantId || "Owner"} → {item.participantId}: {formatCents(item.amount, legacyActivationPlan.currency)}</li>
            {/each}
            </ul>
          {:else}<p>No opening balance event will be created.</p>{/if}
          <p>Digest approved: <code>{legacyActivationPlan.digest.value}</code></p>
          <button type="button" onclick={activateLegacyGroup} disabled={switchingGroup}>Confirm and activate signed group</button>
          <button type="button" onclick={discardLegacyPlan} disabled={switchingGroup}>Back to owner review</button>
        {/if}
      {/if}
    </dialog>
    <dialog bind:this={revisionDialog} aria-labelledby="revision-title">
      <h2 id="revision-title">Revise expense</h2>
      <form method="dialog"><button class="dialog-close" aria-label="Close">Close</button></form>
      {#if editingExpense}
        <ExpenseForm people={group.people} addExpense={changeExpense} initialExpense={editingPayload} title="Revise expense" submitLabel="Save revision" disabled={readOnly || !canChangeExpense(editingExpense)} />
      {:else}
        <p>This expense changed since the form opened. Close it and review the current activity.</p>
      {/if}
    </dialog>
    {/key}
  </main>
{:else}
  <main><p>Loading local group…</p></main>
{/if}
