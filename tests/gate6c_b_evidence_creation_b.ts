import * as S from "./gate6c_b_evidence_support.ts";
import type { AcquisitionOutcome, EvidenceOwnerKind, SqlValue } from "./gate6c_b_evidence_support.ts";
const { APP_ERR, DomainError, FakeAcquisition, FakeStorage, ProxyAdapter, HASH_B, ok, assert, rejectsCode, count, finalRef, stagingRef, allocation, syntheticEvidenceRow, freshWorld, createInput, insertEvidenceRaw, serviceFor, successSource, isCanonicalSha256 } = S;

// E/F — pre-publication and final-path collision guards
await ok("G6C-B-22 preflight exactly-one collision abandons candidate before stage/publish", async () => {
    const w = await freshWorld();
    await insertEvidenceRaw(w.db, "VISIT", w.ownerIds.VISIT, finalRef(50));
    const storage = new FakeStorage([allocation(50), allocation(51)]);
    const result = await serviceFor(w.db, storage).createEvidence(createInput("VISIT", w.ownerIds.VISIT));
    assert(result.status === "CREATED" && result.evidence.storageRef === finalRef(51), "fresh candidate expected");
    assert(!storage.stageLog.includes(finalRef(50)) && !storage.publishLog.includes(finalRef(50)), "colliding committed ref never staged/published");
});

await ok("G6C-B-23 preflight duplicate committed refs surface STORAGE_REF_CONFLICT", async () => {
    const w = await freshWorld();
    await insertEvidenceRaw(w.db, "VISIT", w.ownerIds.VISIT, finalRef(52));
    await insertEvidenceRaw(w.db, "VISIT", w.ownerIds.VISIT, finalRef(52));
    const storage = new FakeStorage([allocation(52)]);
    await rejectsCode(APP_ERR.EVIDENCE_STORAGE_REF_CONFLICT, () => serviceFor(w.db, storage).createEvidence(createInput("VISIT", w.ownerIds.VISIT)));
    assert(storage.publishLog.length === 0, "no publish on pre-existing duplicate refs");
});

await ok("G6C-B-24 final-path collision with zero DB refs preserves old object and retries", async () => {
    const w = await freshWorld();
    const storage = new FakeStorage([allocation(53), allocation(54)]);
    storage.putFinal(finalRef(53), "old-residue", 88, HASH_B);
    const result = await serviceFor(w.db, storage).createEvidence(createInput("VISIT", w.ownerIds.VISIT));
    assert(result.status === "CREATED" && result.evidence.storageRef === finalRef(54), "fresh candidate expected");
    assert(storage.finals.get(finalRef(53))?.marker === "old-residue", "existing final object preserved");
    assert(!storage.publishLog.includes(finalRef(53)), "no overwrite publish to occupied destination");
});

await ok("G6C-B-25 bounded candidate retries fail closed", async () => {
    const w = await freshWorld();
    await insertEvidenceRaw(w.db, "VISIT", w.ownerIds.VISIT, finalRef(55));
    await insertEvidenceRaw(w.db, "VISIT", w.ownerIds.VISIT, finalRef(56));
    const storage = new FakeStorage([allocation(55), allocation(56)]);
    await rejectsCode(APP_ERR.EVIDENCE_STORAGE_WRITE_FAILED, () =>
        serviceFor(w.db, storage, new FakeAcquisition(), { maxCandidateAttempts: 2 }).createEvidence(createInput("VISIT", w.ownerIds.VISIT)),
    );
    assert(storage.allocationIndex === 2, "retry loop must be bounded exactly by configured limit");
});

// G — stage/hash/stat/publish failures
await ok("G6C-B-26 stage failure leaves no Evidence row and cleans incoming", async () => {
    const w = await freshWorld(); const storage = new FakeStorage([allocation(60)]); storage.failStage = new Error("injected stage failure");
    await rejectsCode(APP_ERR.EVIDENCE_STORAGE_WRITE_FAILED, () => serviceFor(w.db, storage).createEvidence(createInput("VISIT", w.ownerIds.VISIT)));
    assert(storage.incoming.size === 0 && await count(w.db, "SELECT count(*) AS c FROM evidence") === 0, "stage failure cleanup");
});

await ok("G6C-B-27 hash failure is typed and leaves no Evidence row", async () => {
    const w = await freshWorld(); const storage = new FakeStorage([allocation(61)]); storage.failStage = new DomainError(APP_ERR.EVIDENCE_HASH_FAILED, "injected hash failure");
    await rejectsCode(APP_ERR.EVIDENCE_HASH_FAILED, () => serviceFor(w.db, storage).createEvidence(createInput("VISIT", w.ownerIds.VISIT)));
    assert(storage.incoming.size === 0 && await count(w.db, "SELECT count(*) AS c FROM evidence") === 0, "hash failure cleanup");
});

