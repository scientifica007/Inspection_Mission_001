// Gate 5G — automated regression for OBS-1 `createAdHocObservation`
// (TRANSACTION-CONTRACTS-v1.md §14 / APPLICATION-CORE-v1.md §4.12 /
// GATE5G-DECISIONS-v1.md):
//   creates exactly ONE durable AdHocObservation identity during an open
//   field Visit (finding_id = NULL always); the Observation ONLY — no
//   Finding, no Subject, no Evidence, no correction.
//   one explicit BEGIN IMMEDIATE unit: authoritative Visit read in-tx
//   (missing => E_VISIT_NOT_FOUND; not PREPARATION / finalized =>
//   E_VISIT_NOT_PREPARATION) -> optional Subject read in-tx (missing =>
//   E_SUBJECT_NOT_FOUND; institution mismatch => E_CONTEXT) -> normalized
//   meaningful text/audit (blank => E_CONFIG) -> single INSERT (changes == 1
//   B5, else ROLLBACK + E_STATE_CONFLICT) -> COMMIT.
//   DELIBERATELY Class B: no dedupe/idempotency key; identical payloads
//   create two distinct observations; COMMIT/ACK-loss => ambiguous outcome,
//   never an internal second INSERT.
//
// Run (repository root; Node.js >= 22 is the adopted development/test host,
// Gate-5A D1 — node:sqlite + native TypeScript type stripping):
//   Node 22.x:   node --experimental-strip-types tests/gate5g_regression.ts
//   Node 24.x:   node tests/gate5g_regression.ts
// Exit: 0 on success, 1 when any assertion fails.
//
// Coverage map (GATE 5G §M TESTS) is reproduced in the ok() labels
// G5G-01..G5G-31, plus the owner-approved final micro-correction timestamp
// regressions G5G-32..G5G-41 (strict ISO-8601 UTC validation of recordedAt).

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { SqlAdapter, SqlRow, SqlValue } from "../src/bootstrap/adapter.ts";
import { openFreshDb } from "../dev/node-sqlite-adapter.ts";
import { APP_ERR } from "../src/application/errors.ts";
import {
    ObservationCreateService,
    type CreateAdHocObservationInput,
} from "../src/application/observation-create.ts";
import { ObservationFindingService } from "../src/application/observation-finding.ts";
import type { NewFindingInput } from "../src/application/initial-disposition.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_SQL = readFileSync(join(ROOT, "docs", "schema", "schema.sql"), "utf8");

const NOW = "2026-09-01T08:00:00.000Z";
const NOW2 = "2026-09-01T09:30:00.000Z";

// ---------------------------------------------------------------------------
// tiny assertion harness (same conventions as tests/gate5f_regression.ts)
// ---------------------------------------------------------------------------
const failures: string[] = [];
let passed = 0;

async function ok(name: string, fn: () => Promise<void> | void): Promise<void> {
    try {
        await fn();
        passed += 1;
    } catch (e) {
        failures.push(`${name} :: ${e instanceof Error ? e.message : String(e)}`);
    }
}

function assert(cond: unknown, msg: string): asserts cond {
    if (!cond) throw new Error(`assertion failed: ${msg}`);
}

async function rejectsCode(code: string, fn: () => Promise<unknown>): Promise<Error> {
    try {
        await fn();
    } catch (e) {
        const actual = e instanceof Error ? ((e as { code?: unknown }).code as string | undefined) : undefined;
        if (actual !== code) {
            throw new Error(`expected code ${code}, got ${String(actual)} :: ${e instanceof Error ? e.message : String(e)}`);
        }
        return e as Error;
    }
    throw new Error(`expected code ${code} but the operation succeeded`);
}

async function rejectsAny(fn: () => Promise<unknown>): Promise<Error> {
    try {
        await fn();
    } catch (e) {
        return e as Error;
    }
    throw new Error("expected the operation to fail");
}

async function count(db: SqlAdapter, sql: string, params: readonly SqlValue[] = []): Promise<number> {
    const rows = await db.query(sql, params);
    return Number(rows[0].c);
}

// ---------------------------------------------------------------------------
// fixtures (raw worlds — OBS-1 touches only visit/inspected_subject/
// adhoc_observation; no bootstrap artifact is needed)
// ---------------------------------------------------------------------------
interface World {
    db: SqlAdapter;
    svc: ObservationCreateService;
    missionId: number;
    institutionId: number;
    visitId: number;
}

async function freshWorld(): Promise<World> {
    const db = openFreshDb(SCHEMA_SQL);
    const missionId = Number(
        (await db.run("INSERT INTO mission(name, status, created_at, created_by) VALUES ('M', 'PREPARATION', ?, 'owner')", [NOW]))
            .lastInsertRowid,
    );
    const institutionId = Number(
        (await db.run("INSERT INTO institution(name, created_at, created_by) VALUES ('Inst', ?, 'owner')", [NOW])).lastInsertRowid,
    );
    const visitId = await insertVisitRaw(db, missionId, institutionId);
    return { db, svc: new ObservationCreateService(db), missionId, institutionId, visitId };
}

