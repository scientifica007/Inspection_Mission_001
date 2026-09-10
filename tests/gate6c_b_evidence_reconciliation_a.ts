import * as S from "./gate6c_b_evidence_support.ts";
import type { EvidenceObjectAllocation, EvidenceSource, EvidenceSourceKind, ManagedEvidenceObject, StagedEvidenceObject } from "./gate6c_b_evidence_support.ts";
const { APP_ERR, EvidenceMaintenanceQueue, EvidenceService, FakeAcquisition, FakeStorage, ProxyAdapter, SCHEMA_SQL, NOW, HASH_A, ok, assert, rejectsCode, count, uuid, finalRef, stagingRef, allocation, syntheticEvidenceRow, freshWorld, createInput, insertEvidenceRaw, serviceFor, getItem, deferred, isCanonicalStorageRef, isCanonicalStagingRef, openFreshDb, successSource } = S;

// K — reconciliation
await ok("G6C-B-41 reconciliation removes canonical .incoming residue", async () => {
    const w = await freshWorld(); const storage = new FakeStorage([allocation(90)]); storage.incoming.add(stagingRef(90));
    const report = await serviceFor(w.db, storage).reconcileEvidence();
    assert(getItem(report, "INCOMING_REMOVED", stagingRef(90)) !== undefined, "incoming removal reported"); assert(!storage.incoming.has(stagingRef(90)), "incoming removed");
});
await ok("G6C-B-42 reconciliation removes final zero-reference orphan", async () => {
    const w = await freshWorld(); const storage = new FakeStorage([allocation(91)]); storage.putFinal(finalRef(91)); const report = await serviceFor(w.db, storage).reconcileEvidence();
    assert(getItem(report, "ORPHAN_REMOVED", finalRef(91)) !== undefined && !storage.finals.has(finalRef(91)), "orphan removed");
});
await ok("G6C-B-43 one committed row + present final is valid", async () => {
    const w = await freshWorld(); const id = await insertEvidenceRaw(w.db, "VISIT", w.ownerIds.VISIT, finalRef(92)); const storage = new FakeStorage([allocation(92)]); storage.putFinal(finalRef(92)); const report = await serviceFor(w.db, storage).reconcileEvidence();
    const item = getItem(report, "VALID_REFERENCE", finalRef(92)); assert(item !== undefined && "evidenceId" in item && item.evidenceId === id, "valid reference expected"); assert(storage.statLog.includes(finalRef(92)), "reconciliation must stat a present committed object");
});
await ok("G6C-B-44 one committed row + missing final => BROKEN_STORAGE_REFERENCE and row retained", async () => {
    const w = await freshWorld(); const id = await insertEvidenceRaw(w.db, "VISIT", w.ownerIds.VISIT, finalRef(93)); const report = await serviceFor(w.db, new FakeStorage([allocation(93)])).reconcileEvidence();
    assert(getItem(report, "BROKEN_STORAGE_REFERENCE", finalRef(93)) !== undefined, "broken ref expected"); assert(await count(w.db, "SELECT count(*) AS c FROM evidence WHERE evidence_id = ?", [id]) === 1, "row retained");
});
await ok("G6C-B-45 duplicate committed storage_ref => conflict, never orphan, file retained", async () => {
    const w = await freshWorld(); await insertEvidenceRaw(w.db, "VISIT", w.ownerIds.VISIT, finalRef(94)); await insertEvidenceRaw(w.db, "VISIT", w.ownerIds.VISIT, finalRef(94)); const storage = new FakeStorage([allocation(94)]); storage.putFinal(finalRef(94), "shared"); const report = await serviceFor(w.db, storage).reconcileEvidence();
    assert(getItem(report, "STORAGE_REF_CONFLICT", finalRef(94)) !== undefined, "conflict expected"); assert(storage.finals.has(finalRef(94)) && !storage.removedOrphans.includes(finalRef(94)), "duplicate-ref file must be retained");
});
await ok("G6C-B-46 malformed committed storage_ref is diagnosed and never resolved/deleted", async () => {
    const w = await freshWorld(); const id = await insertEvidenceRaw(w.db, "VISIT", w.ownerIds.VISIT, "../../outside/evidence.bin"); const storage = new FakeStorage([allocation(95)]); const report = await serviceFor(w.db, storage).reconcileEvidence();
    assert(getItem(report, "BROKEN_STORAGE_REFERENCE", "../../outside/evidence.bin") !== undefined, "malformed ref diagnosed"); assert(await count(w.db, "SELECT count(*) AS c FROM evidence WHERE evidence_id = ?", [id]) === 1, "row retained");
});
await ok("G6C-B-47 unknown managed file is retained", async () => {
    const w = await freshWorld(); const storage = new FakeStorage([allocation(96)]); storage.unknownObjects.push({ kind: "UNKNOWN", ref: "evidence/v1/mystery/object.tmp" }); const report = await serviceFor(w.db, storage).reconcileEvidence();
    assert(getItem(report, "UNKNOWN_MANAGED_OBJECT", "evidence/v1/mystery/object.tmp") !== undefined, "unknown object reported"); assert(storage.removedOrphans.length === 0 && storage.removedIncoming.length === 0, "unknown object not deleted");
});
await ok("G6C-B-48 orphan cleanup failure is surfaced without stopping complete report", async () => {
    const w = await freshWorld(); const storage = new FakeStorage([allocation(97)]); storage.putFinal(finalRef(97)); storage.putFinal(finalRef(98)); storage.failRemoveOrphanRefs.add(finalRef(97)); const report = await serviceFor(w.db, storage).reconcileEvidence();
    assert(getItem(report, "ORPHAN_CLEANUP_FAILED", finalRef(97)) !== undefined, "cleanup failure reported"); assert(getItem(report, "ORPHAN_REMOVED", finalRef(98)) !== undefined, "reconciliation continued to later object");
});
await ok("G6C-B-49 malformed .incoming-like object is not silently deleted", async () => {
    const w = await freshWorld(); const storage = new FakeStorage([allocation(99)]); storage.incoming.add("evidence/v1/.incoming/not-a-uuid.part"); const report = await serviceFor(w.db, storage).reconcileEvidence();
    assert(getItem(report, "UNKNOWN_MANAGED_OBJECT", "evidence/v1/.incoming/not-a-uuid.part") !== undefined, "malformed incoming retained/diagnosed"); assert(storage.incoming.has("evidence/v1/.incoming/not-a-uuid.part"), "must remain");
});

