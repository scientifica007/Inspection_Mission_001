// Gate 5H — automated regression for T8 `transitionFindingStatus`
// (TRANSACTION-CONTRACTS-v1.md §9 / APPLICATION-CORE-v1.md §4.8):
//   one atomic BEGIN IMMEDIATE unit: authoritative Finding read in-tx
//   (missing => E_FINDING_NOT_FOUND) -> adopted transition graph (OPEN ->
//   IN_TREATMENT, OPEN -> RESOLVED direct, IN_TREATMENT -> RESOLVED; generic
//   OPEN/VOIDED targets, backwards moves, and anything out of
//   RESOLVED/VOIDED refused with E_STATE_CONFLICT) -> source-count check
//   (>= 1 durable source across checklist_response + adhoc_observation) ->
//   RESOLVED target: zero CorrectiveActions OPEN/IN_TREATMENT (an action is
//   never REQUIRED) -> optional same-institution context Visit (missing =>
//   E_VISIT_NOT_FOUND, institution mismatch => E_CONTEXT, finalization
//   irrelevant — FollowUp context, not a PREPARATION gate) -> INSERT exactly
//   ONE append-only follow_up (status_target='FINDING',
//   corrective_action_id NULL, status_after=target) -> guarded UPDATE
//   finding (status_changed_at == event_datetime, changes == 1 B5, zero-row
//   => ROLLBACK + re-read) -> COMMIT.
//   T8 is NOT Visit-preparation-only: transitions keep working after the
//   origin Visit is finalized, without touching the Visit.
//   Class-A retry with REQUIRED durable event identity (Gate-5H owner
//   clarification): already-at-target converges (applied:false, no second
//   FollowUp) ONLY on the exact canonical FollowUp event + matching
//   status_changed_at; a different audit event / mismatching
//   status_changed_at / duplicate matching rows / stale retry to an
//   advanced-beyond target => E_STATE_CONFLICT.
//   FollowUp event validation: strict Gate-5G ISO-8601 UTC `Z` form for
//   eventDatetime (calendar-valid, app-supplied, never invented), Gate-5E
//   actorRole set + OTHER requires meaningful actorRoleOther, meaningful
//   normalized note/recordedBy, optional normalized actorName.
//
// Run (repository root; Node.js >= 22 is the adopted development/test host,
// Gate-5A D1 — node:sqlite + native TypeScript type stripping):
//   Node 22.x:   node --experimental-strip-types tests/gate5h_regression.ts
//   Node 24.x:   node tests/gate5h_regression.ts
// Exit: 0 on success, 1 when any assertion fails.
//
// Coverage map (GATE 5H §L TESTS) is reproduced in the ok() labels
// G5H-01..G5H-57, plus the extra schema/contract cases appended by the suite
// (G5H-58..G5H-66).

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { SqlAdapter, SqlRow, SqlValue } from "../src/bootstrap/adapter.ts";
import { openFreshDb } from "../dev/node-sqlite-adapter.ts";
import { BootstrapLoader } from "../src/bootstrap/loader.ts";
import { parseArtifact } from "../src/bootstrap/artifact.ts";
import { APP_ERR } from "../src/application/errors.ts";
import type { VisitType } from "../src/application/applicability.ts";
import { VisitScopeService } from "../src/application/visit-scope.ts";
import {
    InitialDispositionService,
    type FindingSelection,
    type ResponseCellRef,
} from "../src/application/initial-disposition.ts";
import {
    FindingTransitionService,
    type FindingStatus,
    type FindingTransitionEventInput,
    type TransitionFindingStatusResult,
} from "../src/application/finding-status.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_SQL = readFileSync(join(ROOT, "docs", "schema", "schema.sql"), "utf8");
const ARTIFACT_PATH = join(ROOT, "bootstrap", "v1", "checklist-v1.json");
const COMMITTED = parseArtifact(readFileSync(ARTIFACT_PATH, "utf8"));
const EXPECTED_P0 = COMMITTED.manifest.expected_p0_item_codes;

const NOW = "2026-09-01T08:00:00.000Z";
const T_EVENT = "2026-09-02T10:00:00.000Z";
const T_EVENT2 = "2026-09-02T11:00:00.000Z";
const T_EVENT3 = "2026-09-03T09:00:00.000Z";
const VISIT_DATE = "2026-09-10";

// ---------------------------------------------------------------------------
// tiny assertion harness (same conventions as tests/gate5g_regression.ts)
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
// fault-injecting adapters (same shape as tests/gate5e_regression.ts)
// ---------------------------------------------------------------------------
class FaultAdapter implements SqlAdapter {
    private readonly inner: SqlAdapter;
    private readonly shouldFail: (sql: string, params: readonly SqlValue[]) => boolean;

    constructor(inner: SqlAdapter, shouldFail: (sql: string, params: readonly SqlValue[]) => boolean) {
        this.inner = inner;
        this.shouldFail = shouldFail;
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
        if (this.shouldFail(sql, params)) throw new Error("injected adapter fault");
        return this.inner.run(sql, params);
    }
    async query(sql: string, params: readonly SqlValue[] = []): Promise<SqlRow[]> {
        return this.inner.query(sql, params);
    }
}

/** fabricates a zero-row result for the first matching write (B5 simulation). */
class FakeChangesAdapter implements SqlAdapter {
    private readonly inner: SqlAdapter;
    private readonly shouldFake: (sql: string, params: readonly SqlValue[]) => boolean;
    private fired = false;

    constructor(inner: SqlAdapter, shouldFake: (sql: string, params: readonly SqlValue[]) => boolean) {
        this.inner = inner;
        this.shouldFake = shouldFake;
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
        if (!this.fired && this.shouldFake(sql, params)) {
            this.fired = true;
            return { changes: 0, lastInsertRowid: null };
        }
        return this.inner.run(sql, params);
    }
    async query(sql: string, params: readonly SqlValue[] = []): Promise<SqlRow[]> {
        return this.inner.query(sql, params);
    }
}

/**
 * One-shot read fabrication: the first matching query returns the fabricated
 * rows instead of the durable ones (deterministic TOCTOU/race simulation —
 * the in-transaction read observes a stale status while the durable row has
 * already advanced, exactly the window the zero-row guarded UPDATE defends).
 */
class FabricateReadOnceAdapter implements SqlAdapter {
    private readonly inner: SqlAdapter;
    private readonly shouldFabricate: (sql: string, params: readonly SqlValue[]) => boolean;
    private readonly fabricate: (rows: SqlRow[]) => SqlRow[];
    private fired = false;

