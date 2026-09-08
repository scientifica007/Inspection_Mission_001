// Gate 5F — automated regression for T7 `createFindingWithObservationSource`
// (TRANSACTION-CONTRACTS-v1.md §8 / APPLICATION-CORE-v1.md §4.7):
//   ensure-accounted for an EXISTING AdHocObservation (Class A; the durable
//   operation key is observation_id)
//   one explicit BEGIN IMMEDIATE unit: pre-read observation -> already-linked
//   convergence OR new-link eligibility (Visit PREPARATION, checked in-tx)
//   -> INSERT Finding OPEN -> guarded observation link (changes == 1, B5)
//   Gate-5D/5E retry-identity discipline: an already-linked durable Finding
//   converges ONLY when its immutable semantic creation identity matches the
//   requested NEW-Finding draft (created_at and current status excluded)
//   zero-row guarded link -> ROLLBACK -> durable re-read -> converge only on
//   the identical target; no reassignment, no source-less OPEN Finding.
//
// Run (repository root; Node.js >= 22 is the adopted development/test host,
// Gate-5A D1 — node:sqlite + native TypeScript type stripping):
//   Node 22.x:   node --experimental-strip-types tests/gate5f_regression.ts
//   Node 24.x:   node tests/gate5f_regression.ts
// Exit: 0 on success, 1 when any assertion fails.
//
// Coverage map (GATE 5F §K TESTS) is reproduced in the ok() labels G5F-01..25
// plus the extra schema/contract cases appended by the suite (26..29).

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { SqlAdapter, SqlRow, SqlValue } from "../src/bootstrap/adapter.ts";
import { openFreshDb } from "../dev/node-sqlite-adapter.ts";
import { BootstrapLoader } from "../src/bootstrap/loader.ts";
import { parseArtifact } from "../src/bootstrap/artifact.ts";
import { APP_ERR } from "../src/application/errors.ts";
import type { ContextKind, VisitType } from "../src/application/applicability.ts";
import { VisitScopeService } from "../src/application/visit-scope.ts";
import {
    ObservationFindingService,
    type CreateFindingWithObservationSourceInput,
} from "../src/application/observation-finding.ts";
import type { NewFindingInput } from "../src/application/initial-disposition.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_SQL = readFileSync(join(ROOT, "docs", "schema", "schema.sql"), "utf8");
const ARTIFACT_PATH = join(ROOT, "bootstrap", "v1", "checklist-v1.json");
const COMMITTED = parseArtifact(readFileSync(ARTIFACT_PATH, "utf8"));
const EXPECTED_P0 = COMMITTED.manifest.expected_p0_item_codes;

const NOW = "2026-09-01T08:00:00.000Z";
const NOW2 = "2026-09-01T09:30:00.000Z";
const VISIT_DATE = "2026-09-10";

