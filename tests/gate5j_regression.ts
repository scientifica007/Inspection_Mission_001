// Gate 5J — automated regression for T10 `transitionCorrectiveActionStatus`
// (TRANSACTION-CONTRACTS-v1.md §10 / APPLICATION-CORE-v1.md §4.8):
//   one atomic CorrectiveAction status transition: append-only FollowUp event
//   (status_target='CORRECTIVE_ACTION', corrective_action_id mandatory) +
//   guarded status update (changes == 1 B5) in one BEGIN IMMEDIATE unit;
//   RESOLVED additionally writes closed_at/verified_by/verification_note in
//   the SAME guarded statement (closed_at == the transition FollowUp's
//   normalized event_datetime — the settled Gate-5J closed_at rule: no
//   separate user-supplied closure time exists in any authority).
//   Graph: OPEN -> IN_TREATMENT | OPEN -> RESOLVED (legal directly) |
//   IN_TREATMENT -> RESOLVED. No VOIDED action status exists in v1; generic
//   target OPEN and backwards/terminal moves are refused.
//   No Visit PREPARATION gate: transitions remain legal after origin-Visit
//   finalization; contextVisitId is optional FollowUp context (must exist and
//   stay in the parent Finding's institution; E_VISIT_NOT_FOUND /
//   E_CONTEXT otherwise).
//   Event: strict ISO-8601 UTC eventDatetime, closed actorRole set,
//   OTHER => meaningful actorRoleOther, meaningful normalized note /
//   recordedBy, optional normalized actorName.
//   Class A with REQUIRED durable event + closure identity: an
//   already-at-target request converges (applied:false, no duplicate
//   FollowUp) ONLY on the exact canonical FollowUp row plus the target
//   closure identity (IN_TREATMENT: closure fields NULL; RESOLVED:
//   closed_at == event_datetime, verified_by == requested, verification_note
//   null-safe == requested); anything else => E_STATE_CONFLICT.
//   Parent Finding is never modified (status / status_changed_at / source
//   links) and the Finding is never auto-resolved.
//
// Run (repository root; Node.js >= 22 is the adopted development/test host,
// Gate-5A D1 — node:sqlite + native TypeScript type stripping):
//   Node 22.x:   node --experimental-strip-types tests/gate5j_regression.ts
//   Node 24.x:   node tests/gate5j_regression.ts
// Exit: 0 on success, 1 when any assertion fails.
//
// Coverage map (GATE 5J §P TESTS, items 1..65) is reproduced in the ok()
// labels G5J-01..G5J-65, plus contract-mandated extras (G5J-66+).

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { SqlAdapter, SqlRow, SqlValue } from "../src/bootstrap/adapter.ts";
import { openFreshDb } from "../dev/node-sqlite-adapter.ts";
import { APP_ERR } from "../src/application/errors.ts";
import {
    CorrectiveActionStatusService,
    CORRECTIVE_ACTION_STATUSES,
    type CorrectiveActionResolutionInput,
    type CorrectiveActionTransitionEventInput,
    type TransitionCorrectiveActionStatusInput,
} from "../src/application/corrective-action-status.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_SQL = readFileSync(join(ROOT, "docs", "schema", "schema.sql"), "utf8");

const NOW = "2026-09-01T08:00:00.000Z";
const T_EVENT = "2026-09-02T10:15:30.000Z";
const T_EVENT2 = "2026-09-03T12:45:00.000Z";

// ---------------------------------------------------------------------------
// tiny assertion harness (same conventions as tests/gate5h_regression.ts)
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
// fault-injecting adapters (same shape as tests/gate5h_regression.ts)
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

/** commits fail mid-unit (before the durable COMMIT statement runs). */
class CommitFaultAdapter implements SqlAdapter {
    private readonly inner: SqlAdapter;

    constructor(inner: SqlAdapter) {
        this.inner = inner;
    }
    async beginImmediate(): Promise<void> {
        return this.inner.beginImmediate();
    }
    async commit(): Promise<void> {
        throw new Error("injected commit fault");
    }
    async rollback(): Promise<void> {
        return this.inner.rollback();
    }
    async run(sql: string, params: readonly SqlValue[] = []): Promise<Awaited<ReturnType<SqlAdapter["run"]>>> {
        return this.inner.run(sql, params);
    }
    async query(sql: string, params: readonly SqlValue[] = []): Promise<SqlRow[]> {
        return this.inner.query(sql, params);
    }
}

/**
 * One-shot read fabrication: the first matching query returns the fabricated
 * rows instead of the durable ones (deterministic TOCTOU/race simulation —
 * the in-transaction action read observes a stale OPEN status while the
 * durable row has already advanced, exactly the window the zero-row guarded
 * UPDATE defends).
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
// fixtures (raw worlds — T10 touches corrective_action / follow_up only)
// ---------------------------------------------------------------------------
interface World {
    db: SqlAdapter;
    svc: CorrectiveActionStatusService;
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
    return { db, svc: new CorrectiveActionStatusService(db), missionId, institutionId, visitId };
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

/** fixture Finding status move (source present => trigger-safe). */
async function setFindingStatusRaw(db: SqlAdapter, findingId: number, status: string, at = NOW): Promise<void> {
    const res = await db.run(
        "UPDATE finding SET status = ?, status_changed_at = ? WHERE finding_id = ? AND status = 'OPEN'",
        [status, at, findingId] as readonly SqlValue[],
    );
    assert(res.changes === 1, `fixture finding ${findingId} -> ${status} update failed`);
}

/** raw OPEN CorrectiveAction insert (fixture; closure fields NULL). */
async function insertActionRaw(
    db: SqlAdapter,
    findingId: number,
    description = "repair the corridor ceiling leak",
): Promise<number> {
    const res = await db.run(
        `INSERT INTO corrective_action(finding_id, action_type, description, responsible_role,
                                       status, closed_at, verified_by, verification_note, created_at, created_by)
         VALUES (?, 'MAINTENANCE_WORK', ?, 'CONCERNED_SERVICE', 'OPEN', NULL, NULL, NULL, ?, 'inspector-a')`,
        [findingId, description, NOW] as readonly SqlValue[],
    );
    assert(res.changes === 1 && res.lastInsertRowid !== null, "action fixture insert failed");
    return Number(res.lastInsertRowid);
}

/** fixture action status move OPEN -> IN_TREATMENT (raw). */
async function setActionStatusRaw(db: SqlAdapter, actionId: number, status: string): Promise<void> {
    const res = await db.run(
        "UPDATE corrective_action SET status = ? WHERE action_id = ? AND status = 'OPEN'",
        [status, actionId] as readonly SqlValue[],
    );
    assert(res.changes === 1, `fixture action ${actionId} -> ${status} update failed`);
}

/** finalize the visit fixture-style (raw; no pending-cell preflight needed here). */
async function finalizeVisitRaw(db: SqlAdapter, visitId: number, at = NOW): Promise<void> {
    const res = await db.run(
        "UPDATE visit SET status = 'COMPLETED', finalized_at = ? WHERE visit_id = ? AND status = 'PREPARATION' AND finalized_at IS NULL",
        [at, visitId] as readonly SqlValue[],
    );
    assert(res.changes === 1, "visit must finalize");
}

/** a second same-institution Visit (FollowUp context candidate). */
async function insertContextVisitRaw(db: SqlAdapter, missionId: number, institutionId: number): Promise<number> {
    return insertVisitRaw(db, missionId, institutionId);
}

/** a second institution + its Visit (cross-institution context candidate). */
async function insertSecondInstitution(db: SqlAdapter, missionId: number): Promise<number> {
    const instId = Number(
        (await db.run("INSERT INTO institution(name, created_at, created_by) VALUES ('Inst2', ?, 'owner')", [NOW]))
            .lastInsertRowid,
    );
    await insertVisitRaw(db, missionId, instId);
    return instId;
}

