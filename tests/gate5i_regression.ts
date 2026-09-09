// Gate 5I — automated regression for T9 `createCorrectiveAction`
// (TRANSACTION-CONTRACTS-v1.md §10 / APPLICATION-CORE-v1.md §4.13):
//   creates exactly ONE durable CorrectiveAction identity under ONE existing
//   Finding (optional 0..* per Finding); the action row ONLY — no creation
//   FollowUp is invented (the RECOVERY §2 "optional FollowUp event" has no
//   defined authoritative payload/semantics; creation is not a status
//   transition).
//   one explicit BEGIN IMMEDIATE unit: authoritative parent-Finding read
//   in-tx (missing => E_FINDING_NOT_FOUND; status OPEN|IN_TREATMENT proceed,
//   RESOLVED|VOIDED => E_STATE_CONFLICT — validated in-tx before the INSERT
//   so trg_ca_bi never leaks as a raw trigger abort) -> normalized payload
//   validation (closed action_type/responsible_role sets; OTHER companions;
//   meaningful description/createdBy; strict ISO-8601 UTC createdAt) ->
//   single INSERT born OPEN with closed_at/verified_by/verification_note
//   NULL (changes == 1 B5 + rowid, else ROLLBACK + E_STATE_CONFLICT) ->
//   COMMIT.
//   NO Visit gate: creation succeeds after origin-Visit finalization while
//   the Finding is still OPEN/IN_TREATMENT; T9 never alters Finding status /
//   status_changed_at / source links / Visit, never creates a Finding.
//   DELIBERATELY Class B: no dedupe/idempotency key; identical payloads
//   create two distinct actions; COMMIT/ACK-loss => ambiguous outcome, never
//   an internal second INSERT; no duplicate error code exists.
//
// Run (repository root; Node.js >= 22 is the adopted development/test host,
// Gate-5A D1 — node:sqlite + native TypeScript type stripping):
//   Node 22.x:   node --experimental-strip-types tests/gate5i_regression.ts
//   Node 24.x:   node tests/gate5i_regression.ts
// Exit: 0 on success, 1 when any assertion fails.
//
// Coverage map (GATE 5I §K TESTS) is reproduced in the ok() labels
// G5I-01..G5I-47, plus contract-mandated extras.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { SqlAdapter, SqlRow, SqlValue } from "../src/bootstrap/adapter.ts";
import { openFreshDb } from "../dev/node-sqlite-adapter.ts";
import { APP_ERR } from "../src/application/errors.ts";
import {
    CorrectiveActionCreateService,
    CORRECTIVE_ACTION_RESPONSIBLE_ROLES,
    CORRECTIVE_ACTION_TYPES,
    type CreateCorrectiveActionInput,
} from "../src/application/corrective-action-create.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_SQL = readFileSync(join(ROOT, "docs", "schema", "schema.sql"), "utf8");

