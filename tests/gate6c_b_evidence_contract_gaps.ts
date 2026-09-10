import * as S from "./gate6c_b_evidence_support.ts";
import type { EvidenceObjectAllocation, EvidenceSource, ManagedEvidenceObject, StagedEvidenceObject } from "./gate6c_b_evidence_support.ts";
const { APP_ERR, EvidenceApplicationContext, EvidenceService, FakeAcquisition, FakeStorage, ProxyAdapter, HASH_B, ok, assert, rejectsCode, count, finalRef, allocation, freshWorld, createInput, insertEvidenceRaw, deferred } = S;

class BlockingStageStorage extends FakeStorage {
    readonly entered = deferred<void>();
    readonly release = deferred<void>();
    activeStages = 0;
    maxActiveStages = 0;
    listCalls = 0;
    blockFirst = true;
    override async stage(source: EvidenceSource, a: EvidenceObjectAllocation): Promise<StagedEvidenceObject> {
        this.activeStages += 1;
        this.maxActiveStages = Math.max(this.maxActiveStages, this.activeStages);
        if (this.blockFirst) { this.blockFirst = false; this.entered.resolve(); await this.release.promise; }
        try { return await super.stage(source, a); } finally { this.activeStages -= 1; }
    }
    override async listManagedObjects(): Promise<ManagedEvidenceObject[]> { this.listCalls += 1; return super.listManagedObjects(); }
}

class BlockingReconcileStorage extends FakeStorage {
    readonly entered = deferred<void>();
    readonly release = deferred<void>();
    override async listManagedObjects(): Promise<ManagedEvidenceObject[]> {
        this.entered.resolve();
        await this.release.promise;
        return super.listManagedObjects();
    }
}

await ok("G6C-B-71 shared application context serializes create/create across two services", async () => {
    const w = await freshWorld(); const context = new EvidenceApplicationContext();
    const storage = new BlockingStageStorage([allocation(171), allocation(172)]);
    const acq1 = new FakeAcquisition(); const acq2 = new FakeAcquisition();
    const svc1 = new EvidenceService(w.db, acq1, storage, context); const svc2 = new EvidenceService(w.db, acq2, storage, context);
    await svc1.reconcileEvidence();
    const p1 = svc1.createEvidence(createInput("VISIT", w.ownerIds.VISIT)); await storage.entered.promise;
    const p2 = svc2.createEvidence(createInput("VISIT", w.ownerIds.VISIT)); await Promise.resolve(); await Promise.resolve();
    assert(acq2.calls.length === 0, "second service cannot enter while first create owns shared boundary");
    storage.release.resolve(); await Promise.all([p1, p2]);
    assert(storage.maxActiveStages === 1, "create critical sections do not overlap");
    assert(await count(w.db, "SELECT count(*) AS c FROM evidence") === 2, "both serialized creates commit once");
});

await ok("G6C-B-72 shared application context serializes create/reconciliation across services", async () => {
    const w = await freshWorld(); const context = new EvidenceApplicationContext();
    const storage = new BlockingStageStorage([allocation(173)]);
    const svc1 = new EvidenceService(w.db, new FakeAcquisition(), storage, context); const svc2 = new EvidenceService(w.db, new FakeAcquisition(), storage, context);
    await svc1.reconcileEvidence(); const baseline = storage.listCalls;
    const create = svc1.createEvidence(createInput("VISIT", w.ownerIds.VISIT)); await storage.entered.promise;
    const reconcile = svc2.reconcileEvidence(); await Promise.resolve(); await Promise.resolve();
    assert(storage.listCalls === baseline, "reconciliation cannot overlap active create");
    storage.release.resolve(); await create; await reconcile;
    assert(storage.listCalls === baseline + 1, "queued reconciliation runs after create");
});

await ok("G6C-B-73 EvidenceService has no silent per-instance default maintenance context", async () => {
    const w = await freshWorld();
    await rejectsCode(APP_ERR.CONFIG, async () => { new EvidenceService(w.db, new FakeAcquisition(), new FakeStorage([allocation(174)]), undefined as never); });
});

await ok("G6C-B-74 create before reconciliation is side-effect free and blocked", async () => {
    const w = await freshWorld(); const context = new EvidenceApplicationContext(); const acq = new FakeAcquisition();
    const storage = new FakeStorage([allocation(175)]); const proxy = new ProxyAdapter(w.db); const svc = new EvidenceService(proxy, acq, storage, context);
    await rejectsCode(APP_ERR.EVIDENCE_RECONCILIATION_REQUIRED, () => svc.createEvidence(createInput("VISIT", w.ownerIds.VISIT)));
    assert(acq.calls.length === 0, "no acquisition before readiness");
    assert(storage.allocationLog.length === 0 && storage.stageLog.length === 0 && storage.publishLog.length === 0, "no allocation/stage/publish before readiness");
    assert(proxy.evidenceInsertCount === 0 && await count(w.db, "SELECT count(*) AS c FROM evidence") === 0, "no Evidence INSERT before readiness");
    assert(context.readiness === "RECONCILIATION_REQUIRED", "fresh context remains REQUIRED");
});