// ---------------------------------------------------------------------------
// request builders
// ---------------------------------------------------------------------------
function ev(extra: Partial<CorrectiveActionTransitionEventInput> = {}): CorrectiveActionTransitionEventInput {
    return {
        eventDatetime: T_EVENT,
        actorRole: "DIRECTOR",
        actorName: "director-a",
        note: "treatment started",
        recordedBy: "follow-up-clerk",
        ...extra,
    };
}

function rv(extra: Partial<CorrectiveActionResolutionInput> = {}): CorrectiveActionResolutionInput {
    return { verifiedBy: "director-a", ...extra };
}

async function transition(
    svc: CorrectiveActionStatusService,
    actionId: number,
    to: TransitionCorrectiveActionStatusInput["to"],
    event: CorrectiveActionTransitionEventInput,
    contextVisitId: number | null = null,
    resolution?: CorrectiveActionResolutionInput | null,
) {
    const input: TransitionCorrectiveActionStatusInput = { actionId, to, event };
    if (contextVisitId !== null && contextVisitId !== undefined) input.contextVisitId = contextVisitId;
    if (resolution !== undefined) input.resolution = resolution;
    return svc.transitionCorrectiveActionStatus(input);
}

async function actionRow(db: SqlAdapter, actionId: number): Promise<SqlRow> {
    const rows = await db.query("SELECT * FROM corrective_action WHERE action_id = ?", [actionId]);
    assert(rows.length === 1, `action ${actionId} missing`);
    return rows[0];
}

async function actionStatusOf(db: SqlAdapter, actionId: number): Promise<string> {
    return String((await actionRow(db, actionId)).status);
}

async function followUpRows(db: SqlAdapter, actionId: number): Promise<SqlRow[]> {
    return db.query("SELECT * FROM follow_up WHERE corrective_action_id = ? ORDER BY followup_id", [actionId]);
}

async function findingRow(db: SqlAdapter, findingId: number): Promise<SqlRow> {
    const rows = await db.query("SELECT * FROM finding WHERE finding_id = ?", [findingId]);
    assert(rows.length === 1, `finding ${findingId} missing`);
    return rows[0];
}

async function visitRow(db: SqlAdapter, visitId: number): Promise<SqlRow> {
    const rows = await db.query("SELECT * FROM visit WHERE visit_id = ?", [visitId]);
    assert(rows.length === 1, `visit ${visitId} missing`);
    return rows[0];
}

// ---------------------------------------------------------------------------
// S1 — basic transition
// ---------------------------------------------------------------------------
async function tS1_basic(): Promise<void> {
    await ok("G5J-01: missing Action => E_ACTION_NOT_FOUND (never E_FINDING_NOT_FOUND)", async () => {
        const w = await freshWorld();
        const err = await rejectsCode(APP_ERR.ACTION_NOT_FOUND, () =>
            transition(w.svc, 999, "IN_TREATMENT", ev()),
        );
        assert(!err.message.includes("finding"), "the not-found message must not masquerade as a finding error");
        assert((await count(w.db, "SELECT count(*) AS c FROM follow_up")) === 0, "no FollowUp written");
    });

    await ok("G5J-02: OPEN -> IN_TREATMENT succeeds", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const aid = await insertActionRaw(w.db, fid);
        const res = await transition(w.svc, aid, "IN_TREATMENT", ev());
        assert(res.applied === true, "applied");
        assert(res.actionId === aid && res.findingId === fid, "identity in result");
        assert(res.status === "IN_TREATMENT", "result status");
        assert(res.closedAt === null && res.verifiedBy === null && res.verificationNote === null, "result closure NULLs");
        const row = await actionRow(w.db, aid);
        assert(String(row.status) === "IN_TREATMENT", "durable status IN_TREATMENT");
        assert(row.closed_at === null && row.verified_by === null && row.verification_note === null, "durable closure NULLs");
    });

    await ok("G5J-03: OPEN -> RESOLVED succeeds directly", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const aid = await insertActionRaw(w.db, fid);
        const res = await transition(w.svc, aid, "RESOLVED", ev(), null, rv());
        assert(res.applied === true && res.status === "RESOLVED", "applied RESOLVED");
        assert(res.closedAt === T_EVENT, "result closedAt == event_datetime");
        assert(res.verifiedBy === "director-a", "result verifiedBy");
        assert(res.verificationNote === null, "result verificationNote NULL");
        const row = await actionRow(w.db, aid);
        assert(String(row.status) === "RESOLVED", "durable RESOLVED");
        assert(String(row.closed_at) === T_EVENT, "durable closed_at == event_datetime");
        assert(String(row.verified_by) === "director-a", "durable verified_by");
        assert(row.verification_note === null, "durable verification_note NULL");
    });

    await ok("G5J-04: IN_TREATMENT -> RESOLVED succeeds", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const aid = await insertActionRaw(w.db, fid);
        await setActionStatusRaw(w.db, aid, "IN_TREATMENT");
        const res = await transition(w.svc, aid, "RESOLVED", ev(), null, rv({ verificationNote: "checked on site" }));
        assert(res.applied === true && res.status === "RESOLVED", "applied");
        assert(String((await actionRow(w.db, aid)).status) === "RESOLVED", "durable RESOLVED");
    });

    await ok("G5J-05: exactly one FollowUp written per transition", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const aid = await insertActionRaw(w.db, fid);
        await transition(w.svc, aid, "IN_TREATMENT", ev());
        assert((await count(w.db, "SELECT count(*) AS c FROM follow_up")) === 1, "exactly one FollowUp row");
        await transition(w.svc, aid, "RESOLVED", ev({ eventDatetime: T_EVENT2 }), null, rv());
        assert((await count(w.db, "SELECT count(*) AS c FROM follow_up")) === 2, "one more for the second transition");
    });

    await ok("G5J-06: status_target = CORRECTIVE_ACTION", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const aid = await insertActionRaw(w.db, fid);
        await transition(w.svc, aid, "IN_TREATMENT", ev());
        const fu = (await followUpRows(w.db, aid))[0];
        assert(String(fu.status_target) === "CORRECTIVE_ACTION", "status_target CORRECTIVE_ACTION");
        assert(String(fu.status_after) === "IN_TREATMENT", "status_after = requested target");
    });

    await ok("G5J-07: corrective_action_id correct", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const other = await insertActionRaw(w.db, fid, "another action");
        const aid = await insertActionRaw(w.db, fid);
        await transition(w.svc, aid, "IN_TREATMENT", ev());
        const fu = (await followUpRows(w.db, aid))[0];
        assert(Number(fu.corrective_action_id) === aid && Number(fu.corrective_action_id) !== other, "correct action referenced");
    });

    await ok("G5J-08: finding_id == parent Finding", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const otherFid = await insertFindingRaw(w.db, w.visitId, "unrelated finding");
        const aid = await insertActionRaw(w.db, fid);
        await transition(w.svc, aid, "IN_TREATMENT", ev());
        const fu = (await followUpRows(w.db, aid))[0];
        assert(Number(fu.finding_id) === fid && Number(fu.finding_id) !== otherFid, "follow_up.finding_id == parent");
    });
}

