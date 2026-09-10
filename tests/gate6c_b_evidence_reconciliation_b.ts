import * as S from "./gate6c_b_evidence_support.ts";
import type { EvidenceObjectAllocation, EvidenceSource, EvidenceSourceKind, ManagedEvidenceObject, StagedEvidenceObject } from "./gate6c_b_evidence_support.ts";
const { APP_ERR, EvidenceMaintenanceQueue, EvidenceService, FakeAcquisition, FakeStorage, ProxyAdapter, SCHEMA_SQL, NOW, HASH_A, ok, assert, rejectsCode, count, uuid, finalRef, stagingRef, allocation, syntheticEvidenceRow, freshWorld, createInput, insertEvidenceRaw, serviceFor, getItem, deferred, isCanonicalStorageRef, isCanonicalStagingRef, openFreshDb, successSource } = S;

// M — shared serialization boundary
class BlockingStorage extends FakeStorage {
    readonly entered = deferred<void>();
    readonly release = deferred<void>();
    activeStages = 0;
    maxActiveStages = 0;
    blockFirst = true;
    listCalls = 0;
    override async stage(source: EvidenceSource, a: EvidenceObjectAllocation): Promise<StagedEvidenceObject> {
        this.activeStages += 1; this.maxActiveStages = Math.max(this.maxActiveStages, this.activeStages);
        if (this.blockFirst) { this.blockFirst = false; this.entered.resolve(); await this.release.promise; }
        try { return await super.stage(source, a); } finally { this.activeStages -= 1; }
    }
    override async listManagedObjects(): Promise<ManagedEvidenceObject[]> { this.listCalls += 1; return super.listManagedObjects(); }
}

await ok("G6C-B-56 create/create calls do not overlap Evidence critical section", async () => {
    const w = await freshWorld(); const acq = new FakeAcquisition(); const storage = new BlockingStorage([allocation(110), allocation(111)]); const queue = new EvidenceMaintenanceQueue(); const svc = serviceFor(w.db, storage, acq, { maintenance: queue });
    const p1 = svc.createEvidence(createInput("VISIT", w.ownerIds.VISIT)); await storage.entered.promise; const p2 = svc.createEvidence(createInput("VISIT", w.ownerIds.VISIT)); await Promise.resolve(); await Promise.resolve();
    assert(acq.calls.length === 1, "second create must not enter while first is blocked"); storage.release.resolve(); await Promise.all([p1, p2]); assert(storage.maxActiveStages === 1, "stage critical sections must not overlap");
});

await ok("G6C-B-57 create/reconciliation calls share the same serialization boundary", async () => {
    const w = await freshWorld(); const storage = new BlockingStorage([allocation(112)]); const queue = new EvidenceMaintenanceQueue(); const svc = serviceFor(w.db, storage, new FakeAcquisition(), { maintenance: queue });
    const create = svc.createEvidence(createInput("VISIT", w.ownerIds.VISIT)); await storage.entered.promise; const reconcile = svc.reconcileEvidence(); await Promise.resolve(); await Promise.resolve();
    assert(storage.listCalls === 0, "reconcile must not enter while create holds boundary"); storage.release.resolve(); await create; await reconcile; assert(storage.listCalls === 1, "reconcile runs after create releases boundary");
});