await ok("G6C-B-75 successful startup reconciliation enables create", async () => {
    const w = await freshWorld(); const context = new EvidenceApplicationContext(); const svc = new EvidenceService(w.db, new FakeAcquisition(), new FakeStorage([allocation(176)]), context);
    await svc.reconcileEvidence(); assert(context.readiness === "READY", "reconciliation establishes READY");
    assert((await svc.createEvidence(createInput("VISIT", w.ownerIds.VISIT))).status === "CREATED", "create works after readiness");
});

await ok("G6C-B-76 fatal reconciliation failure returns REQUIRED and keeps create blocked", async () => {
    const w = await freshWorld(); const context = new EvidenceApplicationContext(); const acq = new FakeAcquisition(); const storage = new FakeStorage([allocation(177)]); storage.failListManagedObjects = true;
    const svc = new EvidenceService(w.db, acq, storage, context);
    await rejectsCode(APP_ERR.EVIDENCE_ORPHAN_CLEANUP_FAILED, () => svc.reconcileEvidence());
    assert(context.readiness === "RECONCILIATION_REQUIRED", "failure restores REQUIRED");
    await rejectsCode(APP_ERR.EVIDENCE_RECONCILIATION_REQUIRED, () => svc.createEvidence(createInput("VISIT", w.ownerIds.VISIT)));
    assert(acq.calls.length === 0 && storage.allocationLog.length === 0 && storage.publishLog.length === 0, "blocked create remains side-effect free");
});

await ok("G6C-B-77 reconciliation retry is safe and can establish readiness", async () => {
    const w = await freshWorld(); const context = new EvidenceApplicationContext(); const storage = new FakeStorage([allocation(178)]); storage.failListManagedObjects = true;
    const svc = new EvidenceService(w.db, new FakeAcquisition(), storage, context);
    await rejectsCode(APP_ERR.EVIDENCE_ORPHAN_CLEANUP_FAILED, () => svc.reconcileEvidence()); storage.failListManagedObjects = false;
    const report = await svc.reconcileEvidence(); assert(Array.isArray(report.items) && context.readiness === "READY", "retry returns report and READY");
    assert((await svc.createEvidence(createInput("VISIT", w.ownerIds.VISIT))).status === "CREATED", "create works after successful retry");
});

await ok("G6C-B-78 create during active reconciliation fails before acquisition", async () => {
    const w = await freshWorld(); const context = new EvidenceApplicationContext(); const acq = new FakeAcquisition(); const storage = new BlockingReconcileStorage([allocation(179)]);
    const svc = new EvidenceService(w.db, acq, storage, context); const reconciling = svc.reconcileEvidence(); await storage.entered.promise;
    assert(context.readiness === "RECONCILING", "runtime exposes RECONCILING");
    await rejectsCode(APP_ERR.EVIDENCE_RECONCILIATION_REQUIRED, () => svc.createEvidence(createInput("VISIT", w.ownerIds.VISIT)));
    assert(acq.calls.length === 0 && storage.allocationLog.length === 0 && storage.publishLog.length === 0, "no create side effect while reconciling");
    storage.release.resolve(); await reconciling; assert(context.readiness === "READY", "successful reconciliation reaches READY");
});

await ok("G6C-B-79 committed size/hash equal validated published metadata", async () => {
    const w = await freshWorld(); const context = new EvidenceApplicationContext(); const storage = new FakeStorage([allocation(180)]); storage.stageFileSize = 777; storage.stageHash = HASH_B;
    const svc = new EvidenceService(w.db, new FakeAcquisition(), storage, context); await svc.reconcileEvidence();
    const result = await svc.createEvidence(createInput("VISIT", w.ownerIds.VISIT)); assert(result.status === "CREATED" && storage.lastPublishedResult !== null, "publish result expected");
    const rows = await w.db.query("SELECT file_size,content_hash FROM evidence WHERE evidence_id=?", [result.evidence.evidenceId]);
    assert(Number(rows[0].file_size) === storage.lastPublishedResult!.fileSize, "persisted size comes from validated final result");
    assert(String(rows[0].content_hash) === storage.lastPublishedResult!.contentHash, "persisted hash comes from validated final result");
});

await ok("G6C-B-80 malformed published SHA-256 is rejected", async () => {
    const w = await freshWorld(); const context = new EvidenceApplicationContext(); const storage = new FakeStorage([allocation(181)]); storage.publishedHashOverride = `sha256:${"A".repeat(64)}`;
    const svc = new EvidenceService(w.db, new FakeAcquisition(), storage, context); await svc.reconcileEvidence();
    await rejectsCode(APP_ERR.EVIDENCE_HASH_FAILED, () => svc.createEvidence(createInput("VISIT", w.ownerIds.VISIT)));
    assert(await count(w.db, "SELECT count(*) AS c FROM evidence") === 0, "malformed published hash commits zero rows");
});