// ---------------------------------------------------------------------------
// S2 — transition graph
// ---------------------------------------------------------------------------
async function tS2_graph(): Promise<void> {
    await ok("G5J-09: target OPEN rejected (recognized status, never a generic T10 target)", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const aid = await insertActionRaw(w.db, fid);
        await rejectsCode(APP_ERR.STATE_CONFLICT, () => transition(w.svc, aid, "OPEN", ev()));
        await setActionStatusRaw(w.db, aid, "IN_TREATMENT");
        await rejectsCode(APP_ERR.STATE_CONFLICT, () => transition(w.svc, aid, "OPEN", ev()));
        assert((await count(w.db, "SELECT count(*) AS c FROM follow_up")) === 0, "no FollowUp written");
    });

    await ok("G5J-10: VOIDED target rejected (no VOIDED CorrectiveAction status in v1)", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const aid = await insertActionRaw(w.db, fid);
        await rejectsCode(APP_ERR.CONFIG, () => transition(w.svc, aid, "VOIDED" as never, ev()));
        assert((await count(w.db, "SELECT count(*) AS c FROM follow_up")) === 0, "no FollowUp written");
    });

    await ok("G5J-11: IN_TREATMENT -> OPEN rejected", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const aid = await insertActionRaw(w.db, fid);
        await setActionStatusRaw(w.db, aid, "IN_TREATMENT");
        await rejectsCode(APP_ERR.STATE_CONFLICT, () => transition(w.svc, aid, "OPEN", ev()));
        assert(String((await actionRow(w.db, aid)).status) === "IN_TREATMENT", "status unchanged");
    });

    await ok("G5J-12: RESOLVED -> anything rejected (RESOLVED is terminal)", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const aid = await insertActionRaw(w.db, fid);
        await transition(w.svc, aid, "RESOLVED", ev(), null, rv());
        await rejectsCode(APP_ERR.STATE_CONFLICT, () =>
            transition(w.svc, aid, "IN_TREATMENT", ev({ eventDatetime: T_EVENT2 })),
        );
        await rejectsCode(APP_ERR.STATE_CONFLICT, () => transition(w.svc, aid, "OPEN", ev({ eventDatetime: T_EVENT2 })));
        assert(String((await actionRow(w.db, aid)).status) === "RESOLVED", "status unchanged");
        assert((await followUpRows(w.db, aid)).length === 1, "no extra FollowUp");
    });

    await ok("G5J-13: unknown target => E_CONFIG", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const aid = await insertActionRaw(w.db, fid);
        await rejectsCode(APP_ERR.CONFIG, () => transition(w.svc, aid, "BANANA" as never, ev()));
        assert((await count(w.db, "SELECT count(*) AS c FROM follow_up")) === 0, "no FollowUp written");
    });
}

// ---------------------------------------------------------------------------
// S3 — Visit lifecycle (T10 is NOT Visit-preparation-only)
// ---------------------------------------------------------------------------
async function tS3_visitLifecycle(): Promise<void> {
    await ok("G5J-14: legal transition after origin Visit finalization succeeds", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        await insertObservationSourceRaw(w.db, w.visitId, fid);
        const aid = await insertActionRaw(w.db, fid);
        await finalizeVisitRaw(w.db, w.visitId);
        const res = await transition(w.svc, aid, "IN_TREATMENT", ev());
        assert(res.applied === true, "IN_TREATMENT after finalization");
        await transition(w.svc, aid, "RESOLVED", ev({ eventDatetime: T_EVENT2 }), null, rv());
        assert(String((await actionRow(w.db, aid)).status) === "RESOLVED", "RESOLVED after finalization too");
    });

    await ok("G5J-15: Visit unchanged / never reopened", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        await insertObservationSourceRaw(w.db, w.visitId, fid);
        const aid = await insertActionRaw(w.db, fid);
        await finalizeVisitRaw(w.db, w.visitId);
        const before = await visitRow(w.db, w.visitId);
        await transition(w.svc, aid, "RESOLVED", ev(), null, rv());
        const after = await visitRow(w.db, w.visitId);
        for (const col of ["visit_id", "mission_id", "institution_id", "visit_type", "visit_date", "status", "inspector", "finalized_at"]) {
            assert(after[col] === before[col], `visit column ${col} unchanged`);
        }
        assert(String(after.status) === "COMPLETED" && after.finalized_at !== null, "Visit stays finalized");
    });
}

// ---------------------------------------------------------------------------
// S4 — optional context Visit
// ---------------------------------------------------------------------------
async function tS4_contextVisit(): Promise<void> {
    await ok("G5J-16: NULL context succeeds (follow_up.visit_id NULL)", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const aid = await insertActionRaw(w.db, fid);
        const res = await transition(w.svc, aid, "IN_TREATMENT", ev(), null);
        assert(res.applied === true, "applied");
        const fu = (await followUpRows(w.db, aid))[0];
        assert(fu.visit_id === null, "visit_id NULL");
    });

    await ok("G5J-17: same-institution context succeeds (visit_id stored)", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const aid = await insertActionRaw(w.db, fid);
        const ctx = await insertContextVisitRaw(w.db, w.missionId, w.institutionId);
        const res = await transition(w.svc, aid, "IN_TREATMENT", ev(), ctx);
        assert(res.applied === true, "applied");
        const fu = (await followUpRows(w.db, aid))[0];
        assert(Number(fu.visit_id) === ctx, "visit_id stored");
    });

    await ok("G5J-18: missing context => E_VISIT_NOT_FOUND", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const aid = await insertActionRaw(w.db, fid);
        await rejectsCode(APP_ERR.VISIT_NOT_FOUND, () => transition(w.svc, aid, "IN_TREATMENT", ev(), 999));
        assert(String((await actionRow(w.db, aid)).status) === "OPEN", "no transition happened");
        assert((await count(w.db, "SELECT count(*) AS c FROM follow_up")) === 0, "no FollowUp written");
    });

    await ok("G5J-19: cross-institution => E_CONTEXT", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const aid = await insertActionRaw(w.db, fid);
        const inst2 = await insertSecondInstitution(w.db, w.missionId);
        const ctx2 = Number(
            (
                await w.db.query(
                    "SELECT visit_id FROM visit WHERE institution_id = ?",
                    [inst2],
                )
            )[0].visit_id,
        );
        await rejectsCode(APP_ERR.CONTEXT, () => transition(w.svc, aid, "IN_TREATMENT", ev(), ctx2));
        assert(String((await actionRow(w.db, aid)).status) === "OPEN", "no transition happened");
        assert((await count(w.db, "SELECT count(*) AS c FROM follow_up")) === 0, "no FollowUp written");
    });

    await ok("G5J-20: finalized same-institution context accepted", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const aid = await insertActionRaw(w.db, fid);
        const ctx = await insertContextVisitRaw(w.db, w.missionId, w.institutionId);
        await finalizeVisitRaw(w.db, ctx);
        const res = await transition(w.svc, aid, "IN_TREATMENT", ev(), ctx);
        assert(res.applied === true, "finalized context Visit accepted (context, not a gate)");
    });
}

// ---------------------------------------------------------------------------
// S5 — IN_TREATMENT closure-state behavior
// ---------------------------------------------------------------------------
async function tS5_inTreatmentClosure(): Promise<void> {
    await ok("G5J-21: closed_at remains NULL after IN_TREATMENT", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const aid = await insertActionRaw(w.db, fid);
        await transition(w.svc, aid, "IN_TREATMENT", ev());
        const row = await actionRow(w.db, aid);
        assert(row.closed_at === null, "closed_at NULL");
    });

    await ok("G5J-22: verified_by remains NULL after IN_TREATMENT", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const aid = await insertActionRaw(w.db, fid);
        await transition(w.svc, aid, "IN_TREATMENT", ev());
        const row = await actionRow(w.db, aid);
        assert(row.verified_by === null, "verified_by NULL");
    });

    await ok("G5J-23: verification_note remains NULL after IN_TREATMENT", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const aid = await insertActionRaw(w.db, fid);
        await transition(w.svc, aid, "IN_TREATMENT", ev());
        const row = await actionRow(w.db, aid);
        assert(row.verification_note === null, "verification_note NULL");
    });

    await ok("G5J-24: resolution payload supplied for IN_TREATMENT rejected (E_CONFIG, never stored/ignored)", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const aid = await insertActionRaw(w.db, fid);
        await rejectsCode(APP_ERR.CONFIG, () => transition(w.svc, aid, "IN_TREATMENT", ev(), null, rv()));
        await rejectsCode(APP_ERR.CONFIG, () => transition(w.svc, aid, "IN_TREATMENT", ev(), null, {} as never));
        await rejectsCode(APP_ERR.CONFIG, () =>
            transition(w.svc, aid, "IN_TREATMENT", ev(), null, { verifiedBy: "", verificationNote: "x" }),
        );
        const row = await actionRow(w.db, aid);
        assert(String(row.status) === "OPEN", "no transition happened");
        assert(row.closed_at === null && row.verified_by === null && row.verification_note === null, "closure untouched");
        assert((await count(w.db, "SELECT count(*) AS c FROM follow_up")) === 0, "no FollowUp written");
    });
}