    constructor(
        inner: SqlAdapter,
        shouldFabricate: (sql: string, params: readonly SqlValue[]) => boolean,
        fabricate: (rows: SqlRow[]) => SqlRow[],
    ) {
        this.inner = inner;
        this.shouldFabricate = shouldFabricate;
        this.fabricate = fabricate;
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
        return this.inner.run(sql, params);
    }
    async query(sql: string, params: readonly SqlValue[] = []): Promise<SqlRow[]> {
        if (!this.fired && this.shouldFabricate(sql, params)) {
            this.fired = true;
            return this.fabricate(await this.inner.query(sql, params));
        }
        return this.inner.query(sql, params);
    }
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------
interface World {
    db: SqlAdapter;
    scope: VisitScopeService;
    disp: InitialDispositionService;
    svc: FindingTransitionService;
    missionId: number;
    institutionId: number;
}

async function freshWorld(missionStatus = "PREPARATION"): Promise<World> {
    const db = openFreshDb(SCHEMA_SQL);
    await new BootstrapLoader(db, COMMITTED).load();
    const missionId = Number(
        (await db.run("INSERT INTO mission(name, status, created_at, created_by) VALUES ('M', ?, ?, 'owner')", [missionStatus, NOW]))
            .lastInsertRowid,
    );
    const institutionId = Number(
        (await db.run("INSERT INTO institution(name, created_at, created_by) VALUES ('Inst', ?, 'owner')", [NOW])).lastInsertRowid,
    );
    return {
        db,
        scope: new VisitScopeService(db),
        disp: new InitialDispositionService(db),
        svc: new FindingTransitionService(db),
        missionId,
        institutionId,
    };
}

async function standardCreate(w: World, visitType: VisitType = "PLANNED"): Promise<number> {
    const res = await w.scope.createVisit({
        missionId: w.missionId,
        institutionId: w.institutionId,
        visitType,
        visitDate: VISIT_DATE,
        inspector: "inspector-a",
        expectedP0ItemCodes: EXPECTED_P0,
        actor: "inspector-a",
        now: NOW,
    });
    assert(res.capturedCount === EXPECTED_P0.length, `capturedCount ${res.capturedCount}`);
    return res.visitId;
}

async function createVisitFor(w: World, institutionId: number, visitType: VisitType = "PLANNED"): Promise<number> {
    const res = await w.scope.createVisit({
        missionId: w.missionId,
        institutionId,
        visitType,
        visitDate: VISIT_DATE,
        inspector: "inspector-b",
        expectedP0ItemCodes: EXPECTED_P0,
        actor: "inspector-b",
        now: NOW,
    });
    return res.visitId;
}

async function createInstitutionRaw(db: SqlAdapter, name: string): Promise<number> {
    const res = await db.run(
        "INSERT INTO institution(name, created_at, created_by) VALUES (?, ?, 'owner')",
        [name, NOW] as readonly SqlValue[],
    );
    assert(res.changes === 1 && res.lastInsertRowid !== null, "institution insert failed");
    return Number(res.lastInsertRowid);
}

/** raw OPEN Finding insert (fixture; origin = visit, NO sources yet). */
async function insertFindingRaw(
    db: SqlAdapter,
    visitId: number,
    description = "ceiling leak in the corridor",
): Promise<number> {
    const res = await db.run(
        `INSERT INTO finding(origin_visit_id, description, defect_type, location, subject_id,
                             urgency, impact, status, status_changed_at, created_at, created_by)
         VALUES (?, ?, 'WATER_LEAK', 'corridor', NULL, 'IMMEDIATE', 'HIGH', 'OPEN', NULL, ?, 'inspector-a')`,
        [visitId, description, NOW] as readonly SqlValue[],
    );
    assert(res.changes === 1 && res.lastInsertRowid !== null, "finding insert failed");
    return Number(res.lastInsertRowid);
}

/** raw observation row already linked as the finding's FIRST source. */
async function insertObservationSourceRaw(db: SqlAdapter, visitId: number, findingId: number): Promise<number> {
    const res = await db.run(
        `INSERT INTO adhoc_observation(visit_id, subject_id, text, finding_id, recorded_at, recorded_by)
         VALUES (?, NULL, 'leak observed in the corridor', ?, ?, 'inspector-a')`,
        [visitId, findingId, NOW] as readonly SqlValue[],
    );
    assert(res.changes === 1 && res.lastInsertRowid !== null, "observation insert failed");
    return Number(res.lastInsertRowid);
}

/** finding whose durable source is a checklist_response (NC answer, T2/T3A). */
function newFindingSel(extra: Partial<{ urgency: string; impact: string; description: string }> = {}): FindingSelection {
    return {
        mode: "new",
        finding: {
            description: extra.description ?? "equipment defective",
            defectType: "EQUIPMENT_FAULT",
            location: "workshop",
            urgency: (extra.urgency ?? "IMMEDIATE") as never,
            impact: (extra.impact ?? "HIGH") as never,
        },
    };
}

async function cellOf(db: SqlAdapter, visitId: number, subjectId: number | null, itemCode: string): Promise<ResponseCellRef> {
    const rows = await db.query(
        `SELECT cr.item_definition_id
           FROM checklist_response cr
           JOIN checklist_item_definition d ON d.item_definition_id = cr.item_definition_id
          WHERE cr.visit_id = ? AND d.item_code = ? ${subjectId === null ? "AND cr.subject_id IS NULL" : "AND cr.subject_id = ?"}`,
        subjectId === null ? [visitId, itemCode] : [visitId, itemCode, subjectId],
    );
    assert(rows.length === 1, `expected exactly one materialized ${itemCode} cell for visit ${visitId}`);
    return { visitId, itemDefinitionId: Number(rows[0].item_definition_id), subjectId };
}

async function valueIdOf(db: SqlAdapter, itemCode: string, valueCode: string): Promise<number> {
    const rows = await db.query(
        `SELECT av.allowed_value_id
           FROM checklist_allowed_value av
           JOIN checklist_item_definition d ON d.item_definition_id = av.item_definition_id
          WHERE d.item_code = ? AND av.value_code = ?`,
        [itemCode, valueCode],
    );
    assert(rows.length === 1, `expected one allowed value ${itemCode}/${valueCode}`);
    return Number(rows[0].allowed_value_id);
}

async function responseSourceFinding(w: World, visitId: number): Promise<number> {
    const c = await cellOf(w.db, visitId, null, "CHK-010");
    const res = await w.disp.answerSingle({
        cell: c,
        allowedValueId: await valueIdOf(w.db, "CHK-010", "NOT_AVAILABLE"),
        note: "مشكلة جرد",
        finding: newFindingSel(),
        actor: "inspector-a",
        now: NOW,
    });
    assert(res.findingId !== null, "the NC answer must create a Finding");
    return res.findingId;
}

/** raw CorrectiveAction under the finding (fixture; T9 stays out of scope). */
async function insertCaRaw(
    db: SqlAdapter,
    findingId: number,
    status: "OPEN" | "IN_TREATMENT" | "RESOLVED" = "OPEN",
): Promise<number> {
    const res = await db.run(
        `INSERT INTO corrective_action(finding_id, action_type, description, responsible_role, status,
                                       created_at, created_by)
         VALUES (?, 'MAINTENANCE_WORK', 'repair the leak', 'CONCERNED_SERVICE', 'OPEN', ?, 'inspector-a')`,
        [findingId, NOW] as readonly SqlValue[],
    );
    assert(res.changes === 1 && res.lastInsertRowid !== null, "corrective action insert failed");
    const actionId = Number(res.lastInsertRowid);
    if (status === "IN_TREATMENT") {
        await db.run("UPDATE corrective_action SET status = 'IN_TREATMENT' WHERE action_id = ?", [actionId]);
    } else if (status === "RESOLVED") {
        await db.run(
            "UPDATE corrective_action SET status = 'RESOLVED', closed_at = ?, verified_by = 'director-a', verification_note = 'verified' WHERE action_id = ?",
            [NOW, actionId],
        );
    }
    return actionId;
}

/** finalize the visit fixture-style (reason every pending cell first). */
async function finalizeVisitRaw(db: SqlAdapter, visitId: number, at: string = NOW): Promise<void> {
    await db.run(
        `UPDATE checklist_response SET not_inspected_reason = 'closed by owner'
          WHERE visit_id = ? AND overlay_state = 'NOT_INSPECTED' AND not_inspected_reason IS NULL`,
        [visitId],
    );
    const fin = await db.run(
        `UPDATE visit SET status = 'COMPLETED_WITH_UNINSPECTED', finalized_at = ?
          WHERE visit_id = ? AND status = 'PREPARATION' AND finalized_at IS NULL`,
        [at, visitId],
    );
    assert(fin.changes === 1, "visit must finalize");
}

/** fixture VOID (source-less OPEN finding, origin visit still PREPARATION). */
async function voidFindingRaw(db: SqlAdapter, findingId: number, at: string = T_EVENT3): Promise<void> {
    const res = await db.run(
        "UPDATE finding SET status = 'VOIDED', status_changed_at = ? WHERE finding_id = ? AND status = 'OPEN'",
        [at, findingId],
    );
    assert(res.changes === 1, "fixture VOID update failed");
}

// ---------------------------------------------------------------------------
// T8 call helpers
// ---------------------------------------------------------------------------
function ev(extra: Partial<FindingTransitionEventInput> = {}): FindingTransitionEventInput {
    return {
        eventDatetime: T_EVENT,
        actorRole: "DIRECTOR",
        actorName: "director-a",
        note: "treatment started",
        recordedBy: "follow-up-clerk",
        ...extra,
    };
}

function transition(
    svc: FindingTransitionService,
    findingId: number,
    to: FindingStatus,
    event: FindingTransitionEventInput,
    contextVisitId?: number | null,
): Promise<TransitionFindingStatusResult> {
    return svc.transitionFindingStatus({ findingId, to, event, contextVisitId });
}

async function findingRow(db: SqlAdapter, findingId: number): Promise<SqlRow> {
    const rows = await db.query("SELECT * FROM finding WHERE finding_id = ?", [findingId]);
    assert(rows.length === 1, `finding ${findingId} missing`);
    return rows[0];
}

async function followUpRows(db: SqlAdapter, findingId: number): Promise<SqlRow[]> {
    return db.query("SELECT * FROM follow_up WHERE finding_id = ? ORDER BY followup_id", [findingId]);
}

async function findingStatusOf(db: SqlAdapter, findingId: number): Promise<string> {
    return String((await findingRow(db, findingId)).status);
}

/** total recorded sources (both source tables) of a finding. */
async function findingSources(db: SqlAdapter, findingId: number): Promise<number> {
    return count(
        db,
        `SELECT (SELECT count(*) FROM checklist_response WHERE finding_id = ?) +
                (SELECT count(*) FROM adhoc_observation WHERE finding_id = ?) AS c`,
        [findingId, findingId],
    );
}

// ---------------------------------------------------------------------------
// S1 — basic legal transitions
// ---------------------------------------------------------------------------
async function tS1_basic(): Promise<void> {
    await ok("G5H-01: missing Finding => E_FINDING_NOT_FOUND", async () => {
        const w = await freshWorld();
        await rejectsCode(APP_ERR.FINDING_NOT_FOUND, () => transition(w.svc, 999, "IN_TREATMENT", ev()));
        assert((await count(w.db, "SELECT count(*) AS c FROM follow_up")) === 0, "no FollowUp for a missing Finding");
    });

    await ok("G5H-02: OPEN -> IN_TREATMENT succeeds", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const fid = await responseSourceFinding(w, visitId);
        const res = await transition(w.svc, fid, "IN_TREATMENT", ev());
        assert(res.applied === true, "applied");
        assert(res.findingId === fid, "findingId");
        assert(res.status === "IN_TREATMENT", "status");
        assert(res.statusChangedAt === T_EVENT, "statusChangedAt");
        assert((await findingStatusOf(w.db, fid)) === "IN_TREATMENT", "durable status");
    });