const NOW = "2026-09-01T08:00:00.000Z";
const NOW2 = "2026-09-01T09:30:00.000Z";

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
// fixtures (raw worlds — T9 touches only finding / corrective_action)
// ---------------------------------------------------------------------------
interface World {
    db: SqlAdapter;
    svc: CorrectiveActionCreateService;
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
    return { db, svc: new CorrectiveActionCreateService(db), missionId, institutionId, visitId };
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

/** fixture Finding status move (source present => trigger-safe for IN_TREATMENT/RESOLVED). */
async function setFindingStatusRaw(db: SqlAdapter, findingId: number, status: string, at = NOW2): Promise<void> {
    const res = await db.run(
        "UPDATE finding SET status = ?, status_changed_at = ? WHERE finding_id = ? AND status = 'OPEN'",
        [status, at, findingId] as readonly SqlValue[],
    );
    assert(res.changes === 1, `fixture finding ${findingId} -> ${status} update failed`);
}

/** finalize the visit fixture-style (raw; no pending-cell preflight needed here). */
async function finalizeVisitRaw(db: SqlAdapter, visitId: number, at = NOW2): Promise<void> {
    const res = await db.run(
        "UPDATE visit SET status = 'COMPLETED', finalized_at = ? WHERE visit_id = ? AND status = 'PREPARATION' AND finalized_at IS NULL",
        [at, visitId] as readonly SqlValue[],
    );
    assert(res.changes === 1, "visit must finalize");
}

/** default T9 payload builder. */
function act(findingId: number, extra: Partial<CreateCorrectiveActionInput> = {}): CreateCorrectiveActionInput {
    return {
        findingId,
        actionType: "MAINTENANCE_WORK",
        description: "repair the corridor ceiling leak",
        responsibleRole: "CONCERNED_SERVICE",
        createdAt: NOW,
        createdBy: "inspector-a",
        ...extra,
    };
}

async function caRows(db: SqlAdapter): Promise<SqlRow[]> {
    return db.query("SELECT * FROM corrective_action ORDER BY action_id");
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
// fault-injecting adapters (same shape as tests/gate5g_regression.ts)
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
        if (sql.includes("INSERT INTO corrective_action")) this.inserts.count += 1;
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
        const res = await this.inner.run(sql, params);
        if (sql.includes("INSERT INTO corrective_action")) {
            if (this.mode === "zero") return { changes: 0, lastInsertRowid: res.lastInsertRowid };
            return { changes: 1, lastInsertRowid: null };
        }
        return res;
    }
    async query(sql: string, params: readonly SqlValue[] = []): Promise<SqlRow[]> {
        return this.inner.query(sql, params);
    }
}

// ---------------------------------------------------------------------------
// S1 — parent Finding gate
// ---------------------------------------------------------------------------
async function tS1_parentGate(): Promise<void> {
    await ok("G5I-01: missing Finding => E_FINDING_NOT_FOUND", async () => {
        const w = await freshWorld();
        await rejectsCode(APP_ERR.FINDING_NOT_FOUND, () => w.svc.createCorrectiveAction(act(999)));
        assert((await count(w.db, "SELECT count(*) AS c FROM corrective_action")) === 0, "no action created");
    });

    await ok("G5I-02: parent OPEN => create succeeds", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const res = await w.svc.createCorrectiveAction(act(fid));
        assert(res.status === "OPEN", "created action is OPEN");
        assert(res.findingId === fid, "parent is the requested finding");
        assert((await count(w.db, "SELECT count(*) AS c FROM corrective_action")) === 1, "exactly one action");
    });

    await ok("G5I-03: parent IN_TREATMENT => create succeeds", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        await insertObservationSourceRaw(w.db, w.visitId, fid);
        await setFindingStatusRaw(w.db, fid, "IN_TREATMENT");
        const res = await w.svc.createCorrectiveAction(act(fid));
        assert(res.findingId === fid, "action created under the IN_TREATMENT finding");
        assert(String((await findingRow(w.db, fid)).status) === "IN_TREATMENT", "finding stays IN_TREATMENT");
    });

    await ok("G5I-04: parent RESOLVED => rejected (typed conflict, not a raw trigger abort)", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        await insertObservationSourceRaw(w.db, w.visitId, fid);
        await setFindingStatusRaw(w.db, fid, "RESOLVED");
        await rejectsCode(APP_ERR.STATE_CONFLICT, () => w.svc.createCorrectiveAction(act(fid)));
        assert((await count(w.db, "SELECT count(*) AS c FROM corrective_action")) === 0, "no action created");
    });

    await ok("G5I-05: parent VOIDED => rejected (typed conflict, not a raw trigger abort)", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        await setFindingStatusRaw(w.db, fid, "VOIDED");
        await rejectsCode(APP_ERR.STATE_CONFLICT, () => w.svc.createCorrectiveAction(act(fid)));
        assert((await count(w.db, "SELECT count(*) AS c FROM corrective_action")) === 0, "no action created");
    });

    await ok("G5I-06: finalized origin Visit + OPEN Finding => create succeeds (no Visit gate)", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        await insertObservationSourceRaw(w.db, w.visitId, fid);
        await finalizeVisitRaw(w.db, w.visitId);
        const res = await w.svc.createCorrectiveAction(act(fid));
        assert(res.findingId === fid, "action created on a finalized origin Visit");
        const v = await visitRow(w.db, w.visitId);
        assert(String(v.status) === "COMPLETED" && v.finalized_at !== null, "Visit stays finalized");
    });

    await ok("G5I-07: creation does not alter Finding status", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const before = await findingRow(w.db, fid);
        await w.svc.createCorrectiveAction(act(fid));
        const after = await findingRow(w.db, fid);
        assert(after.status === before.status, "finding status unchanged");
    });

    await ok("G5I-08: creation does not alter Finding status_changed_at", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        await insertObservationSourceRaw(w.db, w.visitId, fid);
        await setFindingStatusRaw(w.db, fid, "IN_TREATMENT");
        const before = await findingRow(w.db, fid);
        await w.svc.createCorrectiveAction(act(fid));
        const after = await findingRow(w.db, fid);
        assert(after.status_changed_at === before.status_changed_at, "status_changed_at untouched");
    });

    await ok("G5I-09: creation does not alter source links", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const obsId = await insertObservationSourceRaw(w.db, w.visitId, fid);
        const before = await w.db.query("SELECT finding_id FROM adhoc_observation WHERE observation_id = ?", [obsId]);
        await w.svc.createCorrectiveAction(act(fid));
        const after = await w.db.query("SELECT finding_id FROM adhoc_observation WHERE observation_id = ?", [obsId]);
        assert(after[0].finding_id === before[0].finding_id, "observation source link untouched");
        assert((await count(w.db, "SELECT count(*) AS c FROM adhoc_observation WHERE finding_id = ?", [fid])) === 1, "no source added");
    });
}