await ok("G6C-B-81 published size disagreement is rejected", async () => {
    const w = await freshWorld(); const context = new EvidenceApplicationContext(); const storage = new FakeStorage([allocation(182)]); storage.publishedFileSizeOverride = 999;
    const svc = new EvidenceService(w.db, new FakeAcquisition(), storage, context); await svc.reconcileEvidence();
    await rejectsCode(APP_ERR.EVIDENCE_STORAGE_WRITE_FAILED, () => svc.createEvidence(createInput("VISIT", w.ownerIds.VISIT)));
    assert(await count(w.db, "SELECT count(*) AS c FROM evidence") === 0, "size disagreement commits zero rows");
});

await ok("G6C-B-82 published hash disagreement is rejected", async () => {
    const w = await freshWorld(); const context = new EvidenceApplicationContext(); const storage = new FakeStorage([allocation(183)]); storage.publishedHashOverride = HASH_B;
    const svc = new EvidenceService(w.db, new FakeAcquisition(), storage, context); await svc.reconcileEvidence();
    await rejectsCode(APP_ERR.EVIDENCE_HASH_FAILED, () => svc.createEvidence(createInput("VISIT", w.ownerIds.VISIT)));
    assert(await count(w.db, "SELECT count(*) AS c FROM evidence") === 0, "hash disagreement commits zero rows");
});

await ok("G6C-B-83 wrong published storage_ref is rejected", async () => {
    const w = await freshWorld(); const context = new EvidenceApplicationContext(); const storage = new FakeStorage([allocation(184)]); storage.publishedStorageRefOverride = finalRef(999);
    const svc = new EvidenceService(w.db, new FakeAcquisition(), storage, context); await svc.reconcileEvidence();
    await rejectsCode(APP_ERR.EVIDENCE_STORAGE_WRITE_FAILED, () => svc.createEvidence(createInput("VISIT", w.ownerIds.VISIT)));
    assert(await count(w.db, "SELECT count(*) AS c FROM evidence") === 0, "wrong published ref commits zero rows");
});

await ok("G6C-B-84 published fileSize must be a non-negative integer", async () => {
    const w = await freshWorld(); const context = new EvidenceApplicationContext(); const storage = new FakeStorage([allocation(185)]); storage.publishedFileSizeOverride = -1;
    const svc = new EvidenceService(w.db, new FakeAcquisition(), storage, context); await svc.reconcileEvidence();
    await rejectsCode(APP_ERR.EVIDENCE_STORAGE_WRITE_FAILED, () => svc.createEvidence(createInput("VISIT", w.ownerIds.VISIT)));
    assert(await count(w.db, "SELECT count(*) AS c FROM evidence") === 0, "invalid published size commits zero rows");
});

await ok("G6C-B-85 publication-metadata cleanup requires fresh zero-reference proof", async () => {
    const w = await freshWorld(); const context = new EvidenceApplicationContext(); const events: string[] = []; const proxy = new ProxyAdapter(w.db, events);
    const storage = new FakeStorage([allocation(186)], events); storage.publishedFileSizeOverride = 999;
    const svc = new EvidenceService(proxy, new FakeAcquisition(), storage, context); await svc.reconcileEvidence(); events.length = 0;
    await rejectsCode(APP_ERR.EVIDENCE_STORAGE_WRITE_FAILED, () => svc.createEvidence(createInput("VISIT", w.ownerIds.VISIT)));
    const proof = events.indexOf("db:storage-ref-query:tx"); const removal = events.indexOf(`removeOrphan:${finalRef(186)}`);
    assert(proof >= 0 && removal > proof, "orphan deletion follows fresh exact-ref SQLite proof");
    assert(await count(w.db, "SELECT count(*) AS c FROM evidence") === 0 && !storage.finals.has(finalRef(186)), "zero-reference final may be cleaned");

    const w2 = await freshWorld(); const context2 = new EvidenceApplicationContext(); const proxy2 = new ProxyAdapter(w2.db); const storage2 = new FakeStorage([allocation(187)]); storage2.publishedFileSizeOverride = 999;
    storage2.onPublish = async (ref) => { await insertEvidenceRaw(w2.db, "VISIT", w2.ownerIds.VISIT, ref); };
    const svc2 = new EvidenceService(proxy2, new FakeAcquisition(), storage2, context2); await svc2.reconcileEvidence();
    await rejectsCode(APP_ERR.EVIDENCE_STORAGE_WRITE_FAILED, () => svc2.createEvidence(createInput("VISIT", w2.ownerIds.VISIT)));
    assert(proxy2.evidenceInsertCount === 0, "attempt does not INSERT after invalid final metadata");
    assert(storage2.finals.has(finalRef(187)) && !storage2.removedOrphans.includes(finalRef(187)), "committed reference preserves final object");
});