// ---------------------------------------------------------------------------
// tiny assertion harness (same conventions as tests/gate5e_regression.ts)
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
// fixtures
// ---------------------------------------------------------------------------
interface World {
    db: SqlAdapter;
    scope: VisitScopeService;
    obs: ObservationFindingService;
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
        obs: new ObservationFindingService(db),
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

async function addWorkshopSubject(w: World, visitId: number, name = "W1"): Promise<number> {
    const res = await w.scope.addSubjectToScope({
        kind: "new",
        visitId,
        subject: { subjectType: "WORKSHOP" as ContextKind, name },
        actor: "inspector-a",
        now: NOW,
    });
    return res.subjectId;
}

/** raw observation row insert (fixture; observation-creation is out of scope). */
async function insertObservation(
    db: SqlAdapter,
    visitId: number,
    text: string,
    opts: { subjectId?: number | null; findingId?: number | null } = {},
): Promise<number> {
    const res = await db.run(
        `INSERT INTO adhoc_observation(visit_id, subject_id, text, finding_id, recorded_at, recorded_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [visitId, opts.subjectId ?? null, text, opts.findingId ?? null, NOW, "inspector-a"],
    );
    assert(res.changes === 1 && res.lastInsertRowid !== null, "observation insert failed");
    return Number(res.lastInsertRowid);
}

/** finalize the visit fixture-style (reason every pending cell first). */
async function finalizeVisitRaw(db: SqlAdapter, visitId: number): Promise<void> {
    await db.run(
        `UPDATE checklist_response SET not_inspected_reason = 'closed by owner'
          WHERE visit_id = ? AND overlay_state = 'NOT_INSPECTED' AND not_inspected_reason IS NULL`,
        [visitId],
    );
    const fin = await db.run(
        `UPDATE visit SET status = 'COMPLETED_WITH_UNINSPECTED', finalized_at = ?
          WHERE visit_id = ? AND status = 'PREPARATION' AND finalized_at IS NULL`,
        [NOW, visitId],
    );
    assert(fin.changes === 1, "visit must finalize");
}

/** explicit NEW-Finding draft used by T7 (nothing defaulted). */
function draft(extra: Partial<NewFindingInput> = {}): NewFindingInput {
    return {
        description: "ceiling leak in the corridor",
        defectType: "WATER_LEAK",
        location: "corridor",
        urgency: "IMMEDIATE",
        impact: "HIGH",
        ...extra,
    };
}

function call(
    observationId: number,
    f: NewFindingInput,
    actor = "inspector-a",
    now = NOW,
): CreateFindingWithObservationSourceInput {
    return { observationId, finding: f, actor, now };
}

async function findingRowOf(db: SqlAdapter, findingId: number): Promise<SqlRow> {
    const rows = await db.query(`SELECT * FROM finding WHERE finding_id = ?`, [findingId]);
    assert(rows.length === 1, `finding ${findingId} missing`);
    return rows[0];
}

async function obsRowOf(db: SqlAdapter, observationId: number): Promise<SqlRow> {
    const rows = await db.query(`SELECT * FROM adhoc_observation WHERE observation_id = ?`, [observationId]);
    assert(rows.length === 1, `observation ${observationId} missing`);
    return rows[0];
}

async function findingStatusOf(db: SqlAdapter, findingId: number): Promise<string> {
    return String((await findingRowOf(db, findingId)).status);
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

/** OPEN findings with zero recorded sources (the Gate-4B orphan shape). */
async function orphanOpenFindings(db: SqlAdapter): Promise<number> {
    return count(
        db,
        `SELECT count(*) AS c FROM finding f
          WHERE f.status = 'OPEN'
            AND NOT EXISTS (SELECT 1 FROM checklist_response cr WHERE cr.finding_id = f.finding_id)
            AND NOT EXISTS (SELECT 1 FROM adhoc_observation o WHERE o.finding_id = f.finding_id)`,
    );
}

// fault-injecting adapter (same shape as tests/gate5d_regression.ts)
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

// test-only begin hook: runs an action immediately BEFORE the real
// BEGIN IMMEDIATE to simulate a writer that committed in the window before
// this transaction acquired the write lock (deterministic TOCTOU simulation)
class BeginHookAdapter implements SqlAdapter {
    private readonly inner: SqlAdapter;
    private readonly beforeBegin: () => Promise<void>;

    constructor(inner: SqlAdapter, beforeBegin: () => Promise<void>) {
        this.inner = inner;
        this.beforeBegin = beforeBegin;
    }
    async beginImmediate(): Promise<void> {
        await this.beforeBegin();
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
        return this.inner.query(sql, params);
    }
}

// deterministic B5 zero-row simulation: right before the guarded observation
// link executes, a raw UPDATE on the SAME connection (inside the transaction)
// links the observation to another finding, so the guarded `finding_id IS
// NULL` UPDATE affects zero rows and forces ROLLBACK + durable re-read.
class MutateThenPassAdapter implements SqlAdapter {
    private readonly inner: SqlAdapter;
    private readonly onGuardedLink: (params: readonly SqlValue[]) => Promise<void>;
    private triggered = false;

    constructor(inner: SqlAdapter, onGuardedLink: (params: readonly SqlValue[]) => Promise<void>) {
        this.inner = inner;
        this.onGuardedLink = onGuardedLink;
    }
    get fired(): boolean {
        return this.triggered;
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
        if (!this.triggered && sql.includes("UPDATE adhoc_observation") && sql.includes("SET finding_id") && sql.includes("finding_id IS NULL")) {
            this.triggered = true;
            await this.onGuardedLink(params);
        }
        return this.inner.run(sql, params);
    }
    async query(sql: string, params: readonly SqlValue[] = []): Promise<SqlRow[]> {
        return this.inner.query(sql, params);
    }
}

// ---------------------------------------------------------------------------
// S1 — T7 basic
// ---------------------------------------------------------------------------
async function tS1_basic(): Promise<void> {
    await ok("G5F-01: missing observation => E_OBSERVATION_NOT_FOUND", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await rejectsCode(APP_ERR.OBSERVATION_NOT_FOUND, async () => w.obs.createFindingWithObservationSource(call(9999, draft())));
        assert((await count(w.db, "SELECT count(*) AS c FROM finding")) === 0, "no Finding created");
        void visitId;
    });

    await ok("G5F-02: unlinked observation in PREPARATION + valid draft => Finding created (applied)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const observationId = await insertObservation(w.db, visitId, "تسرب مياه من سقف الممر");
        const res = await w.obs.createFindingWithObservationSource(call(observationId, draft()));
        assert(res.applied === true, "applied");
        assert(res.observationId === observationId, "observationId echoed");
        assert(res.findingId !== null && res.findingId > 0, "finding created");
        assert(res.createdFindingId === res.findingId, "createdFindingId is the new Finding");
        const o = await obsRowOf(w.db, observationId);
        assert(Number(o.finding_id) === res.findingId, "observation durably linked");
    });

    await ok("G5F-03: Finding.origin_visit_id == observation.visit_id (first source in origin)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const observationId = await insertObservation(w.db, visitId, "ملاحظة");
        const res = await w.obs.createFindingWithObservationSource(call(observationId, draft()));
        const f = await findingRowOf(w.db, res.findingId);
        assert(Number(f.origin_visit_id) === visitId, `origin_visit_id ${f.origin_visit_id} != visit ${visitId}`);
    });