async function insertVisitRaw(db: SqlAdapter, missionId: number, institutionId: number): Promise<number> {
    const res = await db.run(
        `INSERT INTO visit(mission_id, institution_id, visit_type, visit_date, status, inspector, created_at, created_by)
         VALUES (?, ?, 'PLANNED', '2026-09-10', 'PREPARATION', 'inspector-a', ?, 'owner')`,
        [missionId, institutionId, NOW],
    );
    assert(res.changes === 1 && res.lastInsertRowid !== null, "visit fixture insert failed");
    return Number(res.lastInsertRowid);
}

async function addInstitution(db: SqlAdapter, name: string): Promise<number> {
    return Number(
        (await db.run("INSERT INTO institution(name, created_at, created_by) VALUES (?, ?, 'owner')", [name, NOW])).lastInsertRowid,
    );
}

async function addSubjectRaw(db: SqlAdapter, institutionId: number, name = "W1"): Promise<number> {
    const res = await db.run(
        `INSERT INTO inspected_subject(institution_id, subject_type, name, created_at, created_by)
         VALUES (?, 'WORKSHOP', ?, ?, 'owner')`,
        [institutionId, name, NOW],
    );
    assert(res.changes === 1 && res.lastInsertRowid !== null, "subject fixture insert failed");
    return Number(res.lastInsertRowid);
}

async function finalizeCompletedRaw(db: SqlAdapter, visitId: number): Promise<void> {
    const res = await db.run(
        `UPDATE visit SET status = 'COMPLETED', finalized_at = ?
          WHERE visit_id = ? AND status = 'PREPARATION' AND finalized_at IS NULL`,
        [NOW, visitId],
    );
    assert(res.changes === 1, "COMPLETED finalize fixture failed (zero NOT_INSPECTED rows required)");
}

const FIXTURE_RULE = JSON.stringify({
    rule_schema_version: 1,
    item_code: "G5G-FIXTURE",
    decision_kind: "AUTO",
    subject_kinds: ["INSTITUTION"],
    source_ar: "test fixture",
});

async function insertFixtureDefinition(db: SqlAdapter): Promise<number> {
    const res = await db.run(
        `INSERT INTO checklist_item_definition(item_code, version_no, domain_id, arabic_question, response_model,
                                               priority, traceability, requirement_refs, applicability_rule, status)
         VALUES ('G5G-FIXTURE', 1, 'DOM-14', 'سؤال تجريبي', 'SINGLE_VALUE', 'P0', 'PROJECT', 'PRJ-03', ?, 'ACTIVE')`,
        [FIXTURE_RULE],
    );
    assert(res.changes === 1 && res.lastInsertRowid !== null, "definition fixture insert failed");
    return Number(res.lastInsertRowid);
}

async function insertNotInspectedRow(db: SqlAdapter, visitId: number, defId: number): Promise<void> {
    const res = await db.run(
        `INSERT INTO checklist_response(visit_id, item_definition_id, subject_id, overlay_state, not_inspected_reason,
                                        recorded_at, recorded_by)
         VALUES (?, ?, NULL, 'NOT_INSPECTED', 'fixture reason', ?, 'owner')`,
        [visitId, defId, NOW],
    );
    assert(res.changes === 1, "NOT_INSPECTED fixture row insert failed");
}

async function finalizeCompletedWithUninspectedRaw(db: SqlAdapter, visitId: number): Promise<void> {
    const res = await db.run(
        `UPDATE visit SET status = 'COMPLETED_WITH_UNINSPECTED', finalized_at = ?
          WHERE visit_id = ? AND status = 'PREPARATION' AND finalized_at IS NULL`,
        [NOW, visitId],
    );
    assert(res.changes === 1, "COMPLETED_WITH_UNINSPECTED finalize fixture failed");
}

function obs(visitId: number, extra: Partial<CreateAdHocObservationInput> = {}): CreateAdHocObservationInput {
    return { visitId, text: "تسرب مياه من سقف الممر", recordedAt: NOW, recordedBy: "inspector-a", ...extra };
}

async function obsRows(db: SqlAdapter): Promise<SqlRow[]> {
    return db.query(`SELECT * FROM adhoc_observation ORDER BY observation_id`);
}

// ---------------------------------------------------------------------------
// fault-injecting adapters (same shape as tests/gate5f_regression.ts)
// ---------------------------------------------------------------------------
class FaultAdapter implements SqlAdapter {
    private readonly inner: SqlAdapter;
    private readonly fail: (kind: "run" | "query" | "commit", sql: string) => boolean;

    constructor(inner: SqlAdapter, fail: (kind: "run" | "query" | "commit", sql: string) => boolean) {
        this.inner = inner;
        this.fail = fail;
    }
    async beginImmediate(): Promise<void> {
        return this.inner.beginImmediate();
    }
    async commit(): Promise<void> {
        if (this.fail("commit", "")) throw new Error("injected adapter fault");
        return this.inner.commit();
    }
    async rollback(): Promise<void> {
        return this.inner.rollback();
    }
    async run(sql: string, params: readonly SqlValue[] = []): Promise<Awaited<ReturnType<SqlAdapter["run"]>>> {
        if (this.fail("run", sql)) throw new Error("injected adapter fault");
        return this.inner.run(sql, params);
    }
    async query(sql: string, params: readonly SqlValue[] = []): Promise<SqlRow[]> {
        if (this.fail("query", sql)) throw new Error("injected adapter fault");
        return this.inner.query(sql, params);
    }
}