// ---------------------------------------------------------------------------
// S6 — RESOLVED closure contract
// ---------------------------------------------------------------------------
async function tS6_resolvedClosure(): Promise<void> {
    await ok("G5J-25: verifiedBy required meaningful (missing payload / missing field => E_CONFIG)", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const aid = await insertActionRaw(w.db, fid);
        await rejectsCode(APP_ERR.CONFIG, () => transition(w.svc, aid, "RESOLVED", ev(), null));
        await rejectsCode(APP_ERR.CONFIG, () => transition(w.svc, aid, "RESOLVED", ev(), null, {} as never));
        await rejectsCode(APP_ERR.CONFIG, () =>
            transition(w.svc, aid, "RESOLVED", ev(), null, { verifiedBy: undefined as never }),
        );
        const row = await actionRow(w.db, aid);
        assert(String(row.status) === "OPEN", "no transition happened");
        assert(row.closed_at === null && row.verified_by === null && row.verification_note === null, "closure untouched");
        assert((await count(w.db, "SELECT count(*) AS c FROM follow_up")) === 0, "no FollowUp written");
    });

    await ok("G5J-26: blank verifiedBy rejected", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const aid = await insertActionRaw(w.db, fid);
        await rejectsCode(APP_ERR.CONFIG, () => transition(w.svc, aid, "RESOLVED", ev(), null, rv({ verifiedBy: "" })));
        await rejectsCode(APP_ERR.CONFIG, () => transition(w.svc, aid, "RESOLVED", ev(), null, rv({ verifiedBy: "   " })));
        assert(String((await actionRow(w.db, aid)).status) === "OPEN", "no transition happened");
    });

    await ok("G5J-27: optional verificationNote NULL accepted", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const aid = await insertActionRaw(w.db, fid);
        const res = await transition(w.svc, aid, "RESOLVED", ev(), null, rv());
        assert(res.applied === true, "applied");
        assert(res.verificationNote === null, "result note NULL");
        assert((await actionRow(w.db, aid)).verification_note === null, "durable note NULL");
    });

    await ok("G5J-28: blank verificationNote normalizes to NULL", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const aid = await insertActionRaw(w.db, fid);
        const res = await transition(w.svc, aid, "RESOLVED", ev(), null, rv({ verificationNote: "   " }));
        assert(res.applied === true && res.verificationNote === null, "blank note normalized to NULL");
        assert((await actionRow(w.db, aid)).verification_note === null, "durable note NULL");
    });

    await ok("G5J-29: meaningful verificationNote stored (normalized)", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const aid = await insertActionRaw(w.db, fid);
        const res = await transition(w.svc, aid, "RESOLVED", ev(), null, rv({ verificationNote: "  checked on site  " }));
        assert(res.applied === true && res.verificationNote === "checked on site", "result note trimmed");
        assert(String((await actionRow(w.db, aid)).verification_note) === "checked on site", "durable note trimmed");
    });

    await ok("G5J-30: closed_at set according to the adopted T10 rule (== normalized transition eventDatetime)", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const aid = await insertActionRaw(w.db, fid);
        // a trimmed-but-valid request timestamp: closed_at stores the
        // NORMALIZED eventDatetime — no separate closure time is invented
        const res = await transition(
            w.svc,
            aid,
            "RESOLVED",
            ev({ eventDatetime: "  2026-09-02T10:15:30.000Z  " }),
            null,
            rv(),
        );
        assert(res.applied === true, "applied");
        assert(res.closedAt === "2026-09-02T10:15:30.000Z", "result closedAt == normalized eventDatetime");
        const row = await actionRow(w.db, aid);
        assert(String(row.closed_at) === "2026-09-02T10:15:30.000Z", "durable closed_at == normalized eventDatetime");
        const fu = (await followUpRows(w.db, aid))[0];
        assert(String(fu.event_datetime) === "2026-09-02T10:15:30.000Z", "FollowUp event_datetime matches closed_at");
    });

    await ok("G5J-31: closure fields written in the same transition statement/transaction", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const aid = await insertActionRaw(w.db, fid);
        const res = await transition(w.svc, aid, "RESOLVED", ev(), null, rv({ verificationNote: "ok" }));
        assert(res.applied === true, "one call, one commit");
        const row = await actionRow(w.db, aid);
        assert(
            String(row.status) === "RESOLVED" &&
                String(row.closed_at) === T_EVENT &&
                String(row.verified_by) === "director-a" &&
                String(row.verification_note) === "ok",
            "status + closed_at + verified_by + verification_note all durable together",
        );
        assert((await followUpRows(w.db, aid)).length === 1, "the one FollowUp of the same transaction");
    });
}