    await ok("G5H-03: OPEN -> RESOLVED succeeds directly", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const fid = await insertFindingRaw(w.db, visitId);
        await insertObservationSourceRaw(w.db, visitId, fid);
        const res = await transition(w.svc, fid, "RESOLVED", ev());
        assert(res.applied === true && res.status === "RESOLVED", "direct OPEN -> RESOLVED applied");
        assert(res.statusChangedAt === T_EVENT, "statusChangedAt");
    });

    await ok("G5H-04: IN_TREATMENT -> RESOLVED succeeds", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const fid = await insertFindingRaw(w.db, visitId);
        await insertObservationSourceRaw(w.db, visitId, fid);
        await transition(w.svc, fid, "IN_TREATMENT", ev());
        const res = await transition(w.svc, fid, "RESOLVED", ev({ eventDatetime: T_EVENT2 }));
        assert(res.applied === true && res.status === "RESOLVED", "second legal transition applied");
        assert(res.statusChangedAt === T_EVENT2, "statusChangedAt follows the second event");
    });

    await ok("G5H-05: status_changed_at == event_datetime (exact)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const fid = await insertFindingRaw(w.db, visitId);
        await insertObservationSourceRaw(w.db, visitId, fid);
        await transition(w.svc, fid, "IN_TREATMENT", ev());
        const f = await findingRow(w.db, fid);
        const fus = await followUpRows(w.db, fid);
        assert(String(f.status_changed_at) === T_EVENT, "finding.status_changed_at == event_datetime");
        assert(String(fus[0].event_datetime) === T_EVENT, "follow_up.event_datetime == event_datetime");
        assert(String(f.status_changed_at) === String(fus[0].event_datetime), "both rows share the same instant");
    });

    await ok("G5H-06: exactly one FollowUp written", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const fid = await insertFindingRaw(w.db, visitId);
        await insertObservationSourceRaw(w.db, visitId, fid);
        await transition(w.svc, fid, "IN_TREATMENT", ev());
        assert((await followUpRows(w.db, fid)).length === 1, "exactly one follow_up row");
    });

    await ok("G5H-07: FollowUp status_target='FINDING'", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const fid = await insertFindingRaw(w.db, visitId);
        await insertObservationSourceRaw(w.db, visitId, fid);
        await transition(w.svc, fid, "RESOLVED", ev());
        const fus = await followUpRows(w.db, fid);
        assert(String(fus[0].status_target) === "FINDING", "status_target");
        assert(String(fus[0].status_after) === "RESOLVED", "status_after");
    });

    await ok("G5H-08: FollowUp corrective_action_id NULL", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const fid = await insertFindingRaw(w.db, visitId);
        await insertObservationSourceRaw(w.db, visitId, fid);
        await transition(w.svc, fid, "IN_TREATMENT", ev());
        const fus = await followUpRows(w.db, fid);
        assert(fus[0].corrective_action_id === null, "corrective_action_id is NULL");
    });
}