/** COMMIT really succeeds durably, then the ACK is lost (ambiguous outcome). */
class CommitFaultAfterAdapter implements SqlAdapter {
    readonly inserts = { count: 0 };
    private readonly inner: SqlAdapter;

    constructor(inner: SqlAdapter) {
        this.inner = inner;
    }
    async beginImmediate(): Promise<void> {
        return this.inner.beginImmediate();
    }
    async commit(): Promise<void> {
        await this.inner.commit(); // the durable COMMIT really happens
        throw new Error("injected ACK-loss after durable COMMIT");
    }
    async rollback(): Promise<void> {
        return this.inner.rollback();
    }
    async run(sql: string, params: readonly SqlValue[] = []): Promise<Awaited<ReturnType<SqlAdapter["run"]>>> {
        if (sql.includes("INSERT INTO adhoc_observation")) this.inserts.count += 1;
        return this.inner.run(sql, params);
    }
    async query(sql: string, params: readonly SqlValue[] = []): Promise<SqlRow[]> {
        return this.inner.query(sql, params);
    }
}

/**
 * The INSERT really happens on the inner connection, but the adapter reports
 * a lying cardinality ("zero" => changes 0; "no-rowid" => changes 1 with no
 * rowid), forcing the B5 guard to ROLLBACK the really-inserted row.
 */
class CardinalityLyingAdapter implements SqlAdapter {
    private readonly inner: SqlAdapter;
    private readonly mode: "zero" | "no-rowid";

    constructor(inner: SqlAdapter, mode: "zero" | "no-rowid") {
        this.inner = inner;
        this.mode = mode;
    }
    async beginImmediate(): Promise<void> {
        return this.inner.beginImmediate();
    }
    async commit(): Promise<void> {
        return this.inner.commit();
    }
    async rollback(): Promise<void> {
        return this.inner.rollback();
    }
    async run(sql: string, params: readonly SqlValue[] = []): Promise<Awaited<ReturnType<SqlAdapter["run"]>>> {
        if (sql.includes("INSERT INTO adhoc_observation")) {
            const real = await this.inner.run(sql, params);
            if (this.mode === "zero") return { changes: 0, lastInsertRowid: real.lastInsertRowid };
            return { changes: 1, lastInsertRowid: null };
        }
        return this.inner.run(sql, params);
    }
    async query(sql: string, params: readonly SqlValue[] = []): Promise<SqlRow[]> {
        return this.inner.query(sql, params);
    }
}

// ---------------------------------------------------------------------------
// S1 — Visit gate (PREPARATION only)
// ---------------------------------------------------------------------------
async function tS1_visitGate(): Promise<void> {
    await ok("G5G-01: missing Visit => E_VISIT_NOT_FOUND, zero rows", async () => {
        const w = await freshWorld();
        await rejectsCode(APP_ERR.VISIT_NOT_FOUND, async () => w.svc.createAdHocObservation(obs(9999)));
        assert((await count(w.db, "SELECT count(*) AS c FROM adhoc_observation")) === 0, "no row created");
    });

    await ok("G5G-02: COMPLETED Visit rejected => E_VISIT_NOT_PREPARATION", async () => {
        const w = await freshWorld();
        await finalizeCompletedRaw(w.db, w.visitId);
        await rejectsCode(APP_ERR.VISIT_NOT_PREPARATION, async () => w.svc.createAdHocObservation(obs(w.visitId)));
        assert((await count(w.db, "SELECT count(*) AS c FROM adhoc_observation")) === 0, "no row created");
    });

    await ok("G5G-03: COMPLETED_WITH_UNINSPECTED Visit rejected => E_VISIT_NOT_PREPARATION", async () => {
        const w = await freshWorld();
        const defId = await insertFixtureDefinition(w.db);
        await insertNotInspectedRow(w.db, w.visitId, defId);
        await finalizeCompletedWithUninspectedRaw(w.db, w.visitId);
        await rejectsCode(APP_ERR.VISIT_NOT_PREPARATION, async () => w.svc.createAdHocObservation(obs(w.visitId)));
        assert((await count(w.db, "SELECT count(*) AS c FROM adhoc_observation")) === 0, "no row created");
    });

    await ok("G5G-04: finalized Visit rejected — finalized_at guard + trg_obs_bi schema floor", async () => {
        const w = await freshWorld();
        await finalizeCompletedRaw(w.db, w.visitId);
        await rejectsCode(APP_ERR.VISIT_NOT_PREPARATION, async () => w.svc.createAdHocObservation(obs(w.visitId)));
        assert((await count(w.db, "SELECT count(*) AS c FROM adhoc_observation")) === 0, "domain path created nothing");
        // DB floor re-verification: a raw INSERT into a finalized Visit is
        // also aborted by trg_obs_bi (defense in depth, same rule)
        const e = await rejectsAny(() =>
            w.db.run(
                `INSERT INTO adhoc_observation(visit_id, subject_id, text, finding_id, recorded_at, recorded_by)
                 VALUES (?, NULL, 'x', NULL, ?, 'owner')`,
                [w.visitId, NOW],
            ),
        );
        assert(e.message.includes("PREPARATION"), `trg_obs_bi floor fires: ${e.message}`);
        assert((await count(w.db, "SELECT count(*) AS c FROM adhoc_observation")) === 0, "schema floor blocked the row");
    });

    await ok("G5G-05: PREPARATION Visit accepts creation (one durable row, state returned)", async () => {
        const w = await freshWorld();
        const created = await w.svc.createAdHocObservation(obs(w.visitId));
        assert(created.observationId > 0, "observation_id assigned");
        assert(created.visitId === w.visitId, "visitId echoed");
        assert(created.findingId === null, "findingId null on creation");
        assert(created.text === "تسرب مياه من سقف الممر", "text echoed");
        assert(created.recordedAt === NOW && created.recordedBy === "inspector-a", "audit echoed");
        const rows = await obsRows(w.db);
        assert(rows.length === 1, "exactly one durable row");
        assert(Number(rows[0].observation_id) === created.observationId, "row identity matches");
    });
}