// ---------------------------------------------------------------------------
// S2 — multiplicity / Class B (no dedupe)
// ---------------------------------------------------------------------------
async function tS2_multiplicity(): Promise<void> {
    await ok("G5I-10: one Finding may receive two Actions", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const a = await w.svc.createCorrectiveAction(act(fid));
        const b = await w.svc.createCorrectiveAction(act(fid, { description: "second repair task" }));
        assert(a.actionId !== b.actionId, "two distinct action identities");
        assert((await count(w.db, "SELECT count(*) AS c FROM corrective_action WHERE finding_id = ?", [fid])) === 2, "two actions");
    });

    await ok("G5I-11: identical payload invoked twice deliberately creates two different action_id values", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const a = await w.svc.createCorrectiveAction(act(fid));
        const b = await w.svc.createCorrectiveAction(act(fid));
        assert(a.actionId !== b.actionId, "distinct action_id values");
        assert((await count(w.db, "SELECT count(*) AS c FROM corrective_action")) === 2, "two durable rows");
    });

    await ok("G5I-12: no dedupe/duplicate error introduced", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        await w.svc.createCorrectiveAction(act(fid));
        await w.svc.createCorrectiveAction(act(fid)); // must NOT throw
        assert((await count(w.db, "SELECT count(*) AS c FROM corrective_action")) === 2, "both creates committed");
    });
}

// ---------------------------------------------------------------------------
// S3 — action type
// ---------------------------------------------------------------------------
async function tS3_actionType(): Promise<void> {
    await ok("G5I-13: each legal action_type accepted", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        for (const t of CORRECTIVE_ACTION_TYPES) {
            const extra = t === "OTHER" ? { actionTypeOther: "custom intervention" } : {};
            const res = await w.svc.createCorrectiveAction(act(fid, { actionType: t, ...extra }));
            assert(res.actionType === t, `action_type ${t} stored`);
        }
        assert((await count(w.db, "SELECT count(*) AS c FROM corrective_action")) === 5, "five actions created");
    });

    await ok("G5I-14: invalid action_type => E_CONFIG", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        await rejectsCode(APP_ERR.CONFIG, () =>
            w.svc.createCorrectiveAction(act(fid, { actionType: "REPAIR_WORK" as never })),
        );
        assert((await count(w.db, "SELECT count(*) AS c FROM corrective_action")) === 0, "no action created");
    });

    await ok("G5I-15: OTHER without meaningful actionTypeOther => E_CONFIG", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        await rejectsCode(APP_ERR.CONFIG, () => w.svc.createCorrectiveAction(act(fid, { actionType: "OTHER" })));
        await rejectsCode(APP_ERR.CONFIG, () =>
            w.svc.createCorrectiveAction(act(fid, { actionType: "OTHER", actionTypeOther: "   " })),
        );
        assert((await count(w.db, "SELECT count(*) AS c FROM corrective_action")) === 0, "no action created");
    });

    await ok("G5I-16: OTHER with meaningful actionTypeOther succeeds (stored normalized)", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const res = await w.svc.createCorrectiveAction(
            act(fid, { actionType: "OTHER", actionTypeOther: "  emergency work order  " }),
        );
        assert(res.actionTypeOther === "emergency work order", "actionTypeOther stored trimmed");
        const row = (await caRows(w.db))[0];
        assert(String(row.action_type_other) === "emergency work order", "durable action_type_other trimmed");
    });

    await ok("G5I-16b: non-OTHER action_type with a meaningful actionTypeOther follows the adopted companion-text convention", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const res = await w.svc.createCorrectiveAction(act(fid, { actionTypeOther: "context note" }));
        assert(res.actionTypeOther === "context note", "companion text kept for a non-OTHER type (schema CHECK allows it)");
    });
}