// ---------------------------------------------------------------------------
// S2 — source-count integrity
// ---------------------------------------------------------------------------
async function tS2_sourceIntegrity(): Promise<void> {
    await ok("G5H-09: source-less OPEN -> IN_TREATMENT rejected", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const fid = await insertFindingRaw(w.db, visitId);
        await rejectsCode(APP_ERR.STATE_CONFLICT, () => transition(w.svc, fid, "IN_TREATMENT", ev()));
        assert((await findingStatusOf(w.db, fid)) === "OPEN", "status unchanged");
        assert((await count(w.db, "SELECT count(*) AS c FROM follow_up")) === 0, "no FollowUp written");
    });

    await ok("G5H-10: source-less OPEN -> RESOLVED rejected", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const fid = await insertFindingRaw(w.db, visitId);
        await rejectsCode(APP_ERR.STATE_CONFLICT, () => transition(w.svc, fid, "RESOLVED", ev()));
        assert((await findingStatusOf(w.db, fid)) === "OPEN", "status unchanged");
        assert((await count(w.db, "SELECT count(*) AS c FROM follow_up")) === 0, "no FollowUp written");
    });

    await ok("G5H-11: a checklist_response source satisfies the source requirement", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const fid = await responseSourceFinding(w, visitId);
        const res = await transition(w.svc, fid, "IN_TREATMENT", ev());
        assert(res.applied === true, "response-source Finding transitions");
    });

    await ok("G5H-12: an adhoc_observation source satisfies the source requirement", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const fid = await insertFindingRaw(w.db, visitId);
        await insertObservationSourceRaw(w.db, visitId, fid);
        const res = await transition(w.svc, fid, "RESOLVED", ev());
        assert(res.applied === true, "observation-source Finding transitions");
    });
}

// ---------------------------------------------------------------------------
// S3 — RESOLVED / CorrectiveAction preconditions
// ---------------------------------------------------------------------------
async function tS3_correctiveActions(): Promise<void> {
    await ok("G5H-13: OPEN -> RESOLVED with zero actions succeeds", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const fid = await insertFindingRaw(w.db, visitId);
        await insertObservationSourceRaw(w.db, visitId, fid);
        assert((await count(w.db, "SELECT count(*) AS c FROM corrective_action WHERE finding_id = ?", [fid])) === 0, "no actions");
        const res = await transition(w.svc, fid, "RESOLVED", ev());
        assert(res.applied === true && res.status === "RESOLVED", "no CorrectiveAction is required to resolve");
    });

    await ok("G5H-14: OPEN -> RESOLVED with an OPEN action rejected", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const fid = await insertFindingRaw(w.db, visitId);
        await insertObservationSourceRaw(w.db, visitId, fid);
        await insertCaRaw(w.db, fid, "OPEN");
        await rejectsCode(APP_ERR.STATE_CONFLICT, () => transition(w.svc, fid, "RESOLVED", ev()));
        assert((await findingStatusOf(w.db, fid)) === "OPEN", "status unchanged");
        assert((await count(w.db, "SELECT count(*) AS c FROM follow_up")) === 0, "no FollowUp written");
    });

    await ok("G5H-15: OPEN -> RESOLVED with an IN_TREATMENT action rejected", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const fid = await insertFindingRaw(w.db, visitId);
        await insertObservationSourceRaw(w.db, visitId, fid);
        await insertCaRaw(w.db, fid, "IN_TREATMENT");
        await rejectsCode(APP_ERR.STATE_CONFLICT, () => transition(w.svc, fid, "RESOLVED", ev()));
        assert((await findingStatusOf(w.db, fid)) === "OPEN", "status unchanged");
        assert((await count(w.db, "SELECT count(*) AS c FROM follow_up")) === 0, "no FollowUp written");
    });

    await ok("G5H-16: OPEN -> RESOLVED with all actions RESOLVED succeeds", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const fid = await insertFindingRaw(w.db, visitId);
        await insertObservationSourceRaw(w.db, visitId, fid);
        await insertCaRaw(w.db, fid, "RESOLVED");
        await insertCaRaw(w.db, fid, "RESOLVED");
        const res = await transition(w.svc, fid, "RESOLVED", ev());
        assert(res.applied === true && res.status === "RESOLVED", "resolved actions do not block");
    });

    await ok("G5H-17: IN_TREATMENT -> RESOLVED with an active action rejected", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const fid = await insertFindingRaw(w.db, visitId);
        await insertObservationSourceRaw(w.db, visitId, fid);
        await transition(w.svc, fid, "IN_TREATMENT", ev());
        await insertCaRaw(w.db, fid, "OPEN");
        await rejectsCode(APP_ERR.STATE_CONFLICT, () => transition(w.svc, fid, "RESOLVED", ev({ eventDatetime: T_EVENT2 })));
        assert((await findingStatusOf(w.db, fid)) === "IN_TREATMENT", "status unchanged");
        assert((await followUpRows(w.db, fid)).length === 1, "still exactly the first FollowUp");
    });

    await ok("G5H-58: mixed actions (one RESOLVED + one OPEN) still block RESOLVED", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const fid = await insertFindingRaw(w.db, visitId);
        await insertObservationSourceRaw(w.db, visitId, fid);
        await insertCaRaw(w.db, fid, "RESOLVED");
        await insertCaRaw(w.db, fid, "OPEN");
        await rejectsCode(APP_ERR.STATE_CONFLICT, () => transition(w.svc, fid, "RESOLVED", ev()));
        assert((await findingStatusOf(w.db, fid)) === "OPEN", "one active action among resolved ones still blocks");
    });
}

// ---------------------------------------------------------------------------
// S4 — forbidden transitions
// ---------------------------------------------------------------------------
async function tS4_forbidden(): Promise<void> {
    await ok("G5H-18: generic OPEN -> VOIDED rejected", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const fid = await insertFindingRaw(w.db, visitId);
        await insertObservationSourceRaw(w.db, visitId, fid);
        await rejectsCode(APP_ERR.STATE_CONFLICT, () => transition(w.svc, fid, "VOIDED", ev()));
        assert((await findingStatusOf(w.db, fid)) === "OPEN", "status unchanged");
        assert((await count(w.db, "SELECT count(*) AS c FROM follow_up")) === 0, "no FollowUp written");
    });

    await ok("G5H-19: IN_TREATMENT -> VOIDED rejected", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const fid = await insertFindingRaw(w.db, visitId);
        await insertObservationSourceRaw(w.db, visitId, fid);
        await transition(w.svc, fid, "IN_TREATMENT", ev());
        await rejectsCode(APP_ERR.STATE_CONFLICT, () => transition(w.svc, fid, "VOIDED", ev({ eventDatetime: T_EVENT2 })));
        assert((await findingStatusOf(w.db, fid)) === "IN_TREATMENT", "status unchanged");
    });

    await ok("G5H-20: IN_TREATMENT -> OPEN rejected (backwards)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const fid = await insertFindingRaw(w.db, visitId);
        await insertObservationSourceRaw(w.db, visitId, fid);
        await transition(w.svc, fid, "IN_TREATMENT", ev());
        await rejectsCode(APP_ERR.STATE_CONFLICT, () => transition(w.svc, fid, "OPEN", ev({ eventDatetime: T_EVENT2 })));
        assert((await findingStatusOf(w.db, fid)) === "IN_TREATMENT", "status unchanged");
    });

    await ok("G5H-21: RESOLVED -> anything rejected", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const fid = await insertFindingRaw(w.db, visitId);
        await insertObservationSourceRaw(w.db, visitId, fid);
        await transition(w.svc, fid, "RESOLVED", ev());
        await rejectsCode(APP_ERR.STATE_CONFLICT, () => transition(w.svc, fid, "IN_TREATMENT", ev({ eventDatetime: T_EVENT2 })));
        await rejectsCode(APP_ERR.STATE_CONFLICT, () => transition(w.svc, fid, "OPEN", ev({ eventDatetime: T_EVENT2 })));
        // already RESOLVED with a DIFFERENT audit event never converges either
        await rejectsCode(APP_ERR.STATE_CONFLICT, () => transition(w.svc, fid, "RESOLVED", ev({ eventDatetime: T_EVENT2 })));
        assert((await findingStatusOf(w.db, fid)) === "RESOLVED", "terminal status unchanged");
        assert((await followUpRows(w.db, fid)).length === 1, "still exactly one FollowUp");
    });

    await ok("G5H-22: VOIDED -> anything rejected", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const fid = await insertFindingRaw(w.db, visitId);
        await voidFindingRaw(w.db, fid);
        await rejectsCode(APP_ERR.STATE_CONFLICT, () => transition(w.svc, fid, "IN_TREATMENT", ev()));
        await rejectsCode(APP_ERR.STATE_CONFLICT, () => transition(w.svc, fid, "RESOLVED", ev()));
        await rejectsCode(APP_ERR.STATE_CONFLICT, () => transition(w.svc, fid, "VOIDED", ev()));
        assert((await findingStatusOf(w.db, fid)) === "VOIDED", "terminal status unchanged");
        assert((await count(w.db, "SELECT count(*) AS c FROM follow_up")) === 0, "T8 never wrote a FollowUp");
    });

    await ok("G5H-23: target OPEN rejected as a generic T8 request", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const fid = await insertFindingRaw(w.db, visitId);
        await insertObservationSourceRaw(w.db, visitId, fid);
        await rejectsCode(APP_ERR.STATE_CONFLICT, () => transition(w.svc, fid, "OPEN", ev()));
        assert((await findingStatusOf(w.db, fid)) === "OPEN", "status unchanged");
    });

    await ok("G5H-59: unknown 'to' value is a malformed request (E_CONFIG)", async () => {
        const w = await freshWorld();
        await rejectsCode(APP_ERR.CONFIG, () => transition(w.svc, 999, "FROZEN" as FindingStatus, ev()));
    });
}