// L — hash behavior
await ok("G6C-B-50 explicit hash mismatch => HASH_MISMATCH and retains row/file", async () => {
    const w = await freshWorld(); const id = await insertEvidenceRaw(w.db, "VISIT", w.ownerIds.VISIT, finalRef(100)); const storage = new FakeStorage([allocation(100)]); storage.putFinal(finalRef(100)); storage.mismatchRefs.add(finalRef(100));
    await rejectsCode(APP_ERR.EVIDENCE_HASH_MISMATCH, () => serviceFor(w.db, storage).verifyEvidenceHash(id)); assert(storage.finals.has(finalRef(100)) && await count(w.db, "SELECT count(*) AS c FROM evidence WHERE evidence_id = ?", [id]) === 1, "retain row/file");
});
await ok("G6C-B-51 historical NULL content_hash is tolerated without hash verification", async () => {
    const w = await freshWorld(); const id = await insertEvidenceRaw(w.db, "VISIT", w.ownerIds.VISIT, finalRef(101), { hash: null }); const storage = new FakeStorage([allocation(101)]); storage.putFinal(finalRef(101)); const result = await serviceFor(w.db, storage).verifyEvidenceHash(id);
    assert(result.status === "HISTORICAL_HASH_ABSENT", "historical null hash tolerated"); assert(storage.verifyLog.length === 0, "must not invent a historical digest");
});
await ok("G6C-B-52 restart reconciliation does not hash every object by default", async () => {
    const w = await freshWorld(); await insertEvidenceRaw(w.db, "VISIT", w.ownerIds.VISIT, finalRef(102)); const storage = new FakeStorage([allocation(102)]); storage.putFinal(finalRef(102)); await serviceFor(w.db, storage).reconcileEvidence(); assert(storage.verifyLog.length === 0, "startup/default reconcile must not full-hash");
});
await ok("G6C-B-53 diagnostic reconciliation hash mismatch is machine-readable and non-destructive", async () => {
    const w = await freshWorld(); const id = await insertEvidenceRaw(w.db, "VISIT", w.ownerIds.VISIT, finalRef(103)); const storage = new FakeStorage([allocation(103)]); storage.putFinal(finalRef(103)); storage.mismatchRefs.add(finalRef(103)); const report = await serviceFor(w.db, storage).reconcileEvidence({ verifyHashes: true });
    assert(getItem(report, "HASH_MISMATCH", finalRef(103)) !== undefined, "hash mismatch reported"); assert(storage.finals.has(finalRef(103)) && await count(w.db, "SELECT count(*) AS c FROM evidence WHERE evidence_id = ?", [id]) === 1, "non-destructive");
});
await ok("G6C-B-54 resolve validates canonical storage_ref before storage resolution", async () => {
    const w = await freshWorld(); const id = await insertEvidenceRaw(w.db, "VISIT", w.ownerIds.VISIT, "content://not-managed/evidence"); const storage = new FakeStorage([allocation(104)]); await rejectsCode(APP_ERR.EVIDENCE_BROKEN_STORAGE_REFERENCE, () => serviceFor(w.db, storage).resolveEvidence(id));
});
await ok("G6C-B-55 canonical managed identity validators enforce lowercase UUID-v4 + safe extension", () => {
    assert(isCanonicalStorageRef(finalRef(105, "jpg")), "canonical final expected"); assert(isCanonicalStagingRef(stagingRef(105)), "canonical staging expected"); assert(!isCanonicalStorageRef(`evidence/v1/objects/${uuid(0xabc).toUpperCase()}.jpg`), "uppercase UUID rejected"); assert(!isCanonicalStorageRef(`evidence/v1/objects/${uuid(105)}.JPG`), "uppercase extension rejected"); assert(!isCanonicalStorageRef(`evidence/v1/objects/${uuid(105)}../jpg`), "traversal-ish ref rejected");
});