// ---------------------------------------------------------------------------
// S4 — responsible role
// ---------------------------------------------------------------------------
async function tS4_responsibleRole(): Promise<void> {
    await ok("G5I-17: each legal responsibleRole accepted", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        for (const r of CORRECTIVE_ACTION_RESPONSIBLE_ROLES) {
            const extra = r === "OTHER" ? { responsibleRoleOther: "maintenance contractor" } : {};
            const res = await w.svc.createCorrectiveAction(act(fid, { responsibleRole: r, ...extra }));
            assert(res.responsibleRole === r, `responsible_role ${r} stored`);
        }
        assert((await count(w.db, "SELECT count(*) AS c FROM corrective_action")) === 4, "four actions created");
    });

    await ok("G5I-18: invalid responsibleRole => E_CONFIG", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        await rejectsCode(APP_ERR.CONFIG, () =>
            w.svc.createCorrectiveAction(act(fid, { responsibleRole: "ADMIN" as never })),
        );
        assert((await count(w.db, "SELECT count(*) AS c FROM corrective_action")) === 0, "no action created");
    });

    await ok("G5I-19: OTHER without meaningful responsibleRoleOther => E_CONFIG", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        await rejectsCode(APP_ERR.CONFIG, () => w.svc.createCorrectiveAction(act(fid, { responsibleRole: "OTHER" })));
        await rejectsCode(APP_ERR.CONFIG, () =>
            w.svc.createCorrectiveAction(act(fid, { responsibleRole: "OTHER", responsibleRoleOther: "  " })),
        );
        assert((await count(w.db, "SELECT count(*) AS c FROM corrective_action")) === 0, "no action created");
    });

    await ok("G5I-20: OTHER with meaningful responsibleRoleOther succeeds (stored normalized)", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const res = await w.svc.createCorrectiveAction(
            act(fid, { responsibleRole: "OTHER", responsibleRoleOther: "  maintenance contractor  " }),
        );
        assert(res.responsibleRoleOther === "maintenance contractor", "responsibleRoleOther stored trimmed");
        const row = (await caRows(w.db))[0];
        assert(String(row.responsible_role_other) === "maintenance contractor", "durable responsible_role_other trimmed");
    });
}