// ---------------------------------------------------------------------------
// S2 — text / audit validation
// ---------------------------------------------------------------------------
async function tS2_textAudit(): Promise<void> {
    await ok("G5G-06: meaningful text required — empty text / blank recordedAt / blank recordedBy => E_CONFIG", async () => {
        const w = await freshWorld();
        await rejectsCode(APP_ERR.CONFIG, async () => w.svc.createAdHocObservation(obs(w.visitId, { text: "" })));
        await rejectsCode(APP_ERR.CONFIG, async () => w.svc.createAdHocObservation(obs(w.visitId, { recordedAt: "" })));
        await rejectsCode(APP_ERR.CONFIG, async () => w.svc.createAdHocObservation(obs(w.visitId, { recordedBy: "" })));
        assert((await count(w.db, "SELECT count(*) AS c FROM adhoc_observation")) === 0, "no row created");
    });

    await ok("G5G-07: whitespace-only text rejected => E_CONFIG", async () => {
        const w = await freshWorld();
        await rejectsCode(APP_ERR.CONFIG, async () => w.svc.createAdHocObservation(obs(w.visitId, { text: "   " })));
        await rejectsCode(APP_ERR.CONFIG, async () => w.svc.createAdHocObservation(obs(w.visitId, { text: "\t \n" })));
        assert((await count(w.db, "SELECT count(*) AS c FROM adhoc_observation")) === 0, "no row created");
    });

    await ok("G5G-08: recordedBy must be meaningful — whitespace-only rejected => E_CONFIG", async () => {
        const w = await freshWorld();
        await rejectsCode(APP_ERR.CONFIG, async () => w.svc.createAdHocObservation(obs(w.visitId, { recordedBy: "   " })));
        assert((await count(w.db, "SELECT count(*) AS c FROM adhoc_observation")) === 0, "no row created");
    });
}