await ok("G6C-B-28 malformed new SHA-256 is rejected before publish", async () => {
    const w = await freshWorld(); const storage = new FakeStorage([allocation(62)]); storage.stageHash = `sha256:${"A".repeat(64)}`;
    await rejectsCode(APP_ERR.EVIDENCE_HASH_FAILED, () => serviceFor(w.db, storage).createEvidence(createInput("VISIT", w.ownerIds.VISIT)));
    assert(storage.publishLog.length === 0 && await count(w.db, "SELECT count(*) AS c FROM evidence") === 0, "malformed hash must not publish/insert");
});

await ok("G6C-B-29 final stat failure cleans only after zero-reference proof", async () => {
    const w = await freshWorld(); const storage = new FakeStorage([allocation(63)]); storage.failStat = true;
    await rejectsCode(APP_ERR.EVIDENCE_STORAGE_WRITE_FAILED, () => serviceFor(w.db, storage).createEvidence(createInput("VISIT", w.ownerIds.VISIT)));
    assert(storage.removedOrphans.includes(finalRef(63)) && !storage.finals.has(finalRef(63)), "published orphan cleaned after proof");
    assert(await count(w.db, "SELECT count(*) AS c FROM evidence") === 0, "no DB row");
});

await ok("G6C-B-30 publish failure commits no Evidence row", async () => {
    const w = await freshWorld(); const storage = new FakeStorage([allocation(64)]); storage.failPublish = true;
    await rejectsCode(APP_ERR.EVIDENCE_STORAGE_WRITE_FAILED, () => serviceFor(w.db, storage).createEvidence(createInput("VISIT", w.ownerIds.VISIT)));
    assert(await count(w.db, "SELECT count(*) AS c FROM evidence") === 0, "no DB row on publish failure");
});

// H — post-publish transactional state drift
await ok("G6C-B-31 transactional recheck unexpected one row => conflict/no insert/file preserved", async () => {
    const w = await freshWorld(); const proxy = new ProxyAdapter(w.db); proxy.transactionalStorageRefRows = [syntheticEvidenceRow(finalRef(70), 700)]; const storage = new FakeStorage([allocation(70)]);
    await rejectsCode(APP_ERR.EVIDENCE_STORAGE_REF_CONFLICT, () => serviceFor(proxy, storage).createEvidence(createInput("VISIT", w.ownerIds.VISIT)));
    assert(proxy.evidenceInsertCount === 0, "no Evidence INSERT after drift"); assert(storage.finals.has(finalRef(70)), "published final preserved for diagnosis");
});

await ok("G6C-B-32 transactional recheck unexpected >1 rows => conflict/no arbitrary winner", async () => {
    const w = await freshWorld(); const proxy = new ProxyAdapter(w.db); proxy.transactionalStorageRefRows = [syntheticEvidenceRow(finalRef(71), 701), syntheticEvidenceRow(finalRef(71), 702)]; const storage = new FakeStorage([allocation(71)]);
    await rejectsCode(APP_ERR.EVIDENCE_STORAGE_REF_CONFLICT, () => serviceFor(proxy, storage).createEvidence(createInput("VISIT", w.ownerIds.VISIT)));
    assert(proxy.evidenceInsertCount === 0 && storage.finals.has(finalRef(71)), "preserve state; no insert");
});

// I — INSERT/cardinality failure compensation
await ok("G6C-B-33 Evidence INSERT failure rolls back and removes proven orphan", async () => {
    const w = await freshWorld(); const proxy = new ProxyAdapter(w.db); proxy.failEvidenceInsert = true; const storage = new FakeStorage([allocation(72)]);
    await rejectsCode(APP_ERR.EVIDENCE_SQLITE_FAILED, () => serviceFor(proxy, storage).createEvidence(createInput("VISIT", w.ownerIds.VISIT)));
    assert(await count(w.db, "SELECT count(*) AS c FROM evidence") === 0, "INSERT transaction rolled back"); assert(storage.removedOrphans.includes(finalRef(72)), "final orphan removed after fresh zero proof");
});

await ok("G6C-B-34 lying changes=0 rolls back inserted row and cleans final", async () => {
    const w = await freshWorld(); const proxy = new ProxyAdapter(w.db); proxy.lieEvidenceInsertChanges = 0; const storage = new FakeStorage([allocation(73)]);
    await rejectsCode(APP_ERR.STATE_CONFLICT, () => serviceFor(proxy, storage).createEvidence(createInput("VISIT", w.ownerIds.VISIT)));
    assert(await count(w.db, "SELECT count(*) AS c FROM evidence") === 0, "lying cardinality row rolled back"); assert(!storage.finals.has(finalRef(73)), "orphan cleaned");
});