// ---------------------------------------------------------------------------
// S7 — FollowUp event validation
// ---------------------------------------------------------------------------
async function tS7_event(): Promise<void> {
    await ok("G5J-32: meaningful note required", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const aid = await insertActionRaw(w.db, fid);
        await rejectsCode(APP_ERR.CONFIG, () => transition(w.svc, aid, "IN_TREATMENT", ev({ note: undefined as never })));
        await rejectsCode(APP_ERR.CONFIG, () => transition(w.svc, aid, "IN_TREATMENT", ev({ note: "" })));
        await rejectsCode(APP_ERR.CONFIG, () => transition(w.svc, aid, "IN_TREATMENT", ev({ note: "   " })));
        assert((await count(w.db, "SELECT count(*) AS c FROM follow_up")) === 0, "no FollowUp written");
    });

    await ok("G5J-33: meaningful recordedBy required", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const aid = await insertActionRaw(w.db, fid);
        await rejectsCode(APP_ERR.CONFIG, () => transition(w.svc, aid, "IN_TREATMENT", ev({ recordedBy: "" })));
        await rejectsCode(APP_ERR.CONFIG, () => transition(w.svc, aid, "IN_TREATMENT", ev({ recordedBy: "   " })));
        assert((await count(w.db, "SELECT count(*) AS c FROM follow_up")) === 0, "no FollowUp written");
    });

    await ok("G5J-34: OTHER requires actorRoleOther", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const aid = await insertActionRaw(w.db, fid);
        await rejectsCode(APP_ERR.CONFIG, () => transition(w.svc, aid, "IN_TREATMENT", ev({ actorRole: "OTHER" })));
        await rejectsCode(APP_ERR.CONFIG, () =>
            transition(w.svc, aid, "IN_TREATMENT", ev({ actorRole: "OTHER", actorRoleOther: "   " })),
        );
        const res = await transition(
            w.svc,
            aid,
            "IN_TREATMENT",
            ev({ actorRole: "OTHER", actorRoleOther: "  maintenance contractor  " }),
        );
        assert(res.applied === true, "OTHER with meaningful actorRoleOther succeeds");
        assert(String((await followUpRows(w.db, aid))[0].actor_role_other) === "maintenance contractor", "stored trimmed");
    });

    await ok("G5J-35: invalid actorRole rejected", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const aid = await insertActionRaw(w.db, fid);
        await rejectsCode(APP_ERR.CONFIG, () => transition(w.svc, aid, "IN_TREATMENT", ev({ actorRole: "ADMIN" as never })));
        assert((await count(w.db, "SELECT count(*) AS c FROM follow_up")) === 0, "no FollowUp written");
    });

    await ok("G5J-36: canonical UTC Z accepted", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const aid = await insertActionRaw(w.db, fid);
        const res = await transition(w.svc, aid, "IN_TREATMENT", ev({ eventDatetime: "2026-09-02T10:15:30Z" }));
        assert(res.applied === true, "canonical Z form accepted");
    });

    await ok("G5J-37: milliseconds accepted", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const aid = await insertActionRaw(w.db, fid);
        const res = await transition(w.svc, aid, "IN_TREATMENT", ev({ eventDatetime: "2026-09-02T10:15:30.123456Z" }));
        assert(res.applied === true, "fractional seconds accepted");
        assert(String((await followUpRows(w.db, aid))[0].event_datetime) === "2026-09-02T10:15:30.123456Z", "stored verbatim");
    });

    await ok("G5J-38: arbitrary non-date rejected", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const aid = await insertActionRaw(w.db, fid);
        await rejectsCode(APP_ERR.CONFIG, () => transition(w.svc, aid, "IN_TREATMENT", ev({ eventDatetime: "yesterday" })));
        assert((await count(w.db, "SELECT count(*) AS c FROM follow_up")) === 0, "no FollowUp written");
    });

    await ok("G5J-39: timezone-less rejected", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const aid = await insertActionRaw(w.db, fid);
        await rejectsCode(APP_ERR.CONFIG, () =>
            transition(w.svc, aid, "IN_TREATMENT", ev({ eventDatetime: "2026-09-02T10:15:30" })),
        );
        assert((await count(w.db, "SELECT count(*) AS c FROM follow_up")) === 0, "no FollowUp written");
    });

    await ok("G5J-40: offset timestamp rejected", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const aid = await insertActionRaw(w.db, fid);
        await rejectsCode(APP_ERR.CONFIG, () =>
            transition(w.svc, aid, "IN_TREATMENT", ev({ eventDatetime: "2026-09-02T10:15:30+01:00" })),
        );
        assert((await count(w.db, "SELECT count(*) AS c FROM follow_up")) === 0, "no FollowUp written");
    });

    await ok("G5J-41: impossible date/time rejected", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const aid = await insertActionRaw(w.db, fid);
        for (const bad of [
            "2026-13-01T00:00:00Z",
            "2026-02-30T00:00:00Z",
            "2025-02-29T00:00:00Z", // 2025 is not a leap year
            "2026-09-02T25:00:00Z",
            "2026-09-02T10:60:00Z",
            "2026-09-02T10:15:61Z",
            "2026-00-10T00:00:00Z",
            "2026-09-00T00:00:00Z",
        ]) {
            await rejectsCode(APP_ERR.CONFIG, () => transition(w.svc, aid, "IN_TREATMENT", ev({ eventDatetime: bad })));
        }
        assert((await count(w.db, "SELECT count(*) AS c FROM follow_up")) === 0, "no FollowUp written");
    });
}

// ---------------------------------------------------------------------------
// S8 — atomicity
// ---------------------------------------------------------------------------
async function tS8_atomicity(): Promise<void> {
    await ok("G5J-42: FollowUp insert failure => no action transition", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const aid = await insertActionRaw(w.db, fid);
        const fault = new FaultAdapter(w.db, (sql) => sql.includes("INSERT INTO follow_up"));
        const svcFault = new CorrectiveActionStatusService(fault);
        await rejectsAny(() => transition(svcFault, aid, "IN_TREATMENT", ev()));
        assert((await actionStatusOf(w.db, aid)) === "OPEN", "action still OPEN");
        assert((await count(w.db, "SELECT count(*) AS c FROM follow_up")) === 0, "no FollowUp committed");
    });

    await ok("G5J-43: action UPDATE failure => FollowUp rolls back", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const aid = await insertActionRaw(w.db, fid);
        const fault = new FaultAdapter(w.db, (sql) => sql.includes("UPDATE corrective_action"));
        const svcFault = new CorrectiveActionStatusService(fault);
        await rejectsAny(() => transition(svcFault, aid, "IN_TREATMENT", ev()));
        assert((await actionStatusOf(w.db, aid)) === "OPEN", "action still OPEN");
        assert((await count(w.db, "SELECT count(*) AS c FROM follow_up")) === 0, "tentative FollowUp rolled back");
    });

    await ok("G5J-44: injected failure after FollowUp before UPDATE rolls back all", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const aid = await insertActionRaw(w.db, fid);
        // the FollowUp INSERT goes through (inner), then the UPDATE fails:
        // both must disappear — no event without its status change
        const fault = new FaultAdapter(w.db, (sql) => sql.includes("UPDATE corrective_action"));
        const svcFault = new CorrectiveActionStatusService(fault);
        await rejectsAny(() => transition(svcFault, aid, "RESOLVED", ev(), null, rv({ verificationNote: "ok" })));
        const row = await actionRow(w.db, aid);
        assert(String(row.status) === "OPEN", "status rolled back");
        assert(row.closed_at === null && row.verified_by === null && row.verification_note === null, "closure untouched");
        assert((await count(w.db, "SELECT count(*) AS c FROM follow_up")) === 0, "FollowUp rolled back");
    });

    await ok("G5J-45: no failed path leaves closure fields partially set", async () => {
        const modes: Array<"fu-insert" | "update" | "commit"> = ["fu-insert", "update", "commit"];
        for (const mode of modes) {
            const w = await freshWorld();
            const fid = await insertFindingRaw(w.db, w.visitId);
            const aid = await insertActionRaw(w.db, fid);
            let fault: SqlAdapter;
            if (mode === "fu-insert") {
                fault = new FaultAdapter(w.db, (sql) => sql.includes("INSERT INTO follow_up"));
            } else if (mode === "update") {
                fault = new FaultAdapter(w.db, (sql) => sql.includes("UPDATE corrective_action"));
            } else {
                fault = new CommitFaultAdapter(w.db);
            }
            const svcFault = new CorrectiveActionStatusService(fault);
            await rejectsAny(() => transition(svcFault, aid, "RESOLVED", ev(), null, rv({ verificationNote: "ok" })));
            const row = await actionRow(w.db, aid);
            assert(String(row.status) === "OPEN", `${mode}: status OPEN`);
            assert(row.closed_at === null && row.verified_by === null && row.verification_note === null, `${mode}: no partial closure`);
            assert((await count(w.db, "SELECT count(*) AS c FROM follow_up")) === 0, `${mode}: no partial FollowUp`);
        }
    });
}