// ---------------------------------------------------------------------------
// S2b — recordedAt: strict ISO-8601 UTC validation (final micro-correction)
// ---------------------------------------------------------------------------
async function tS2b_timestamp(): Promise<void> {
    await ok("G5G-32: canonical UTC timestamp with Z succeeds", async () => {
        const w = await freshWorld();
        const created = await w.svc.createAdHocObservation(obs(w.visitId, { recordedAt: "2026-09-01T08:00:00Z" }));
        assert(created.recordedAt === "2026-09-01T08:00:00Z", "result recorded_at exact");
        const rows = await obsRows(w.db);
        assert(String(rows[0].recorded_at) === "2026-09-01T08:00:00Z", "stored recorded_at exact");
    });

    await ok("G5G-33: UTC timestamp with milliseconds succeeds", async () => {
        const w = await freshWorld();
        const created = await w.svc.createAdHocObservation(obs(w.visitId, { recordedAt: "2026-09-01T08:00:00.000Z" }));
        assert(created.recordedAt === "2026-09-01T08:00:00.000Z", "millisecond form accepted and stored");
        const rows = await obsRows(w.db);
        assert(String(rows[0].recorded_at) === "2026-09-01T08:00:00.000Z", "stored exact");
    });

    await ok("G5G-34: surrounding whitespace is normalized and accepted", async () => {
        const w = await freshWorld();
        const created = await w.svc.createAdHocObservation(obs(w.visitId, { recordedAt: "  2026-09-01T08:00:00.000Z  " }));
        assert(created.recordedAt === "2026-09-01T08:00:00.000Z", "trimmed in result");
        const rows = await obsRows(w.db);
        assert(String(rows[0].recorded_at) === "2026-09-01T08:00:00.000Z", "trimmed text stored");
    });

    await ok("G5G-35: arbitrary non-date string => E_CONFIG", async () => {
        const w = await freshWorld();
        await rejectsCode(APP_ERR.CONFIG, async () => w.svc.createAdHocObservation(obs(w.visitId, { recordedAt: "not-a-date" })));
        assert((await count(w.db, "SELECT count(*) AS c FROM adhoc_observation")) === 0, "no row created");
    });

    await ok("G5G-36: date-only => E_CONFIG", async () => {
        const w = await freshWorld();
        await rejectsCode(APP_ERR.CONFIG, async () => w.svc.createAdHocObservation(obs(w.visitId, { recordedAt: "2026-09-01" })));
        assert((await count(w.db, "SELECT count(*) AS c FROM adhoc_observation")) === 0, "no row created");
    });

    await ok("G5G-37: timezone-less datetime => E_CONFIG", async () => {
        const w = await freshWorld();
        await rejectsCode(APP_ERR.CONFIG, async () =>
            w.svc.createAdHocObservation(obs(w.visitId, { recordedAt: "2026-09-01T08:00:00" })),
        );
        assert((await count(w.db, "SELECT count(*) AS c FROM adhoc_observation")) === 0, "no row created");
    });

    await ok("G5G-38: non-Z offset timestamp => E_CONFIG", async () => {
        const w = await freshWorld();
        await rejectsCode(APP_ERR.CONFIG, async () =>
            w.svc.createAdHocObservation(obs(w.visitId, { recordedAt: "2026-09-01T09:00:00+01:00" })),
        );
        assert((await count(w.db, "SELECT count(*) AS c FROM adhoc_observation")) === 0, "no row created");
    });

    await ok("G5G-39: impossible calendar date => E_CONFIG", async () => {
        const w = await freshWorld();
        await rejectsCode(APP_ERR.CONFIG, async () =>
            w.svc.createAdHocObservation(obs(w.visitId, { recordedAt: "2026-02-30T08:00:00Z" })),
        );
        await rejectsCode(APP_ERR.CONFIG, async () =>
            w.svc.createAdHocObservation(obs(w.visitId, { recordedAt: "2026-13-01T08:00:00Z" })),
        );
        assert((await count(w.db, "SELECT count(*) AS c FROM adhoc_observation")) === 0, "no row created");
    });

    await ok("G5G-40: impossible hour/time => E_CONFIG", async () => {
        const w = await freshWorld();
        await rejectsCode(APP_ERR.CONFIG, async () =>
            w.svc.createAdHocObservation(obs(w.visitId, { recordedAt: "2026-09-01T25:00:00Z" })),
        );
        assert((await count(w.db, "SELECT count(*) AS c FROM adhoc_observation")) === 0, "no row created");
    });

    await ok("G5G-41: every rejected timestamp leaves zero Observation rows", async () => {
        const w = await freshWorld();
        const bad = [
            "not-a-date",
            "2026-09-01",
            "2026-09-01T08:00:00",
            "2026-09-01T09:00:00+01:00",
            "2026-02-30T08:00:00Z",
            "2026-13-01T08:00:00Z",
            "2026-09-01T25:00:00Z",
        ];
        for (const t of bad) {
            await rejectsCode(APP_ERR.CONFIG, async () => w.svc.createAdHocObservation(obs(w.visitId, { recordedAt: t })));
        }
        assert((await count(w.db, "SELECT count(*) AS c FROM adhoc_observation")) === 0, "zero durable rows");
    });
}

// ---------------------------------------------------------------------------
// S3 — optional subject
// ---------------------------------------------------------------------------
async function tS3_subject(): Promise<void> {
    await ok("G5G-09: subjectId NULL succeeds — a general Visit/institution-level observation", async () => {
        const w = await freshWorld();
        const created = await w.svc.createAdHocObservation(obs(w.visitId)); // subjectId omitted
        assert(created.subjectId === null, "result subjectId null");
        const rows = await obsRows(w.db);
        assert(rows[0].subject_id === null, "stored subject_id NULL");
    });

    await ok("G5G-10: existing same-institution subject succeeds", async () => {
        const w = await freshWorld();
        const subjectId = await addSubjectRaw(w.db, w.institutionId);
        const created = await w.svc.createAdHocObservation(obs(w.visitId, { subjectId }));
        assert(created.subjectId === subjectId, "result subjectId exact");
        const rows = await obsRows(w.db);
        assert(Number(rows[0].subject_id) === subjectId, "stored subject_id exact");
    });

    await ok("G5G-11: missing subject => E_SUBJECT_NOT_FOUND", async () => {
        const w = await freshWorld();
        await rejectsCode(APP_ERR.SUBJECT_NOT_FOUND, async () => w.svc.createAdHocObservation(obs(w.visitId, { subjectId: 9999 })));
        assert((await count(w.db, "SELECT count(*) AS c FROM adhoc_observation")) === 0, "no row created");
    });

    await ok("G5G-12: cross-institution subject => E_CONTEXT", async () => {
        const w = await freshWorld();
        const inst2 = await addInstitution(w.db, "Inst2");
        const foreignSubject = await addSubjectRaw(w.db, inst2, "W2");
        await rejectsCode(APP_ERR.CONTEXT, async () =>
            w.svc.createAdHocObservation(obs(w.visitId, { subjectId: foreignSubject })),
        );
        assert((await count(w.db, "SELECT count(*) AS c FROM adhoc_observation")) === 0, "no row created");
    });
}