// ---------------------------------------------------------------------------
// S5 — text / audit validation
// ---------------------------------------------------------------------------
async function tS5_text(): Promise<void> {
    await ok("G5I-21: meaningful description required", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        await rejectsCode(APP_ERR.CONFIG, () => w.svc.createCorrectiveAction(act(fid, { description: undefined as never })));
        assert((await count(w.db, "SELECT count(*) AS c FROM corrective_action")) === 0, "no action created");
    });

    await ok("G5I-22: blank description rejected", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        await rejectsCode(APP_ERR.CONFIG, () => w.svc.createCorrectiveAction(act(fid, { description: "" })));
        await rejectsCode(APP_ERR.CONFIG, () => w.svc.createCorrectiveAction(act(fid, { description: "   " })));
        assert((await count(w.db, "SELECT count(*) AS c FROM corrective_action")) === 0, "no action created");
    });

    await ok("G5I-23: meaningful createdBy required", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        await rejectsCode(APP_ERR.CONFIG, () => w.svc.createCorrectiveAction(act(fid, { createdBy: "" })));
        await rejectsCode(APP_ERR.CONFIG, () => w.svc.createCorrectiveAction(act(fid, { createdBy: "   " })));
        assert((await count(w.db, "SELECT count(*) AS c FROM corrective_action")) === 0, "no action created");
    });

    await ok("G5I-24: optional responsibleName NULL accepted", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const res = await w.svc.createCorrectiveAction(act(fid));
        assert(res.responsibleName === null, "responsibleName NULL");
        const row = (await caRows(w.db))[0];
        assert(row.responsible_name === null, "durable responsible_name NULL");
    });

    await ok("G5I-25: blank optional responsibleName normalizes consistently to NULL", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const a = await w.svc.createCorrectiveAction(act(fid, { responsibleName: "" }));
        const b = await w.svc.createCorrectiveAction(act(fid, { responsibleName: "   " }));
        const c = await w.svc.createCorrectiveAction(act(fid, { responsibleName: "  director-a  " }));
        assert(a.responsibleName === null && b.responsibleName === null, "blank names normalize to NULL");
        assert(c.responsibleName === "director-a", "meaningful name stored trimmed");
        const rows = await caRows(w.db);
        assert(rows[0].responsible_name === null && rows[1].responsible_name === null, "durable NULLs");
        assert(String(rows[2].responsible_name) === "director-a", "durable trimmed name");
    });
}

// ---------------------------------------------------------------------------
// S6 — due date boundary
// ---------------------------------------------------------------------------
async function tS6_dueDate(): Promise<void> {
    await ok("G5I-26: NULL dueDate accepted", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const res = await w.svc.createCorrectiveAction(act(fid));
        assert(res.dueDate === null, "dueDate NULL");
        const row = (await caRows(w.db))[0];
        assert(row.due_date === null, "durable due_date NULL");
    });

    await ok("G5I-27: non-null dueDate stored as supplied text — no invented format validation (documented boundary)", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        // the adopted contract stores nullable TEXT with NO mandated ISO date
        // semantics: the caller's text is preserved (trimmed) verbatim
        const a = await w.svc.createCorrectiveAction(act(fid, { dueDate: "2026-10-01" }));
        const b = await w.svc.createCorrectiveAction(act(fid, { dueDate: "  2026-10-01  " }));
        const c = await w.svc.createCorrectiveAction(act(fid, { dueDate: "" }));
        assert(a.dueDate === "2026-10-01", "supplied text preserved");
        assert(b.dueDate === "2026-10-01", "only the adopted trim normalization applies");
        assert(c.dueDate === null, "blank dueDate normalizes to NULL (adopted optional-text convention)");
        const rows = await caRows(w.db);
        assert(String(rows[0].due_date) === "2026-10-01", "durable due_date verbatim");
        assert(rows[2].due_date === null, "durable blank due_date NULL");
    });
}