// N — no-delete / asymmetric compensation
await ok("G6C-B-58 reconciliation never deletes committed Evidence rows", async () => {
    const w = await freshWorld(); const id1 = await insertEvidenceRaw(w.db, "VISIT", w.ownerIds.VISIT, finalRef(120)); const id2 = await insertEvidenceRaw(w.db, "VISIT", w.ownerIds.VISIT, finalRef(120)); const id3 = await insertEvidenceRaw(w.db, "VISIT", w.ownerIds.VISIT, finalRef(121)); const storage = new FakeStorage([allocation(120)]); storage.putFinal(finalRef(120)); await serviceFor(w.db, storage).reconcileEvidence();
    assert(await count(w.db, "SELECT count(*) AS c FROM evidence WHERE evidence_id IN (?,?,?)", [id1, id2, id3]) === 3, "all committed rows retained");
});
await ok("G6C-B-59 EvidenceService exposes no normal deleteEvidence operation", () => { const prototype = EvidenceService.prototype as unknown as Record<string, unknown>; assert(prototype.deleteEvidence === undefined, "deleteEvidence must not exist"); });
await ok("G6C-B-60 post-publish conflict never compensates by deleting referenced final", async () => {
    const w = await freshWorld(); const proxy = new ProxyAdapter(w.db); proxy.transactionalStorageRefRows = [syntheticEvidenceRow(finalRef(122), 1220)]; const storage = new FakeStorage([allocation(122)]);
    await rejectsCode(APP_ERR.EVIDENCE_STORAGE_REF_CONFLICT, () => serviceFor(proxy, storage).createEvidence(createInput("VISIT", w.ownerIds.VISIT))); assert(storage.removedOrphans.length === 0 && storage.finals.has(finalRef(122)), "no filesystem compensation on referenced conflict");
});