    await ok("G5F-04: Finding.subject_id == observation.subject_id — including the NULL case", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        // NULL (institution-context) observation
        const obsNull = await insertObservation(w.db, visitId, "ملاحظة عامة");
        const rNull = await w.obs.createFindingWithObservationSource(call(obsNull, draft()));
        const fNull = await findingRowOf(w.db, rNull.findingId);
        assert(fNull.subject_id === null, "subject NULL copied to the Finding");
        // subject-context observation
        const subjectId = await addWorkshopSubject(w, visitId);
        const obsSubj = await insertObservation(w.db, visitId, "ملاحظة ورشة", { subjectId });
        const rSubj = await w.obs.createFindingWithObservationSource(call(obsSubj, draft({ description: "آلة معطلة" })));
        const fSubj = await findingRowOf(w.db, rSubj.findingId);
        assert(Number(fSubj.subject_id) === subjectId, `subject_id ${fSubj.subject_id} != ${subjectId}`);
    });

    await ok("G5F-05: exactly one Finding / exactly one source link (both source tables)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const observationId = await insertObservation(w.db, visitId, "ملاحظة");
        const res = await w.obs.createFindingWithObservationSource(call(observationId, draft()));
        assert((await count(w.db, "SELECT count(*) AS c FROM finding")) === 1, "exactly one Finding");
        assert((await count(w.db, "SELECT count(*) AS c FROM adhoc_observation WHERE finding_id = ?", [res.findingId])) === 1, "one obs source");
        assert((await count(w.db, "SELECT count(*) AS c FROM checklist_response WHERE finding_id = ?", [res.findingId])) === 0, "zero response sources");
        assert((await findingSources(w.db, res.findingId)) === 1, "exactly one recorded source");
        const o = await obsRowOf(w.db, observationId);
        assert(Number(o.finding_id) === res.findingId, "exact source link");
    });

    await ok("G5F-06: explicit urgency/impact required (never defaulted)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const observationId = await insertObservation(w.db, visitId, "ملاحظة");
        await rejectsCode(APP_ERR.CONFIG, async () =>
            w.obs.createFindingWithObservationSource(call(observationId, { ...draft(), urgency: undefined as never })),
        );
        await rejectsCode(APP_ERR.CONFIG, async () =>
            w.obs.createFindingWithObservationSource(call(observationId, { ...draft(), impact: undefined as never })),
        );
        await rejectsCode(APP_ERR.CONFIG, async () =>
            w.obs.createFindingWithObservationSource(call(observationId, { ...draft(), urgency: "URGENT" as never })),
        );
        await rejectsCode(APP_ERR.CONFIG, async () =>
            w.obs.createFindingWithObservationSource(call(observationId, { ...draft(), impact: "CRITICAL" as never })),
        );
        assert((await count(w.db, "SELECT count(*) AS c FROM finding")) === 0, "no Finding created by invalid shapes");
        const o = await obsRowOf(w.db, observationId);
        assert(o.finding_id === null, "observation stays unlinked");
    });

    await ok("G5F-07: invalid/nonmatching subject context rejected by existing integrity", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const subjectId = await addWorkshopSubject(w, visitId);
        const observationId = await insertObservation(w.db, visitId, "ملاحظة ورشة", { subjectId });
        const res = await w.obs.createFindingWithObservationSource(call(observationId, draft({ description: "آلة معطلة" })));
        const f = await findingRowOf(w.db, res.findingId);
        // by-construction institution consistency: finding origin institution ==
        // observation visit institution, and finding subject institution ==
        // origin visit institution (trg_finding_bi enforced at INSERT)
        const instRows = await w.db.query(
            `SELECT (SELECT v.institution_id FROM visit v WHERE v.visit_id = f.origin_visit_id) AS origin_inst,
                    (SELECT s.institution_id FROM inspected_subject s WHERE s.subject_id = f.subject_id) AS subject_inst
               FROM finding f WHERE f.finding_id = ?`,
            [res.findingId],
        );
        assert(Number(instRows[0].origin_inst) === w.institutionId, "origin institution matches the visit");
        assert(Number(instRows[0].subject_inst) === w.institutionId, "subject institution matches the origin visit");
        // a cross-institution subject is rejected by trg_finding_bi (raw check)
        const inst2 = Number(
            (await w.db.run("INSERT INTO institution(name, created_at, created_by) VALUES ('Inst2', ?, 'owner')", [NOW])).lastInsertRowid,
        );
        const subj2 = Number(
            (
                await w.db.run(
                    "INSERT INTO inspected_subject(institution_id, subject_type, name, created_at, created_by) VALUES (?, 'WORKSHOP', 'W2', ?, 'owner')",
                    [inst2, NOW],
                )
            ).lastInsertRowid,
        );
        const e = await rejectsAny(() =>
            w.db.run(
                `INSERT INTO finding(origin_visit_id, description, subject_id, urgency, impact, status, created_at, created_by)
                 VALUES (?, 'x', ?, 'IMMEDIATE', 'HIGH', 'OPEN', ?, 'owner')`,
                [visitId, subj2, NOW],
            ),
        );
        assert(e.message.includes("same institution"), `trg_finding_bi fires: ${e.message}`);
        assert((await count(w.db, "SELECT count(*) AS c FROM finding")) === 1, "the cross-institution INSERT aborted entirely");
    });

    await ok("G5F-26: defect_type=OTHER requires a meaningful defect_type_other", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const observationId = await insertObservation(w.db, visitId, "ملاحظة");
        await rejectsCode(APP_ERR.CONFIG, async () =>
            w.obs.createFindingWithObservationSource(call(observationId, { ...draft(), defectType: "OTHER", defectTypeOther: "  " })),
        );
        assert((await count(w.db, "SELECT count(*) AS c FROM finding")) === 0, "no Finding created");
    });

    await ok("G5F-27: created Finding is OPEN, status_changed_at NULL, explicit audit fields", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const observationId = await insertObservation(w.db, visitId, "ملاحظة");
        const res = await w.obs.createFindingWithObservationSource(call(observationId, draft(), "inspector-a", NOW));
        const f = await findingRowOf(w.db, res.findingId);
        assert(String(f.status) === "OPEN", "status OPEN on creation");
        assert(f.status_changed_at === null, "status_changed_at NULL on creation");
        assert(String(f.created_at) === NOW && String(f.created_by) === "inspector-a", "app-supplied creation audit");
    });

    await ok("G5F-28: blank description / actor / now rejected (E_CONFIG)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const observationId = await insertObservation(w.db, visitId, "ملاحظة");
        await rejectsCode(APP_ERR.CONFIG, async () => w.obs.createFindingWithObservationSource(call(observationId, { ...draft(), description: "   " })));
        await rejectsCode(APP_ERR.CONFIG, async () => w.obs.createFindingWithObservationSource(call(observationId, draft(), "  ")));
        await rejectsCode(APP_ERR.CONFIG, async () => w.obs.createFindingWithObservationSource(call(observationId, draft(), "inspector-a", "")));
        assert((await count(w.db, "SELECT count(*) AS c FROM finding")) === 0, "no Finding created");
    });

    await ok("G5F-29: location is normalized (trimmed; NULL when blank)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const obs1 = await insertObservation(w.db, visitId, "ملاحظة 1");
        const r1 = await w.obs.createFindingWithObservationSource(call(obs1, draft({ location: "  corridor B  " })));
        const f1 = await findingRowOf(w.db, r1.findingId);
        assert(String(f1.location) === "corridor B", "location trimmed");
        const obs2 = await insertObservation(w.db, visitId, "ملاحظة 2");
        const r2 = await w.obs.createFindingWithObservationSource(call(obs2, draft({ description: "مشكل آخر", location: "   " })));
        const f2 = await findingRowOf(w.db, r2.findingId);
        assert(f2.location === null, "blank location stored NULL");
    });
}