// ---------------------------------------------------------------------------
// S5 — Visit lifecycle (T8 is not preparation-only)
// ---------------------------------------------------------------------------
async function tS5_visitLifecycle(): Promise<void> {
    await ok("G5H-24: legal T8 transition after origin Visit finalization succeeds", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const fid = await insertFindingRaw(w.db, visitId);
        await insertObservationSourceRaw(w.db, visitId, fid);
        await finalizeVisitRaw(w.db, visitId);
        const res = await transition(w.svc, fid, "IN_TREATMENT", ev());
        assert(res.applied === true && res.status === "IN_TREATMENT", "follow-up continues after finalization");
        const res2 = await transition(w.svc, fid, "RESOLVED", ev({ eventDatetime: T_EVENT2 }));
        assert(res2.applied === true && res2.status === "RESOLVED", "full post-finalization progression");
    });

    await ok("G5H-25: T8 does not alter/reopen the Visit", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const fid = await insertFindingRaw(w.db, visitId);
        await insertObservationSourceRaw(w.db, visitId, fid);
        await finalizeVisitRaw(w.db, visitId);
        const before = await w.db.query("SELECT status, finalized_at FROM visit WHERE visit_id = ?", [visitId]);
        await transition(w.svc, fid, "IN_TREATMENT", ev());
        const after = await w.db.query("SELECT status, finalized_at FROM visit WHERE visit_id = ?", [visitId]);
        assert(String(after[0].status) === String(before[0].status), "visit status untouched");
        assert(String(after[0].finalized_at) === String(before[0].finalized_at), "finalized_at untouched");
    });
}

// ---------------------------------------------------------------------------
// S6 — optional context Visit
// ---------------------------------------------------------------------------
async function tS6_contextVisit(): Promise<void> {
    await ok("G5H-26: NULL contextVisitId succeeds", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const fid = await insertFindingRaw(w.db, visitId);
        await insertObservationSourceRaw(w.db, visitId, fid);
        const res = await transition(w.svc, fid, "IN_TREATMENT", ev(), null);
        assert(res.applied === true, "null context visit is FollowUp context-free");
        const fus = await followUpRows(w.db, fid);
        assert(fus[0].visit_id === null, "follow_up.visit_id NULL");
    });

    await ok("G5H-27: same-institution context Visit succeeds", async () => {
        const w = await freshWorld();
        const origin = await standardCreate(w);
        const context = await createVisitFor(w, w.institutionId);
        const fid = await insertFindingRaw(w.db, origin);
        await insertObservationSourceRaw(w.db, origin, fid);
        const res = await transition(w.svc, fid, "IN_TREATMENT", ev(), context);
        assert(res.applied === true, "same-institution context visit accepted");
        const fus = await followUpRows(w.db, fid);
        assert(Number(fus[0].visit_id) === context, "follow_up.visit_id == contextVisitId");
    });

    await ok("G5H-28: missing context Visit => E_VISIT_NOT_FOUND", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const fid = await insertFindingRaw(w.db, visitId);
        await insertObservationSourceRaw(w.db, visitId, fid);
        await rejectsCode(APP_ERR.VISIT_NOT_FOUND, () => transition(w.svc, fid, "IN_TREATMENT", ev(), 9999));
        assert((await findingStatusOf(w.db, fid)) === "OPEN", "status unchanged");
        assert((await count(w.db, "SELECT count(*) AS c FROM follow_up")) === 0, "no FollowUp written");
    });

    await ok("G5H-29: cross-institution context Visit => E_CONTEXT", async () => {
        const w = await freshWorld();
        const origin = await standardCreate(w);
        const otherInstitution = await createInstitutionRaw(w.db, "Other");
        const foreign = await createVisitFor(w, otherInstitution);
        const fid = await insertFindingRaw(w.db, origin);
        await insertObservationSourceRaw(w.db, origin, fid);
        await rejectsCode(APP_ERR.CONTEXT, () => transition(w.svc, fid, "IN_TREATMENT", ev(), foreign));
        assert((await findingStatusOf(w.db, fid)) === "OPEN", "status unchanged");
        assert((await count(w.db, "SELECT count(*) AS c FROM follow_up")) === 0, "no FollowUp written");
    });

    await ok("G5H-30: finalized same-institution context Visit is not rejected merely for being finalized", async () => {
        const w = await freshWorld();
        const origin = await standardCreate(w);
        const context = await createVisitFor(w, w.institutionId);
        await finalizeVisitRaw(w.db, context);
        const fid = await insertFindingRaw(w.db, origin);
        await insertObservationSourceRaw(w.db, origin, fid);
        const res = await transition(w.svc, fid, "IN_TREATMENT", ev(), context);
        assert(res.applied === true, "context Visit finalization is irrelevant to T8");
        const fus = await followUpRows(w.db, fid);
        assert(Number(fus[0].visit_id) === context, "follow_up.visit_id == finalized context visit");
    });

    await ok("G5H-60: the origin Visit itself is an acceptable context Visit", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const fid = await insertFindingRaw(w.db, visitId);
        await insertObservationSourceRaw(w.db, visitId, fid);
        const res = await transition(w.svc, fid, "IN_TREATMENT", ev(), visitId);
        assert(res.applied === true, "origin visit passes the same-institution rule");
        const fus = await followUpRows(w.db, fid);
        assert(Number(fus[0].visit_id) === visitId, "follow_up.visit_id == origin visit");
    });
}