// O — bounded-memory/runtime-neutral seam behavior
await ok("G6C-B-61 Application create API carries source identity/metadata, not whole bytes/base64", async () => {
    const w = await freshWorld(); const input = createInput("VISIT", w.ownerIds.VISIT); assert(!("bytes" in input) && !("base64" in input) && !("blob" in input), "public create input has no binary payload"); const acq = new FakeAcquisition(); const outcome = acq.file; assert(outcome.status === "SUCCESS", "success source expected"); assert(!("bytes" in outcome.source) && !("base64" in outcome.source), "source contract carries no whole binary");
});
await ok("G6C-B-62 storage port alone performs stage/hash responsibility", async () => {
    const w = await freshWorld(); const storage = new FakeStorage([allocation(123)]); const result = await serviceFor(w.db, storage).createEvidence(createInput("VISIT", w.ownerIds.VISIT)); assert(result.status === "CREATED" && storage.stageLog.length === 1, "stage invoked exactly once behind storage port"); assert(result.evidence.contentHash === HASH_A, "application consumes storage-produced digest metadata");
});
await ok("G6C-B-63 FILE_TOO_LARGE remains reserved and no numeric limit is applied", async () => {
    const w = await freshWorld(); const acq = new FakeAcquisition(); acq.file = successSource("GENERIC_FILE", { sizeHint: Number.MAX_SAFE_INTEGER }); const result = await serviceFor(w.db, new FakeStorage([allocation(124)]), acq).createEvidence(createInput("VISIT", w.ownerIds.VISIT)); assert(result.status === "CREATED", "no invented application-layer numeric size limit"); assert(APP_ERR.EVIDENCE_FILE_TOO_LARGE === "E_EVIDENCE_FILE_TOO_LARGE", "reserved typed code exists");
});
await ok("G6C-B-64 incoming cleanup failure is surfaced as ORPHAN_CLEANUP_FAILED", async () => {
    const w = await freshWorld(); const storage = new FakeStorage([allocation(125)]); storage.failStage = new Error("stage failed"); storage.failRemoveIncomingRefs.add(stagingRef(125)); await rejectsCode(APP_ERR.EVIDENCE_ORPHAN_CLEANUP_FAILED, () => serviceFor(w.db, storage).createEvidence(createInput("VISIT", w.ownerIds.VISIT)));
});
await ok("G6C-B-65 final orphan cleanup failure is surfaced after INSERT failure", async () => {
    const w = await freshWorld(); const proxy = new ProxyAdapter(w.db); proxy.failEvidenceInsert = true; const storage = new FakeStorage([allocation(126)]); storage.failRemoveOrphanRefs.add(finalRef(126)); await rejectsCode(APP_ERR.EVIDENCE_ORPHAN_CLEANUP_FAILED, () => serviceFor(proxy, storage).createEvidence(createInput("VISIT", w.ownerIds.VISIT))); assert(await count(w.db, "SELECT count(*) AS c FROM evidence") === 0, "DB transaction rolled back despite cleanup failure");
});
await ok("G6C-B-66 owner attachment is not restricted to Visit PREPARATION", async () => {
    const db = openFreshDb(SCHEMA_SQL);
    const missionId = Number((await db.run(`INSERT INTO mission(name,status,created_at,created_by) VALUES ('M66','PREPARATION',?,'owner')`, [NOW])).lastInsertRowid);
    const institutionId = Number((await db.run(`INSERT INTO institution(name,created_at,created_by) VALUES ('I66',?,'owner')`, [NOW])).lastInsertRowid);
    const visitId = Number((await db.run(`INSERT INTO visit(mission_id,institution_id,visit_type,visit_date,status,inspector,created_at,created_by) VALUES (?,?,'PLANNED','2026-09-10','PREPARATION','inspector-a',?,'owner')`, [missionId, institutionId, NOW])).lastInsertRowid);
    const finalized = await db.run("UPDATE visit SET status='COMPLETED', finalized_at=? WHERE visit_id=? AND status='PREPARATION'", [NOW, visitId]); assert(finalized.changes === 1, "minimal fixture visit must finalize");
    const result = await serviceFor(db, new FakeStorage([allocation(127)])).createEvidence(createInput("VISIT", visitId)); assert(result.status === "CREATED", "Evidence remains attachable later; no PREPARATION-only gate invented");
});
await ok("G6C-B-67 source kind dispatch covers CAMERA_PHOTO/GALLERY_MEDIA/GENERIC_FILE exactly", async () => {
    const kinds: EvidenceSourceKind[] = ["CAMERA_PHOTO", "GALLERY_MEDIA", "GENERIC_FILE"];
    for (const [i, kind] of kinds.entries()) { const w = await freshWorld(); const acq = new FakeAcquisition(); const result = await serviceFor(w.db, new FakeStorage([allocation(130 + i)]), acq).createEvidence(createInput("VISIT", w.ownerIds.VISIT, kind)); assert(result.status === "CREATED" && acq.calls.length === 1 && acq.calls[0] === kind, `dispatch ${kind}`); }
});
await ok("G6C-B-68 allocation must use same lowercase UUID-v4 token in final/staging refs", async () => {
    const w = await freshWorld(); const bad: EvidenceObjectAllocation = { storageRef: finalRef(140), stagingRef: stagingRef(141) }; await rejectsCode(APP_ERR.EVIDENCE_STORAGE_WRITE_FAILED, () => serviceFor(w.db, new FakeStorage([bad])).createEvidence(createInput("VISIT", w.ownerIds.VISIT))); assert(await count(w.db, "SELECT count(*) AS c FROM evidence") === 0, "invalid allocation not persisted");
});
await ok("G6C-B-69 reconciliation report ordering is deterministic", async () => {
    const w = await freshWorld(); const storage = new FakeStorage([allocation(150)]); storage.putFinal(finalRef(152)); storage.putFinal(finalRef(151)); storage.incoming.add(stagingRef(153)); storage.unknownObjects.push({ kind: "UNKNOWN", ref: "z-unknown" }); const svc = serviceFor(w.db, storage); const first = await svc.reconcileEvidence(); storage.putFinal(finalRef(152)); storage.putFinal(finalRef(151)); storage.incoming.add(stagingRef(153)); const second = await svc.reconcileEvidence(); const k1 = first.items.map(x => JSON.stringify(x)); const k2 = second.items.map(x => JSON.stringify(x)); assert(k1.length === k2.length && k1.every((v, i) => v === k2[i]), "same inputs classify in same order");
});
await ok("G6C-B-70 canonical schema has no UNIQUE(storage_ref) and service does not depend on one", async () => {
    assert(!/UNIQUE\s*\(\s*storage_ref\s*\)/i.test(SCHEMA_SQL), "canonical schema must not contain UNIQUE(storage_ref)"); const w = await freshWorld(); await insertEvidenceRaw(w.db, "VISIT", w.ownerIds.VISIT, finalRef(160)); await insertEvidenceRaw(w.db, "VISIT", w.ownerIds.VISIT, finalRef(160)); assert(await count(w.db, "SELECT count(*) AS c FROM evidence WHERE storage_ref=?", [finalRef(160)]) === 2, "schema permits fixture duplicate; app layer diagnoses it");
});
