import * as S from "./gate6c_b_evidence_support.ts";
import type { AcquisitionOutcome, EvidenceOwnerKind, SqlValue } from "./gate6c_b_evidence_support.ts";
const { APP_ERR, DomainError, FakeAcquisition, FakeStorage, ProxyAdapter, HASH_B, ok, assert, rejectsCode, count, finalRef, stagingRef, allocation, syntheticEvidenceRow, freshWorld, createInput, insertEvidenceRaw, serviceFor, successSource, isCanonicalSha256 } = S;

// A — successful creation / ordering / metadata
await ok("G6C-B-01 successful creation returns durable evidence_id", async () => {
    const w = await freshWorld();
    const storage = new FakeStorage([allocation(1)]);
    const result = await serviceFor(w.db, storage).createEvidence(createInput("VISIT", w.ownerIds.VISIT));
    assert(result.status === "CREATED" && result.evidence.evidenceId > 0, "expected CREATED with evidence id");
});

await ok("G6C-B-02 successful creation commits exactly one Evidence row", async () => {
    const w = await freshWorld();
    const result = await serviceFor(w.db, new FakeStorage([allocation(2)])).createEvidence(createInput("VISIT", w.ownerIds.VISIT));
    assert(result.status === "CREATED", "expected CREATED");
    assert(await count(w.db, "SELECT count(*) AS c FROM evidence") === 1, "exactly one row expected");
});

await ok("G6C-B-03 publish precedes transactional Evidence INSERT", async () => {
    const w = await freshWorld();
    const events: string[] = [];
    const proxy = new ProxyAdapter(w.db, events);
    const storage = new FakeStorage([allocation(3)], events);
    const result = await serviceFor(proxy, storage).createEvidence(createInput("VISIT", w.ownerIds.VISIT));
    assert(result.status === "CREATED", "expected CREATED");
    assert(events.indexOf(`publish:${finalRef(3)}`) < events.indexOf("db:evidence-insert"), "publish must precede INSERT");
});

await ok("G6C-B-04 pre-publish SQLite and final-path guards precede publish", async () => {
    const w = await freshWorld();
    const events: string[] = [];
    const proxy = new ProxyAdapter(w.db, events);
    const storage = new FakeStorage([allocation(4)], events);
    await serviceFor(proxy, storage).createEvidence(createInput("VISIT", w.ownerIds.VISIT));
    const preflight = events.indexOf("db:storage-ref-query:plain");
    const exists = events.indexOf(`exists:${finalRef(4)}`);
    const publish = events.indexOf(`publish:${finalRef(4)}`);
    assert(preflight >= 0 && preflight < publish, "SQLite preflight before publish");
    assert(exists >= 0 && exists < publish, "final-path check before publish");
});

await ok("G6C-B-05 transactional storage_ref recheck remains inside BEGIN IMMEDIATE", async () => {
    const w = await freshWorld();
    const events: string[] = [];
    const proxy = new ProxyAdapter(w.db, events);
    await serviceFor(proxy, new FakeStorage([allocation(5)], events)).createEvidence(createInput("VISIT", w.ownerIds.VISIT));
    const begin = events.lastIndexOf("db:begin");
    const txQuery = events.lastIndexOf("db:storage-ref-query:tx");
    const insert = events.indexOf("db:evidence-insert");
    assert(begin >= 0 && begin < txQuery && txQuery < insert, "BEGIN -> recheck -> INSERT ordering");
});

await ok("G6C-B-06 new content_hash is canonical SHA-256", async () => {
    const w = await freshWorld();
    const result = await serviceFor(w.db, new FakeStorage([allocation(6)])).createEvidence(createInput("VISIT", w.ownerIds.VISIT));
    assert(result.status === "CREATED" && isCanonicalSha256(result.evidence.contentHash), "canonical SHA-256 required");
});

await ok("G6C-B-07 sourceRef never becomes storage_ref", async () => {
    const w = await freshWorld();
    const acquisition = new FakeAcquisition();
    acquisition.file = successSource("GENERIC_FILE", { sourceRef: "content://synthetic/provider/7" });
    await serviceFor(w.db, new FakeStorage([allocation(7)]), acquisition).createEvidence(createInput("VISIT", w.ownerIds.VISIT));
    const rows = await w.db.query("SELECT storage_ref FROM evidence");
    assert(String(rows[0].storage_ref) === finalRef(7), "managed storage_ref expected");
    assert(String(rows[0].storage_ref) !== "content://synthetic/provider/7", "sourceRef must not persist");
});