// ---------------------------------------------------------------------------
// S7 — FollowUp event validation
// ---------------------------------------------------------------------------
async function tS7_eventValidation(): Promise<void> {
    await ok("G5H-31: meaningful note required (blank => E_CONFIG)", async () => {
        const w = await freshWorld();
        await rejectsCode(APP_ERR.CONFIG, () => transition(w.svc, 999, "IN_TREATMENT", ev({ note: "   " })));
    });

    await ok("G5H-32: meaningful recordedBy required (blank => E_CONFIG)", async () => {
        const w = await freshWorld();
        await rejectsCode(APP_ERR.CONFIG, () => transition(w.svc, 999, "IN_TREATMENT", ev({ recordedBy: "  " })));
    });

    await ok("G5H-33: actorRole=OTHER requires a meaningful actorRoleOther", async () => {
        const w = await freshWorld();
        await rejectsCode(APP_ERR.CONFIG, () => transition(w.svc, 999, "IN_TREATMENT", ev({ actorRole: "OTHER" })));
        await rejectsCode(APP_ERR.CONFIG, () => transition(w.svc, 999, "IN_TREATMENT", ev({ actorRole: "OTHER", actorRoleOther: "  " })));
    });

    await ok("G5H-34: invalid actorRole rejected (E_CONFIG)", async () => {
        const w = await freshWorld();
        await rejectsCode(APP_ERR.CONFIG, () =>
            transition(w.svc, 999, "IN_TREATMENT", ev({ actorRole: "MANAGER" as never })),
        );
    });

    await ok("G5H-35: canonical UTC Z timestamp accepted", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const fid = await insertFindingRaw(w.db, visitId);
        await insertObservationSourceRaw(w.db, visitId, fid);
        const res = await transition(w.svc, fid, "IN_TREATMENT", ev({ eventDatetime: "2026-09-02T10:00:00Z" }));
        assert(res.applied === true, "second-precision UTC Z accepted");
        assert(res.statusChangedAt === "2026-09-02T10:00:00Z", "stored verbatim");
    });

    await ok("G5H-36: milliseconds UTC Z accepted", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const fid = await insertFindingRaw(w.db, visitId);
        await insertObservationSourceRaw(w.db, visitId, fid);
        const res = await transition(w.svc, fid, "RESOLVED", ev({ eventDatetime: "2026-09-02T10:00:00.123Z" }));
        assert(res.applied === true, "fractional UTC Z accepted");
        assert(res.statusChangedAt === "2026-09-02T10:00:00.123Z", "stored verbatim");
    });

    await ok("G5H-37: non-date eventDatetime rejected", async () => {
        const w = await freshWorld();
        await rejectsCode(APP_ERR.CONFIG, () => transition(w.svc, 999, "IN_TREATMENT", ev({ eventDatetime: "not-a-date" })));
    });

    await ok("G5H-38: timezone-less eventDatetime rejected", async () => {
        const w = await freshWorld();
        await rejectsCode(APP_ERR.CONFIG, () =>
            transition(w.svc, 999, "IN_TREATMENT", ev({ eventDatetime: "2026-09-02T10:00:00" })),
        );
    });

    await ok("G5H-39: non-Z offset eventDatetime rejected", async () => {
        const w = await freshWorld();
        await rejectsCode(APP_ERR.CONFIG, () =>
            transition(w.svc, 999, "IN_TREATMENT", ev({ eventDatetime: "2026-09-02T10:00:00+01:00" })),
        );
    });

    await ok("G5H-40: impossible calendar/time components rejected", async () => {
        const w = await freshWorld();
        for (const bad of ["2026-02-30T10:00:00Z", "2026-13-01T10:00:00Z", "2026-09-02T25:00:00Z", "2026-09-02T10:61:00Z"]) {
            await rejectsCode(APP_ERR.CONFIG, () => transition(w.svc, 999, "IN_TREATMENT", ev({ eventDatetime: bad })));
        }
    });

    await ok("G5H-61: eventDatetime is trimmed and stored normalized", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const fid = await insertFindingRaw(w.db, visitId);
        await insertObservationSourceRaw(w.db, visitId, fid);
        const res = await transition(w.svc, fid, "IN_TREATMENT", ev({ eventDatetime: "  2026-09-02T10:00:00.000Z  " }));
        assert(res.applied === true, "padded datetime accepted after trimming");
        assert(res.statusChangedAt === T_EVENT, "stored as the normalized trimmed value");
        const fus = await followUpRows(w.db, fid);
        assert(String(fus[0].event_datetime) === T_EVENT, "follow_up stores the trimmed value");
    });

    await ok("G5H-62: actorName is optional and stored NULL when omitted", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const fid = await insertFindingRaw(w.db, visitId);
        await insertObservationSourceRaw(w.db, visitId, fid);
        const res = await transition(w.svc, fid, "IN_TREATMENT", ev({ actorName: undefined }));
        assert(res.applied === true, "actorName omitted");
        const fus = await followUpRows(w.db, fid);
        assert(fus[0].actor_name === null, "actor_name NULL");
        // and an identical retry without actorName still converges
        const retry = await transition(w.svc, fid, "IN_TREATMENT", ev({ actorName: undefined }));
        assert(retry.applied === false, "identical null-safe retry converges");
    });

    await ok("G5H-63: actorRoleOther is normalized (trimmed) and stored", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const fid = await insertFindingRaw(w.db, visitId);
        await insertObservationSourceRaw(w.db, visitId, fid);
        const res = await transition(w.svc, fid, "IN_TREATMENT", ev({ actorRole: "OTHER", actorRoleOther: "  field-team  " }));
        assert(res.applied === true, "OTHER + meaningful roleOther accepted");
        const fus = await followUpRows(w.db, fid);
        assert(String(fus[0].actor_role_other) === "field-team", "stored trimmed");
    });
}

// ---------------------------------------------------------------------------
// S8 — atomicity
// ---------------------------------------------------------------------------
async function tS8_atomicity(): Promise<void> {
    await ok("G5H-41: injected failure after FollowUp INSERT rolls back FollowUp + status", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const fid = await insertFindingRaw(w.db, visitId);
        await insertObservationSourceRaw(w.db, visitId, fid);
        let faulted = false;
        const inner = new FaultAdapter(w.db, (sql) => {
            const hit = sql.includes("UPDATE finding") && sql.includes("status_changed_at");
            if (hit) faulted = true;
            return hit;
        });
        const svcFault = new FindingTransitionService(inner);
        await rejectsAny(() => transition(svcFault, fid, "IN_TREATMENT", ev()));
        assert(faulted, "fault injection must trigger on the guarded status update");
        assert((await findingStatusOf(w.db, fid)) === "OPEN", "status rolled back");
        assert((await count(w.db, "SELECT count(*) AS c FROM follow_up")) === 0, "FollowUp rolled back");
    });

    await ok("G5H-42: status-update zero-row failure rolls back the FollowUp", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const fid = await insertFindingRaw(w.db, visitId);
        await insertObservationSourceRaw(w.db, visitId, fid);
        const inner = new FakeChangesAdapter(
            w.db,
            (sql) => sql.includes("UPDATE finding") && sql.includes("status_changed_at"),
        );
        const svcFake = new FindingTransitionService(inner);
        await rejectsCode(APP_ERR.STATE_CONFLICT, () => transition(svcFake, fid, "IN_TREATMENT", ev()));
        assert((await findingStatusOf(w.db, fid)) === "OPEN", "status unchanged");
        assert((await count(w.db, "SELECT count(*) AS c FROM follow_up")) === 0, "FollowUp rolled back");
    });

    await ok("G5H-43: no tested failed path leaves an audit row without its status transition", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const fid = await insertFindingRaw(w.db, visitId);
        await insertObservationSourceRaw(w.db, visitId, fid);
        // several failing shapes in the same world
        await rejectsAny(() => transition(w.svc, fid, "VOIDED", ev()));
        await rejectsAny(() => transition(w.svc, fid, "IN_TREATMENT", ev({ note: "  " })));
        await rejectsAny(() => transition(w.svc, fid, "RESOLVED", ev({ eventDatetime: "bad" })));
        const faulted = new FindingTransitionService(
            new FaultAdapter(w.db, (sql) => sql.includes("UPDATE finding") && sql.includes("status_changed_at")),
        );
        await rejectsAny(() => transition(faulted, fid, "IN_TREATMENT", ev()));
        // invariant: no follow_up row exists for a transition that did not commit
        assert((await count(w.db, "SELECT count(*) AS c FROM follow_up")) === 0, "no orphan audit rows");
        assert((await findingStatusOf(w.db, fid)) === "OPEN", "no status change survived a failure");
    });
}