// ---------------------------------------------------------------------------
// S4 — created row semantics
// ---------------------------------------------------------------------------
async function tS4_rowSemantics(): Promise<void> {
    await ok("G5G-13: created row has finding_id NULL", async () => {
        const w = await freshWorld();
        const created = await w.svc.createAdHocObservation(obs(w.visitId));
        const rows = await obsRows(w.db);
        assert(rows[0].finding_id === null, "finding_id NULL on creation");
        void created;
    });

    await ok("G5G-14: visit_id stored exactly", async () => {
        const w = await freshWorld();
        const visitId2 = await insertVisitRaw(w.db, w.missionId, w.institutionId);
        const created = await w.svc.createAdHocObservation(obs(visitId2));
        const rows = await obsRows(w.db);
        assert(Number(rows[0].visit_id) === visitId2, `stored visit_id ${rows[0].visit_id} != ${visitId2}`);
        void created;
    });

    await ok("G5G-15: subject_id stored exactly / null-safe", async () => {
        const w = await freshWorld();
        const a = await w.svc.createAdHocObservation(obs(w.visitId));
        const subjectId = await addSubjectRaw(w.db, w.institutionId);
        const b = await w.svc.createAdHocObservation(obs(w.visitId, { subjectId }));
        const rows = await obsRows(w.db);
        const rowA = rows.find((r) => Number(r.observation_id) === a.observationId);
        const rowB = rows.find((r) => Number(r.observation_id) === b.observationId);
        assert(rowA !== undefined && rowA.subject_id === null, "NULL stored as NULL");
        assert(rowB !== undefined && Number(rowB.subject_id) === subjectId, "subject_id stored exactly");
    });

    await ok("G5G-16: normalized meaningful text stored (trimmed)", async () => {
        const w = await freshWorld();
        const created = await w.svc.createAdHocObservation(obs(w.visitId, { text: "  تسرب مياه من السقف  " }));
        assert(created.text === "تسرب مياه من السقف", "result text normalized");
        const rows = await obsRows(w.db);
        assert(String(rows[0].text) === "تسرب مياه من السقف", "stored text normalized");
    });

    await ok("G5G-17: recorded_at stored exactly according to contract (app-supplied)", async () => {
        const w = await freshWorld();
        await w.svc.createAdHocObservation(obs(w.visitId, { recordedAt: NOW2 }));
        const rows = await obsRows(w.db);
        assert(String(rows[0].recorded_at) === NOW2, "recorded_at stored exactly as supplied");
    });

    await ok("G5G-18: recorded_by stored normalized as adopted (trimmed)", async () => {
        const w = await freshWorld();
        const created = await w.svc.createAdHocObservation(obs(w.visitId, { recordedBy: "  inspector-a  " }));
        assert(created.recordedBy === "inspector-a", "result recorded_by normalized");
        const rows = await obsRows(w.db);
        assert(String(rows[0].recorded_by) === "inspector-a", "stored recorded_by normalized");
    });

    await ok("G5G-19: a successful call creates exactly one observation row", async () => {
        const w = await freshWorld();
        const created = await w.svc.createAdHocObservation(obs(w.visitId));
        assert((await count(w.db, "SELECT count(*) AS c FROM adhoc_observation")) === 1, "exactly one row");
        assert(
            (await count(w.db, "SELECT count(*) AS c FROM adhoc_observation WHERE observation_id = ?", [created.observationId])) === 1,
            "the row is the created identity",
        );
    });
}

// ---------------------------------------------------------------------------
// S5 — transaction atomicity / cardinality
// ---------------------------------------------------------------------------
async function tS5_atomicity(): Promise<void> {
    await ok("G5G-20: insert cardinality != 1 => ROLLBACK + E_STATE_CONFLICT", async () => {
        // (a) adapter reports changes == 0 although the row was really inserted
        {
            const w = await freshWorld();
            const lying = new CardinalityLyingAdapter(w.db, "zero");
            const svc = new ObservationCreateService(lying);
            await rejectsCode(APP_ERR.STATE_CONFLICT, async () => svc.createAdHocObservation(obs(w.visitId)));
            assert((await count(w.db, "SELECT count(*) AS c FROM adhoc_observation")) === 0, "the really-inserted row was rolled back");
        }
        // (b) adapter reports a successful insert but no rowid
        {
            const w = await freshWorld();
            const lying = new CardinalityLyingAdapter(w.db, "no-rowid");
            const svc = new ObservationCreateService(lying);
            await rejectsCode(APP_ERR.STATE_CONFLICT, async () => svc.createAdHocObservation(obs(w.visitId)));
            assert((await count(w.db, "SELECT count(*) AS c FROM adhoc_observation")) === 0, "the really-inserted row was rolled back");
        }
    });

    await ok("G5G-21: injected failure before INSERT leaves zero rows", async () => {
        const w = await freshWorld();
        // fail the in-tx Visit read — the INSERT never executes
        const fault = new FaultAdapter(w.db, (kind, sql) => kind === "query" && sql.includes("FROM visit"));
        const svc = new ObservationCreateService(fault);
        await rejectsAny(async () => svc.createAdHocObservation(obs(w.visitId)));
        assert((await count(w.db, "SELECT count(*) AS c FROM adhoc_observation")) === 0, "zero rows");
    });

    await ok("G5G-22: injected failure after INSERT but before COMMIT rolls back", async () => {
        const w = await freshWorld();
        // the INSERT executes inside the transaction, then COMMIT faults —
        // the whole unit must roll back
        const fault = new FaultAdapter(w.db, (kind) => kind === "commit");
        const svc = new ObservationCreateService(fault);
        await rejectsAny(async () => svc.createAdHocObservation(obs(w.visitId)));
        assert((await count(w.db, "SELECT count(*) AS c FROM adhoc_observation")) === 0, "tentative row rolled back");
    });
}