// ---------------------------------------------------------------------------
// S2 — Visit gate
// ---------------------------------------------------------------------------
async function tS2_visitGate(): Promise<void> {
    await ok("G5F-08: unlinked observation on a finalized Visit cannot gain a new Finding", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const observationId = await insertObservation(w.db, visitId, "ملاحظة");
        await finalizeVisitRaw(w.db, visitId);
        await rejectsCode(APP_ERR.VISIT_NOT_PREPARATION, async () =>
            w.obs.createFindingWithObservationSource(call(observationId, draft())),
        );
        assert((await count(w.db, "SELECT count(*) AS c FROM finding")) === 0, "no Finding created");
        const o = await obsRowOf(w.db, observationId);
        assert(o.finding_id === null, "observation stays unlinked");
    });

    await ok("G5F-09: already-linked historical retry still converges after Visit finalization", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const observationId = await insertObservation(w.db, visitId, "ملاحظة");
        const first = await w.obs.createFindingWithObservationSource(call(observationId, draft()));
        await finalizeVisitRaw(w.db, visitId);
        // recognizing the identical historical target must NOT require the
        // Visit to still be PREPARATION (no new relationship is created)
        const again = await w.obs.createFindingWithObservationSource(call(observationId, draft(), "inspector-a", NOW2));
        assert(again.applied === false, "converged");
        assert(again.findingId === first.findingId && again.createdFindingId === null, "existing durable Finding returned");
        assert((await count(w.db, "SELECT count(*) AS c FROM finding")) === 1, "no second Finding");
        const o = await obsRowOf(w.db, observationId);
        assert(Number(o.finding_id) === first.findingId, "link unchanged");
    });
}