// ---------------------------------------------------------------------------
// S9 — Class-A retry with durable event + closure identity
// ---------------------------------------------------------------------------
async function tS9_retry(): Promise<void> {
    await ok("G5J-46: exact IN_TREATMENT retry => applied:false", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const aid = await insertActionRaw(w.db, fid);
        const first = await transition(w.svc, aid, "IN_TREATMENT", ev());
        assert(first.applied === true, "first call applies");
        const retry = await transition(w.svc, aid, "IN_TREATMENT", ev());
        assert(retry.applied === false, "identical retry converges without a write");
        assert(retry.actionId === aid && retry.findingId === fid, "identity in result");
        assert(retry.status === "IN_TREATMENT", "durable status");
        assert(retry.closedAt === null && retry.verifiedBy === null && retry.verificationNote === null, "closure identity intact");
    });

    await ok("G5J-47: exact retry => one FollowUp only", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const aid = await insertActionRaw(w.db, fid);
        await transition(w.svc, aid, "IN_TREATMENT", ev());
        await transition(w.svc, aid, "IN_TREATMENT", ev());
        await transition(w.svc, aid, "IN_TREATMENT", ev());
        assert((await followUpRows(w.db, aid)).length === 1, "no duplicate FollowUp on identical retries");
    });

    await ok("G5J-48: same target, different eventDatetime => conflict", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const aid = await insertActionRaw(w.db, fid);
        await transition(w.svc, aid, "IN_TREATMENT", ev());
        await rejectsCode(APP_ERR.STATE_CONFLICT, () =>
            transition(w.svc, aid, "IN_TREATMENT", ev({ eventDatetime: T_EVENT2 })),
        );
        assert((await followUpRows(w.db, aid)).length === 1, "no second FollowUp on a conflicting retry");
    });

    await ok("G5J-49: different note => conflict", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const aid = await insertActionRaw(w.db, fid);
        await transition(w.svc, aid, "IN_TREATMENT", ev());
        await rejectsCode(APP_ERR.STATE_CONFLICT, () =>
            transition(w.svc, aid, "IN_TREATMENT", ev({ note: "different note" })),
        );
        assert((await followUpRows(w.db, aid)).length === 1, "no second FollowUp");
    });

    await ok("G5J-50: different actor => conflict", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const aid = await insertActionRaw(w.db, fid);
        await transition(w.svc, aid, "IN_TREATMENT", ev());
        await rejectsCode(APP_ERR.STATE_CONFLICT, () =>
            transition(w.svc, aid, "IN_TREATMENT", ev({ actorName: "someone-else" })),
        );
        await rejectsCode(APP_ERR.STATE_CONFLICT, () =>
            transition(w.svc, aid, "IN_TREATMENT", ev({ actorRole: "INSPECTOR", actorName: "director-a" })),
        );
        assert((await followUpRows(w.db, aid)).length === 1, "no second FollowUp");
    });

    await ok("G5J-51: different contextVisitId => conflict", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const aid = await insertActionRaw(w.db, fid);
        const ctx = await insertContextVisitRaw(w.db, w.missionId, w.institutionId);
        await transition(w.svc, aid, "IN_TREATMENT", ev(), ctx);
        // identical except the context visit is missing this time => conflict
        await rejectsCode(APP_ERR.STATE_CONFLICT, () => transition(w.svc, aid, "IN_TREATMENT", ev(), null));
        // the exact same context visit is an identical retry => converges
        const exact = await transition(w.svc, aid, "IN_TREATMENT", ev(), ctx);
        assert(exact.applied === false, "exact context retry converges");
        assert((await followUpRows(w.db, aid)).length === 1, "no second FollowUp");
    });

    await ok("G5J-52: exact RESOLVED retry => applied:false (durable closure identity returned)", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const aid = await insertActionRaw(w.db, fid);
        const first = await transition(w.svc, aid, "RESOLVED", ev(), null, rv({ verificationNote: "checked on site" }));
        assert(first.applied === true, "first call applies");
        const retry = await transition(w.svc, aid, "RESOLVED", ev(), null, rv({ verificationNote: "checked on site" }));
        assert(retry.applied === false, "identical RESOLVED retry converges");
        assert(retry.status === "RESOLVED", "durable status");
        assert(retry.closedAt === T_EVENT, "durable closed_at == event_datetime");
        assert(retry.verifiedBy === "director-a", "durable verified_by");
        assert(retry.verificationNote === "checked on site", "durable verification_note");
        assert((await followUpRows(w.db, aid)).length === 1, "one FollowUp only");
    });

    await ok("G5J-53: RESOLVED retry different verifiedBy => conflict", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const aid = await insertActionRaw(w.db, fid);
        await transition(w.svc, aid, "RESOLVED", ev(), null, rv());
        await rejectsCode(APP_ERR.STATE_CONFLICT, () =>
            transition(w.svc, aid, "RESOLVED", ev(), null, rv({ verifiedBy: "someone-else" })),
        );
        assert((await followUpRows(w.db, aid)).length === 1, "no second FollowUp");
    });

    await ok("G5J-54: different verificationNote => conflict", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const aid = await insertActionRaw(w.db, fid);
        await transition(w.svc, aid, "RESOLVED", ev(), null, rv({ verificationNote: "all good" }));
        await rejectsCode(APP_ERR.STATE_CONFLICT, () =>
            transition(w.svc, aid, "RESOLVED", ev(), null, rv({ verificationNote: "different" })),
        );
        assert((await followUpRows(w.db, aid)).length === 1, "no second FollowUp");
    });

    await ok("G5J-55: closed_at mismatch defeats convergence", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const aid = await insertActionRaw(w.db, fid);
        // fixture corruption: the durable closure timestamp differs from the
        // canonical FollowUp event (the FollowUp event stays T_EVENT while
        // the raw closure carried T_EVENT2)
        const raw = await w.db.run(
            `UPDATE corrective_action SET status = 'RESOLVED', closed_at = ?, verified_by = ?, verification_note = NULL
              WHERE action_id = ? AND status = 'OPEN'`,
            [T_EVENT2, "director-a", aid] as readonly SqlValue[],
        );
        assert(raw.changes === 1, "fixture closure applied");
        const fu = await w.db.run(
            `INSERT INTO follow_up(finding_id, corrective_action_id, visit_id, status_target, status_after,
                                   event_datetime, actor_role, actor_role_other, actor_name, note, recorded_by)
             VALUES (?, ?, NULL, 'CORRECTIVE_ACTION', 'RESOLVED', ?, 'DIRECTOR', NULL, 'director-a', 'treatment started', 'follow-up-clerk')`,
            [fid, aid, T_EVENT] as readonly SqlValue[],
        );
        assert(fu.changes === 1, "fixture FollowUp inserted");
        await rejectsCode(APP_ERR.STATE_CONFLICT, () => transition(w.svc, aid, "RESOLVED", ev(), null, rv()));
        assert((await followUpRows(w.db, aid)).length === 1, "no new FollowUp");
    });

    await ok("G5J-56: duplicate matching FollowUp defeats convergence", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const aid = await insertActionRaw(w.db, fid);
        await transition(w.svc, aid, "IN_TREATMENT", ev());
        const dup = await w.db.run(
            `INSERT INTO follow_up(finding_id, corrective_action_id, visit_id, status_target, status_after,
                                   event_datetime, actor_role, actor_role_other, actor_name, note, recorded_by)
             VALUES (?, ?, NULL, 'CORRECTIVE_ACTION', 'IN_TREATMENT', ?, 'DIRECTOR', NULL, 'director-a', 'treatment started', 'follow-up-clerk')`,
            [fid, aid, T_EVENT] as readonly SqlValue[],
        );
        assert(dup.changes === 1, "duplicate fixture row inserted");
        await rejectsCode(APP_ERR.STATE_CONFLICT, () => transition(w.svc, aid, "IN_TREATMENT", ev()));
        assert((await followUpRows(w.db, aid)).length === 2, "duplicate integrity conflict, never a third row");
    });

    await ok("G5J-57: stale IN_TREATMENT retry after later RESOLVED => conflict", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const aid = await insertActionRaw(w.db, fid);
        await transition(w.svc, aid, "IN_TREATMENT", ev());
        await transition(w.svc, aid, "RESOLVED", ev({ eventDatetime: T_EVENT2 }), null, rv());
        await rejectsCode(APP_ERR.STATE_CONFLICT, () => transition(w.svc, aid, "IN_TREATMENT", ev()));
        assert((await actionStatusOf(w.db, aid)) === "RESOLVED", "never moves backwards");
        assert((await followUpRows(w.db, aid)).length === 2, "exactly the two committed events");
    });

    await ok("G5J-58: zero-row guarded-write exact convergence produces no duplicate FollowUp", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const aid = await insertActionRaw(w.db, fid);
        await transition(w.svc, aid, "IN_TREATMENT", ev());

        // race simulation: the retry's in-transaction action read observes a
        // STALE OPEN status (as if a writer had just committed), while the
        // durable row is already IN_TREATMENT with the exact requested event —
        // the guarded UPDATE then zero-rows, rolls the tentative FollowUp
        // back, and convergence must recognize the identical durable event
        const stale = new FabricateReadOnceAdapter(
            w.db,
            (sql) => sql.includes("FROM corrective_action"),
            (rows) => rows.map((r) => ({ ...r, status: "OPEN" })),
        );
        const svcStale = new CorrectiveActionStatusService(stale);
        const res = await transition(svcStale, aid, "IN_TREATMENT", ev());
        assert(res.applied === false, "converged on the identical durable event");
        assert(res.status === "IN_TREATMENT", "durable result");
        assert((await followUpRows(w.db, aid)).length === 1, "the rolled-back tentative FollowUp left no duplicate");
    });
}