// ---------------------------------------------------------------------------
// S9 — Class-A retry with durable event identity
// ---------------------------------------------------------------------------
async function tS9_retry(): Promise<void> {
    await ok("G5H-44: exact retry => applied:false", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const fid = await insertFindingRaw(w.db, visitId);
        await insertObservationSourceRaw(w.db, visitId, fid);
        const first = await transition(w.svc, fid, "IN_TREATMENT", ev());
        assert(first.applied === true, "first call applies");
        const retry = await transition(w.svc, fid, "IN_TREATMENT", ev());
        assert(retry.applied === false, "identical retry converges without a write");
        assert(retry.findingId === fid && retry.status === "IN_TREATMENT", "durable result");
        assert(retry.statusChangedAt === T_EVENT, "statusChangedAt == event_datetime");
    });

    await ok("G5H-45: exact retry leaves exactly one FollowUp", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const fid = await insertFindingRaw(w.db, visitId);
        await insertObservationSourceRaw(w.db, visitId, fid);
        await transition(w.svc, fid, "IN_TREATMENT", ev());
        await transition(w.svc, fid, "IN_TREATMENT", ev());
        await transition(w.svc, fid, "IN_TREATMENT", ev());
        assert((await followUpRows(w.db, fid)).length === 1, "no duplicate FollowUp on identical retries");
    });

    await ok("G5H-46: same target but different eventDatetime => conflict", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const fid = await insertFindingRaw(w.db, visitId);
        await insertObservationSourceRaw(w.db, visitId, fid);
        await transition(w.svc, fid, "IN_TREATMENT", ev());
        await rejectsCode(APP_ERR.STATE_CONFLICT, () =>
            transition(w.svc, fid, "IN_TREATMENT", ev({ eventDatetime: T_EVENT2 })),
        );
        assert((await followUpRows(w.db, fid)).length === 1, "no second FollowUp on a conflicting retry");
    });

    await ok("G5H-47: same target but different note => conflict", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const fid = await insertFindingRaw(w.db, visitId);
        await insertObservationSourceRaw(w.db, visitId, fid);
        await transition(w.svc, fid, "IN_TREATMENT", ev());
        await rejectsCode(APP_ERR.STATE_CONFLICT, () =>
            transition(w.svc, fid, "IN_TREATMENT", ev({ note: "different note" })),
        );
        assert((await followUpRows(w.db, fid)).length === 1, "no second FollowUp");
    });

    await ok("G5H-48: same target but different actor identity => conflict", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const fid = await insertFindingRaw(w.db, visitId);
        await insertObservationSourceRaw(w.db, visitId, fid);
        await transition(w.svc, fid, "IN_TREATMENT", ev());
        await rejectsCode(APP_ERR.STATE_CONFLICT, () =>
            transition(w.svc, fid, "IN_TREATMENT", ev({ actorName: "someone-else" })),
        );
        await rejectsCode(APP_ERR.STATE_CONFLICT, () =>
            transition(w.svc, fid, "IN_TREATMENT", ev({ actorRole: "INSPECTOR", actorName: "director-a" })),
        );
        assert((await followUpRows(w.db, fid)).length === 1, "no second FollowUp");
    });

    await ok("G5H-49: same target but different contextVisitId => conflict", async () => {
        const w = await freshWorld();
        const origin = await standardCreate(w);
        const context = await createVisitFor(w, w.institutionId);
        const fid = await insertFindingRaw(w.db, origin);
        await insertObservationSourceRaw(w.db, origin, fid);
        await transition(w.svc, fid, "IN_TREATMENT", ev(), context);
        // identical except the context visit is missing this time
        await rejectsCode(APP_ERR.STATE_CONFLICT, () => transition(w.svc, fid, "IN_TREATMENT", ev(), null));
        assert((await followUpRows(w.db, fid)).length === 1, "no second FollowUp");
    });

    await ok("G5H-50: status_changed_at mismatch defeats convergence", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const fid = await insertFindingRaw(w.db, visitId);
        await insertObservationSourceRaw(w.db, visitId, fid);
        await transition(w.svc, fid, "IN_TREATMENT", ev());
        // fixture corruption: audit clock moved while the FollowUp stays intact
        await w.db.run("UPDATE finding SET status_changed_at = ? WHERE finding_id = ?", [T_EVENT2, fid]);
        await rejectsCode(APP_ERR.STATE_CONFLICT, () => transition(w.svc, fid, "IN_TREATMENT", ev()));
        assert((await followUpRows(w.db, fid)).length === 1, "no second FollowUp");
    });

    await ok("G5H-51: duplicate matching FollowUp corruption defeats convergence", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const fid = await insertFindingRaw(w.db, visitId);
        await insertObservationSourceRaw(w.db, visitId, fid);
        await transition(w.svc, fid, "IN_TREATMENT", ev());
        // fixture corruption: an exact duplicate audit row appears
        const dup = await w.db.run(
            `INSERT INTO follow_up(finding_id, corrective_action_id, visit_id, status_target, status_after,
                                   event_datetime, actor_role, actor_role_other, actor_name, note, recorded_by)
             VALUES (?, NULL, NULL, 'FINDING', 'IN_TREATMENT', ?, 'DIRECTOR', NULL, 'director-a', 'treatment started', 'follow-up-clerk')`,
            [fid, T_EVENT],
        );
        assert(dup.changes === 1, "duplicate fixture row inserted");
        await rejectsCode(APP_ERR.STATE_CONFLICT, () => transition(w.svc, fid, "IN_TREATMENT", ev()));
        assert((await followUpRows(w.db, fid)).length === 2, "duplicate integrity conflict, never a third row");
    });

    await ok("G5H-52: stale retry to IN_TREATMENT after the Finding later RESOLVED => conflict", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const fid = await insertFindingRaw(w.db, visitId);
        await insertObservationSourceRaw(w.db, visitId, fid);
        await transition(w.svc, fid, "IN_TREATMENT", ev());
        await transition(w.svc, fid, "RESOLVED", ev({ eventDatetime: T_EVENT2 }));
        await rejectsCode(APP_ERR.STATE_CONFLICT, () => transition(w.svc, fid, "IN_TREATMENT", ev()));
        assert((await findingStatusOf(w.db, fid)) === "RESOLVED", "never moves backwards");
        assert((await followUpRows(w.db, fid)).length === 2, "exactly the two committed events");
    });

    await ok("G5H-53: zero-row guarded-write convergence creates no duplicate FollowUp", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const fid = await insertFindingRaw(w.db, visitId);
        await insertObservationSourceRaw(w.db, visitId, fid);
        await transition(w.svc, fid, "IN_TREATMENT", ev());

        // race simulation: the retry's in-transaction read observes a STALE
        // OPEN status (as if a writer had just committed), while the durable
        // row is already IN_TREATMENT with the exact requested event — the
        // guarded UPDATE then zero-rows, rolls the tentative FollowUp back,
        // and convergence must recognize the identical durable event
        const stale = new FabricateReadOnceAdapter(
            w.db,
            (sql) => sql.includes("FROM finding WHERE finding_id"),
            (rows) => rows.map((r) => ({ ...r, status: "OPEN" })),
        );
        const svcStale = new FindingTransitionService(stale);
        const res = await transition(svcStale, fid, "IN_TREATMENT", ev());
        assert(res.applied === false, "converged on the identical durable event");
        assert(res.status === "IN_TREATMENT" && res.statusChangedAt === T_EVENT, "durable result");
        assert((await followUpRows(w.db, fid)).length === 1, "the rolled-back tentative FollowUp left no duplicate");
    });
}