// ---------------------------------------------------------------------------
// S3 — retry identity (Gate-5D/5E discipline applied to T7)
// ---------------------------------------------------------------------------
async function tS3_retryIdentity(): Promise<void> {
    await ok("G5F-10: identical retry => applied:false / same finding_id / one Finding only", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const observationId = await insertObservation(w.db, visitId, "ملاحظة");
        const first = await w.obs.createFindingWithObservationSource(call(observationId, draft()));
        const again = await w.obs.createFindingWithObservationSource(call(observationId, draft()));
        assert(again.applied === false, "retry converged without writes");
        assert(again.findingId === first.findingId, "same durable Finding");
        assert(again.createdFindingId === null, "no Finding created by the retry");
        assert((await count(w.db, "SELECT count(*) AS c FROM finding")) === 1, "one Finding only");
        assert((await findingSources(w.db, first.findingId)) === 1, "still exactly one source link");
    });

    await ok("G5F-11: a fresh retry timestamp does not defeat identical convergence", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const observationId = await insertObservation(w.db, visitId, "ملاحظة");
        const first = await w.obs.createFindingWithObservationSource(call(observationId, draft(), "inspector-a", NOW));
        const again = await w.obs.createFindingWithObservationSource(call(observationId, draft(), "inspector-a", NOW2));
        assert(again.applied === false && again.findingId === first.findingId, "created_at is retry-time noise");
        assert((await count(w.db, "SELECT count(*) AS c FROM finding")) === 1, "one Finding only");
    });

    await ok("G5F-12: a later legitimate status transition does not defeat historical retry recognition", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const observationId = await insertObservation(w.db, visitId, "ملاحظة");
        const first = await w.obs.createFindingWithObservationSource(call(observationId, draft()));
        // T8 territory (fixture): OPEN -> IN_TREATMENT with its one source
        await w.db.run("UPDATE finding SET status = 'IN_TREATMENT', status_changed_at = ? WHERE finding_id = ? AND status = 'OPEN'", [
            NOW2,
            first.findingId,
        ]);
        assert((await findingStatusOf(w.db, first.findingId)) === "IN_TREATMENT", "fixture transition applied");
        const again = await w.obs.createFindingWithObservationSource(call(observationId, draft(), "inspector-a", NOW2));
        assert(again.applied === false && again.findingId === first.findingId, "current status is not part of retry identity");
        assert((await count(w.db, "SELECT count(*) AS c FROM finding")) === 1, "one Finding only");
    });

    await ok("G5F-13: different description => typed conflict (never silent success)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const observationId = await insertObservation(w.db, visitId, "ملاحظة");
        const first = await w.obs.createFindingWithObservationSource(call(observationId, draft({ description: "الوصف الأول" })));
        await rejectsCode(APP_ERR.STATE_CONFLICT, async () =>
            w.obs.createFindingWithObservationSource(call(observationId, draft({ description: "وصف مختلف" }))),
        );
        assert((await count(w.db, "SELECT count(*) AS c FROM finding")) === 1, "no second Finding");
        const o = await obsRowOf(w.db, observationId);
        assert(Number(o.finding_id) === first.findingId, "existing link never overwritten");
    });

    await ok("G5F-13b: different defect_type / location => typed conflict", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const observationId = await insertObservation(w.db, visitId, "ملاحظة");
        const first = await w.obs.createFindingWithObservationSource(call(observationId, draft({ defectType: "WATER_LEAK", location: "corridor" })));
        await rejectsCode(APP_ERR.STATE_CONFLICT, async () =>
            w.obs.createFindingWithObservationSource(call(observationId, draft({ defectType: "EQUIPMENT_FAULT" }))),
        );
        await rejectsCode(APP_ERR.STATE_CONFLICT, async () =>
            w.obs.createFindingWithObservationSource(call(observationId, draft({ location: "roof" }))),
        );
        const o = await obsRowOf(w.db, observationId);
        assert(Number(o.finding_id) === first.findingId, "existing link never overwritten");
        assert((await count(w.db, "SELECT count(*) AS c FROM finding")) === 1, "no second Finding");
    });

    await ok("G5F-14: different urgency => typed conflict", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const observationId = await insertObservation(w.db, visitId, "ملاحظة");
        const first = await w.obs.createFindingWithObservationSource(call(observationId, draft({ urgency: "IMMEDIATE" })));
        await rejectsCode(APP_ERR.STATE_CONFLICT, async () =>
            w.obs.createFindingWithObservationSource(call(observationId, draft({ urgency: "ROUTINE" }))),
        );
        const o = await obsRowOf(w.db, observationId);
        assert(Number(o.finding_id) === first.findingId, "existing link never overwritten");
        assert((await count(w.db, "SELECT count(*) AS c FROM finding")) === 1, "no second Finding");
    });

    await ok("G5F-15: different impact => typed conflict", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const observationId = await insertObservation(w.db, visitId, "ملاحظة");
        const first = await w.obs.createFindingWithObservationSource(call(observationId, draft({ impact: "HIGH" })));
        await rejectsCode(APP_ERR.STATE_CONFLICT, async () =>
            w.obs.createFindingWithObservationSource(call(observationId, draft({ impact: "LOW" }))),
        );
        const o = await obsRowOf(w.db, observationId);
        assert(Number(o.finding_id) === first.findingId, "existing link never overwritten");
        assert((await count(w.db, "SELECT count(*) AS c FROM finding")) === 1, "no second Finding");
    });

    await ok("G5F-16: different actor/created_by => typed conflict (adopted 5D/5E rule)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const observationId = await insertObservation(w.db, visitId, "ملاحظة");
        const first = await w.obs.createFindingWithObservationSource(call(observationId, draft(), "inspector-a", NOW));
        await rejectsCode(APP_ERR.STATE_CONFLICT, async () =>
            w.obs.createFindingWithObservationSource(call(observationId, draft(), "inspector-b", NOW)),
        );
        const o = await obsRowOf(w.db, observationId);
        assert(Number(o.finding_id) === first.findingId, "existing link never overwritten");
        assert((await count(w.db, "SELECT count(*) AS c FROM finding")) === 1, "no second Finding");
    });
}