// ---------------------------------------------------------------------------
// S10 — parent Finding non-automation
// ---------------------------------------------------------------------------
async function tS10_parentFinding(): Promise<void> {
    await ok("G5J-59: T10 does not change parent Finding status", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        await insertObservationSourceRaw(w.db, w.visitId, fid);
        const aid = await insertActionRaw(w.db, fid);
        const before = await findingRow(w.db, fid);
        await transition(w.svc, aid, "IN_TREATMENT", ev());
        await transition(w.svc, aid, "RESOLVED", ev({ eventDatetime: T_EVENT2 }), null, rv());
        const after = await findingRow(w.db, fid);
        assert(after.status === before.status, "Finding status unchanged (transitions stay T8)");
    });

    await ok("G5J-60: T10 does not change Finding.status_changed_at", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        await insertObservationSourceRaw(w.db, w.visitId, fid);
        await setFindingStatusRaw(w.db, fid, "IN_TREATMENT", T_EVENT);
        const aid = await insertActionRaw(w.db, fid);
        const before = await findingRow(w.db, fid);
        await transition(w.svc, aid, "RESOLVED", ev(), null, rv());
        const after = await findingRow(w.db, fid);
        assert(after.status_changed_at === before.status_changed_at, "status_changed_at untouched");
    });

    await ok("G5J-61: T10 does not change source links", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const obsId = await insertObservationSourceRaw(w.db, w.visitId, fid);
        const aid = await insertActionRaw(w.db, fid);
        const before = await w.db.query("SELECT observation_id, finding_id FROM adhoc_observation ORDER BY observation_id");
        await transition(w.svc, aid, "RESOLVED", ev(), null, rv());
        const after = await w.db.query("SELECT observation_id, finding_id FROM adhoc_observation ORDER BY observation_id");
        assert(before.length === after.length, "no source rows added/removed");
        for (let i = 0; i < before.length; i += 1) {
            assert(
                after[i].observation_id === before[i].observation_id && after[i].finding_id === before[i].finding_id,
                "source row untouched",
            );
        }
        assert(Number((await w.db.query("SELECT finding_id FROM adhoc_observation WHERE observation_id = ?", [obsId]))[0].finding_id) === fid, "link intact");
    });

    await ok("G5J-62: resolving the last active Action does NOT auto-resolve the Finding", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        await insertObservationSourceRaw(w.db, w.visitId, fid);
        await setFindingStatusRaw(w.db, fid, "IN_TREATMENT", T_EVENT);
        const aid = await insertActionRaw(w.db, fid);
        await transition(w.svc, aid, "RESOLVED", ev(), null, rv());
        assert(String((await actionRow(w.db, aid)).status) === "RESOLVED", "action resolved");
        assert(String((await findingRow(w.db, fid)).status) === "IN_TREATMENT", "Finding NOT auto-resolved (T8 stays explicit)");
    });
}

