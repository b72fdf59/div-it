<script>
  let { people, addPerson, disabled = false, signedMode = false, membership = null, localDevice = null,
    localParticipantId = null, activeDocumentId = "", trustPin = null, renameParticipant, grantOrganizer, revokeOrganizer } = $props();
  let name = $state("");
  let saving = $state(false);
  let selectedRenameId = $state("");
  let renameValue = $state("");
  let selectedRoleId = $state("");
  let roleChange = $state(null);
  let renameReview = $state(null);
  let error = $state("");

  let organizers = $derived(new Set(membership?.organizers || []));
  let enrolledDevices = $derived(membership?.devices || []);
  let selectedRename = $derived(people.find(({ id }) => id === selectedRenameId) || people[0]);
  let selectedRole = $derived(people.find(({ id }) => id === selectedRoleId) || people[0]);
  let conflicts = $derived((membership?.diagnostics || []).filter((diagnostic) => diagnostic.status === "conflicting" && diagnostic.participantId));
  let canRename = $derived(signedMode && !!localParticipantId && organizers.has(localParticipantId));
  let canManageRoles = $derived(signedMode && !!localParticipantId && localParticipantId === membership?.ownerParticipantId);

  function reviewContext() {
    return { documentId: activeDocumentId, groupId: membership?.groupId, membershipHeads: [...(membership?.heads || [])].sort(),
      trustPin: trustPin ? { ...trustPin } : null };
  }
  function contextStillCurrent(review) {
    const current = reviewContext();
    return review.documentId === current.documentId && review.groupId === current.groupId
      && review.trustPin?.genesisId === current.trustPin?.genesisId
      && review.trustPin?.publicKeyFingerprint === current.trustPin?.publicKeyFingerprint
      && review.membershipHeads.length === current.membershipHeads.length
      && review.membershipHeads.every((head, index) => head === current.membershipHeads[index]);
  }

  $effect(() => {
    if (saving) return;
    if (renameReview && !contextStillCurrent(renameReview.context)) {
      renameReview = null;
      error = "Membership changed since this review. Review the participant and intended rename again.";
    }
    if (roleChange && !contextStillCurrent(roleChange.context)) {
      roleChange = null;
      error = "Membership changed since this review. Review the participant and intended role change again.";
    }
  });

  async function submit() {
    const value = name.trim();
    if (!value || saving) return;
    saving = true;
    try {
      if (await addPerson(value)) name = "";
    } finally { saving = false; }
  }

  async function saveRename() {
    if (!selectedRename || !renameValue.trim() || !renameReview || saving) return;
    if (renameReview.participantId !== selectedRename.id || renameReview.name !== renameValue.trim() || !contextStillCurrent(renameReview.context)) {
      renameReview = null;
      error = "Membership changed since this review. Review the participant and intended rename again.";
      return;
    }
    saving = true;
    error = "";
    try {
      await renameParticipant(selectedRename.id, renameValue.trim(), renameReview.context);
      renameValue = "";
      renameReview = null;
    } catch (cause) {
      error = cause.message;
    } finally { saving = false; }
  }

  function reviewRename() {
    if (!selectedRename || !renameValue.trim()) return;
    renameReview = { participantId: selectedRename.id, name: renameValue.trim(), context: reviewContext() };
    error = "";
  }

  function selectRename(event) {
    selectedRenameId = event.currentTarget.value;
    renameValue = people.find(({ id }) => id === selectedRenameId)?.name || "";
  }

  function selectRole(event) {
    selectedRoleId = event.currentTarget.value;
    roleChange = null;
  }

  async function confirmRoleChange() {
    const change = roleChange;
    if (!change || saving) return;
    if (!contextStillCurrent(change.context)) {
      roleChange = null;
      error = "Membership changed since this review. Review the participant and intended role change again.";
      return;
    }
    saving = true;
    error = "";
    try {
      const save = change.organizer ? grantOrganizer : revokeOrganizer;
      await save(change.participantId, change.context);
      roleChange = null;
    } catch (cause) {
      error = cause.message;
    } finally { saving = false; }
  }
</script>