// ---------------------------------------------------------------------------
// S4 — atomicity / crash windows
// ---------------------------------------------------------------------------
async function tS4_atomicity(): Promise<void> {
    await ok("G5F-17: injected failure after Finding INSERT => zero new Finding remains", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const observationId = await insertObservation(w.db, visitId, "ملاحظة");
        let faulted = false;
        const inner = new FaultAdapter(w.db, (sql) => {
            if (!faulted && sql.includes("UPDATE adhoc_observation") && sql.includes("SET finding_id")) {
                faulted = true;
                return true;
            }
            return false;
        });
        const obs = new ObservationFindingService(inner);
        await rejectsAny(async () => obs.createFindingWithObservationSource(call(observationId, draft())));
        assert(faulted, "fault injection did not trigger");
        assert((await count(w.db, "SELECT count(*) AS c FROM finding")) === 0, "tentative Finding rolled back");
        const o = await obsRowOf(w.db, observationId);
        assert(o.finding_id === null, "observation stays unlinked");
    });

    await ok("G5F-18: guarded observation UPDATE zero-row => tentative Finding rolled back", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const obs1 = await insertObservation(w.db, visitId, "ملاحظة 1");
        const first = await w.obs.createFindingWithObservationSource(call(obs1, draft()));
        const obs2 = await insertObservation(w.db, visitId, "ملاحظة 2");
        // B5 simulation: right before the guarded link executes, the row is
        // already linked (in-tx) to first.findingId, so the guarded
        // `finding_id IS NULL` UPDATE affects zero rows
        const mut = new MutateThenPassAdapter(w.db, async (params) => {
            const observationId = Number(params[1]);
            await w.db.run("UPDATE adhoc_observation SET finding_id = ? WHERE observation_id = ?", [first.findingId, observationId]);
        });
        const obs = new ObservationFindingService(mut);
        await rejectsCode(APP_ERR.STATE_CONFLICT, async () => obs.createFindingWithObservationSource(call(obs2, draft())));
        assert(mut.fired, "zero-row guard must trigger");
        // the rollback removed the tentative Finding AND the in-tx injection
        assert((await count(w.db, "SELECT count(*) AS c FROM finding")) === 1, "only the pre-existing Finding remains");
        const o2 = await obsRowOf(w.db, obs2);
        assert(o2.finding_id === null, "observation stays unlinked after the rollback");
        assert((await findingSources(w.db, first.findingId)) === 1, "pre-existing Finding keeps exactly its own source");
    });

    await ok("G5F-19: simulated ACK-loss/concurrent durable link converges to the existing identical link", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const obs1 = await insertObservation(w.db, visitId, "ملاحظة 1");
        const first = await w.obs.createFindingWithObservationSource(call(obs1, draft(), "inspector-a", NOW));
        const obs2 = await insertObservation(w.db, visitId, "ملاحظة 2");
        // a writer durably linked obs2 to the identical-target Finding in the
        // window right before our BEGIN IMMEDIATE (ACK-loss on our side)
        const hook = new BeginHookAdapter(w.db, async () => {
            await w.db.run("UPDATE adhoc_observation SET finding_id = ? WHERE observation_id = ?", [first.findingId, obs2]);
        });
        const obs = new ObservationFindingService(hook);
        const again = await obs.createFindingWithObservationSource(call(obs2, draft(), "inspector-a", NOW2));
        assert(again.applied === false, "converged on the already-linked identical target");
        assert(again.findingId === first.findingId && again.createdFindingId === null, "existing durable Finding returned");
        assert((await count(w.db, "SELECT count(*) AS c FROM finding")) === 1, "no second Finding");
        const o2 = await obsRowOf(w.db, obs2);
        assert(Number(o2.finding_id) === first.findingId, "durable link preserved");
        assert((await findingSources(w.db, first.findingId)) === 2, "the concurrent durable link is the only link");
    });

    await ok("G5F-20: conflicting durable link never overwritten", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const obs1 = await insertObservation(w.db, visitId, "ملاحظة 1");
        const other = await w.obs.createFindingWithObservationSource(call(obs1, draft({ description: "نقص آخر مختلف" })));
        const obs2 = await insertObservation(w.db, visitId, "ملاحظة 2");
        const hook = new BeginHookAdapter(w.db, async () => {
            await w.db.run("UPDATE adhoc_observation SET finding_id = ? WHERE observation_id = ?", [other.findingId, obs2]);
        });
        const obs = new ObservationFindingService(hook);
        await rejectsCode(APP_ERR.STATE_CONFLICT, async () => obs.createFindingWithObservationSource(call(obs2, draft())));
        const o2 = await obsRowOf(w.db, obs2);
        assert(Number(o2.finding_id) === other.findingId, "the conflicting durable link is preserved — never overwritten");
        assert((await count(w.db, "SELECT count(*) AS c FROM finding")) === 1, "no new Finding created");
        assert((await findingSources(w.db, other.findingId)) === 2, "no reassignment happened");
    });

    await ok("G5F-21: no tested path leaves a source-less OPEN Finding", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const obs1 = await insertObservation(w.db, visitId, "ملاحظة 1");
        const first = await w.obs.createFindingWithObservationSource(call(obs1, draft()));

        // (a) injected failure after the Finding INSERT
        const obsA = await insertObservation(w.db, visitId, "ملاحظة أ");
        const fault = new FaultAdapter(w.db, (sql) => sql.includes("UPDATE adhoc_observation") && sql.includes("SET finding_id"));
        await rejectsAny(async () => new ObservationFindingService(fault).createFindingWithObservationSource(call(obsA, draft())));
        assert((await orphanOpenFindings(w.db)) === 0, "no orphan after the fault rollback");

        // (b) zero-row guarded link
        const obsB = await insertObservation(w.db, visitId, "ملاحظة ب");
        const mut = new MutateThenPassAdapter(w.db, async (params) => {
            await w.db.run("UPDATE adhoc_observation SET finding_id = ? WHERE observation_id = ?", [first.findingId, Number(params[1])]);
        });
        await rejectsCode(APP_ERR.STATE_CONFLICT, async () => new ObservationFindingService(mut).createFindingWithObservationSource(call(obsB, draft())));
        assert((await orphanOpenFindings(w.db)) === 0, "no orphan after the zero-row rollback");

        // (c) conflicting durable link (never overwritten)
        const obsC = await insertObservation(w.db, visitId, "ملاحظة ج");
        const hook = new BeginHookAdapter(w.db, async () => {
            await w.db.run("UPDATE adhoc_observation SET finding_id = ? WHERE observation_id = ?", [first.findingId, obsC]);
        });
        await rejectsCode(APP_ERR.STATE_CONFLICT, async () =>
            new ObservationFindingService(hook).createFindingWithObservationSource(call(obsC, draft({ description: "وصف متعارض" }))),
        );
        assert((await orphanOpenFindings(w.db)) === 0, "no orphan after the conflicting-link refusal");

        // (d) conflicting plain retry
        await rejectsCode(APP_ERR.STATE_CONFLICT, async () => w.obs.createFindingWithObservationSource(call(obs1, draft({ impact: "LOW" }))));
        assert((await orphanOpenFindings(w.db)) === 0, "final sweep: zero source-less OPEN Findings");
    });
}