// ---------------------------------------------------------------------------
// S11 — cross-cutting boundaries
// ---------------------------------------------------------------------------
async function tS11_crosscutting(): Promise<void> {
    await ok("G5J-63: no T9 Action creation in T10", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const aid = await insertActionRaw(w.db, fid);
        const before = await count(w.db, "SELECT count(*) AS c FROM corrective_action");
        await transition(w.svc, aid, "RESOLVED", ev(), null, rv());
        assert((await count(w.db, "SELECT count(*) AS c FROM corrective_action")) === before, "action count unchanged");
    });

    await ok("G5J-64: no VOIDED action produced", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const aid = await insertActionRaw(w.db, fid);
        await transition(w.svc, aid, "IN_TREATMENT", ev());
        await transition(w.svc, aid, "RESOLVED", ev({ eventDatetime: T_EVENT2 }), null, rv());
        const statuses = (await w.db.query("SELECT status FROM corrective_action")).map((r) => String(r.status));
        for (const s of statuses) {
            assert((CORRECTIVE_ACTION_STATUSES as readonly string[]).includes(s), `status '${s}' is in the action value set`);
        }
        assert((await count(w.db, "SELECT count(*) AS c FROM corrective_action WHERE status = 'VOIDED'")) === 0, "no VOIDED action");
        assert(
            (await count(w.db, "SELECT count(*) AS c FROM follow_up WHERE status_target = 'CORRECTIVE_ACTION' AND status_after = 'VOIDED'")) === 0,
            "no CORRECTIVE_ACTION/VOIDED audit rows",
        );
    });

    await ok("G5J-65: production application core imports no node:* module", async () => {
        const files = [
            "applicability.ts",
            "corrections.ts",
            "corrective-action-create.ts",
            "corrective-action-status.ts",
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

    await ok("G5J-66: no evidence / external-system-tracking rows are created", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const aid = await insertActionRaw(w.db, fid);
        await transition(w.svc, aid, "RESOLVED", ev(), null, rv());
        assert((await count(w.db, "SELECT count(*) AS c FROM evidence")) === 0, "no evidence row");
        assert((await count(w.db, "SELECT count(*) AS c FROM external_system_tracking")) === 0, "no tracking row");
    });
}

// ---------------------------------------------------------------------------
// S12 — contract-mandated extras
// ---------------------------------------------------------------------------
async function tS12_extras(): Promise<void> {
    await ok("G5J-67: event validation happens before any Action read (pure shape first)", async () => {
        const w = await freshWorld();
        // action 999 does not exist; the malformed EVENT must surface first
        await rejectsCode(APP_ERR.CONFIG, () =>
            transition(w.svc, 999, "IN_TREATMENT", ev({ eventDatetime: "not-a-date" })),
        );
        await rejectsCode(APP_ERR.CONFIG, () => transition(w.svc, 999, "IN_TREATMENT", ev({ note: "  " })));
        // and the malformed TARGET must surface before the missing action too
        await rejectsCode(APP_ERR.CONFIG, () => transition(w.svc, 999, "BANANA" as never, ev()));
        // resolution shape for RESOLVED is also pure
        await rejectsCode(APP_ERR.CONFIG, () => transition(w.svc, 999, "RESOLVED", ev(), null, rv({ verifiedBy: "" })));
    });

    await ok("G5J-68: conflicting already-at-target request writes nothing", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const aid = await insertActionRaw(w.db, fid);
        await transition(w.svc, aid, "IN_TREATMENT", ev());
        const before = await actionRow(w.db, aid);
        await rejectsCode(APP_ERR.STATE_CONFLICT, () => transition(w.svc, aid, "IN_TREATMENT", ev({ note: "other" })));
        const after = await actionRow(w.db, aid);
        assert(
            after.status === before.status && after.closed_at === before.closed_at && after.verified_by === before.verified_by,
            "action row untouched by a conflicting retry",
        );
        assert((await followUpRows(w.db, aid)).length === 1, "no new FollowUp");
    });

    await ok("G5J-69: already-at-target with NO durable transition event => conflict (never silent status-match success)", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const aid = await insertActionRaw(w.db, fid);
        // fixture: IN_TREATMENT reached WITHOUT any durable transition event —
        // the bare "status == requested target" shortcut must NOT succeed
        await setActionStatusRaw(w.db, aid, "IN_TREATMENT");
        await rejectsCode(APP_ERR.STATE_CONFLICT, () => transition(w.svc, aid, "IN_TREATMENT", ev()));
        assert(String((await actionRow(w.db, aid)).status) === "IN_TREATMENT", "status unchanged");
        assert((await count(w.db, "SELECT count(*) AS c FROM follow_up")) === 0, "no FollowUp fabricated");
    });

    await ok("G5J-70: RESOLVED -> RESOLVED with a different event => conflict", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const aid = await insertActionRaw(w.db, fid);
        await transition(w.svc, aid, "RESOLVED", ev(), null, rv());
        await rejectsCode(APP_ERR.STATE_CONFLICT, () =>
            transition(w.svc, aid, "RESOLVED", ev({ eventDatetime: T_EVENT2 }), null, rv()),
        );
        assert((await followUpRows(w.db, aid)).length === 1, "one FollowUp only");
    });

    await ok("G5J-71: event fields normalized on storage (trim; blank actorName => NULL)", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const aid = await insertActionRaw(w.db, fid);
        const res = await transition(
            w.svc,
            aid,
            "IN_TREATMENT",
            ev({
                eventDatetime: "  2026-09-02T10:15:30.000Z  ",
                note: "  treatment started  ",
                recordedBy: "  follow-up-clerk  ",
                actorName: "   ",
            }),
        );
        assert(res.applied === true, "applied");
        const fu = (await followUpRows(w.db, aid))[0];
        assert(String(fu.event_datetime) === "2026-09-02T10:15:30.000Z", "event_datetime trimmed");
        assert(String(fu.note) === "treatment started", "note trimmed");
        assert(String(fu.recorded_by) === "follow-up-clerk", "recorded_by trimmed");
        assert(fu.actor_name === null, "blank actor_name stored NULL");
    });

    await ok("G5J-72: zero-row guarded UPDATE without a durable identical event => E_STATE_CONFLICT", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const aid = await insertActionRaw(w.db, fid);
        const fake = new FakeChangesAdapter(w.db, (sql) => sql.includes("UPDATE corrective_action"));
        const svcFake = new CorrectiveActionStatusService(fake);
        await rejectsCode(APP_ERR.STATE_CONFLICT, () => transition(svcFake, aid, "IN_TREATMENT", ev()));
        assert((await actionStatusOf(w.db, aid)) === "OPEN", "no transition committed");
        assert((await count(w.db, "SELECT count(*) AS c FROM follow_up")) === 0, "tentative FollowUp rolled back, nothing converged");
    });

    await ok("G5J-73: IN_TREATMENT retry with corrupted non-null closure field defeats convergence", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const aid = await insertActionRaw(w.db, fid);
        await transition(w.svc, aid, "IN_TREATMENT", ev());
        // fixture corruption: a closure-adjacent field set while IN_TREATMENT
        const corr = await w.db.run("UPDATE corrective_action SET verification_note = 'stray' WHERE action_id = ?", [aid]);
        assert(corr.changes === 1, "fixture corruption applied");
        await rejectsCode(APP_ERR.STATE_CONFLICT, () => transition(w.svc, aid, "IN_TREATMENT", ev()));
        assert((await followUpRows(w.db, aid)).length === 1, "no second FollowUp");
    });

    await ok("G5J-74: schema floor re-enforces the T10 rules (defense in depth, not the error surface)", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const aid = await insertActionRaw(w.db, fid);
        // raw RESOLVED without closed_at/verified_by hits trg_ca_bu / CHECK
        await rejectsAny(() => w.db.run("UPDATE corrective_action SET status = 'RESOLVED' WHERE action_id = ?", [aid]));
        // raw backwards move hits trg_ca_bu
        await setActionStatusRaw(w.db, aid, "IN_TREATMENT");
        await rejectsAny(() => w.db.run("UPDATE corrective_action SET status = 'OPEN' WHERE action_id = ?", [aid]));
        // raw VOIDED is outside the CHECK value set
        await rejectsAny(() => w.db.run("UPDATE corrective_action SET status = 'VOIDED' WHERE action_id = ?", [aid]));
        // raw FollowUp whose corrective_action belongs to a different finding
        // hits trg_fu_bi; and CORRECTIVE_ACTION/VOIDED hits the table CHECK
        const otherFid = await insertFindingRaw(w.db, w.visitId, "other finding");
        const otherAid = await insertActionRaw(w.db, otherFid);
        await rejectsAny(() =>
            w.db.run(
                `INSERT INTO follow_up(finding_id, corrective_action_id, visit_id, status_target, status_after,
                                       event_datetime, actor_role, note, recorded_by)
                 VALUES (?, ?, NULL, 'CORRECTIVE_ACTION', 'RESOLVED', ?, 'DIRECTOR', 'x', 'clerk')`,
                [fid, otherAid, T_EVENT] as readonly SqlValue[],
            ),
        );
        await rejectsAny(() =>
            w.db.run(
                `INSERT INTO follow_up(finding_id, corrective_action_id, visit_id, status_target, status_after,
                                       event_datetime, actor_role, note, recorded_by)
                 VALUES (?, ?, NULL, 'CORRECTIVE_ACTION', 'VOIDED', ?, 'DIRECTOR', 'x', 'clerk')`,
                [fid, aid, T_EVENT] as readonly SqlValue[],
            ),
        );
        assert((await count(w.db, "SELECT count(*) AS c FROM follow_up")) === 0, "no raw audit row committed");
    });

    await ok("G5J-75: T10 never modifies the origin Visit or creates a context Visit", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        await insertObservationSourceRaw(w.db, w.visitId, fid);
        const aid = await insertActionRaw(w.db, fid);
        const before = await visitRow(w.db, w.visitId);
        const beforeCount = await count(w.db, "SELECT count(*) AS c FROM visit");
        await transition(w.svc, aid, "RESOLVED", ev(), null, rv());
        const after = await visitRow(w.db, w.visitId);
        for (const col of ["visit_id", "mission_id", "institution_id", "visit_type", "visit_date", "status", "inspector", "finalized_at", "created_at", "created_by"]) {
            assert(after[col] === before[col], `visit column ${col} unchanged`);
        }
        assert((await count(w.db, "SELECT count(*) AS c FROM visit")) === beforeCount, "no Visit created");
    });
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------
const SUITES: Array<[string, () => Promise<void>]> = [
    ["S1 basic transition", tS1_basic],
    ["S2 transition graph", tS2_graph],
    ["S3 Visit lifecycle", tS3_visitLifecycle],
    ["S4 context Visit", tS4_contextVisit],
    ["S5 IN_TREATMENT closure", tS5_inTreatmentClosure],
    ["S6 RESOLVED closure", tS6_resolvedClosure],
    ["S7 event validation", tS7_event],
    ["S8 atomicity", tS8_atomicity],
    ["S9 Class-A retry", tS9_retry],
    ["S10 parent Finding", tS10_parentFinding],
    ["S11 cross-cutting", tS11_crosscutting],
    ["S12 contract extras", tS12_extras],
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