// ---------------------------------------------------------------------------
// S10 — cross-cutting
// ---------------------------------------------------------------------------
async function tS10_crosscutting(): Promise<void> {
    await ok("G5H-54: T8 never produces VOIDED", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const fid = await insertFindingRaw(w.db, visitId);
        await insertObservationSourceRaw(w.db, visitId, fid);
        await transition(w.svc, fid, "IN_TREATMENT", ev());
        await transition(w.svc, fid, "RESOLVED", ev({ eventDatetime: T_EVENT2 }));
        assert((await findingStatusOf(w.db, fid)) === "RESOLVED", "T8 terminal state");
        assert(
            (await count(w.db, "SELECT count(*) AS c FROM follow_up WHERE status_after = 'VOIDED'")) === 0,
            "no VOIDED FollowUp was ever written by T8",
        );
    });

    await ok("G5H-55: T8 never creates CorrectiveAction", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const fid = await insertFindingRaw(w.db, visitId);
        await insertObservationSourceRaw(w.db, visitId, fid);
        await insertCaRaw(w.db, fid, "RESOLVED");
        const before = await count(w.db, "SELECT count(*) AS c FROM corrective_action");
        await transition(w.svc, fid, "RESOLVED", ev());
        const after = await count(w.db, "SELECT count(*) AS c FROM corrective_action");
        assert(before === after && after === 1, "T8 neither creates nor modifies actions");
        const ca = await w.db.query("SELECT status, closed_at, verified_by FROM corrective_action WHERE finding_id = ?", [fid]);
        assert(String(ca[0].status) === "RESOLVED" && String(ca[0].verified_by) === "director-a", "action untouched");
    });

    await ok("G5H-56: T8 never modifies source links", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const fid = await responseSourceFinding(w, visitId);
        const obsId = await insertObservationSourceRaw(w.db, visitId, fid);
        const responseBefore = await w.db.query("SELECT note, finding_id FROM checklist_response WHERE finding_id = ?", [fid]);
        await transition(w.svc, fid, "IN_TREATMENT", ev());
        await transition(w.svc, fid, "RESOLVED", ev({ eventDatetime: T_EVENT2 }));
        const responseAfter = await w.db.query("SELECT note, finding_id FROM checklist_response WHERE finding_id = ?", [fid]);
        assert(responseAfter.length === responseBefore.length, "no source rows added/removed");
        assert(String(responseAfter[0].note) === String(responseBefore[0].note), "response note untouched");
        const obs = await w.db.query("SELECT finding_id FROM adhoc_observation WHERE observation_id = ?", [obsId]);
        assert(Number(obs[0].finding_id) === fid, "observation link untouched");
        assert((await findingSources(w.db, fid)) === 2, "both sources still durable");
    });

    await ok("G5H-57: production application core imports no node:* module", async () => {
        const files = [
            "applicability.ts",
            "corrections.ts",
            "errors.ts",
            "finding-status.ts",
            "initial-disposition.ts",
            "observation-create.ts",
            "observation-finding.ts",
            "visit-scope.ts",
        ].map((f) => join(ROOT, "src", "application", f));
        for (const file of files) {
            const text = readFileSync(file, "utf8");
            const m = /(?:from\s+|require\()\s*["']node:/.exec(text);
            assert(m === null, `${file} imports a node:* module: ${m ? m[0] : ""}`);
            assert(!/node:sqlite/.test(text), `${file} must not reference node:sqlite`);
            assert(!/node-sqlite-adapter/.test(text), `${file} must not import the dev/test adapter`);
        }
    });

    await ok("G5H-64: event validation happens before any Finding read (pure shape first)", async () => {
        const w = await freshWorld();
        // no visit / no finding at all: the malformed event must fail with
        // E_CONFIG, not with a lookup error
        await rejectsCode(APP_ERR.CONFIG, () => transition(w.svc, 999, "IN_TREATMENT", ev({ actorRole: "OTHER" })));
    });

    await ok("G5H-65: T8 leaves no duplicate FollowUp after a conflicting already-at-target request", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const fid = await insertFindingRaw(w.db, visitId);
        await insertObservationSourceRaw(w.db, visitId, fid);
        await transition(w.svc, fid, "RESOLVED", ev());
        // conflicting RESOLVED retry (different recordedBy)
        await rejectsCode(APP_ERR.STATE_CONFLICT, () =>
            transition(w.svc, fid, "RESOLVED", ev({ recordedBy: "someone-else" })),
        );
        assert((await followUpRows(w.db, fid)).length === 1, "still exactly one FollowUp");
    });

    await ok("G5H-66: IN_TREATMENT -> IN_TREATMENT with a different event => conflict (never silent success)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const fid = await insertFindingRaw(w.db, visitId);
        await insertObservationSourceRaw(w.db, visitId, fid);
        await transition(w.svc, fid, "IN_TREATMENT", ev());
        await rejectsCode(APP_ERR.STATE_CONFLICT, () =>
            transition(w.svc, fid, "IN_TREATMENT", ev({ eventDatetime: T_EVENT2, note: "second treatment note" })),
        );
        assert((await followUpRows(w.db, fid)).length === 1, "no second FollowUp");
    });
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------
const SUITES: ReadonlyArray<[string, () => Promise<void>]> = [
    ["S1 basic legal transitions", tS1_basic],
    ["S2 source-count integrity", tS2_sourceIntegrity],
    ["S3 CorrectiveAction preconditions", tS3_correctiveActions],
    ["S4 forbidden transitions", tS4_forbidden],
    ["S5 post-finalization lifecycle", tS5_visitLifecycle],
    ["S6 context Visit", tS6_contextVisit],
    ["S7 event validation", tS7_eventValidation],
    ["S8 atomicity", tS8_atomicity],
    ["S9 retry / event identity", tS9_retry],
    ["S10 cross-cutting", tS10_crosscutting],
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