// ---------------------------------------------------------------------------
// S5 — cross-cutting
// ---------------------------------------------------------------------------
async function tS5_crossCutting(): Promise<void> {
    await ok("G5F-22: production application core imports no node:* module", async () => {
        const files = ["errors.ts", "observation-finding.ts"].map((f) => join(ROOT, "src", "application", f));
        for (const file of files) {
            const text = readFileSync(file, "utf8");
            const m = /(?:from\s+|require\()\s*["']node:/.exec(text);
            assert(m === null, `${file} imports a node:* module: ${m ? m[0] : ""}`);
            assert(!/node:sqlite/.test(text), `${file} must not reference node:sqlite`);
            assert(!/node-sqlite-adapter/.test(text), `${file} must not import the dev/test adapter`);
        }
    });

    await ok("G5F-23: observation text/recorded_at/recorded_by are unchanged by T7", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const observationId = await insertObservation(w.db, visitId, "نص الملاحظة الأصلي");
        const before = await obsRowOf(w.db, observationId);
        const res = await w.obs.createFindingWithObservationSource(call(observationId, draft()));
        const after = await obsRowOf(w.db, observationId);
        assert(String(after.text) === String(before.text), "text unchanged");
        assert(String(after.recorded_at) === String(before.recorded_at), "recorded_at unchanged");
        assert(String(after.recorded_by) === String(before.recorded_by), "recorded_by unchanged");
        assert(Number(after.finding_id) === res.findingId, "only finding_id changed");
    });

    await ok("G5F-24: T7 does not perform T6 re-home/retraction behavior", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const observationId = await insertObservation(w.db, visitId, "ملاحظة");
        const first = await w.obs.createFindingWithObservationSource(call(observationId, draft()));
        // a conflicting retry must neither unlink nor void anything
        await rejectsCode(APP_ERR.STATE_CONFLICT, async () =>
            w.obs.createFindingWithObservationSource(call(observationId, draft({ description: "وصف آخر" }))),
        );
        const o = await obsRowOf(w.db, observationId);
        assert(Number(o.finding_id) === first.findingId, "link stays — no retraction");
        assert((await findingStatusOf(w.db, first.findingId)) === "OPEN", "Finding stays OPEN — no void");
        assert((await count(w.db, "SELECT count(*) AS c FROM follow_up")) === 0, "no FollowUp events written");
        assert((await count(w.db, "SELECT count(*) AS c FROM finding WHERE status = 'VOIDED'")) === 0, "nothing VOIDED");
        assert((await count(w.db, "SELECT count(*) AS c FROM finding")) === 1, "no re-home target created");
    });

    await ok("G5F-25: VOIDED target/source reassignment is not introduced", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const observationId = await insertObservation(w.db, visitId, "ملاحظة");
        // fixture: a source-less OPEN Finding, then a raw OPEN -> VOIDED
        // (the DB allows it with zero sources on an open origin Visit; the
        // domain service never produces this shape — this is a schema-guard test)
        const fv = Number(
            (
                await w.db.run(
                    `INSERT INTO finding(origin_visit_id, description, urgency, impact, status, created_at, created_by)
                     VALUES (?, 'fixture finding', 'ROUTINE', 'LOW', 'OPEN', ?, 'owner')`,
                    [visitId, NOW],
                )
            ).lastInsertRowid,
        );
        await w.db.run("UPDATE finding SET status = 'VOIDED', status_changed_at = ? WHERE finding_id = ? AND status = 'OPEN'", [NOW2, fv]);
        assert((await findingStatusOf(w.db, fv)) === "VOIDED", "fixture voided");
        // the schema refuses to link an observation to a VOIDED Finding
        const e = await rejectsAny(() =>
            w.db.run("UPDATE adhoc_observation SET finding_id = ? WHERE observation_id = ? AND finding_id IS NULL", [fv, observationId]),
        );
        assert(e.message.includes("VOIDED"), `trg_obs_bu fires: ${e.message}`);
        const o0 = await obsRowOf(w.db, observationId);
        assert(o0.finding_id === null, "observation stays unlinked");
        // T7 on that observation creates a brand-NEW OPEN Finding and never
        // touches or reuses the VOIDED one
        const res = await w.obs.createFindingWithObservationSource(call(observationId, draft()));
        assert(res.applied === true && res.findingId !== fv, "a new OPEN Finding, never the VOIDED one");
        assert((await findingStatusOf(w.db, fv)) === "VOIDED" && (await findingSources(w.db, fv)) === 0, "VOIDED stays source-less");
        assert((await findingStatusOf(w.db, res.findingId)) === "OPEN" && (await findingSources(w.db, res.findingId)) === 1, "new Finding owns the source");
    });
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------
const SUITES: Array<[string, () => Promise<void>]> = [
    ["G5F-1 T7 basic creation", tS1_basic],
    ["G5F-2 Visit gate (PREPARATION / finalization)", tS2_visitGate],
    ["G5F-3 retry identity (5D/5E discipline)", tS3_retryIdentity],
    ["G5F-4 atomicity / crash windows", tS4_atomicity],
    ["G5F-5 cross-cutting + extras", tS5_crossCutting],
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