await ok("G6C-B-35 missing lastInsertRowid rolls back and cleans final", async () => {
    const w = await freshWorld(); const proxy = new ProxyAdapter(w.db); proxy.suppressEvidenceInsertRowid = true; const storage = new FakeStorage([allocation(74)]);
    await rejectsCode(APP_ERR.STATE_CONFLICT, () => serviceFor(proxy, storage).createEvidence(createInput("VISIT", w.ownerIds.VISIT)));
    assert(await count(w.db, "SELECT count(*) AS c FROM evidence") === 0 && !storage.finals.has(finalRef(74)), "rollback + cleanup");
});

// J — uncertain COMMIT convergence
await ok("G6C-B-36 COMMIT failure before durability => zero rows, no success, safe orphan cleanup", async () => {
    const w = await freshWorld(); const proxy = new ProxyAdapter(w.db); proxy.commitMode = "FAIL_BEFORE_ONCE"; const storage = new FakeStorage([allocation(80)]);
    await rejectsCode(APP_ERR.EVIDENCE_SQLITE_FAILED, () => serviceFor(proxy, storage).createEvidence(createInput("VISIT", w.ownerIds.VISIT)));
    assert(await count(w.db, "SELECT count(*) AS c FROM evidence") === 0, "zero committed rows expected"); assert(!storage.finals.has(finalRef(80)), "confirmed orphan removed"); assert(proxy.evidenceInsertCount === 1, "must not blindly retry INSERT");
});

await ok("G6C-B-37 ACK loss after durable COMMIT + exact one match converges SUCCESS", async () => {
    const w = await freshWorld(); const proxy = new ProxyAdapter(w.db); proxy.commitMode = "ACK_LOSS_AFTER_ONCE"; const storage = new FakeStorage([allocation(81)]);
    const result = await serviceFor(proxy, storage).createEvidence(createInput("VISIT", w.ownerIds.VISIT));
    assert(result.status === "CREATED", "must converge to success"); assert(await count(w.db, "SELECT count(*) AS c FROM evidence") === 1, "exactly one durable row"); assert(proxy.evidenceInsertCount === 1, "no second INSERT");
});

await ok("G6C-B-38 ACK loss + exactly one mismatching row => STORAGE_REF_CONFLICT", async () => {
    const w = await freshWorld(); const proxy = new ProxyAdapter(w.db); proxy.commitMode = "ACK_LOSS_AFTER_ONCE"; proxy.recoveryStorageRefRows = [syntheticEvidenceRow(finalRef(82), 820, { file_name: "different.bin" })]; const storage = new FakeStorage([allocation(82)]);
    await rejectsCode(APP_ERR.EVIDENCE_STORAGE_REF_CONFLICT, () => serviceFor(proxy, storage).createEvidence(createInput("VISIT", w.ownerIds.VISIT)));
    assert(proxy.evidenceInsertCount === 1 && storage.finals.has(finalRef(82)), "row/file preserved; no retry insert");
});

await ok("G6C-B-39 ACK loss + >1 rows => STORAGE_REF_CONFLICT/no arbitrary winner", async () => {
    const w = await freshWorld(); const proxy = new ProxyAdapter(w.db); proxy.commitMode = "ACK_LOSS_AFTER_ONCE"; proxy.recoveryStorageRefRows = [syntheticEvidenceRow(finalRef(83), 830), syntheticEvidenceRow(finalRef(83), 831)]; const storage = new FakeStorage([allocation(83)]);
    await rejectsCode(APP_ERR.EVIDENCE_STORAGE_REF_CONFLICT, () => serviceFor(proxy, storage).createEvidence(createInput("VISIT", w.ownerIds.VISIT)));
    assert(proxy.evidenceInsertCount === 1 && storage.finals.has(finalRef(83)), "preserve file and no second INSERT");
});

await ok("G6C-B-40 uncertain-COMMIT identity ignores mutable note", async () => {
    const w = await freshWorld(); const proxy = new ProxyAdapter(w.db); proxy.commitMode = "ACK_LOSS_AFTER_ONCE";
    const originalQuery = proxy.query.bind(proxy);
    proxy.query = async (sql: string, params: readonly SqlValue[] = []) => { const rows = await originalQuery(sql, params); if (proxy.afterAckLoss && sql.includes("WHERE storage_ref = ?") && rows.length === 1) return [{ ...rows[0], note: "edited later" }]; return rows; };
    const result = await serviceFor(proxy, new FakeStorage([allocation(84)])).createEvidence(createInput("VISIT", w.ownerIds.VISIT));
    assert(result.status === "CREATED", "note must not participate in attempt identity");
});