// ---------------------------------------------------------------------------
// S7 — created row semantics
// ---------------------------------------------------------------------------
async function tS7_creationState(): Promise<void> {
    await ok("G5I-28: created status exactly OPEN", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const res = await w.svc.createCorrectiveAction(act(fid));
        assert(res.status === "OPEN", "result status OPEN");
        const row = (await caRows(w.db))[0];
        assert(String(row.status) === "OPEN", "durable status OPEN");
    });

    await ok("G5I-29: closed_at NULL at creation", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const res = await w.svc.createCorrectiveAction(act(fid));
        assert(res.closedAt === null, "result closedAt NULL");
        const row = (await caRows(w.db))[0];
        assert(row.closed_at === null, "durable closed_at NULL");
    });

    await ok("G5I-30: verified_by NULL at creation", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const res = await w.svc.createCorrectiveAction(act(fid));
        assert(res.verifiedBy === null, "result verifiedBy NULL");
        const row = (await caRows(w.db))[0];
        assert(row.verified_by === null, "durable verified_by NULL");
    });

    await ok("G5I-31: verification_note NULL at creation", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const res = await w.svc.createCorrectiveAction(act(fid));
        assert(res.verificationNote === null, "result verificationNote NULL");
        const row = (await caRows(w.db))[0];
        assert(row.verification_note === null, "durable verification_note NULL");
    });

    await ok("G5I-32: finding_id exactly the parent Finding", async () => {
        const w = await freshWorld();
        const other = await insertFindingRaw(w.db, w.visitId, "unrelated finding");
        const fid = await insertFindingRaw(w.db, w.visitId);
        const res = await w.svc.createCorrectiveAction(act(fid));
        assert(res.findingId === fid && res.findingId !== other, "action owned by the exact parent");
        const row = (await caRows(w.db))[0];
        assert(Number(row.finding_id) === fid, "durable finding_id exact");
    });

    await ok("G5I-33: createdAt stored according to the adopted strict ISO-8601 UTC contract", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const res = await w.svc.createCorrectiveAction(act(fid, { createdAt: "  2026-09-01T08:00:00.000Z  " }));
        assert(res.createdAt === "2026-09-01T08:00:00.000Z", "valid UTC instant stored trimmed");
        // no invented time, and impossible/offset/local forms are refused
        await rejectsCode(APP_ERR.CONFIG, () => w.svc.createCorrectiveAction(act(fid, { createdAt: "2026-13-01T00:00:00Z" })));
        await rejectsCode(APP_ERR.CONFIG, () => w.svc.createCorrectiveAction(act(fid, { createdAt: "2026-02-30T00:00:00Z" })));
        await rejectsCode(APP_ERR.CONFIG, () => w.svc.createCorrectiveAction(act(fid, { createdAt: "2026-09-01T08:00:00+01:00" })));
        await rejectsCode(APP_ERR.CONFIG, () => w.svc.createCorrectiveAction(act(fid, { createdAt: "2026-09-01T08:00:00" })));
        await rejectsCode(APP_ERR.CONFIG, () => w.svc.createCorrectiveAction(act(fid, { createdAt: "" })));
        assert((await count(w.db, "SELECT count(*) AS c FROM corrective_action")) === 1, "only the valid create committed");
    });

    await ok("G5I-34: createdBy normalized and stored", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const res = await w.svc.createCorrectiveAction(act(fid, { createdBy: "  inspector-a  " }));
        assert(res.createdBy === "inspector-a", "result createdBy trimmed");
        const row = (await caRows(w.db))[0];
        assert(String(row.created_by) === "inspector-a", "durable created_by trimmed");
    });
}