await ok("G6C-B-08 file_size comes from stored-object stat, not source sizeHint", async () => {
    const w = await freshWorld();
    const acquisition = new FakeAcquisition();
    acquisition.file = successSource("GENERIC_FILE", { sizeHint: 99999999 });
    const storage = new FakeStorage([allocation(8)]);
    storage.stageFileSize = 1234;
    await serviceFor(w.db, storage, acquisition).createEvidence(createInput("VISIT", w.ownerIds.VISIT));
    const rows = await w.db.query("SELECT file_size FROM evidence");
    assert(Number(rows[0].file_size) === 1234, "stored-object size expected");
});

await ok("G6C-B-09 unsafe display filename cannot control managed path", async () => {
    const w = await freshWorld();
    const acquisition = new FakeAcquisition();
    acquisition.file = successSource("GENERIC_FILE", { displayName: "../../outside/evil.EXE" });
    const result = await serviceFor(w.db, new FakeStorage([allocation(9, "bin")]), acquisition).createEvidence(createInput("VISIT", w.ownerIds.VISIT));
    assert(result.status === "CREATED", "expected CREATED");
    assert(result.evidence.storageRef === finalRef(9, "bin"), "physical identity must remain canonical/neutral");
    assert(result.evidence.fileName === "../../outside/evil.EXE", "display metadata may be retained separately");
});

// B — all six owner kinds
for (const [index, kind] of (["VISIT", "CHECKLIST_RESPONSE", "ADHOC_OBSERVATION", "FINDING", "CORRECTIVE_ACTION", "FOLLOW_UP"] as const).entries()) {
    await ok(`G6C-B-${String(10 + index).padStart(2, "0")} owner kind ${kind} attaches successfully`, async () => {
        const w = await freshWorld();
        const result = await serviceFor(w.db, new FakeStorage([allocation(20 + index)])).createEvidence(createInput(kind, w.ownerIds[kind]));
        assert(result.status === "CREATED" && result.evidence.ownerKind === kind, `expected ${kind}`);
    });
}

// C — owner failures
await ok("G6C-B-16 unknown owner kind is E_EVIDENCE_OWNER_INVALID with no storage work", async () => {
    const w = await freshWorld();
    const storage = new FakeStorage([allocation(30)]);
    await rejectsCode(APP_ERR.EVIDENCE_OWNER_INVALID, () =>
        serviceFor(w.db, storage).createEvidence({ ...createInput("VISIT", w.ownerIds.VISIT), ownerKind: "BOGUS" as EvidenceOwnerKind }),
    );
    assert(storage.allocationLog.length === 0 && storage.finals.size === 0, "invalid owner must fail before storage");
});

await ok("G6C-B-17 missing owner is E_EVIDENCE_OWNER_NOT_FOUND with no residue", async () => {
    const w = await freshWorld();
    const storage = new FakeStorage([allocation(31)]);
    await rejectsCode(APP_ERR.EVIDENCE_OWNER_NOT_FOUND, () => serviceFor(w.db, storage).createEvidence(createInput("VISIT", 999999)));
    assert(storage.incoming.size === 0 && storage.finals.size === 0, "missing owner must leave no storage residue");
    assert(await count(w.db, "SELECT count(*) AS c FROM evidence") === 0, "no Evidence row");
});

// D — acquisition outcomes
await ok("G6C-B-18 USER_CANCELLED is an expected result with no DB write", async () => {
    const w = await freshWorld();
    const acq = new FakeAcquisition();
    acq.file = { status: "USER_CANCELLED" };
    const storage = new FakeStorage([allocation(32)]);
    const result = await serviceFor(w.db, storage, acq).createEvidence(createInput("VISIT", w.ownerIds.VISIT));
    assert(result.status === "USER_CANCELLED", "expected cancellation result");
    assert(storage.allocationLog.length === 0 && await count(w.db, "SELECT count(*) AS c FROM evidence") === 0, "no side effects");
});

for (const [i, outcome, code] of [
    [{ status: "PERMISSION_DENIED" } as AcquisitionOutcome, APP_ERR.EVIDENCE_PERMISSION_DENIED],
    [{ status: "SOURCE_UNAVAILABLE" } as AcquisitionOutcome, APP_ERR.EVIDENCE_SOURCE_UNAVAILABLE],
    [{ status: "UNSUPPORTED_SOURCE" } as AcquisitionOutcome, APP_ERR.EVIDENCE_UNSUPPORTED_SOURCE],
].map((x, i) => [i, x[0], x[1]] as const)) {
    await ok(`G6C-B-${19 + i} ${outcome.status} maps to typed error with no DB write`, async () => {
        const w = await freshWorld();
        const acq = new FakeAcquisition();
        acq.file = outcome;
        const storage = new FakeStorage([allocation(40 + i)]);
        await rejectsCode(code, () => serviceFor(w.db, storage, acq).createEvidence(createInput("VISIT", w.ownerIds.VISIT)));
        assert(storage.allocationLog.length === 0 && await count(w.db, "SELECT count(*) AS c FROM evidence") === 0, "no side effects");
    });
}