// ---------------------------------------------------------------------------
// S6 — no side effects / Class-B identity
// ---------------------------------------------------------------------------
async function tS6_sideEffects(): Promise<void> {
    await ok("G5G-23: no Finding row is created", async () => {
        const w = await freshWorld();
        await w.svc.createAdHocObservation(obs(w.visitId));
        await w.svc.createAdHocObservation(obs(w.visitId, { text: "ملاحظة ثانية" }));
        assert((await count(w.db, "SELECT count(*) AS c FROM finding")) === 0, "zero Findings");
    });

    await ok("G5G-24: no Subject row is created", async () => {
        const w = await freshWorld();
        // subject-less create must not invent a Subject
        await w.svc.createAdHocObservation(obs(w.visitId));
        assert((await count(w.db, "SELECT count(*) AS c FROM inspected_subject")) === 0, "no Subject invented");
        // create referencing an EXISTING subject must not create another
        const subjectId = await addSubjectRaw(w.db, w.institutionId);
        await w.svc.createAdHocObservation(obs(w.visitId, { subjectId }));
        assert((await count(w.db, "SELECT count(*) AS c FROM inspected_subject")) === 1, "still exactly one Subject");
    });

    await ok("G5G-25: no Evidence row is created", async () => {
        const w = await freshWorld();
        await w.svc.createAdHocObservation(obs(w.visitId));
        assert((await count(w.db, "SELECT count(*) AS c FROM evidence")) === 0, "zero Evidence rows");
    });

    await ok("G5G-26: identical payload invoked twice deliberately creates TWO distinct identities (no dedupe)", async () => {
        const w = await freshWorld();
        const a = await w.svc.createAdHocObservation(obs(w.visitId));
        const b = await w.svc.createAdHocObservation(obs(w.visitId));
        assert(a.observationId !== b.observationId, "two distinct observation identities");
        assert((await count(w.db, "SELECT count(*) AS c FROM adhoc_observation")) === 2, "two durable rows — no false dedupe");
        const rows = await obsRows(w.db);
        assert(String(rows[0].text) === String(rows[1].text), "identical stored payloads");
        assert(rows[0].finding_id === null && rows[1].finding_id === null, "both rows start unlinked");
    });
}