// ---------------------------------------------------------------------------
// S8 — atomicity / cardinality
// ---------------------------------------------------------------------------
async function tS8_atomicity(): Promise<void> {
    await ok("G5I-35: affectedRows != 1 => rollback (B5; no committed no-op, no partial Action)", async () => {
        // "zero" mode: the INSERT really happens but the adapter reports 0 rows
        {
            const w = await freshWorld();
            const fid = await insertFindingRaw(w.db, w.visitId);
            const svc = new CorrectiveActionCreateService(new CardinalityLyingAdapter(w.db, "zero"));
            await rejectsCode(APP_ERR.STATE_CONFLICT, () => svc.createCorrectiveAction(act(fid)));
            assert((await count(w.db, "SELECT count(*) AS c FROM corrective_action")) === 0, "really-inserted row rolled back");
        }
        // "no-rowid" mode: 1 row reported but no rowid surfaces
        {
            const w = await freshWorld();
            const fid = await insertFindingRaw(w.db, w.visitId);
            const svc = new CorrectiveActionCreateService(new CardinalityLyingAdapter(w.db, "no-rowid"));
            await rejectsCode(APP_ERR.STATE_CONFLICT, () => svc.createCorrectiveAction(act(fid)));
            assert((await count(w.db, "SELECT count(*) AS c FROM corrective_action")) === 0, "row without rowid rolled back");
        }
    });

    await ok("G5I-36: injected failure before INSERT => no Action", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const fault = new FaultAdapter(w.db, (kind, sql) => kind === "query" && sql.includes("FROM finding"));
        const svc = new CorrectiveActionCreateService(fault);
        await rejectsAny(() => svc.createCorrectiveAction(act(fid)));
        assert((await count(w.db, "SELECT count(*) AS c FROM corrective_action")) === 0, "no action created");
    });

    await ok("G5I-37: injected failure after INSERT before COMMIT => rollback", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const fault = new FaultAdapter(w.db, (kind) => kind === "commit");
        const svc = new CorrectiveActionCreateService(fault);
        await rejectsAny(() => svc.createCorrectiveAction(act(fid)));
        assert((await count(w.db, "SELECT count(*) AS c FROM corrective_action")) === 0, "inserted row rolled back");
    });

    await ok("G5I-38: no tested failure leaves a partial Action", async () => {
        // every fault mode above is re-run and the world is checked complete:
        // zero corrective_action rows, finding untouched, visit untouched
        const modes: Array<"zero" | "no-rowid" | "pre-insert" | "pre-commit"> = ["zero", "no-rowid", "pre-insert", "pre-commit"];
        for (const mode of modes) {
            const w = await freshWorld();
            const fid = await insertFindingRaw(w.db, w.visitId);
            const beforeF = await findingRow(w.db, fid);
            const beforeV = await visitRow(w.db, w.visitId);
            let svc: CorrectiveActionCreateService;
            if (mode === "zero" || mode === "no-rowid") {
                svc = new CorrectiveActionCreateService(new CardinalityLyingAdapter(w.db, mode));
            } else if (mode === "pre-insert") {
                svc = new CorrectiveActionCreateService(
                    new FaultAdapter(w.db, (kind, sql) => kind === "query" && sql.includes("FROM finding")),
                );
            } else {
                svc = new CorrectiveActionCreateService(new FaultAdapter(w.db, (kind) => kind === "commit"));
            }
            await rejectsAny(() => svc.createCorrectiveAction(act(fid)));
            assert((await count(w.db, "SELECT count(*) AS c FROM corrective_action")) === 0, `${mode}: no partial action`);
            const afterF = await findingRow(w.db, fid);
            const afterV = await visitRow(w.db, w.visitId);
            assert(
                afterF.status === beforeF.status && afterF.status_changed_at === beforeF.status_changed_at,
                `${mode}: finding untouched`,
            );
            assert(
                afterV.status === beforeV.status && afterV.finalized_at === beforeV.finalized_at,
                `${mode}: visit untouched`,
            );
        }
    });
}

// ---------------------------------------------------------------------------
// S9 — Class-B recovery
// ---------------------------------------------------------------------------
async function tS9_recovery(): Promise<void> {
    await ok("G5I-39: COMMIT-success / ACK-loss — durable row may exist, service performs no internal second INSERT", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const fault = new CommitFaultAfterAdapter(w.db);
        const svc = new CorrectiveActionCreateService(fault);
        // the durable COMMIT happens, then the ACK is lost: the caller sees an
        // ambiguous error although one durable row exists
        await rejectsAny(() => svc.createCorrectiveAction(act(fid)));
        assert((await count(w.db, "SELECT count(*) AS c FROM corrective_action")) === 1, "one durable row may exist after ACK-loss");
        assert(fault.inserts.count === 1, "the service never internally issued a second INSERT");
    });

    await ok("G5I-40: a deliberate later invocation remains a distinct create (never claimed exactly-once)", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const fault = new CommitFaultAfterAdapter(w.db);
        const svc = new CorrectiveActionCreateService(fault);
        await rejectsAny(() => svc.createCorrectiveAction(act(fid)));
        // two deliberate later invocations with the exact same payload are two
        // NEW Class-B creates — no convergence claim, no duplicate error
        const r1 = await w.svc.createCorrectiveAction(act(fid));
        const r2 = await w.svc.createCorrectiveAction(act(fid));
        const rows = await caRows(w.db);
        assert(rows.length === 3, "each invocation created its own durable row");
        const ids = new Set<number>(rows.map((r) => Number(r.action_id)));
        assert(ids.size === 3 && ids.has(r1.actionId) && ids.has(r2.actionId), "three distinct action identities");
    });
}