<section class="card people-card" aria-label="People and roles">
  <h2>People</h2>
  {#if error}<p role="alert" class="form-error">{error}</p>{/if}
  {#if !signedMode || canRename}
    <form onsubmit={(event) => { event.preventDefault(); submit(); }}>
      <input bind:value={name} placeholder="Name" aria-label="Person name" disabled={disabled || saving}>
      <button type="submit" disabled={disabled || saving}>Add</button>
    </form>
  {/if}
  <h3>Participants</h3>
  <ul class="people">
    {#if people.length}
      {#each people as person (person.id)}
        {@const personDevices = enrolledDevices.filter((device) => device.participantId === person.id)}
        <li>
          <strong>{person.name || "Name conflict"}</strong>
          {#if signedMode}
            <span>{person.id === membership?.ownerParticipantId ? "Owner" : organizers.has(person.id) ? "Organizer" : "Member"}</span>
            <small>{personDevices.length} enrolled {personDevices.length === 1 ? "device" : "devices"}</small>
            {#if person.id === localParticipantId && localDevice}
              <small> This device: {localDevice.deviceId} · key {localDevice.keyId} · {localDevice.publicKeyFingerprint}</small>
            {/if}
          {/if}
        </li>
      {/each}
    {:else}
      <li>Add people to begin.</li>
    {/if}
  </ul>

  {#if signedMode}
    {#if conflicts.length}
      <aside role="alert" aria-label="Unresolved membership conflicts">
        <h3>Unresolved roster conflicts</h3>
        <ul>{#each conflicts as conflict, index (`${conflict.type}:${conflict.participantId}:${index}`)}
          <li>{conflict.reason === "participant-name-conflict" ? "Competing participant names" : "Competing organizer roles"} for {people.find(({ id }) => id === conflict.participantId)?.name || "participant"} ({conflict.participantId}): {conflict.recordIds?.join(", ") || "competing signed records"}. No branch was selected.</li>
        {/each}</ul>
      </aside>
    {/if}
    {#if canRename && people.length}
      <section aria-label="Rename participant">
        <h3>Rename participant</h3>
        <label>Participant
          <select aria-label="Participant to rename" value={selectedRename?.id || ""} onchange={(event) => { selectRename(event); renameReview = null; }} disabled={disabled || saving}>
            {#each people as person (person.id)}<option value={person.id}>{person.name || person.id} · {person.id}</option>{/each}
          </select>
        </label>
        <label>New name
          <input aria-label="New participant name" bind:value={renameValue} disabled={disabled || saving}>
        </label>
        {#if selectedRename}
          <p>Rename <strong>{selectedRename.name || selectedRename.id}</strong> ({selectedRename.id}) to <strong>{renameValue.trim() || "(enter a name)"}</strong>.</p>
        {/if}
        <button type="button" onclick={reviewRename} disabled={disabled || saving || !selectedRename || !renameValue.trim()}>
          Review rename
        </button>
        {#if renameReview}
          <p>Confirm rename: <strong>{selectedRename?.name || renameReview.participantId}</strong> ({renameReview.participantId}) to <strong>{renameReview.name}</strong>.</p>
          <button type="button" onclick={saveRename} disabled={disabled || saving}>Confirm this rename</button>
        {/if}
      </section>
    {/if}
    {#if canManageRoles && people.length}
      <section aria-label="Organizer role management">
        <h3>Organizer roles</h3>
        <label>Participant
          <select aria-label="Participant for role change" value={selectedRole?.id || ""} onchange={selectRole} disabled={disabled || saving}>
            {#each people as person (person.id)}<option value={person.id}>{person.name || person.id} · {person.id}</option>{/each}
          </select>
        </label>
        {#if selectedRole}
          <p>Selected: <strong>{selectedRole.name || selectedRole.id}</strong> ({selectedRole.id}) · current role: {selectedRole.id === membership?.ownerParticipantId ? "Owner" : organizers.has(selectedRole.id) ? "Organizer" : "Member"}</p>
          <button type="button" onclick={() => { roleChange = { participantId: selectedRole.id, organizer: true, context: reviewContext() }; error = ""; }} disabled={disabled || saving || organizers.has(selectedRole.id)}>
            Review organizer grant
          </button>
          <button type="button" onclick={() => { roleChange = { participantId: selectedRole.id, organizer: false, context: reviewContext() }; error = ""; }} disabled={disabled || saving || !organizers.has(selectedRole.id) || selectedRole.id === membership?.ownerParticipantId}>
            Review organizer revocation
          </button>
          {#if roleChange}
            <p>Confirm: {roleChange.organizer ? "grant organizer authority to" : "revoke organizer authority from"} <strong>{people.find(({ id }) => id === roleChange.participantId)?.name}</strong> ({roleChange.participantId}).</p>
            <button type="button" onclick={confirmRoleChange} disabled={disabled || saving}>
              Confirm {roleChange.organizer ? "grant" : "revocation"}
            </button>
          {/if}
        {/if}
      </section>
    {/if}
  {/if}
</section>