// ---------------------------------------------------------------------------
// S7 — boundaries / recovery
// ---------------------------------------------------------------------------
async function tS7_boundaries(): Promise<void> {
    await ok("G5G-27: production application core imports no node:* module", async () => {
        const files = ["errors.ts", "observation-create.ts"].map((f) => join(ROOT, "src", "application", f));
        for (const file of files) {
            const text = readFileSync(file, "utf8");
            const m = /(?:from\s+|require\()\s*["']node:/.exec(text);
            assert(m === null, `${file} imports a node:* module: ${m ? m[0] : ""}`);
            assert(!/node:sqlite/.test(text), `${file} must not reference node:sqlite`);
            assert(!/node-sqlite-adapter/.test(text), `${file} must not import the dev/test adapter`);
        }
    });

    await ok("G5G-28: T7 consumes an OBS-1-created observation — OBS-1 itself never links", async () => {
        const w = await freshWorld();
        const created = await w.svc.createAdHocObservation(obs(w.visitId));
        assert(created.findingId === null, "OBS-1 created no link");
        assert((await count(w.db, "SELECT count(*) AS c FROM finding")) === 0, "zero Findings after OBS-1");
        const draft: NewFindingInput = {
            description: "ceiling leak in the corridor",
            defectType: "WATER_LEAK",
            location: "corridor",
            urgency: "IMMEDIATE",
            impact: "HIGH",
        };
        const t7 = new ObservationFindingService(w.db);
        const res = await t7.createFindingWithObservationSource({
            observationId: created.observationId,
            finding: draft,
            actor: "inspector-a",
            now: NOW,
        });
        assert(res.applied === true, "T7 applied the link on the existing OBS-1 observation");
        assert((await count(w.db, "SELECT count(*) AS c FROM finding")) === 1, "T7 created exactly one Finding");
        const rows = await obsRows(w.db);
        assert(Number(rows[0].finding_id) === res.findingId, "T7 linked the OBS-1-created observation");
    });

    await ok("G5G-29: OBS-1 does not alter another existing Observation", async () => {
        const w = await freshWorld();
        const first = await w.svc.createAdHocObservation(obs(w.visitId, { text: "  الملاحظة الأولى  " }));
        const before = (await obsRows(w.db))[0];
        await w.svc.createAdHocObservation(obs(w.visitId, { text: "ملاحظة ثانية" }));
        const after = (await obsRows(w.db)).find((r) => Number(r.observation_id) === first.observationId);
        assert(after !== undefined, "first observation still exists");
        for (const col of ["observation_id", "visit_id", "subject_id", "text", "finding_id", "recorded_at", "recorded_by"]) {
            assert(after[col] === before[col], `first observation column ${col} unchanged`);
        }
        assert((await count(w.db, "SELECT count(*) AS c FROM adhoc_observation")) === 2, "only the second row was added");
    });

    await ok("G5G-30: no finalized historical row is inserted by any tested path", async () => {
        // COMPLETED world
        {
            const w = await freshWorld();
            await finalizeCompletedRaw(w.db, w.visitId);
            await rejectsCode(APP_ERR.VISIT_NOT_PREPARATION, async () => w.svc.createAdHocObservation(obs(w.visitId)));
            assert(
                (await count(
                    w.db,
                    `SELECT count(*) AS c FROM adhoc_observation o JOIN visit v ON v.visit_id = o.visit_id
                      WHERE v.finalized_at IS NOT NULL`,
                )) === 0,
                "no observation exists on the finalized COMPLETED Visit",
            );
        }
        // COMPLETED_WITH_UNINSPECTED world
        {
            const w = await freshWorld();
            const defId = await insertFixtureDefinition(w.db);
            await insertNotInspectedRow(w.db, w.visitId, defId);
            await finalizeCompletedWithUninspectedRaw(w.db, w.visitId);
            await rejectsCode(APP_ERR.VISIT_NOT_PREPARATION, async () => w.svc.createAdHocObservation(obs(w.visitId)));
            assert(
                (await count(
                    w.db,
                    `SELECT count(*) AS c FROM adhoc_observation o JOIN visit v ON v.visit_id = o.visit_id
                      WHERE v.finalized_at IS NOT NULL`,
                )) === 0,
                "no observation exists on the finalized COMPLETED_WITH_UNINSPECTED Visit",
            );
        }
    });

    await ok("G5G-31: COMMIT-success / ACK-loss — ambiguous to the caller, never a second INSERT, no claimed dedupe", async () => {
        const w = await freshWorld();
        const fault = new CommitFaultAfterAdapter(w.db);
        const svc = new ObservationCreateService(fault);
        // the durable COMMIT happens, then the ACK is lost: the caller sees an
        // ambiguous error although one durable row may exist
        await rejectsAny(async () => svc.createAdHocObservation(obs(w.visitId)));
        assert((await count(w.db, "SELECT count(*) AS c FROM adhoc_observation")) === 1, "one durable row may exist after ACK-loss");
        assert(fault.inserts.count === 1, "the service never internally issued a second INSERT");
        // a later manual re-invocation (same payload) is NOT claimed to be the
        // same request: each is a new Class-B create
        const r1 = await w.svc.createAdHocObservation(obs(w.visitId));
        const r2 = await w.svc.createAdHocObservation(obs(w.visitId));
        assert((await count(w.db, "SELECT count(*) AS c FROM adhoc_observation")) === 3, "each deliberate invocation created a row");
        const ids = new Set<number>();
        for (const r of await obsRows(w.db)) ids.add(Number(r.observation_id));
        assert(ids.size === 3 && ids.has(r1.observationId) && ids.has(r2.observationId), "three distinct observation identities");
    });
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------
const SUITES: Array<[string, () => Promise<void>]> = [
    ["G5G-1 Visit gate (PREPARATION only)", tS1_visitGate],
    ["G5G-2 text / audit validation", tS2_textAudit],
    ["G5G-2b recordedAt strict ISO-8601 UTC", tS2b_timestamp],
    ["G5G-3 optional subject", tS3_subject],
    ["G5G-4 created row semantics", tS4_rowSemantics],
    ["G5G-5 transaction atomicity / cardinality", tS5_atomicity],
    ["G5G-6 no side effects / Class-B identity", tS6_sideEffects],
    ["G5G-7 boundaries / recovery", tS7_boundaries],
];

async function main(): Promise<void> {
    for (const [label, fn] of SUITES) {
        const before = passed;
        const failBefore = failures.length;
        await fn();
        const status = failures.length === failBefore ? "PASS" : "FAIL";
        console.log(
            `[${status}] ${label} — ${passed - before} passed` +
                (failures.length > failBefore ? `, ${failures.length - failBefore} failed` : ""),
        );
    }
    console.log(`\nTOTAL: ${passed} passed, ${failures.length} failed`);
    for (const f of failures) console.log(`  FAIL ${f}`);
    if (failures.length > 0) {
        console.log("\nRESULT: FAILURE");
        process.exitCode = 1;
    } else {
        console.log("RESULT: SUCCESS (0 failures)");
        process.exitCode = 0;
    }
}

await main();