// ---------------------------------------------------------------------------
// S10 — cross-cutting boundaries
// ---------------------------------------------------------------------------
async function tS10_crosscutting(): Promise<void> {
    await ok("G5I-41: no Finding created", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const before = await count(w.db, "SELECT count(*) AS c FROM finding");
        await w.svc.createCorrectiveAction(act(fid));
        assert((await count(w.db, "SELECT count(*) AS c FROM finding")) === before, "finding count unchanged");
    });

    await ok("G5I-42: no FollowUp created (T9 records the action row only — no creation FollowUp is invented)", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        await w.svc.createCorrectiveAction(act(fid));
        assert((await count(w.db, "SELECT count(*) AS c FROM follow_up")) === 0, "no follow_up row");
    });

    await ok("G5I-43: no Visit modified", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        const before = await visitRow(w.db, w.visitId);
        await w.svc.createCorrectiveAction(act(fid));
        const after = await visitRow(w.db, w.visitId);
        for (const col of ["visit_id", "mission_id", "institution_id", "visit_type", "visit_date", "status", "inspector", "finalized_at"]) {
            assert(after[col] === before[col], `visit column ${col} unchanged`);
        }
    });

    await ok("G5I-44: no source link modified", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        await insertObservationSourceRaw(w.db, w.visitId, fid);
        const before = await w.db.query("SELECT observation_id, finding_id FROM adhoc_observation ORDER BY observation_id");
        await w.svc.createCorrectiveAction(act(fid));
        const after = await w.db.query("SELECT observation_id, finding_id FROM adhoc_observation ORDER BY observation_id");
        assert(before.length === after.length, "no source rows added/removed");
        for (let i = 0; i < before.length; i += 1) {
            assert(after[i].observation_id === before[i].observation_id && after[i].finding_id === before[i].finding_id, "source row untouched");
        }
    });

    await ok("G5I-45: production application core imports no node:* module", async () => {
        const files = [
            "applicability.ts",
            "corrections.ts",
            "corrective-action-create.ts",
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

    await ok("G5I-46: no evidence / external-system-tracking rows are created", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        await w.svc.createCorrectiveAction(act(fid));
        assert((await count(w.db, "SELECT count(*) AS c FROM evidence")) === 0, "no evidence row");
        assert((await count(w.db, "SELECT count(*) AS c FROM external_system_tracking")) === 0, "no tracking row");
    });

    await ok("G5I-47: schema floor re-enforces the T9 preconditions (defense in depth, not the error surface)", async () => {
        const w = await freshWorld();
        const fid = await insertFindingRaw(w.db, w.visitId);
        await insertObservationSourceRaw(w.db, w.visitId, fid);
        await setFindingStatusRaw(w.db, fid, "RESOLVED");
        // a raw INSERT bypassing the service hits trg_ca_bi; the domain service
        // above already turned the same precondition into E_STATE_CONFLICT
        await rejectsAny(() =>
            w.db.run(
                `INSERT INTO corrective_action(finding_id, action_type, description, responsible_role, status,
                                               created_at, created_by)
                 VALUES (?, 'MAINTENANCE_WORK', 'raw', 'DIRECTOR', 'OPEN', ?, 'owner')`,
                [fid, NOW] as readonly SqlValue[],
            ),
        );
        assert((await count(w.db, "SELECT count(*) AS c FROM corrective_action")) === 0, "trigger refused the raw insert");
    });
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------
const SUITES: Array<[string, () => Promise<void>]> = [
    ["S1 parent Finding gate", tS1_parentGate],
    ["S2 multiplicity / Class B", tS2_multiplicity],
    ["S3 action type", tS3_actionType],
    ["S4 responsible role", tS4_responsibleRole],
    ["S5 text / audit validation", tS5_text],
    ["S6 due date boundary", tS6_dueDate],
    ["S7 creation state", tS7_creationState],
    ["S8 atomicity / cardinality", tS8_atomicity],
    ["S9 Class-B recovery", tS9_recovery],
    ["S10 cross-cutting boundaries", tS10_crosscutting],
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
