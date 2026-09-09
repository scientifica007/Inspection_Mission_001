// Gate 5E — automated regression for the adopted T6 correction family
// (TRANSACTION-CONTRACTS-v1.md §7 / APPLICATION-CORE-v1.md §4.4/§4.7/§4.9):
//   ordinary response corrections (answer/reasoned/HUMAN reversals)
//   ordinary Finding source detach + re-home while F_old keeps >= 1 source
//   T6-VOID    voidOpenFindingByLastSourceCorrection
//   T6-REHOME  rehomeLastSourceAndVoidFinding (existing target / NEW target)
//   observation sources (retraction / re-home only — T7 stays out of scope)
//   SCHEDULE corrections (overall + reconciliation row set in one tx)
// with Class-A state-based retry convergence (no idempotency table) and B5
// affected-row guards on every guarded write.
//
// Run (repository root; Node.js >= 22 is the adopted development/test host,
// Gate-5A D1 — node:sqlite + native TypeScript type stripping):
//   Node 22.x:   node --experimental-strip-types tests/gate5e_regression.ts
//   Node 24.x:   node tests/gate5e_regression.ts
// Exit: 0 on success, 1 when any assertion fails.
//
// Coverage map (GATE 5E §TESTS) is reproduced in the ok() labels G5E-01..41
// plus the extra schema/contract cases appended by the suite (42..).
// The owner-authorized correction pass adds: full SCHEDULE row-set
// replacement (G5E-36/36b/53..57 — shrink/grow/same-size/overlay/rollback/
// retry) and retry identity for VOID/REHOME events and NEW-target Finding
// creation (G5E-58..69).

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
    InitialDispositionService,
    type AnswerSingleInput,
    type FindingSelection,
    type InitialDispositionResult,
    type ReconciliationRowInput,
    type ResponseCellRef,
} from "../src/application/initial-disposition.ts";
import {
    CorrectionsService,
    type CellCorrectionRequest,
    type FollowUpEventInput,
    type RehomeFindingTarget,
} from "../src/application/corrections.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_SQL = readFileSync(join(ROOT, "docs", "schema", "schema.sql"), "utf8");
const ARTIFACT_PATH = join(ROOT, "bootstrap", "v1", "checklist-v1.json");
const COMMITTED = parseArtifact(readFileSync(ARTIFACT_PATH, "utf8"));
const EXPECTED_P0 = COMMITTED.manifest.expected_p0_item_codes;

const NOW = "2026-09-01T08:00:00.000Z";
const NOW2 = "2026-09-01T09:30:00.000Z";
const VISIT_DATE = "2026-09-10";

// ---------------------------------------------------------------------------
// tiny assertion harness (same conventions as tests/gate5c_regression.ts)
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
    disp: InitialDispositionService;
    corr: CorrectionsService;
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
        corr: new CorrectionsService(db),
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

/** createVisit for a DIFFERENT institution on the same mission (fixtures). */
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

/** logical cell address of (visit, context, item_code); asserts exactly one row. */
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

/** allowed value id of (definition's item_code, value_code). */
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

interface RowState {
    overlayState: string | null;
    answeredValueId: number | null;
    note: string | null;
    notInspectedReason: string | null;
    findingId: number | null;
    recordedAt: string;
    recordedBy: string;
}

async function rowStateOf(db: SqlAdapter, responseId: number): Promise<RowState> {
    const rows = await db.query(
        `SELECT overlay_state, answered_value_id, note, not_inspected_reason, finding_id, recorded_at, recorded_by
           FROM checklist_response WHERE response_id = ?`,
        [responseId],
    );
    assert(rows.length === 1, `response ${responseId} missing`);
    const r = rows[0];
    return {
        overlayState: r.overlay_state === null ? null : String(r.overlay_state),
        answeredValueId: r.answered_value_id === null ? null : Number(r.answered_value_id),
        note: r.note === null ? null : String(r.note),
        notInspectedReason: r.not_inspected_reason === null ? null : String(r.not_inspected_reason),
        findingId: r.finding_id === null ? null : Number(r.finding_id),
        recordedAt: String(r.recorded_at),
        recordedBy: String(r.recorded_by),
    };
}

async function responseIdOf(db: SqlAdapter, ref: ResponseCellRef): Promise<number> {
    const rows = await db.query(
        `SELECT response_id FROM checklist_response
          WHERE visit_id = ? AND item_definition_id = ? ${ref.subjectId === null ? "AND subject_id IS NULL" : "AND subject_id = ?"}`,
        ref.subjectId === null ? [ref.visitId, ref.itemDefinitionId] : [ref.visitId, ref.itemDefinitionId, ref.subjectId],
    );
    assert(rows.length === 1, `response row missing for ${JSON.stringify(ref)}`);
    return Number(rows[0].response_id);
}

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

function existingFindingSel(findingId: number, covers = true): FindingSelection {
    return { mode: "existing", findingId, coversSameIssueConfirmed: covers } as FindingSelection;
}

async function singleAnswerOk(
    w: World,
    ref: ResponseCellRef,
    itemCode: string,
    valueCode: string,
    extra: Partial<AnswerSingleInput> = {},
): Promise<InitialDispositionResult> {
    const res = await w.disp.answerSingle({
        cell: ref,
        allowedValueId: await valueIdOf(w.db, itemCode, valueCode),
        ...extra,
    });
    return res;
}

/** correction request: answered target (allowed value of the pinned definition). */
async function answerReq(db: SqlAdapter, itemCode: string, valueCode: string, note: string | null = null): Promise<CellCorrectionRequest> {
    return { target: { kind: "answer", allowedValueId: await valueIdOf(db, itemCode, valueCode) }, note };
}

/** correction request: answered target with a reconciliation row set. */
async function answerReqWithRows(
    db: SqlAdapter,
    itemCode: string,
    valueCode: string,
    rows: readonly ReconciliationRowInput[],
    note: string | null = null,
): Promise<CellCorrectionRequest> {
    return { target: { kind: "answer", allowedValueId: await valueIdOf(db, itemCode, valueCode) }, rows, note };
}

function notInspectedReq(reason: string): CellCorrectionRequest {
    return { target: { kind: "notInspected", reason } };
}

function notApplicableReq(decision?: "NOT_APPLICABLE"): CellCorrectionRequest {
    return decision === undefined
        ? { target: { kind: "notApplicable" } }
        : { target: { kind: "notApplicable" }, decision };
}

function applicableReq(req: CellCorrectionRequest): CellCorrectionRequest {
    return { ...req, humanDecision: "APPLICABLE" };
}

/** raw observation row insert (fixture; T7 stays out of scope). */
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

/** raw corrective-action row insert (fixture; T9 stays out of scope). */
async function insertAction(db: SqlAdapter, findingId: number): Promise<number> {
    const res = await db.run(
        `INSERT INTO corrective_action(finding_id, action_type, description, responsible_role, created_at, created_by)
         VALUES (?, 'MAINTENANCE_WORK', 'fix', 'DIRECTOR', ?, 'inspector-a')`,
        [findingId, NOW],
    );
    assert(res.changes === 1 && res.lastInsertRowid !== null, "action insert failed");
    return Number(res.lastInsertRowid);
}

/** raw finding row insert (fixture). */
async function insertFinding(db: SqlAdapter, visitId: number): Promise<number> {
    const res = await db.run(
        `INSERT INTO finding(origin_visit_id, description, urgency, impact, status, status_changed_at, created_at, created_by)
         VALUES (?, 'fixture', 'ROUTINE', 'LOW', 'OPEN', NULL, ?, 'owner')`,
        [visitId, NOW],
    );
    assert(res.changes === 1 && res.lastInsertRowid !== null, "finding insert failed");
    return Number(res.lastInsertRowid);
}

/** raw OPEN -> VOIDED fixture transition (zero-source, origin PREPARATION). */
async function voidFindingRaw(db: SqlAdapter, findingId: number): Promise<void> {
    const res = await db.run(
        "UPDATE finding SET status = 'VOIDED', status_changed_at = ? WHERE finding_id = ? AND status = 'OPEN'",
        [NOW, findingId],
    );
    assert(res.changes === 1, "raw void failed");
}

async function reconRowsOf(db: SqlAdapter, responseId: number): Promise<Array<Record<string, SqlValue>>> {
    return db.query(
        `SELECT category, declared_qty, observed_qty, difference, discrepancy_type, discrepancy_desc
           FROM equipment_reconciliation_row WHERE response_id = ? ORDER BY sort_order, row_id`,
        [responseId],
    );
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

function voidEvent(now = NOW2, note = "recorded by mistake — correction voids the finding"): FollowUpEventInput {
    return {
        now,
        actorRole: "INSPECTOR",
        actorName: "inspector-a",
        recordedBy: "inspector-a",
        note,
    };
}

/** sources count of a finding across both source tables. */
async function findingSources(db: SqlAdapter, findingId: number): Promise<number> {
    const responses = await count(db, "SELECT count(*) AS c FROM checklist_response WHERE finding_id = ?", [findingId]);
    const observations = await count(db, "SELECT count(*) AS c FROM adhoc_observation WHERE finding_id = ?", [findingId]);
    return responses + observations;
}

async function findingStatusOf(db: SqlAdapter, findingId: number): Promise<string> {
    const rows = await db.query("SELECT status FROM finding WHERE finding_id = ?", [findingId]);
    assert(rows.length === 1, `finding ${findingId} missing`);
    return String(rows[0].status);
}

async function findingRowOf(db: SqlAdapter, findingId: number): Promise<Record<string, SqlValue>> {
    const rows = await db.query("SELECT * FROM finding WHERE finding_id = ?", [findingId]);
    assert(rows.length === 1, `finding ${findingId} missing`);
    return rows[0];
}

/** sweep: no committed source-less OPEN finding; every VOIDED has zero sources. */
async function assertFindingInvariants(db: SqlAdapter): Promise<void> {
    const findings = await db.query("SELECT finding_id, status FROM finding");
    for (const f of findings) {
        const id = Number(f.finding_id);
        const sources = await findingSources(db, id);
        const status = String(f.status);
        if (status === "OPEN") {
            assert(sources >= 1, `OPEN finding ${id} rests with zero sources`);
        }
        if (status === "VOIDED") {
            assert(sources === 0, `VOIDED finding ${id} still carries ${sources} source(s)`);
        }
    }
}

async function followUpsOf(db: SqlAdapter, findingId: number): Promise<Array<Record<string, SqlValue>>> {
    return db.query(
        `SELECT followup_id, status_target, status_after, event_datetime, note FROM follow_up
          WHERE finding_id = ? ORDER BY followup_id`,
        [findingId],
    );
}

async function obsRowOf(db: SqlAdapter, observationId: number): Promise<Record<string, SqlValue>> {
    const rows = await db.query(
        `SELECT o.observation_id, o.subject_id, o.text, o.finding_id, o.recorded_at, o.recorded_by
           FROM adhoc_observation o WHERE o.observation_id = ?`,
        [observationId],
    );
    assert(rows.length === 1, `observation ${observationId} missing`);
    return rows[0];
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

// ---------------------------------------------------------------------------
// S1 — ordinary corrections (single-value cells)
// ---------------------------------------------------------------------------
async function tS1_ordinaryCorrections(): Promise<void> {
    await ok("G5E-01: answer -> another answer (NC -> COMPLIANT) replaces value/note while F_old keeps a source", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const c10 = await cellOf(w.db, visitId, null, "CHK-010");
        const c11 = await cellOf(w.db, visitId, null, "CHK-011");
        const rid = await responseIdOf(w.db, c10);
        const f = (await singleAnswerOk(w, c10, "CHK-010", "NOT_AVAILABLE", { note: "مشكلة جرد", finding: newFindingSel(), actor: "inspector-a", now: NOW })).findingId!;
        await singleAnswerOk(w, c11, "CHK-011", "FAULTS_PRESENT", { note: "مشكلة مشتركة", finding: existingFindingSel(f), actor: "inspector-a", now: NOW });
        const before = await count(w.db, "SELECT count(*) AS c FROM checklist_response");
        const res = await w.corr.correctSingle({ cell: c10, request: await answerReq(w.db, "CHK-010", "AVAILABLE", "مصحح") });
        assert(res.applied === true, "correction must be applied");
        const st = await rowStateOf(w.db, rid);
        assert(st.answeredValueId === await valueIdOf(w.db, "CHK-010", "AVAILABLE"), "durable answered value replaced");
        assert(st.overlayState === null && st.notInspectedReason === null, "answer state");
        assert(st.note === "مصحح", `note replaced: ${st.note}`);
        assert(st.findingId === null, "COMPLIANT answer carries no finding link");
        assert(await findingStatusOf(w.db, f) === "OPEN", "F_old stays active");
        assert((await findingSources(w.db, f)) === 1, "F_old retains its second source");
        assert((await followUpsOf(w.db, f)).length === 0, "ordinary correction writes no FollowUp");
        assert((await count(w.db, "SELECT count(*) AS c FROM checklist_response")) === before, "no cell INSERT");
        await assertFindingInvariants(w.db);
    });

    await ok("G5E-02: reasoned NOT_INSPECTED -> answer", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const c6 = await cellOf(w.db, visitId, null, "CHK-006");
        const rid = await responseIdOf(w.db, c6);
        await w.disp.markNotInspected({ cell: c6, reason: "ورشة مغلقة" });
        const res = await w.corr.correctSingle({ cell: c6, request: await answerReq(w.db, "CHK-006", "REGULAR") });
        assert(res.applied === true, "applied");
        const st = await rowStateOf(w.db, rid);
        assert(st.overlayState === null && st.answeredValueId === await valueIdOf(w.db, "CHK-006", "REGULAR"), "answered");
        assert(st.notInspectedReason === null && st.findingId === null, "reason cleared, no finding");
    });

    await ok("G5E-03: answer -> deliberate NOT_INSPECTED(reason)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const c6 = await cellOf(w.db, visitId, null, "CHK-006");
        const rid = await responseIdOf(w.db, c6);
        await singleAnswerOk(w, c6, "CHK-006", "REGULAR");
        const res = await w.corr.correctSingle({ cell: c6, request: notInspectedReq("أعيد الفتح لاحقاً") });
        assert(res.applied === true, "applied");
        const st = await rowStateOf(w.db, rid);
        assert(st.overlayState === "NOT_INSPECTED" && st.notInspectedReason === "أعيد الفتح لاحقاً", "reasoned deliberate state");
        assert(st.answeredValueId === null && st.findingId === null && st.note === null, "no answer / link / note");
    });

    await ok("G5E-04: finalized / non-PREPARATION Visit rejects every correction", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const c6 = await cellOf(w.db, visitId, null, "CHK-006");
        const rid = await responseIdOf(w.db, c6);
        await singleAnswerOk(w, c6, "CHK-006", "REGULAR");
        await finalizeVisitRaw(w.db, visitId);
        await rejectsCode(APP_ERR.VISIT_NOT_PREPARATION, async () =>
            w.corr.correctSingle({ cell: c6, request: notInspectedReq("ممنوع") }),
        );
        await rejectsCode(APP_ERR.VISIT_NOT_PREPARATION, async () =>
            w.corr.correctSchedule({
                cell: await cellOf(w.db, visitId, null, "CHK-012"),
                request: await answerReq(w.db, "CHK-012", "MISMATCHED", "x"),
            }),
        );
        const st = await rowStateOf(w.db, rid);
        assert(st.answeredValueId === await valueIdOf(w.db, "CHK-006", "REGULAR"), "durable answer untouched after finalization");
    });

    await ok("G5E-05: recorded_at / recorded_by and cell identity unchanged by corrections", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const c6 = await cellOf(w.db, visitId, null, "CHK-006");
        const c7 = await cellOf(w.db, visitId, null, "CHK-007");
        const rid = await responseIdOf(w.db, c6);
        const f = (await singleAnswerOk(w, c6, "CHK-006", "IRREGULAR", { note: "عطل", finding: newFindingSel(), actor: "inspector-a", now: NOW })).findingId!;
        await singleAnswerOk(w, c7, "CHK-007", "IRREGULAR", { note: "ثاني", finding: existingFindingSel(f), actor: "inspector-a", now: NOW });
        const before = await rowStateOf(w.db, rid);
        const resCount = await count(w.db, "SELECT count(*) AS c FROM checklist_response");
        await w.corr.correctSingle({ cell: c6, request: await answerReq(w.db, "CHK-006", "REGULAR", "تعديل") });
        const after = await rowStateOf(w.db, rid);
        assert(after.recordedAt === before.recordedAt && after.recordedBy === before.recordedBy, "recorded audit immutable");
        assert((await count(w.db, "SELECT count(*) AS c FROM checklist_response")) === resCount, "no scope row added");
        assert((await responseIdOf(w.db, c6)) === rid, "response_id (cell identity) unchanged by the correction");
        assert((await findingStatusOf(w.db, f)) === "OPEN" && (await findingSources(w.db, f)) === 1, "F_old kept active with its second source");
    });

    await ok("G5E-06: HUMAN NA -> answer requires explicit APPLICABLE", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const c20 = await cellOf(w.db, visitId, null, "CHK-020");
        const rid = await responseIdOf(w.db, c20);
        await w.disp.resolveHumanApplicability({ cell: c20 });
        const req = await answerReq(w.db, "CHK-020", "AVAILABLE");
        const e = await rejectsCode(APP_ERR.HUMAN_NEEDS_DECISION, async () => w.corr.correctSingle({ cell: c20, request: req }));
        assert(e.message.includes("APPLICABLE"), `message names the explicit decision: ${e.message}`);
        assert((await rowStateOf(w.db, rid)).overlayState === "NA", "still NA after the refused reversal");
        const res = await w.corr.correctSingle({ cell: c20, request: applicableReq(req) });
        assert(res.applied === true, "reversal with the explicit APPLICABLE decision succeeds");
        const st = await rowStateOf(w.db, rid);
        assert(st.overlayState === null && st.answeredValueId === await valueIdOf(w.db, "CHK-020", "AVAILABLE"), "answered after reversal");
    });

    await ok("G5E-07: HUMAN NA -> reasoned NOT_INSPECTED requires APPLICABLE", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const c20 = await cellOf(w.db, visitId, null, "CHK-020");
        const rid = await responseIdOf(w.db, c20);
        await w.disp.resolveHumanApplicability({ cell: c20 });
        const req = notInspectedReq("لا يوجد اليوم");
        await rejectsCode(APP_ERR.HUMAN_NEEDS_DECISION, async () => w.corr.correctSingle({ cell: c20, request: req }));
        assert((await rowStateOf(w.db, rid)).overlayState === "NA", "still NA after the refused reversal");
        const res = await w.corr.correctSingle({ cell: c20, request: applicableReq(req) });
        assert(res.applied === true, "applied");
        const st = await rowStateOf(w.db, rid);
        assert(st.overlayState === "NOT_INSPECTED" && st.notInspectedReason === "لا يوجد اليوم", "reasoned after reversal");
    });

    await ok("G5E-08: HUMAN answered -> NA requires explicit NOT_APPLICABLE", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const c20 = await cellOf(w.db, visitId, null, "CHK-020");
        const rid = await responseIdOf(w.db, c20);
        await singleAnswerOk(w, c20, "CHK-020", "AVAILABLE", { humanDecision: "APPLICABLE" });
        const req = notApplicableReq();
        const e = await rejectsCode(APP_ERR.HUMAN_NEEDS_DECISION, async () => w.corr.correctSingle({ cell: c20, request: req }));
        assert(e.message.includes("NOT_APPLICABLE"), `message names the explicit decision: ${e.message}`);
        const st = await rowStateOf(w.db, rid);
        assert(st.answeredValueId === await valueIdOf(w.db, "CHK-020", "AVAILABLE"), "still answered after the refused reversal");
        const res = await w.corr.correctSingle({ cell: c20, request: notApplicableReq("NOT_APPLICABLE") });
        assert(res.applied === true, "applied");
        const na = await rowStateOf(w.db, rid);
        assert(na.overlayState === "NA" && na.answeredValueId === null && na.findingId === null, "NA after explicit reversal");
    });

    await ok("G5E-09: HUMAN reasoned NOT_INSPECTED -> NA with explicit NOT_APPLICABLE", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const c20 = await cellOf(w.db, visitId, null, "CHK-020");
        const rid = await responseIdOf(w.db, c20);
        await w.disp.markNotInspected({ cell: c20, reason: "غير متاح حالياً", humanDecision: "APPLICABLE" });
        const res = await w.corr.correctSingle({ cell: c20, request: notApplicableReq("NOT_APPLICABLE") });
        assert(res.applied === true, "applied");
        const st = await rowStateOf(w.db, rid);
        assert(st.overlayState === "NA" && st.notInspectedReason === null && st.answeredValueId === null, "NA state");
    });

    await ok("G5E-10: AUTO NA cannot use the HUMAN reversal path (E_CONFIG, no blind swap)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        // CHK-013 at the institution context is a deterministic AUTO-NA cell
        const c13 = await cellOf(w.db, visitId, null, "CHK-013");
        const rid = await responseIdOf(w.db, c13);
        await rejectsCode(APP_ERR.CONFIG, async () =>
            w.corr.correctSingle({ cell: c13, request: notApplicableReq("NOT_APPLICABLE") }),
        );
        await rejectsCode(APP_ERR.CONFIG, async () =>
            w.corr.correctSingle({ cell: c13, request: await answerReq(w.db, "CHK-013", "READY") }),
        );
        const st = await rowStateOf(w.db, rid);
        assert(st.overlayState === "NA", "AUTO-NA durable state untouched");
    });

    await ok("G5E-78: contextual AUTO-NA (HUMAN_CONFIRMATION definition excluded by subject_kinds) cannot be reversed", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const subjectId = await addWorkshopSubject(w, visitId, "W1");
        // CHK-020's root decision_kind is HUMAN_CONFIRMATION but its rule
        // subject_kinds=[INSTITUTION]: in a WORKSHOP context the adopted
        // evaluator returns NOT_APPLICABLE, so Gate 5C materialized an
        // AUTOMATIC NA — a root-decision_kind-only check must NOT let the
        // HUMAN reversal touch it.
        const c20 = await cellOf(w.db, visitId, subjectId, "CHK-020");
        const rid = await responseIdOf(w.db, c20);
        const before = await rowStateOf(w.db, rid);
        assert(before.overlayState === "NA", "precondition: the WORKSHOP cell was materialized as automatic NA");
        const findingsBefore = await count(w.db, "SELECT count(*) AS c FROM finding");
        const followUpsBefore = await count(w.db, "SELECT count(*) AS c FROM follow_up");

        // the exact reported reproduction: answer with humanDecision='APPLICABLE'
        await rejectsCode(APP_ERR.CONFIG, async () =>
            w.corr.correctSingle({ cell: c20, request: applicableReq(await answerReq(w.db, "CHK-020", "AVAILABLE")) }),
        );
        // reasoned NOT_INSPECTED reversal is equally refused
        await rejectsCode(APP_ERR.CONFIG, async () =>
            w.corr.correctSingle({ cell: c20, request: applicableReq(notInspectedReq("إعادة فحص")) }),
        );
        // an NA target on the automatic NA is not a correction either
        await rejectsCode(APP_ERR.CONFIG, async () =>
            w.corr.correctSingle({ cell: c20, request: notApplicableReq("NOT_APPLICABLE") }),
        );

        const after = await rowStateOf(w.db, rid);
        assert(after.overlayState === "NA" && after.answeredValueId === null && after.notInspectedReason === null, "durable cell remains automatic NA");
        assert(after.recordedAt === before.recordedAt && after.recordedBy === before.recordedBy, "scope-entry audit untouched");
        assert(
            (await count(w.db, "SELECT count(*) AS c FROM finding")) === findingsBefore &&
                (await count(w.db, "SELECT count(*) AS c FROM follow_up")) === followUpsBefore,
            "no Finding / FollowUp / source side effect",
        );
    });

    await ok("G5E-79: genuine HUMAN reversal in an applicable context still works both ways", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const c20 = await cellOf(w.db, visitId, null, "CHK-020");
        const rid = await responseIdOf(w.db, c20);
        await w.disp.resolveHumanApplicability({ cell: c20 });
        assert((await rowStateOf(w.db, rid)).overlayState === "NA", "precondition: HUMAN-decided NA");
        // NA -> answered with the explicit APPLICABLE decision
        const res1 = await w.corr.correctSingle({ cell: c20, request: applicableReq(await answerReq(w.db, "CHK-020", "AVAILABLE")) });
        assert(res1.applied === true, "institution-context HUMAN reversal applied");
        assert((await rowStateOf(w.db, rid)).answeredValueId === await valueIdOf(w.db, "CHK-020", "AVAILABLE"), "answered after reversal");
        // answered -> NA with the explicit NOT_APPLICABLE decision
        const res2 = await w.corr.correctSingle({ cell: c20, request: notApplicableReq("NOT_APPLICABLE") });
        assert(res2.applied === true, "answered -> NA reversal applied");
        assert((await rowStateOf(w.db, rid)).overlayState === "NA", "NA after the explicit reversal");
    });
}

// ---------------------------------------------------------------------------
// S2 — ordinary finding-source discipline
// ---------------------------------------------------------------------------
async function tS2_findingSourceOrdinary(): Promise<void> {
    await ok("G5E-11: NC -> COMPLIANT detaches while F_old keeps an observation source; F_old stays OPEN", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const c6 = await cellOf(w.db, visitId, null, "CHK-006");
        const rid = await responseIdOf(w.db, c6);
        const f = (await singleAnswerOk(w, c6, "CHK-006", "IRREGULAR", { note: "عطل", finding: newFindingSel(), actor: "inspector-a", now: NOW })).findingId!;
        await insertObservation(w.db, visitId, "تسرب ملاحظ في الورشة", { findingId: f });
        const res = await w.corr.correctSingle({ cell: c6, request: await answerReq(w.db, "CHK-006", "REGULAR") });
        assert(res.applied === true, "ordinary detach applied");
        const st = await rowStateOf(w.db, rid);
        assert(st.answeredValueId === await valueIdOf(w.db, "CHK-006", "REGULAR") && st.findingId === null, "source detached with the answer");
        assert(await findingStatusOf(w.db, f) === "OPEN", "F_old remains OPEN (other source retained)");
        assert((await findingSources(w.db, f)) === 1, "F_old keeps its observation source");
        assert((await followUpsOf(w.db, f)).length === 0, "no VOID FollowUp");
        await assertFindingInvariants(w.db);
    });

    await ok("G5E-12: ordinary NC re-home while F_old retains another source", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const c6 = await cellOf(w.db, visitId, null, "CHK-006");
        const c7 = await cellOf(w.db, visitId, null, "CHK-007");
        const c10 = await cellOf(w.db, visitId, null, "CHK-010");
        const rid6 = await responseIdOf(w.db, c6);
        const fOld = (await singleAnswerOk(w, c6, "CHK-006", "IRREGULAR", { note: "عطل كهربائي", finding: newFindingSel(), actor: "inspector-a", now: NOW })).findingId!;
        await singleAnswerOk(w, c7, "CHK-007", "IRREGULAR", { note: "نفس العطل", finding: existingFindingSel(fOld), actor: "inspector-a", now: NOW });
        const fTarget = (await singleAnswerOk(w, c10, "CHK-010", "NOT_AVAILABLE", { note: "عطل آخر", finding: newFindingSel(), actor: "inspector-a", now: NOW })).findingId!;
        const res = await w.corr.rehomeSource({
            source: { kind: "response", cell: c6 },
            target: { mode: "existing", findingId: fTarget, coversSameIssueConfirmed: true },
        });
        assert(res.applied === true, "ordinary re-home applied");
        const st = await rowStateOf(w.db, rid6);
        assert(st.findingId === fTarget, "source moved to the target Finding");
        assert(st.answeredValueId === await valueIdOf(w.db, "CHK-006", "IRREGULAR"), "the NC answer itself is untouched");
        assert(st.note === "عطل كهربائي", "the note is untouched by a pure re-home");
        assert(await findingStatusOf(w.db, fOld) === "OPEN", "F_old stays OPEN");
        assert((await findingSources(w.db, fOld)) === 1, "F_old retains >= 1 source");
        assert((await findingSources(w.db, fTarget)) === 2, "target gained the source");
        assert((await followUpsOf(w.db, fOld)).length === 0, "no VOID FollowUp on an ordinary re-home");
        await assertFindingInvariants(w.db);
    });

    await ok("G5E-13: old Finding remains active and retains >= 1 source after the re-home", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const c6 = await cellOf(w.db, visitId, null, "CHK-006");
        const fOld = (await singleAnswerOk(w, c6, "CHK-006", "IRREGULAR", { note: "عطل", finding: newFindingSel(), actor: "inspector-a", now: NOW })).findingId!;
        const obsId = await insertObservation(w.db, visitId, "مشاهدة مصاحبة", { findingId: fOld });
        const c10 = await cellOf(w.db, visitId, null, "CHK-010");
        const fTarget = (await singleAnswerOk(w, c10, "CHK-010", "NOT_AVAILABLE", { note: "ثانوي", finding: newFindingSel(), actor: "inspector-a", now: NOW })).findingId!;
        await w.corr.rehomeSource({
            source: { kind: "observation", observationId: obsId },
            target: { mode: "existing", findingId: fTarget, coversSameIssueConfirmed: true },
        });
        assert(await findingStatusOf(w.db, fOld) === "OPEN", "F_old active");
        assert((await findingSources(w.db, fOld)) === 1, "F_old keeps its response source");
        assert((await findingSources(w.db, fTarget)) === 2, "observation moved to the target");
        const o = await obsRowOf(w.db, obsId);
        assert(Number(o.finding_id) === fTarget, "durable observation link");
        const voided = await w.db.query("SELECT count(*) AS c FROM finding WHERE status = 'VOIDED'");
        assert(Number(voided[0].c) === 0, "nothing was VOIDED by the ordinary re-home");
        await assertFindingInvariants(w.db);
    });

    await ok("G5E-14a: cross-institution re-home target rejected (E_CONTEXT)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const otherInst = Number(
            (await w.db.run("INSERT INTO institution(name, created_at, created_by) VALUES ('Other', ?, 'owner')", [NOW])).lastInsertRowid,
        );
        const foreignVisit = await createVisitFor(w, otherInst);
        const foreignCell = await cellOf(w.db, foreignVisit, null, "CHK-006");
        const foreign = (await singleAnswerOk(w, foreignCell, "CHK-006", "IRREGULAR", { note: "خارجي", finding: newFindingSel(), actor: "inspector-b", now: NOW })).findingId!;
        const c6 = await cellOf(w.db, visitId, null, "CHK-006");
        const c7 = await cellOf(w.db, visitId, null, "CHK-007");
        const fOld = (await singleAnswerOk(w, c6, "CHK-006", "IRREGULAR", { note: "محلي", finding: newFindingSel(), actor: "inspector-a", now: NOW })).findingId!;
        await singleAnswerOk(w, c7, "CHK-007", "IRREGULAR", { note: "ثاني", finding: existingFindingSel(fOld), actor: "inspector-a", now: NOW });
        const e = await rejectsCode(APP_ERR.CONTEXT, async () =>
            w.corr.rehomeSource({ source: { kind: "response", cell: c6 }, target: { mode: "existing", findingId: foreign, coversSameIssueConfirmed: true } }),
        );
        assert(e.message.includes("institution"), `message mentions institution: ${e.message}`);
        assert((await rowStateOf(w.db, await responseIdOf(w.db, c6))).findingId === fOld, "link untouched");
    });

    await ok("G5E-14b: VOIDED/RESOLVED re-home target rejected (E_FINDING_TARGET_INVALID)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const c6 = await cellOf(w.db, visitId, null, "CHK-006");
        const c7 = await cellOf(w.db, visitId, null, "CHK-007");
        const fOld = (await singleAnswerOk(w, c6, "CHK-006", "IRREGULAR", { note: "عطل", finding: newFindingSel(), actor: "inspector-a", now: NOW })).findingId!;
        await singleAnswerOk(w, c7, "CHK-007", "IRREGULAR", { note: "ثاني", finding: existingFindingSel(fOld), actor: "inspector-a", now: NOW });
        const voidedTarget = await insertFinding(w.db, visitId);
        await voidFindingRaw(w.db, voidedTarget);
        const resolvedTarget = (await singleAnswerOk(w, await cellOf(w.db, visitId, null, "CHK-010"), "CHK-010", "NOT_AVAILABLE", { note: "r", finding: newFindingSel(), actor: "inspector-a", now: NOW })).findingId!;
        await w.db.run("UPDATE finding SET status = 'RESOLVED', status_changed_at = ? WHERE finding_id = ?", [NOW, resolvedTarget]);
        const e1 = await rejectsCode(APP_ERR.FINDING_TARGET_INVALID, async () =>
            w.corr.rehomeSource({ source: { kind: "response", cell: c6 }, target: { mode: "existing", findingId: voidedTarget, coversSameIssueConfirmed: true } }),
        );
        assert(e1.message.includes("VOIDED"), `message names VOIDED: ${e1.message}`);
        await rejectsCode(APP_ERR.FINDING_TARGET_INVALID, async () =>
            w.corr.rehomeSource({ source: { kind: "response", cell: c6 }, target: { mode: "existing", findingId: resolvedTarget, coversSameIssueConfirmed: true } }),
        );
    });

    await ok("G5E-14c: subject-mismatched re-home target rejected (E_CONTEXT)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const wsA = await addWorkshopSubject(w, visitId, "WS-A");
        const wsB = await addWorkshopSubject(w, visitId, "WS-B");
        const cA = await cellOf(w.db, visitId, wsA, "CHK-006");
        const cA2 = await cellOf(w.db, visitId, wsA, "CHK-007");
        const fOld = (await singleAnswerOk(w, cA, "CHK-006", "IRREGULAR", { note: "عطل أ", finding: newFindingSel(), actor: "inspector-a", now: NOW })).findingId!;
        await singleAnswerOk(w, cA2, "CHK-007", "IRREGULAR", { note: "ثاني أ", finding: existingFindingSel(fOld), actor: "inspector-a", now: NOW });
        const cB = await cellOf(w.db, visitId, wsB, "CHK-006");
        const fB = (await singleAnswerOk(w, cB, "CHK-006", "IRREGULAR", { note: "عطل ب", finding: newFindingSel(), actor: "inspector-a", now: NOW })).findingId!;
        const e = await rejectsCode(APP_ERR.CONTEXT, async () =>
            w.corr.rehomeSource({ source: { kind: "response", cell: cA }, target: { mode: "existing", findingId: fB, coversSameIssueConfirmed: true } }),
        );
        assert(e.message.includes("subject"), `message mentions subject: ${e.message}`);
    });
}

// ---------------------------------------------------------------------------
// S3 — T6-VOID
// ---------------------------------------------------------------------------
async function tS3_void(): Promise<void> {
    async function singleSourceFinding(
        w: World,
        itemCode: string,
        valueCode: string,
        note: string,
        extra: Partial<AnswerSingleInput> = {},
    ): Promise<{ cell: ResponseCellRef; findingId: number }> {
        const visitId = await standardCreate(w);
        const cell = await cellOf(w.db, visitId, null, itemCode);
        const findingId = (await singleAnswerOk(w, cell, itemCode, valueCode, {
            note,
            finding: newFindingSel(),
            actor: "inspector-a",
            now: NOW,
            ...extra,
        })).findingId!;
        return { cell, findingId };
    }

    await ok("G5E-15: last NC source -> COMPLIANT: detach + FollowUp + F_old VOIDED in one transaction", async () => {
        const w = await freshWorld();
        const { cell: c6, findingId: f } = await singleSourceFinding(w, "CHK-006", "IRREGULAR", "عطل مسجل");
        const rid = await responseIdOf(w.db, c6);
        const event = voidEvent();
        const res = await w.corr.voidOpenFindingByLastSourceCorrection({
            findingId: f,
            correction: { kind: "response", cell: c6, request: await answerReq(w.db, "CHK-006", "REGULAR") },
            event,
        });
        assert(res.applied === true && res.voidedFindingId === f, "void applied");
        const st = await rowStateOf(w.db, rid);
        assert(st.answeredValueId === await valueIdOf(w.db, "CHK-006", "REGULAR") && st.findingId === null, "source corrected to COMPLIANT, detached");
        assert(st.overlayState === null, "answered state");
        const fr = await findingRowOf(w.db, f);
        assert(String(fr.status) === "VOIDED", "F_old VOIDED");
        assert(String(fr.status_changed_at) === event.now, "status_changed_at == event_datetime");
        const fus = await followUpsOf(w.db, f);
        assert(fus.length === 1, "exactly one FollowUp");
        assert(String(fus[0].status_target) === "FINDING" && String(fus[0].status_after) === "VOIDED", "FINDING/VOIDED event");
        assert(String(fus[0].event_datetime) === event.now, "FollowUp event_datetime == status_changed_at");
        assert((await findingSources(w.db, f)) === 0, "VOIDED finding has zero sources");
        await assertFindingInvariants(w.db);
    });

    await ok("G5E-16: last NC source -> HUMAN NA (valid HUMAN applicability correction)", async () => {
        const w = await freshWorld();
        const { cell: c20, findingId: f } = await singleSourceFinding(w, "CHK-020", "NOT_AVAILABLE", "غير متوفر", {
            humanDecision: "APPLICABLE",
        });
        const rid = await responseIdOf(w.db, c20);
        const event = voidEvent();
        const res = await w.corr.voidOpenFindingByLastSourceCorrection({
            findingId: f,
            correction: { kind: "response", cell: c20, request: { target: { kind: "notApplicable" }, decision: "NOT_APPLICABLE" } },
            event,
        });
        assert(res.applied === true, "applied");
        const st = await rowStateOf(w.db, rid);
        assert(st.overlayState === "NA" && st.answeredValueId === null && st.findingId === null, "HUMAN NA durable state");
        assert(await findingStatusOf(w.db, f) === "VOIDED", "F_old VOIDED");
    });

    await ok("G5E-17: last NC source -> deliberate NOT_INSPECTED(reason)", async () => {
        const w = await freshWorld();
        const { cell: c6, findingId: f } = await singleSourceFinding(w, "CHK-006", "IRREGULAR", "عطل");
        const rid = await responseIdOf(w.db, c6);
        const res = await w.corr.voidOpenFindingByLastSourceCorrection({
            findingId: f,
            correction: { kind: "response", cell: c6, request: notInspectedReq("أعيد فتح الجرد لاحقاً") },
            event: voidEvent(),
        });
        assert(res.applied === true, "applied");
        const st = await rowStateOf(w.db, rid);
        assert(st.overlayState === "NOT_INSPECTED" && st.notInspectedReason === "أعيد فتح الجرد لاحقاً", "reasoned terminal state");
        assert(st.answeredValueId === null && st.findingId === null && st.note === null, "no answer / link / note");
        assert(await findingStatusOf(w.db, f) === "VOIDED", "F_old VOIDED");
    });

    await ok("G5E-18: last observation source retraction voids F_old", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const f = await insertFinding(w.db, visitId);
        const obsId = await insertObservation(w.db, visitId, "تسرب مياه من السقف", { findingId: f });
        const res = await w.corr.voidOpenFindingByLastSourceCorrection({
            findingId: f,
            correction: { kind: "observation", observationId: obsId },
            event: voidEvent(),
        });
        assert(res.applied === true && res.voidedFindingId === f, "observation retraction void applied");
        const o = await obsRowOf(w.db, obsId);
        assert(o.finding_id === null, "observation detached");
        assert(o.text === "تسرب مياه من السقف", "text untouched without an explicit correction");
        assert(await findingStatusOf(w.db, f) === "VOIDED", "F_old VOIDED");
        assert((await followUpsOf(w.db, f)).length === 1, "FollowUp recorded");
    });

    await ok("G5E-19: zero CorrectiveActions required (VOID never invents or requires an action)", async () => {
        const w = await freshWorld();
        const { cell: c6, findingId: f } = await singleSourceFinding(w, "CHK-006", "IRREGULAR", "عطل");
        assert((await count(w.db, "SELECT count(*) AS c FROM corrective_action WHERE finding_id = ?", [f])) === 0, "no actions on fixture");
        const res = await w.corr.voidOpenFindingByLastSourceCorrection({
            findingId: f,
            correction: { kind: "response", cell: c6, request: await answerReq(w.db, "CHK-006", "REGULAR") },
            event: voidEvent(),
        });
        assert(res.applied === true, "void succeeds with zero actions");
        assert((await count(w.db, "SELECT count(*) AS c FROM corrective_action")) === 0, "no action row appeared anywhere");
    });

    await ok("G5E-20: any CorrectiveAction => reject (E_VOID_HAS_ACTIONS); nothing changes", async () => {
        const w = await freshWorld();
        const { cell: c6, findingId: f } = await singleSourceFinding(w, "CHK-006", "IRREGULAR", "عطل");
        const rid = await responseIdOf(w.db, c6);
        await insertAction(w.db, f);
        const e = await rejectsCode(APP_ERR.VOID_HAS_ACTIONS, async () =>
            w.corr.voidOpenFindingByLastSourceCorrection({
                findingId: f,
                correction: { kind: "response", cell: c6, request: await answerReq(w.db, "CHK-006", "REGULAR") },
                event: voidEvent(),
            }),
        );
        assert(e.message.includes("1 corrective action"), `message counts actions: ${e.message}`);
        const st = await rowStateOf(w.db, rid);
        assert(st.answeredValueId === await valueIdOf(w.db, "CHK-006", "IRREGULAR") && st.findingId === f, "source untouched");
        assert(await findingStatusOf(w.db, f) === "OPEN", "F_old stays OPEN");
        assert((await followUpsOf(w.db, f)).length === 0, "no FollowUp");
    });

    await ok("G5E-21: IN_TREATMENT/RESOLVED last-source retraction stays refused in v1", async () => {
        const w = await freshWorld();
        const { cell: c6, findingId: f } = await singleSourceFinding(w, "CHK-006", "IRREGULAR", "عطل");
        const rid = await responseIdOf(w.db, c6);
        await w.db.run("UPDATE finding SET status = 'IN_TREATMENT', status_changed_at = ? WHERE finding_id = ? AND status = 'OPEN'", [NOW, f]);
        await rejectsCode(APP_ERR.STATE_CONFLICT, async () =>
            w.corr.voidOpenFindingByLastSourceCorrection({
                findingId: f,
                correction: { kind: "response", cell: c6, request: await answerReq(w.db, "CHK-006", "REGULAR") },
                event: voidEvent(),
            }),
        );
        await rejectsCode(APP_ERR.STATE_CONFLICT, async () =>
            w.corr.correctSingle({ cell: c6, request: await answerReq(w.db, "CHK-006", "REGULAR") }),
        );
        await rejectsCode(APP_ERR.STATE_CONFLICT, async () =>
            w.corr.rehomeLastSourceAndVoidFinding({
                findingId: f,
                source: { kind: "response", cell: c6 },
                target: { mode: "existing", findingId: 0, coversSameIssueConfirmed: true } as unknown as RehomeFindingTarget,
                event: voidEvent(),
            }),
        );
        await w.db.run("UPDATE finding SET status = 'RESOLVED', status_changed_at = ? WHERE finding_id = ? AND status = 'IN_TREATMENT'", [NOW2, f]);
        await rejectsCode(APP_ERR.STATE_CONFLICT, async () =>
            w.corr.voidOpenFindingByLastSourceCorrection({
                findingId: f,
                correction: { kind: "response", cell: c6, request: await answerReq(w.db, "CHK-006", "REGULAR") },
                event: voidEvent(),
            }),
        );
        const st = await rowStateOf(w.db, rid);
        assert(st.answeredValueId === await valueIdOf(w.db, "CHK-006", "IRREGULAR") && st.findingId === f, "source untouched by all refusals");
        assert(await findingStatusOf(w.db, f) === "RESOLVED", "finding terminal but not VOIDED");
    });

    await ok("G5E-22: injected failure after the source detach rolls everything back", async () => {
        const w = await freshWorld();
        const { cell: c6, findingId: f } = await singleSourceFinding(w, "CHK-006", "IRREGULAR", "عطل");
        const rid = await responseIdOf(w.db, c6);
        let faulted = false;
        const inner = new FaultAdapter(w.db, (sql) => {
            if (sql.includes("INSERT INTO follow_up")) {
                faulted = true;
                return true;
            }
            return false;
        });
        const corr = new CorrectionsService(inner);
        await rejectsAny(async () =>
            corr.voidOpenFindingByLastSourceCorrection({
                findingId: f,
                correction: { kind: "response", cell: c6, request: await answerReq(w.db, "CHK-006", "REGULAR") },
                event: voidEvent(),
            }),
        );
        assert(faulted, "fault injection must trigger on the FollowUp insert");
        const st = await rowStateOf(w.db, rid);
        assert(st.answeredValueId === await valueIdOf(w.db, "CHK-006", "IRREGULAR") && st.findingId === f, "source correction rolled back");
        assert(await findingStatusOf(w.db, f) === "OPEN", "F_old still OPEN");
        assert((await followUpsOf(w.db, f)).length === 0, "no FollowUp survived");
        assert((await findingSources(w.db, f)) === 1, "source count restored");
    });

    await ok("G5E-23: injected FollowUp/status failure rolls everything back", async () => {
        const w = await freshWorld();
        const { cell: c6, findingId: f } = await singleSourceFinding(w, "CHK-006", "IRREGULAR", "عطل");
        const rid = await responseIdOf(w.db, c6);
        let faulted = false;
        const inner = new FaultAdapter(w.db, (sql) => {
            if (sql.includes("UPDATE finding") && sql.includes("SET status = 'VOIDED'")) {
                faulted = true;
                return true;
            }
            return false;
        });
        const corr = new CorrectionsService(inner);
        await rejectsAny(async () =>
            corr.voidOpenFindingByLastSourceCorrection({
                findingId: f,
                correction: { kind: "response", cell: c6, request: await answerReq(w.db, "CHK-006", "REGULAR") },
                event: voidEvent(),
            }),
        );
        assert(faulted, "fault injection must trigger on the OPEN -> VOIDED update");
        const st = await rowStateOf(w.db, rid);
        assert(st.answeredValueId === await valueIdOf(w.db, "CHK-006", "IRREGULAR") && st.findingId === f, "source correction rolled back");
        assert(await findingStatusOf(w.db, f) === "OPEN", "status change rolled back");
        assert((await followUpsOf(w.db, f)).length === 0, "FollowUp rolled back with the status");
    });

    await ok("G5E-24: identical retry creates no second FollowUp", async () => {
        const w = await freshWorld();
        const { cell: c6, findingId: f } = await singleSourceFinding(w, "CHK-006", "IRREGULAR", "عطل");
        const req = await answerReq(w.db, "CHK-006", "REGULAR");
        const event = voidEvent();
        const call = async () =>
            w.corr.voidOpenFindingByLastSourceCorrection({ findingId: f, correction: { kind: "response", cell: c6, request: req }, event });
        const first = await call();
        const again = await call();
        assert(first.applied === true && again.applied === false, "identical retry converges");
        assert((await followUpsOf(w.db, f)).length === 1, "no second FollowUp");
        assert((await count(w.db, "SELECT count(*) AS c FROM finding")) === 1, "no second finding");
        assert(await findingStatusOf(w.db, f) === "VOIDED", "still VOIDED");
    });
}

// ---------------------------------------------------------------------------
// S4 — T6-REHOME
// ---------------------------------------------------------------------------
async function tS4_rehome(): Promise<void> {
    await ok("G5E-25: last response source -> existing target + F_old VOIDED atomically", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const c6 = await cellOf(w.db, visitId, null, "CHK-006");
        const rid6 = await responseIdOf(w.db, c6);
        const fOld = (await singleAnswerOk(w, c6, "CHK-006", "IRREGULAR", { note: "عطل", finding: newFindingSel(), actor: "inspector-a", now: NOW })).findingId!;
        const c7 = await cellOf(w.db, visitId, null, "CHK-007");
        const fTarget = (await singleAnswerOk(w, c7, "CHK-007", "IRREGULAR", { note: "هدف", finding: newFindingSel(), actor: "inspector-a", now: NOW })).findingId!;
        const event = voidEvent();
        const res = await w.corr.rehomeLastSourceAndVoidFinding({
            findingId: fOld,
            source: { kind: "response", cell: c6 },
            target: { mode: "existing", findingId: fTarget, coversSameIssueConfirmed: true },
            event,
        });
        assert(res.applied === true, "applied");
        const st = await rowStateOf(w.db, rid6);
        assert(st.findingId === fTarget, "source re-assigned to the target");
        assert(st.answeredValueId === await valueIdOf(w.db, "CHK-006", "IRREGULAR"), "the NC answer stays valid (only the link moves)");
        const fr = await findingRowOf(w.db, fOld);
        assert(String(fr.status) === "VOIDED" && String(fr.status_changed_at) === event.now, "F_old VOIDED with shared timestamp");
        assert((await findingSources(w.db, fOld)) === 0, "F_old zero sources");
        assert((await findingSources(w.db, fTarget)) === 2, "target now holds both sources");
        const fus = await followUpsOf(w.db, fOld);
        assert(fus.length === 1 && String(fus[0].status_after) === "VOIDED", "one VOIDED FollowUp on F_old");
        await assertFindingInvariants(w.db);
    });

    await ok("G5E-26: last observation source -> existing target + F_old VOIDED", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const fOld = await insertFinding(w.db, visitId);
        const obsId = await insertObservation(w.db, visitId, "ملاحظة مسجلة", { findingId: fOld });
        const c10 = await cellOf(w.db, visitId, null, "CHK-010");
        const fTarget = (await singleAnswerOk(w, c10, "CHK-010", "NOT_AVAILABLE", { note: "هدف", finding: newFindingSel(), actor: "inspector-a", now: NOW })).findingId!;
        const res = await w.corr.rehomeLastSourceAndVoidFinding({
            findingId: fOld,
            source: { kind: "observation", observationId: obsId },
            target: { mode: "existing", findingId: fTarget, coversSameIssueConfirmed: true },
            event: voidEvent(),
        });
        assert(res.applied === true, "applied");
        const o = await obsRowOf(w.db, obsId);
        assert(Number(o.finding_id) === fTarget, "observation moved to the target");
        assert(await findingStatusOf(w.db, fOld) === "VOIDED", "F_old VOIDED");
        assert((await findingSources(w.db, fTarget)) === 2, "target holds both sources");
        assert((await followUpsOf(w.db, fOld)).length === 1, "VOIDED FollowUp on F_old");
    });

    await ok("G5E-27a: VOIDED target rejected (E_FINDING_TARGET_INVALID)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const c6 = await cellOf(w.db, visitId, null, "CHK-006");
        const fOld = (await singleAnswerOk(w, c6, "CHK-006", "IRREGULAR", { note: "عطل", finding: newFindingSel(), actor: "inspector-a", now: NOW })).findingId!;
        const voidedTarget = await insertFinding(w.db, visitId);
        await voidFindingRaw(w.db, voidedTarget);
        const e = await rejectsCode(APP_ERR.FINDING_TARGET_INVALID, async () =>
            w.corr.rehomeLastSourceAndVoidFinding({
                findingId: fOld,
                source: { kind: "response", cell: c6 },
                target: { mode: "existing", findingId: voidedTarget, coversSameIssueConfirmed: true },
                event: voidEvent(),
            }),
        );
        assert(e.message.includes("VOIDED"), `message names VOIDED: ${e.message}`);
        assert((await rowStateOf(w.db, await responseIdOf(w.db, c6))).findingId === fOld, "source untouched");
    });

    await ok("G5E-27b: RESOLVED target rejected (E_FINDING_TARGET_INVALID)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const c6 = await cellOf(w.db, visitId, null, "CHK-006");
        const fOld = (await singleAnswerOk(w, c6, "CHK-006", "IRREGULAR", { note: "عطل", finding: newFindingSel(), actor: "inspector-a", now: NOW })).findingId!;
        const c10 = await cellOf(w.db, visitId, null, "CHK-010");
        const fTarget = (await singleAnswerOk(w, c10, "CHK-010", "NOT_AVAILABLE", { note: "r", finding: newFindingSel(), actor: "inspector-a", now: NOW })).findingId!;
        await w.db.run("UPDATE finding SET status = 'RESOLVED', status_changed_at = ? WHERE finding_id = ?", [NOW, fTarget]);
        const e = await rejectsCode(APP_ERR.FINDING_TARGET_INVALID, async () =>
            w.corr.rehomeLastSourceAndVoidFinding({
                findingId: fOld,
                source: { kind: "response", cell: c6 },
                target: { mode: "existing", findingId: fTarget, coversSameIssueConfirmed: true },
                event: voidEvent(),
            }),
        );
        assert(e.message.includes("RESOLVED"), `message names RESOLVED: ${e.message}`);
    });

    await ok("G5E-28a: cross-institution T6-REHOME target rejected (E_CONTEXT)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const c6 = await cellOf(w.db, visitId, null, "CHK-006");
        const fOld = (await singleAnswerOk(w, c6, "CHK-006", "IRREGULAR", { note: "عطل", finding: newFindingSel(), actor: "inspector-a", now: NOW })).findingId!;
        const otherInst = Number(
            (await w.db.run("INSERT INTO institution(name, created_at, created_by) VALUES ('Other', ?, 'owner')", [NOW])).lastInsertRowid,
        );
        const foreignVisit = await createVisitFor(w, otherInst);
        const foreign = (await singleAnswerOk(w, await cellOf(w.db, foreignVisit, null, "CHK-006"), "CHK-006", "IRREGULAR", { note: "خارجي", finding: newFindingSel(), actor: "inspector-b", now: NOW })).findingId!;
        await rejectsCode(APP_ERR.CONTEXT, async () =>
            w.corr.rehomeLastSourceAndVoidFinding({
                findingId: fOld,
                source: { kind: "response", cell: c6 },
                target: { mode: "existing", findingId: foreign, coversSameIssueConfirmed: true },
                event: voidEvent(),
            }),
        );
    });

    await ok("G5E-28b: subject-mismatched T6-REHOME target rejected (E_CONTEXT)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const wsA = await addWorkshopSubject(w, visitId, "WS-A");
        const wsB = await addWorkshopSubject(w, visitId, "WS-B");
        const cA = await cellOf(w.db, visitId, wsA, "CHK-006");
        const fOld = (await singleAnswerOk(w, cA, "CHK-006", "IRREGULAR", { note: "عطل أ", finding: newFindingSel(), actor: "inspector-a", now: NOW })).findingId!;
        const cB = await cellOf(w.db, visitId, wsB, "CHK-006");
        const fB = (await singleAnswerOk(w, cB, "CHK-006", "IRREGULAR", { note: "عطل ب", finding: newFindingSel(), actor: "inspector-a", now: NOW })).findingId!;
        await rejectsCode(APP_ERR.CONTEXT, async () =>
            w.corr.rehomeLastSourceAndVoidFinding({
                findingId: fOld,
                source: { kind: "response", cell: cA },
                target: { mode: "existing", findingId: fB, coversSameIssueConfirmed: true },
                event: voidEvent(),
            }),
        );
    });

    await ok("G5E-29: coversSameIssueConfirmed is required for an existing target", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const c6 = await cellOf(w.db, visitId, null, "CHK-006");
        const fOld = (await singleAnswerOk(w, c6, "CHK-006", "IRREGULAR", { note: "عطل", finding: newFindingSel(), actor: "inspector-a", now: NOW })).findingId!;
        const c7 = await cellOf(w.db, visitId, null, "CHK-007");
        const fTarget = (await singleAnswerOk(w, c7, "CHK-007", "IRREGULAR", { note: "هدف", finding: newFindingSel(), actor: "inspector-a", now: NOW })).findingId!;
        const noConfirm = { mode: "existing", findingId: fTarget, coversSameIssueConfirmed: false } as unknown as RehomeFindingTarget;
        const e = await rejectsCode(APP_ERR.FINDING_TARGET_INVALID, async () =>
            w.corr.rehomeLastSourceAndVoidFinding({ findingId: fOld, source: { kind: "response", cell: c6 }, target: noConfirm, event: voidEvent() }),
        );
        assert(e.message.includes("covers-same-issue"), `message names the confirmation: ${e.message}`);
        assert(await findingStatusOf(w.db, fOld) === "OPEN", "F_old untouched");
    });

    await ok("G5E-30: injected failure rolls back source re-assignment + F_old status", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const c6 = await cellOf(w.db, visitId, null, "CHK-006");
        const fOld = (await singleAnswerOk(w, c6, "CHK-006", "IRREGULAR", { note: "عطل", finding: newFindingSel(), actor: "inspector-a", now: NOW })).findingId!;
        const c7 = await cellOf(w.db, visitId, null, "CHK-007");
        const fTarget = (await singleAnswerOk(w, c7, "CHK-007", "IRREGULAR", { note: "هدف", finding: newFindingSel(), actor: "inspector-a", now: NOW })).findingId!;
        let faulted = false;
        const inner = new FaultAdapter(w.db, (sql) => {
            if (sql.includes("INSERT INTO follow_up")) {
                faulted = true;
                return true;
            }
            return false;
        });
        const corr = new CorrectionsService(inner);
        await rejectsAny(async () =>
            corr.rehomeLastSourceAndVoidFinding({
                findingId: fOld,
                source: { kind: "response", cell: c6 },
                target: { mode: "existing", findingId: fTarget, coversSameIssueConfirmed: true },
                event: voidEvent(),
            }),
        );
        assert(faulted, "fault injection must trigger");
        assert((await rowStateOf(w.db, await responseIdOf(w.db, c6))).findingId === fOld, "source stayed on F_old");
        assert(await findingStatusOf(w.db, fOld) === "OPEN", "F_old still OPEN");
        assert((await findingSources(w.db, fTarget)) === 1, "target unchanged");
        assert((await followUpsOf(w.db, fOld)).length === 0, "no FollowUp survived");
    });

    await ok("G5E-31: NEW target — origin_visit_id == the SOURCE's Visit; explicit data preserved", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const c6 = await cellOf(w.db, visitId, null, "CHK-006");
        const rid6 = await responseIdOf(w.db, c6);
        const fOld = (await singleAnswerOk(w, c6, "CHK-006", "IRREGULAR", { note: "عطل في الورشة", finding: newFindingSel(), actor: "inspector-a", now: NOW })).findingId!;
        const event = voidEvent();
        const target: RehomeFindingTarget = {
            mode: "new",
            finding: {
                description: "الرابط الأصلي خاطئ — العطل يخص غرفة الكهرباء",
                defectType: "ELECTRICAL_FAULT",
                location: "غرفة الكهرباء",
                urgency: "BEFORE_ENTRY",
                impact: "MEDIUM",
            },
        };
        const res = await w.corr.rehomeLastSourceAndVoidFinding({ findingId: fOld, source: { kind: "response", cell: c6 }, target, event });
        assert(res.applied === true && res.createdFindingId !== null, "new target created");
        const st = await rowStateOf(w.db, rid6);
        assert(st.findingId === res.createdFindingId, "source re-assigned to the NEW target");
        const t = await findingRowOf(w.db, res.createdFindingId!);
        assert(Number(t.origin_visit_id) === visitId, "origin_visit_id == the source's Visit");
        assert(t.subject_id === null, "institution-context source -> subject NULL");
        assert(String(t.status) === "OPEN", "new target OPEN");
        assert(String(t.urgency) === "BEFORE_ENTRY" && String(t.impact) === "MEDIUM", "explicit urgency/impact preserved (never defaulted)");
        assert(String(t.created_at) === event.now && String(t.created_by) === event.recordedBy, "creation audit from the event");
        assert(String((await findingRowOf(w.db, fOld)).status) === "VOIDED", "F_old VOIDED");
        assert((await followUpsOf(w.db, fOld)).length === 1, "VOIDED FollowUp on F_old");
        await assertFindingInvariants(w.db);
    });

    await ok("G5E-32: NEW target (observation source) + re-home + old VOID in one transaction", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const fOld = await insertFinding(w.db, visitId);
        const obsId = await insertObservation(w.db, visitId, "ملاحظة بصرية على الأسلاك", { findingId: fOld });
        const target: RehomeFindingTarget = {
            mode: "new",
            finding: { description: "أسلاك مكشوفة في الممر", urgency: "IMMEDIATE", impact: "HIGH" },
        };
        const res = await w.corr.rehomeLastSourceAndVoidFinding({
            findingId: fOld,
            source: { kind: "observation", observationId: obsId },
            target,
            event: voidEvent(),
        });
        assert(res.applied === true && res.createdFindingId !== null, "applied with a created target");
        const o = await obsRowOf(w.db, obsId);
        assert(Number(o.finding_id) === res.createdFindingId, "observation moved to the new target");
        const t = await findingRowOf(w.db, res.createdFindingId!);
        assert(Number(t.origin_visit_id) === visitId, "new target origin == the observation's visit");
        assert(String(t.description) === "أسلاك مكشوفة في الممر", "explicit data preserved");
        assert(await findingStatusOf(w.db, fOld) === "VOIDED", "F_old VOIDED");
        assert((await count(w.db, "SELECT count(*) AS c FROM finding")) === 2, "exactly F_old + one new target");
        await assertFindingInvariants(w.db);
    });

    await ok("G5E-33: injected failure rolls back the NEW target too", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const c6 = await cellOf(w.db, visitId, null, "CHK-006");
        const fOld = (await singleAnswerOk(w, c6, "CHK-006", "IRREGULAR", { note: "عطل", finding: newFindingSel(), actor: "inspector-a", now: NOW })).findingId!;
        let faulted = false;
        const inner = new FaultAdapter(w.db, (sql) => {
            if (sql.includes("UPDATE checklist_response") && sql.includes("SET finding_id")) {
                faulted = true;
                return true;
            }
            return false;
        });
        const corr = new CorrectionsService(inner);
        const target: RehomeFindingTarget = { mode: "new", finding: { description: "هدف جديد", urgency: "ROUTINE", impact: "LOW" } };
        await rejectsAny(async () =>
            corr.rehomeLastSourceAndVoidFinding({ findingId: fOld, source: { kind: "response", cell: c6 }, target, event: voidEvent() }),
        );
        assert(faulted, "fault injection must trigger on the guarded re-assignment");
        assert((await count(w.db, "SELECT count(*) AS c FROM finding")) === 1, "the NEW target vanished with the rollback");
        assert((await rowStateOf(w.db, await responseIdOf(w.db, c6))).findingId === fOld, "source still on F_old");
        assert(await findingStatusOf(w.db, fOld) === "OPEN", "F_old still OPEN");
        assert((await followUpsOf(w.db, fOld)).length === 0, "no FollowUp survived");
    });

    await ok("G5E-34: retry creates no second NEW target (durable source.finding_id converges)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const c6 = await cellOf(w.db, visitId, null, "CHK-006");
        const fOld = (await singleAnswerOk(w, c6, "CHK-006", "IRREGULAR", { note: "عطل", finding: newFindingSel(), actor: "inspector-a", now: NOW })).findingId!;
        const target: RehomeFindingTarget = { mode: "new", finding: { description: "هدف واحد فقط", urgency: "ROUTINE", impact: "LOW" } };
        const call = async () =>
            w.corr.rehomeLastSourceAndVoidFinding({ findingId: fOld, source: { kind: "response", cell: c6 }, target, event: voidEvent() });
        const first = await call();
        const again = await call();
        assert(first.applied === true && again.applied === false, "identical retry converges");
        assert(first.findingId === again.findingId && again.findingId !== null, "durable link identifies the created target");
        assert((await count(w.db, "SELECT count(*) AS c FROM finding")) === 2, "no second target Finding");
        assert((await followUpsOf(w.db, fOld)).length === 1, "no duplicate FollowUp");
        assert(await findingStatusOf(w.db, fOld) === "VOIDED", "F_old VOIDED");
    });
}

// ---------------------------------------------------------------------------
// S5 — SCHEDULE corrections
// ---------------------------------------------------------------------------
async function tS5_schedule(): Promise<void> {
    await ok("G5E-35: SCHEDULE correction replaces the reconciliation row set atomically with the overall", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const c12 = await cellOf(w.db, visitId, null, "CHK-012");
        const rid = await responseIdOf(w.db, c12);
        const c6 = await cellOf(w.db, visitId, null, "CHK-006");
        const rows: ReconciliationRowInput[] = [
            { category: "كراسي", declaredQty: 10, observedQty: 7, discrepancyType: "QTY_SHORTAGE", discrepancyDesc: "3 ناقصة" },
        ];
        const f = (await w.disp.answerSchedule({
            cell: c12,
            allowedValueId: await valueIdOf(w.db, "CHK-012", "MISMATCHED"),
            note: "فوارق في الجرد",
            rows,
            finding: newFindingSel(),
            actor: "inspector-a",
            now: NOW,
        })).findingId!;
        await singleAnswerOk(w, c6, "CHK-006", "IRREGULAR", { note: "ثانوي", finding: existingFindingSel(f), actor: "inspector-a", now: NOW });
        const res = await w.corr.correctSchedule({
            cell: c12,
            request: await answerReqWithRows(w.db, "CHK-012", "MATCHED", [{ category: "كراسي", declaredQty: 10, observedQty: 10 }]),
        });
        assert(res.applied === true, "schedule correction applied");
        const st = await rowStateOf(w.db, rid);
        assert(st.answeredValueId === await valueIdOf(w.db, "CHK-012", "MATCHED") && st.findingId === null, "overall MATCHED, link dropped");
        const durable = await reconRowsOf(w.db, rid);
        assert(durable.length === 1, "exactly one durable row (the corrected complete set)");
        assert(String(durable[0].category) === "كراسي" && Number(durable[0].difference) === 0 && durable[0].discrepancy_type === null, "row content replaced");
        assert(await findingStatusOf(w.db, f) === "OPEN", "F_old keeps its other source");
        assert((await findingSources(w.db, f)) === 1, "F_old source count");
        await assertFindingInvariants(w.db);
    });

    await ok("G5E-36: injected failure AFTER the row-set replacement rolls back rows + response together", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const c12 = await cellOf(w.db, visitId, null, "CHK-012");
        const rid = await responseIdOf(w.db, c12);
        const c6 = await cellOf(w.db, visitId, null, "CHK-006");
        const rows: ReconciliationRowInput[] = [
            { category: "أ", declaredQty: 10, observedQty: 7, discrepancyType: "QTY_SHORTAGE", discrepancyDesc: "3" },
            { category: "ب", declaredQty: 4, observedQty: 1, discrepancyType: "QTY_SHORTAGE", discrepancyDesc: "3" },
        ];
        const f = (await w.disp.answerSchedule({
            cell: c12,
            allowedValueId: await valueIdOf(w.db, "CHK-012", "MISMATCHED"),
            note: "فوارق",
            rows,
            finding: newFindingSel(),
            actor: "inspector-a",
            now: NOW,
        })).findingId!;
        await singleAnswerOk(w, c6, "CHK-006", "IRREGULAR", { note: "ثانوي", finding: existingFindingSel(f), actor: "inspector-a", now: NOW });
        // fault the OVERALL response update (after the old rows were deleted and
        // the corrected set inserted): everything must roll back
        let faulted = false;
        const inner = new FaultAdapter(w.db, (sql) => {
            if (sql.includes("UPDATE checklist_response") && sql.includes("SET answered_value_id")) {
                faulted = true;
                return true;
            }
            return false;
        });
        const corr = new CorrectionsService(inner);
        await rejectsAny(async () =>
            corr.correctSchedule({
                cell: c12,
                request: await answerReqWithRows(w.db, "CHK-012", "MATCHED", [{ category: "أ", declaredQty: 10, observedQty: 10 }]),
            }),
        );
        assert(faulted, "fault injection must trigger on the overall update");
        const st = await rowStateOf(w.db, rid);
        assert(st.answeredValueId === await valueIdOf(w.db, "CHK-012", "MISMATCHED") && st.findingId === f, "overall disposition restored");
        const durable = await reconRowsOf(w.db, rid);
        assert(durable.length === 2, "the ORIGINAL complete row set restored");
        assert(Number(durable[0].difference) === -3 && Number(durable[1].difference) === -3, "original row content restored");
        assert(await findingStatusOf(w.db, f) === "OPEN", "finding untouched");
    });

    await ok("G5E-36b: injected failure after the response change but before all new rows restores the old complete set", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const c12 = await cellOf(w.db, visitId, null, "CHK-012");
        const rid = await responseIdOf(w.db, c12);
        const c6 = await cellOf(w.db, visitId, null, "CHK-006");
        const rows: ReconciliationRowInput[] = [
            { category: "أ", declaredQty: 10, observedQty: 7, discrepancyType: "QTY_SHORTAGE" },
        ];
        const f = (await w.disp.answerSchedule({
            cell: c12,
            allowedValueId: await valueIdOf(w.db, "CHK-012", "MISMATCHED"),
            note: "فوارق",
            rows,
            finding: newFindingSel(),
            actor: "inspector-a",
            now: NOW,
        })).findingId!;
        await singleAnswerOk(w, c6, "CHK-006", "IRREGULAR", { note: "ثانوي", finding: existingFindingSel(f), actor: "inspector-a", now: NOW });
        // NC target: overall changes FIRST, then the old rows are deleted and the
        // corrected set inserted — fault the 2nd INSERT
        let seen = 0;
        let faulted = false;
        const inner = new FaultAdapter(w.db, (sql) => {
            if (sql.includes("INSERT INTO equipment_reconciliation_row")) {
                seen += 1;
                if (seen === 2) {
                    faulted = true;
                    return true;
                }
            }
            return false;
        });
        const corr = new CorrectionsService(inner);
        await rejectsAny(async () =>
            corr.correctSchedule({
                cell: c12,
                request: await answerReqWithRows(w.db, "CHK-012", "MISMATCHED", [
                    { category: "أ", declaredQty: 10, observedQty: 8, discrepancyType: "QTY_SHORTAGE" },
                    { category: "ب", declaredQty: 5, observedQty: 5 },
                ], "فوارق معدلة"),
                finding: existingFindingSel(f),
                actor: "inspector-a",
                now: NOW,
            }),
        );
        assert(faulted && seen === 2, "fault injection must trigger on the 2nd corrected row");
        const st = await rowStateOf(w.db, rid);
        assert(st.answeredValueId === await valueIdOf(w.db, "CHK-012", "MISMATCHED") && st.note === "فوارق", "overall response restored");
        const durable = await reconRowsOf(w.db, rid);
        assert(durable.length === 1 && Number(durable[0].difference) === -3, "the ORIGINAL row set restored");
        assert(await findingStatusOf(w.db, f) === "OPEN", "finding untouched");
    });

    await ok("G5E-53: SCHEDULE correction shrinks the row set (3 old rows -> 1 corrected row)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const c12 = await cellOf(w.db, visitId, null, "CHK-012");
        const rid = await responseIdOf(w.db, c12);
        const c6 = await cellOf(w.db, visitId, null, "CHK-006");
        const rows: ReconciliationRowInput[] = [
            { category: "أ", declaredQty: 10, observedQty: 7, discrepancyType: "QTY_SHORTAGE" },
            { category: "ب", declaredQty: 4, observedQty: 1, discrepancyType: "QTY_SHORTAGE" },
            { category: "ج", declaredQty: 5, observedQty: 5 },
        ];
        const f = (await w.disp.answerSchedule({
            cell: c12,
            allowedValueId: await valueIdOf(w.db, "CHK-012", "MISMATCHED"),
            note: "فوارق",
            rows,
            finding: newFindingSel(),
            actor: "inspector-a",
            now: NOW,
        })).findingId!;
        await singleAnswerOk(w, c6, "CHK-006", "IRREGULAR", { note: "ثانوي", finding: existingFindingSel(f), actor: "inspector-a", now: NOW });
        const res = await w.corr.correctSchedule({
            cell: c12,
            request: await answerReqWithRows(w.db, "CHK-012", "MATCHED", [{ category: "أ", declaredQty: 10, observedQty: 10 }]),
        });
        assert(res.applied === true, "shrinking correction applied");
        const durable = await reconRowsOf(w.db, rid);
        assert(durable.length === 1, "exactly ONE row remains (no stale rows)");
        assert(String(durable[0].category) === "أ" && Number(durable[0].difference) === 0, "corrected content");
        const st = await rowStateOf(w.db, rid);
        assert(st.answeredValueId === await valueIdOf(w.db, "CHK-012", "MATCHED") && st.findingId === null, "overall MATCHED");
        assert(await findingStatusOf(w.db, f) === "OPEN" && (await findingSources(w.db, f)) === 1, "F_old keeps its other source");
        await assertFindingInvariants(w.db);
    });

    await ok("G5E-54: SCHEDULE correction grows the row set (1 old row -> 3 corrected rows)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const c12 = await cellOf(w.db, visitId, null, "CHK-012");
        const rid = await responseIdOf(w.db, c12);
        await w.disp.answerSchedule({
            cell: c12,
            allowedValueId: await valueIdOf(w.db, "CHK-012", "MATCHED"),
            rows: [{ category: "أ", declaredQty: 10, observedQty: 10 }],
        });
        const res = await w.corr.correctSchedule({
            cell: c12,
            request: await answerReqWithRows(w.db, "CHK-012", "MISMATCHED", [
                { category: "أ", declaredQty: 10, observedQty: 8, discrepancyType: "QTY_SHORTAGE" },
                { category: "ب", declaredQty: 4, observedQty: 4 },
                { category: "ج", declaredQty: 6, observedQty: 9, discrepancyType: "QTY_EXCESS" },
            ], "فوارق جديدة"),
            finding: newFindingSel(),
            actor: "inspector-a",
            now: NOW,
        });
        assert(res.applied === true, "growing correction applied");
        const durable = await reconRowsOf(w.db, rid);
        assert(durable.length === 3, "exactly THREE rows (complete corrected set)");
        assert(Number(durable[0].difference) === -2 && Number(durable[2].difference) === 3, "corrected contents");
        await assertFindingInvariants(w.db);
    });

    await ok("G5E-55: SCHEDULE correction replaces same-size content (3 -> 3, different values)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const c12 = await cellOf(w.db, visitId, null, "CHK-012");
        const rid = await responseIdOf(w.db, c12);
        const c6 = await cellOf(w.db, visitId, null, "CHK-006");
        const rows: ReconciliationRowInput[] = [
            { category: "أ", declaredQty: 10, observedQty: 7, discrepancyType: "QTY_SHORTAGE" },
            { category: "ب", declaredQty: 4, observedQty: 4 },
            { category: "ج", declaredQty: 5, observedQty: 5 },
        ];
        const f = (await w.disp.answerSchedule({
            cell: c12,
            allowedValueId: await valueIdOf(w.db, "CHK-012", "MISMATCHED"),
            note: "فوارق",
            rows,
            finding: newFindingSel(),
            actor: "inspector-a",
            now: NOW,
        })).findingId!;
        await singleAnswerOk(w, c6, "CHK-006", "IRREGULAR", { note: "ثانوي", finding: existingFindingSel(f), actor: "inspector-a", now: NOW });
        const res = await w.corr.correctSchedule({
            cell: c12,
            request: await answerReqWithRows(w.db, "CHK-012", "MISMATCHED", [
                { category: "أ", declaredQty: 10, observedQty: 8, discrepancyType: "QTY_SHORTAGE" },
                { category: "ب", declaredQty: 4, observedQty: 4 },
                { category: "ج", declaredQty: 5, observedQty: 6, discrepancyType: "QTY_EXCESS" },
            ], "فوارق معدلة"),
            finding: existingFindingSel(f),
            actor: "inspector-a",
            now: NOW,
        });
        assert(res.applied === true, "same-size replacement applied");
        const durable = await reconRowsOf(w.db, rid);
        assert(durable.length === 3 && Number(durable[0].difference) === -2 && Number(durable[2].difference) === 1, "new contents in place");
        const st = await rowStateOf(w.db, rid);
        assert(st.note === "فوارق معدلة", "overall note replaced");
    });

    await ok("G5E-56: a rowed SCHEDULE answer -> deliberate NOT_INSPECTED(reason) leaves ZERO rows", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const c12 = await cellOf(w.db, visitId, null, "CHK-012");
        const rid = await responseIdOf(w.db, c12);
        const c6 = await cellOf(w.db, visitId, null, "CHK-006");
        const f = (await w.disp.answerSchedule({
            cell: c12,
            allowedValueId: await valueIdOf(w.db, "CHK-012", "MISMATCHED"),
            note: "فوارق",
            rows: [
                { category: "أ", declaredQty: 10, observedQty: 7, discrepancyType: "QTY_SHORTAGE" },
                { category: "ب", declaredQty: 4, observedQty: 1, discrepancyType: "QTY_SHORTAGE" },
            ],
            finding: newFindingSel(),
            actor: "inspector-a",
            now: NOW,
        })).findingId!;
        await singleAnswerOk(w, c6, "CHK-006", "IRREGULAR", { note: "ثانوي", finding: existingFindingSel(f), actor: "inspector-a", now: NOW });
        const res = await w.corr.correctSchedule({ cell: c12, request: notInspectedReq("تعذر إتمام المطابقة لاحقاً") });
        assert(res.applied === true, "rowed answer -> NOT_INSPECTED correction applied");
        const st = await rowStateOf(w.db, rid);
        assert(st.overlayState === "NOT_INSPECTED" && st.notInspectedReason === "تعذر إتمام المطابقة لاحقاً", "overlay state");
        assert(st.answeredValueId === null && st.findingId === null, "no answer / no finding link");
        assert((await count(w.db, "SELECT count(*) AS c FROM equipment_reconciliation_row WHERE response_id = ?", [rid])) === 0, "ZERO rows remain");
        assert(await findingStatusOf(w.db, f) === "OPEN" && (await findingSources(w.db, f)) === 1, "F_old keeps its other source");
        await assertFindingInvariants(w.db);
    });

    await ok("G5E-57: identical corrected SCHEDULE retry converges; a different payload applies as a NEW correction", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const c12 = await cellOf(w.db, visitId, null, "CHK-012");
        const rid = await responseIdOf(w.db, c12);
        const c6 = await cellOf(w.db, visitId, null, "CHK-006");
        const rows: ReconciliationRowInput[] = [
            { category: "أ", declaredQty: 10, observedQty: 7, discrepancyType: "QTY_SHORTAGE" },
            { category: "ب", declaredQty: 4, observedQty: 1, discrepancyType: "QTY_SHORTAGE" },
        ];
        const f = (await w.disp.answerSchedule({
            cell: c12,
            allowedValueId: await valueIdOf(w.db, "CHK-012", "MISMATCHED"),
            note: "فوارق",
            rows,
            finding: newFindingSel(),
            actor: "inspector-a",
            now: NOW,
        })).findingId!;
        await singleAnswerOk(w, c6, "CHK-006", "IRREGULAR", { note: "ثانوي", finding: existingFindingSel(f), actor: "inspector-a", now: NOW });
        const req = await answerReqWithRows(w.db, "CHK-012", "MATCHED", [{ category: "أ", declaredQty: 10, observedQty: 10 }]);
        const first = await w.corr.correctSchedule({ cell: c12, request: req });
        const again = await w.corr.correctSchedule({ cell: c12, request: req });
        assert(first.applied === true && again.applied === false, "identical corrected retry converges");
        assert((await count(w.db, "SELECT count(*) AS c FROM equipment_reconciliation_row WHERE response_id = ?", [rid])) === 1, "no duplicate rows");
        // a DIFFERENT corrected payload is a new correction, never a silent
        // no-op convergence on stale content
        const different = await w.corr.correctSchedule({
            cell: c12,
            request: await answerReqWithRows(w.db, "CHK-012", "MISMATCHED", [
                { category: "أ", declaredQty: 10, observedQty: 9, discrepancyType: "QTY_SHORTAGE" },
            ], "مصحح مرة أخرى"),
            finding: existingFindingSel(f),
            actor: "inspector-a",
            now: NOW,
        });
        assert(different.applied === true, "conflicting payload applies as a NEW correction, never converges silently");
        const durable = await reconRowsOf(w.db, rid);
        assert(durable.length === 1 && Number(durable[0].difference) === -1, "durable reflects the latest corrected set");
        await assertFindingInvariants(w.db);
    });

    await ok("G5E-37a: NC SCHEDULE last source refuses an ordinary MATCHED correction (E_LAST_SOURCE)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const c12 = await cellOf(w.db, visitId, null, "CHK-012");
        const f = (await w.disp.answerSchedule({
            cell: c12,
            allowedValueId: await valueIdOf(w.db, "CHK-012", "MISMATCHED"),
            note: "فوارق",
            rows: [{ category: "أ", declaredQty: 10, observedQty: 7, discrepancyType: "QTY_SHORTAGE" }],
            finding: newFindingSel(),
            actor: "inspector-a",
            now: NOW,
        })).findingId!;
        const e = await rejectsCode(APP_ERR.LAST_SOURCE, async () =>
            w.corr.correctSchedule({
                cell: c12,
                request: await answerReqWithRows(w.db, "CHK-012", "MATCHED", [{ category: "أ", declaredQty: 10, observedQty: 10 }]),
            }),
        );
        assert(e.message.includes("T6-VOID"), `message routes to the dedicated op: ${e.message}`);
        assert(await findingStatusOf(w.db, f) === "OPEN", "F_old untouched");
    });

    await ok("G5E-37b: T6-VOID terminal correction of a SCHEDULE source (rows replaced, F VOIDED)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const c12 = await cellOf(w.db, visitId, null, "CHK-012");
        const rid = await responseIdOf(w.db, c12);
        const f = (await w.disp.answerSchedule({
            cell: c12,
            allowedValueId: await valueIdOf(w.db, "CHK-012", "MISMATCHED"),
            note: "فوارق",
            rows: [{ category: "أ", declaredQty: 10, observedQty: 7, discrepancyType: "QTY_SHORTAGE", discrepancyDesc: "3" }],
            finding: newFindingSel(),
            actor: "inspector-a",
            now: NOW,
        })).findingId!;
        const res = await w.corr.voidOpenFindingByLastSourceCorrection({
            findingId: f,
            correction: {
                kind: "response",
                cell: c12,
                request: await answerReqWithRows(w.db, "CHK-012", "MATCHED", [{ category: "أ", declaredQty: 10, observedQty: 10 }]),
            },
            event: voidEvent(),
        });
        assert(res.applied === true, "schedule-source VOID applied");
        const st = await rowStateOf(w.db, rid);
        assert(st.answeredValueId === await valueIdOf(w.db, "CHK-012", "MATCHED") && st.findingId === null, "overall MATCHED");
        const durable = await reconRowsOf(w.db, rid);
        assert(durable.length === 1 && Number(durable[0].difference) === 0, "rows replaced by the zero-difference set");
        assert(await findingStatusOf(w.db, f) === "VOIDED", "F_old VOIDED");
        assert((await followUpsOf(w.db, f)).length === 1, "FollowUp recorded");
        await assertFindingInvariants(w.db);
    });

    await ok("G5E-37c: T6-REHOME of a SCHEDULE source keeps its reconciliation rows untouched", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const c12 = await cellOf(w.db, visitId, null, "CHK-012");
        const rid = await responseIdOf(w.db, c12);
        const fOld = (await w.disp.answerSchedule({
            cell: c12,
            allowedValueId: await valueIdOf(w.db, "CHK-012", "MISMATCHED"),
            note: "فوارق",
            rows: [{ category: "أ", declaredQty: 10, observedQty: 7, discrepancyType: "QTY_SHORTAGE", discrepancyDesc: "3" }],
            finding: newFindingSel(),
            actor: "inspector-a",
            now: NOW,
        })).findingId!;
        const c10 = await cellOf(w.db, visitId, null, "CHK-010");
        const fTarget = (await singleAnswerOk(w, c10, "CHK-010", "NOT_AVAILABLE", { note: "هدف", finding: newFindingSel(), actor: "inspector-a", now: NOW })).findingId!;
        const res = await w.corr.rehomeLastSourceAndVoidFinding({
            findingId: fOld,
            source: { kind: "response", cell: c12 },
            target: { mode: "existing", findingId: fTarget, coversSameIssueConfirmed: true },
            event: voidEvent(),
        });
        assert(res.applied === true, "schedule source re-homed");
        const st = await rowStateOf(w.db, rid);
        assert(st.findingId === fTarget, "link moved (the NC schedule answer stays valid)");
        const durable = await reconRowsOf(w.db, rid);
        assert(durable.length === 1 && Number(durable[0].difference) === -3, "reconciliation rows untouched by the re-home");
        assert(await findingStatusOf(w.db, fOld) === "VOIDED", "F_old VOIDED");
        await assertFindingInvariants(w.db);
    });
}

// ---------------------------------------------------------------------------
// S6 — cross-cutting + extras
// ---------------------------------------------------------------------------
async function tS6_crossCutting(): Promise<void> {
    await ok("G5E-38: no committed source-less OPEN Finding after any tested path (sweep)", async () => {
        // a mixed world: ordinary detach + T6-REHOME (obs) + T6-VOID +
        // refused / fault-injected operations — then sweep the invariants
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        // (1) ordinary NC detach while F1 keeps an observation source
        const c6 = await cellOf(w.db, visitId, null, "CHK-006");
        const f1 = (await singleAnswerOk(w, c6, "CHK-006", "IRREGULAR", { note: "1", finding: newFindingSel(), actor: "inspector-a", now: NOW })).findingId!;
        const o1 = await insertObservation(w.db, visitId, "مصدر ثان", { findingId: f1 });
        await w.corr.correctSingle({ cell: c6, request: await answerReq(w.db, "CHK-006", "REGULAR") });
        // (2) T6-REHOME: the observation becomes F1's last source -> existing F2, F1 VOIDED
        const f2 = await insertFinding(w.db, visitId);
        await insertObservation(w.db, visitId, "وحيد على F2", { findingId: f2 });
        const r2 = await w.corr.rehomeLastSourceAndVoidFinding({
            findingId: f1,
            source: { kind: "observation", observationId: o1 },
            target: { mode: "existing", findingId: f2, coversSameIssueConfirmed: true },
            event: voidEvent(),
        });
        assert(r2.applied === true, "obs re-home+VOID applied");
        // (3) T6-VOID refusal while a CorrectiveAction exists (nothing changes)
        const c7 = await cellOf(w.db, visitId, null, "CHK-007");
        const f3 = (await singleAnswerOk(w, c7, "CHK-007", "IRREGULAR", { note: "3", finding: newFindingSel(), actor: "inspector-a", now: NOW })).findingId!;
        await insertAction(w.db, f3);
        await rejectsCode(APP_ERR.VOID_HAS_ACTIONS, async () =>
            w.corr.voidOpenFindingByLastSourceCorrection({
                findingId: f3,
                correction: { kind: "response", cell: c7, request: await answerReq(w.db, "CHK-007", "REGULAR") },
                event: voidEvent(),
            }),
        );
        // (4) injected failure mid T6-REHOME (NEW target rolled back too)
        const c10 = await cellOf(w.db, visitId, null, "CHK-010");
        const f4 = (await singleAnswerOk(w, c10, "CHK-010", "NOT_AVAILABLE", { note: "4", finding: newFindingSel(), actor: "inspector-a", now: NOW })).findingId!;
        const inner = new FaultAdapter(w.db, (sql) => sql.includes("UPDATE checklist_response") && sql.includes("SET finding_id"));
        const corr = new CorrectionsService(inner);
        await rejectsAny(async () =>
            corr.rehomeLastSourceAndVoidFinding({
                findingId: f4,
                source: { kind: "response", cell: c10 },
                target: { mode: "new", finding: { description: "لا يظهر", urgency: "ROUTINE", impact: "LOW" } },
                event: voidEvent(),
            }),
        );
        await assertFindingInvariants(w.db);
        assert((await findingSources(w.db, f2)) === 2, "F2 holds o1 + o2");
        assert((await findingSources(w.db, f3)) === 1 && (await findingSources(w.db, f4)) === 1, "OPEN findings keep sources");
        const voidedRows = await w.db.query("SELECT finding_id FROM finding WHERE status = 'VOIDED'");
        assert(voidedRows.length === 1 && Number(voidedRows[0].finding_id) === f1, "exactly F1 VOIDED");
    });

    await ok("G5E-39: every VOIDED Finding has zero sources (and the schema refuses a raw relink)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const c6 = await cellOf(w.db, visitId, null, "CHK-006");
        const f1 = (await singleAnswerOk(w, c6, "CHK-006", "IRREGULAR", { note: "عطل", finding: newFindingSel(), actor: "inspector-a", now: NOW })).findingId!;
        await w.corr.voidOpenFindingByLastSourceCorrection({
            findingId: f1,
            correction: { kind: "response", cell: c6, request: await answerReq(w.db, "CHK-006", "REGULAR") },
            event: voidEvent(),
        });
        const f2 = await insertFinding(w.db, visitId);
        await voidFindingRaw(w.db, f2);
        const voided = await w.db.query("SELECT finding_id FROM finding WHERE status = 'VOIDED'");
        assert(voided.length === 2, "two VOIDED findings in the world");
        for (const v of voided) {
            assert((await findingSources(w.db, Number(v.finding_id))) === 0, `VOIDED ${v.finding_id} has zero sources`);
        }
        // schema backstop: even a raw link onto a VOIDED finding is refused
        const pending = await cellOf(w.db, visitId, null, "CHK-011");
        const rid = await responseIdOf(w.db, pending);
        await rejectsAny(async () =>
            w.db.run(
                "UPDATE checklist_response SET finding_id = ? WHERE response_id = ?",
                [Number(voided[0].finding_id), rid],
            ),
        );
    });

    await ok("G5E-40: a VOIDED Finding can never receive a source through the correction service", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const voidedTarget = await insertFinding(w.db, visitId);
        await voidFindingRaw(w.db, voidedTarget);
        // (a) an NC correction cannot link the VOIDED finding
        const c7 = await cellOf(w.db, visitId, null, "CHK-007");
        const rid7 = await responseIdOf(w.db, c7);
        await singleAnswerOk(w, c7, "CHK-007", "REGULAR");
        const e = await rejectsCode(APP_ERR.FINDING_TARGET_INVALID, async () =>
            w.corr.correctSingle({
                cell: c7,
                request: await answerReq(w.db, "CHK-007", "IRREGULAR", "ملاحظة"),
                finding: existingFindingSel(voidedTarget),
            }),
        );
        assert(e.message.includes("VOIDED"), `message names VOIDED: ${e.message}`);
        assert((await rowStateOf(w.db, rid7)).answeredValueId === await valueIdOf(w.db, "CHK-007", "REGULAR"), "cell untouched");
        // (b) a re-home cannot move a source onto the VOIDED finding
        const c6 = await cellOf(w.db, visitId, null, "CHK-006");
        const fOld = (await singleAnswerOk(w, c6, "CHK-006", "IRREGULAR", { note: "عطل", finding: newFindingSel(), actor: "inspector-a", now: NOW })).findingId!;
        // ordinary re-home needs F_old to keep >= 1 other source
        const c10 = await cellOf(w.db, visitId, null, "CHK-010");
        await singleAnswerOk(w, c10, "CHK-010", "NOT_AVAILABLE", { note: "ثان", finding: existingFindingSel(fOld), actor: "inspector-a", now: NOW });
        await rejectsCode(APP_ERR.FINDING_TARGET_INVALID, async () =>
            w.corr.rehomeSource({ source: { kind: "response", cell: c6 }, target: { mode: "existing", findingId: voidedTarget, coversSameIssueConfirmed: true } }),
        );
        // last-source re-home+VOID onto the VOIDED target (F2 is a single-source OPEN finding)
        const c11 = await cellOf(w.db, visitId, null, "CHK-011");
        const f2 = (await singleAnswerOk(w, c11, "CHK-011", "FAULTS_PRESENT", { note: "وحيد", finding: newFindingSel(), actor: "inspector-a", now: NOW })).findingId!;
        await rejectsCode(APP_ERR.FINDING_TARGET_INVALID, async () =>
            w.corr.rehomeLastSourceAndVoidFinding({
                findingId: f2,
                source: { kind: "response", cell: c11 },
                target: { mode: "existing", findingId: voidedTarget, coversSameIssueConfirmed: true },
                event: voidEvent(),
            }),
        );
        assert((await findingSources(w.db, voidedTarget)) === 0, "VOIDED still source-less");
    });

    await ok("G5E-41: production application core imports no node:* module", async () => {
        const files = ["errors.ts", "applicability.ts", "visit-scope.ts", "initial-disposition.ts", "corrections.ts"].map((f) =>
            join(ROOT, "src", "application", f),
        );
        for (const file of files) {
            const text = readFileSync(file, "utf8");
            const m = /(?:from\s+|require\()\s*["']node:/.exec(text);
            assert(m === null, `${file} imports a node:* module: ${m ? m[0] : ""}`);
            assert(!/node:sqlite/.test(text), `${file} must not reference node:sqlite`);
            assert(!/node-sqlite-adapter/.test(text), `${file} must not import the dev/test adapter`);
        }
    });

    // ---- extra cases beyond the numbered map ------------------------------

    await ok("G5E-42: observation retraction with an explicit text correction (adopted shape D)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const f = await insertFinding(w.db, visitId);
        const obsId = await insertObservation(w.db, visitId, "تسرب كبير من السقف", { findingId: f });
        const corrected = "تسرب محدود من النافذة (تصحيح الوصف مع السحب)";
        const res = await w.corr.voidOpenFindingByLastSourceCorrection({
            findingId: f,
            correction: { kind: "observation", observationId: obsId, correctedText: corrected },
            event: voidEvent(),
        });
        assert(res.applied === true, "applied");
        const o = await obsRowOf(w.db, obsId);
        assert(o.finding_id === null, "observation retracted");
        assert(String(o.text) === corrected, "explicitly requested text correction applied");
        assert(await findingStatusOf(w.db, f) === "VOIDED", "F_old VOIDED");
    });

    await ok("G5E-43: ordinary re-home of an observation with an explicit text ride-along", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const c6 = await cellOf(w.db, visitId, null, "CHK-006");
        const fOld = (await singleAnswerOk(w, c6, "CHK-006", "IRREGULAR", { note: "عطل", finding: newFindingSel(), actor: "inspector-a", now: NOW })).findingId!;
        const obsId = await insertObservation(w.db, visitId, "نص أولي", { findingId: fOld });
        const c10 = await cellOf(w.db, visitId, null, "CHK-010");
        const fTarget = (await singleAnswerOk(w, c10, "CHK-010", "NOT_AVAILABLE", { note: "هدف", finding: newFindingSel(), actor: "inspector-a", now: NOW })).findingId!;
        const corrected = "نص مصحح بعد إعادة المعاينة";
        const res = await w.corr.rehomeSource({
            source: { kind: "observation", observationId: obsId, correctedText: corrected },
            target: { mode: "existing", findingId: fTarget, coversSameIssueConfirmed: true },
        });
        assert(res.applied === true, "applied");
        const o = await obsRowOf(w.db, obsId);
        assert(Number(o.finding_id) === fTarget && String(o.text) === corrected, "observation moved and text corrected");
        assert(await findingStatusOf(w.db, fOld) === "OPEN", "F_old keeps its response source");
        assert((await findingSources(w.db, fOld)) === 1, "F_old source count");
    });

    await ok("G5E-44a: observation subject ride-along must match the target subject (E_CONTEXT)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const wsA = await addWorkshopSubject(w, visitId, "WS-A");
        const wsB = await addWorkshopSubject(w, visitId, "WS-B");
        const cA = await cellOf(w.db, visitId, wsA, "CHK-006");
        const fOld = (await singleAnswerOk(w, cA, "CHK-006", "IRREGULAR", { note: "عطل أ", finding: newFindingSel(), actor: "inspector-a", now: NOW })).findingId!;
        const obsId = await insertObservation(w.db, visitId, "ملاحظة على أ", { subjectId: wsA, findingId: fOld });
        const cB = await cellOf(w.db, visitId, wsB, "CHK-006");
        const fB = (await singleAnswerOk(w, cB, "CHK-006", "IRREGULAR", { note: "عطل ب", finding: newFindingSel(), actor: "inspector-a", now: NOW })).findingId!;
        await rejectsCode(APP_ERR.CONTEXT, async () =>
            w.corr.rehomeSource({
                source: { kind: "observation", observationId: obsId },
                target: { mode: "existing", findingId: fB, coversSameIssueConfirmed: true },
            }),
        );
    });

    await ok("G5E-44b: explicit subject correction rides along and makes the re-home legal", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const wsA = await addWorkshopSubject(w, visitId, "WS-A");
        const wsB = await addWorkshopSubject(w, visitId, "WS-B");
        const cA = await cellOf(w.db, visitId, wsA, "CHK-006");
        const fOld = (await singleAnswerOk(w, cA, "CHK-006", "IRREGULAR", { note: "عطل أ", finding: newFindingSel(), actor: "inspector-a", now: NOW })).findingId!;
        const obsId = await insertObservation(w.db, visitId, "ملاحظة على أ", { subjectId: wsA, findingId: fOld });
        const cB = await cellOf(w.db, visitId, wsB, "CHK-006");
        const fB = (await singleAnswerOk(w, cB, "CHK-006", "IRREGULAR", { note: "عطل ب", finding: newFindingSel(), actor: "inspector-a", now: NOW })).findingId!;
        const res = await w.corr.rehomeSource({
            source: { kind: "observation", observationId: obsId, correctedSubjectId: wsB },
            target: { mode: "existing", findingId: fB, coversSameIssueConfirmed: true },
        });
        assert(res.applied === true, "re-home with corrected subject applied");
        const o = await obsRowOf(w.db, obsId);
        assert(Number(o.finding_id) === fB && Number(o.subject_id) === wsB, "observation now on subject B / finding B");
        assert(await findingStatusOf(w.db, fOld) === "OPEN", "F_old keeps its response source");
        await rejectsCode(APP_ERR.CONFIG, async () =>
            w.corr.rehomeSource({
                source: { kind: "observation", observationId: obsId, correctedSubjectId: 999999 },
                target: { mode: "existing", findingId: fB, coversSameIssueConfirmed: true },
            }),
        );
    });

    await ok("G5E-45: SCHEDULE COMPLIANT -> NON_COMPLIANT correction (row set grows atomically)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const c12 = await cellOf(w.db, visitId, null, "CHK-012");
        const rid = await responseIdOf(w.db, c12);
        await w.disp.answerSchedule({ cell: c12, allowedValueId: await valueIdOf(w.db, "CHK-012", "MATCHED"), rows: [] });
        const res = await w.corr.correctSchedule({
            cell: c12,
            request: await answerReqWithRows(w.db, "CHK-012", "MISMATCHED", [
                { category: "طاولات", declaredQty: 5, observedQty: 3, discrepancyType: "QTY_SHORTAGE", discrepancyDesc: "2" },
            ], "فوارق جديدة"),
            finding: newFindingSel(),
            actor: "inspector-a",
            now: NOW,
        });
        assert(res.applied === true && res.findingId !== null, "corrected to MISMATCHED with accountability");
        const st = await rowStateOf(w.db, rid);
        assert(st.answeredValueId === await valueIdOf(w.db, "CHK-012", "MISMATCHED"), "overall MISMATCHED");
        assert(st.note === "فوارق جديدة", "note replaced");
        const durable = await reconRowsOf(w.db, rid);
        assert(durable.length === 1 && Number(durable[0].difference) === -2, "row set inserted with the NC overall");
        const fr = await findingRowOf(w.db, res.findingId!);
        assert(Number(fr.origin_visit_id) === visitId && String(fr.status) === "OPEN", "new finding atomic");
        await assertFindingInvariants(w.db);
    });

    await ok("G5E-46: identical ordinary-correction retry converges (no second Finding)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const c6 = await cellOf(w.db, visitId, null, "CHK-006");
        const rid = await responseIdOf(w.db, c6);
        await singleAnswerOk(w, c6, "CHK-006", "REGULAR");
        const req = await answerReq(w.db, "CHK-006", "IRREGULAR", "أصبح معطلاً");
        const call = async () =>
            w.corr.correctSingle({ cell: c6, request: req, finding: newFindingSel(), actor: "inspector-a", now: NOW });
        const first = await call();
        const again = await call();
        assert(first.applied === true && again.applied === false, "identical retry converges");
        assert(again.findingId === first.findingId && first.findingId !== null, "durable finding returned");
        assert((await count(w.db, "SELECT count(*) AS c FROM finding")) === 1, "no second Finding");
        assert((await rowStateOf(w.db, rid)).note === "أصبح معطلاً", "note stable");
    });

    await ok("G5E-47: a conflicting correction retry never silently succeeds (E_LAST_SOURCE)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const c6 = await cellOf(w.db, visitId, null, "CHK-006");
        const rid = await responseIdOf(w.db, c6);
        await singleAnswerOk(w, c6, "CHK-006", "REGULAR");
        const first = await w.corr.correctSingle({
            cell: c6,
            request: await answerReq(w.db, "CHK-006", "IRREGULAR", "أصبح معطلاً"),
            finding: newFindingSel(),
            actor: "inspector-a",
            now: NOW,
        });
        // a DIFFERENT retry payload would detach F's last source -> refused
        const e = await rejectsCode(APP_ERR.LAST_SOURCE, async () =>
            w.corr.correctSingle({
                cell: c6,
                request: await answerReq(w.db, "CHK-006", "IRREGULAR", "نص مختلف"),
                finding: newFindingSel(),
                actor: "inspector-a",
                now: NOW,
            }),
        );
        assert(e.message.includes("T6-REHOME") || e.message.includes("T6-VOID"), `message routes to the dedicated branch: ${e.message}`);
        const st = await rowStateOf(w.db, rid);
        assert(st.note === "أصبح معطلاً" && st.findingId === first.findingId, "durable state unchanged by the refused conflict");
        assert((await count(w.db, "SELECT count(*) AS c FROM finding")) === 1, "no second Finding");
    });

    await ok("G5E-48: TOCTOU — existing target resolved right before BEGIN IMMEDIATE is rejected in-tx", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const c7 = await cellOf(w.db, visitId, null, "CHK-007");
        const rid7 = await responseIdOf(w.db, c7);
        await singleAnswerOk(w, c7, "CHK-007", "REGULAR");
        const c10 = await cellOf(w.db, visitId, null, "CHK-010");
        const fTarget = (await singleAnswerOk(w, c10, "CHK-010", "NOT_AVAILABLE", { note: "هدف", finding: newFindingSel(), actor: "inspector-a", now: NOW })).findingId!;
        const hook = new BeginHookAdapter(w.db, async () => {
            await w.db.run("UPDATE finding SET status = 'RESOLVED', status_changed_at = ? WHERE finding_id = ? AND status = 'OPEN'", [
                NOW,
                fTarget,
            ]);
        });
        const corr = new CorrectionsService(hook);
        await rejectsCode(APP_ERR.FINDING_TARGET_INVALID, async () =>
            corr.correctSingle({
                cell: c7,
                request: await answerReq(w.db, "CHK-007", "IRREGULAR", "ملاحظة"),
                finding: existingFindingSel(fTarget),
            }),
        );
        const st = await rowStateOf(w.db, rid7);
        assert(st.answeredValueId === await valueIdOf(w.db, "CHK-007", "REGULAR"), "cell stays REGULAR");
        assert((await findingSources(w.db, fTarget)) === 1, "no new source attached after the TOCTOU rejection");
    });

    await ok("G5E-49: T6-VOID refuses a source that is not F_old's last (ordinary correction applies)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const c6 = await cellOf(w.db, visitId, null, "CHK-006");
        const c7 = await cellOf(w.db, visitId, null, "CHK-007");
        const f = (await singleAnswerOk(w, c6, "CHK-006", "IRREGULAR", { note: "1", finding: newFindingSel(), actor: "inspector-a", now: NOW })).findingId!;
        await singleAnswerOk(w, c7, "CHK-007", "IRREGULAR", { note: "2", finding: existingFindingSel(f), actor: "inspector-a", now: NOW });
        const e = await rejectsCode(APP_ERR.LAST_SOURCE, async () =>
            w.corr.voidOpenFindingByLastSourceCorrection({
                findingId: f,
                correction: { kind: "response", cell: c6, request: await answerReq(w.db, "CHK-006", "REGULAR") },
                event: voidEvent(),
            }),
        );
        assert(e.message.includes("2 source"), `message reports the count: ${e.message}`);
        assert(await findingStatusOf(w.db, f) === "OPEN", "F_old stays OPEN (ordinary correction applies, never void)");
    });

    await ok("G5E-50: ordinary re-home retry converges idempotently", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const c6 = await cellOf(w.db, visitId, null, "CHK-006");
        const fOld = (await singleAnswerOk(w, c6, "CHK-006", "IRREGULAR", { note: "عطل", finding: newFindingSel(), actor: "inspector-a", now: NOW })).findingId!;
        const c7 = await cellOf(w.db, visitId, null, "CHK-007");
        await singleAnswerOk(w, c7, "CHK-007", "IRREGULAR", { note: "ثان", finding: existingFindingSel(fOld), actor: "inspector-a", now: NOW });
        const c10 = await cellOf(w.db, visitId, null, "CHK-010");
        const fTarget = (await singleAnswerOk(w, c10, "CHK-010", "NOT_AVAILABLE", { note: "هدف", finding: newFindingSel(), actor: "inspector-a", now: NOW })).findingId!;
        const call = async () =>
            w.corr.rehomeSource({ source: { kind: "response", cell: c6 }, target: { mode: "existing", findingId: fTarget, coversSameIssueConfirmed: true } });
        const first = await call();
        const again = await call();
        assert(first.applied === true && again.applied === false, "identical re-home retry converges");
        assert((await findingSources(w.db, fOld)) === 1 && (await findingSources(w.db, fTarget)) === 2, "links stable");
        assert((await count(w.db, "SELECT count(*) AS c FROM finding")) === 2, "no extra finding");
    });

    await ok("G5E-51: ordinary re-home onto a NEW target (created atomically, F_old stays active)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const c6 = await cellOf(w.db, visitId, null, "CHK-006");
        const fOld = (await singleAnswerOk(w, c6, "CHK-006", "IRREGULAR", { note: "عطل", finding: newFindingSel(), actor: "inspector-a", now: NOW })).findingId!;
        const c7 = await cellOf(w.db, visitId, null, "CHK-007");
        await singleAnswerOk(w, c7, "CHK-007", "IRREGULAR", { note: "ثان", finding: existingFindingSel(fOld), actor: "inspector-a", now: NOW });
        const res = await w.corr.rehomeSource({
            source: { kind: "response", cell: c6 },
            target: { mode: "new", finding: { description: "عطل منفصل بعد إعادة التقييم", urgency: "ROUTINE", impact: "LOW" } },
            actor: "inspector-a",
            now: NOW2,
        });
        assert(res.applied === true && res.createdFindingId !== null, "new target created by the ordinary re-home");
        assert((await rowStateOf(w.db, await responseIdOf(w.db, c6))).findingId === res.createdFindingId, "source moved to the new target");
        const t = await findingRowOf(w.db, res.createdFindingId!);
        assert(Number(t.origin_visit_id) === visitId && String(t.status) === "OPEN", "new target origin/status");
        assert(String(t.created_at) === NOW2 && String(t.created_by) === "inspector-a", "creation audit");
        assert(await findingStatusOf(w.db, fOld) === "OPEN", "F_old stays active (never VOIDED by an ordinary re-home)");
        assert((await findingSources(w.db, fOld)) === 1, "F_old retains its other source");
        const voidedRows = await w.db.query("SELECT count(*) AS c FROM finding WHERE status = 'VOIDED'");
        assert(Number(voidedRows[0].c) === 0, "nothing was VOIDED");
        await assertFindingInvariants(w.db);
    });

    await ok("G5E-52: an IN_TREATMENT finding is a legal re-home target (inspector's explicit choice)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const c6 = await cellOf(w.db, visitId, null, "CHK-006");
        const fOld = (await singleAnswerOk(w, c6, "CHK-006", "IRREGULAR", { note: "عطل", finding: newFindingSel(), actor: "inspector-a", now: NOW })).findingId!;
        const c7 = await cellOf(w.db, visitId, null, "CHK-007");
        await singleAnswerOk(w, c7, "CHK-007", "IRREGULAR", { note: "ثان", finding: existingFindingSel(fOld), actor: "inspector-a", now: NOW });
        const c10 = await cellOf(w.db, visitId, null, "CHK-010");
        const fTarget = (await singleAnswerOk(w, c10, "CHK-010", "NOT_AVAILABLE", { note: "هدف", finding: newFindingSel(), actor: "inspector-a", now: NOW })).findingId!;
        await w.db.run("UPDATE finding SET status = 'IN_TREATMENT', status_changed_at = ? WHERE finding_id = ? AND status = 'OPEN'", [NOW, fTarget]);
        const res = await w.corr.rehomeSource({
            source: { kind: "response", cell: c6 },
            target: { mode: "existing", findingId: fTarget, coversSameIssueConfirmed: true },
        });
        assert(res.applied === true, "IN_TREATMENT target accepted");
        assert((await rowStateOf(w.db, await responseIdOf(w.db, c6))).findingId === fTarget, "source moved onto the IN_TREATMENT finding");
        assert(await findingStatusOf(w.db, fTarget) === "IN_TREATMENT", "target state unchanged");
        await assertFindingInvariants(w.db);
    });
}

// ---------------------------------------------------------------------------
// S7 — retry identity (Gate-5E correction D/E):
//   * T6-VOID / T6-REHOME retries converge ONLY on the identical VOID event
//     identity (FollowUp fields + finding.status_changed_at);
//   * NEW-target retries converge ONLY when the durable target Finding matches
//     the requested creation identity (origin/subject/description/defect/
//     location/urgency/impact/created_by — created_at and current status are
//     deliberately excluded).
// ---------------------------------------------------------------------------
async function tS7_retryIdentity(): Promise<void> {
    /** one single-source OPEN finding on CHK-006 (institution context). */
    async function singleSource(w: World): Promise<{ cell: ResponseCellRef; findingId: number; rid: number }> {
        const visitId = await standardCreate(w);
        const cell = await cellOf(w.db, visitId, null, "CHK-006");
        const findingId = (await singleAnswerOk(w, cell, "CHK-006", "IRREGULAR", {
            note: "عطل",
            finding: newFindingSel(),
            actor: "inspector-a",
            now: NOW,
        })).findingId!;
        return { cell, findingId, rid: await responseIdOf(w.db, cell) };
    }

    await ok("G5E-58: exact T6-VOID event retry converges; one FollowUp only", async () => {
        const w = await freshWorld();
        const { cell, findingId } = await singleSource(w);
        const event = voidEvent(NOW2, "ملاحظة إبطال");
        const req = await answerReq(w.db, "CHK-006", "REGULAR");
        const call = async () =>
            w.corr.voidOpenFindingByLastSourceCorrection({ findingId, correction: { kind: "response", cell, request: req }, event });
        const first = await call();
        const again = await call();
        assert(first.applied === true && again.applied === false, "identical event retry converges");
        assert((await followUpsOf(w.db, findingId)).length === 1, "one FollowUp only");
    });

    await ok("G5E-59: T6-VOID retry with a DIFFERENT event_datetime is a conflict", async () => {
        const w = await freshWorld();
        const { cell, findingId } = await singleSource(w);
        await w.corr.voidOpenFindingByLastSourceCorrection({
            findingId,
            correction: { kind: "response", cell, request: await answerReq(w.db, "CHK-006", "REGULAR") },
            event: voidEvent(NOW2, "ملاحظة إبطال"),
        });
        const e = await rejectsCode(APP_ERR.STATE_CONFLICT, async () =>
            w.corr.voidOpenFindingByLastSourceCorrection({
                findingId,
                correction: { kind: "response", cell, request: await answerReq(w.db, "CHK-006", "REGULAR") },
                event: voidEvent("2026-09-03T07:00:00.000Z", "ملاحظة إبطال"),
            }),
        );
        assert(e.message.includes("event identity"), `message names the event identity: ${e.message}`);
        assert((await followUpsOf(w.db, findingId)).length === 1, "no second FollowUp");
        assert(await findingStatusOf(w.db, findingId) === "VOIDED", "F_old stays VOIDED");
    });

    await ok("G5E-60: T6-VOID retry with a DIFFERENT note is a conflict", async () => {
        const w = await freshWorld();
        const { cell, findingId } = await singleSource(w);
        await w.corr.voidOpenFindingByLastSourceCorrection({
            findingId,
            correction: { kind: "response", cell, request: await answerReq(w.db, "CHK-006", "REGULAR") },
            event: voidEvent(NOW2, "ملاحظة الإبطال الأصلية"),
        });
        await rejectsCode(APP_ERR.STATE_CONFLICT, async () =>
            w.corr.voidOpenFindingByLastSourceCorrection({
                findingId,
                correction: { kind: "response", cell, request: await answerReq(w.db, "CHK-006", "REGULAR") },
                event: voidEvent(NOW2, "ملاحظة مختلفة"),
            }),
        );
        assert((await followUpsOf(w.db, findingId)).length === 1, "no second FollowUp");
    });

    await ok("G5E-61: T6-VOID retry with a DIFFERENT actor/audit identity is a conflict", async () => {
        const w = await freshWorld();
        const { cell, findingId } = await singleSource(w);
        await w.corr.voidOpenFindingByLastSourceCorrection({
            findingId,
            correction: { kind: "response", cell, request: await answerReq(w.db, "CHK-006", "REGULAR") },
            event: voidEvent(NOW2, "ملاحظة إبطال"),
        });
        const otherActor: FollowUpEventInput = { ...voidEvent(NOW2, "ملاحظة إبطال"), recordedBy: "inspector-b", actorName: "inspector-b" };
        await rejectsCode(APP_ERR.STATE_CONFLICT, async () =>
            w.corr.voidOpenFindingByLastSourceCorrection({
                findingId,
                correction: { kind: "response", cell, request: await answerReq(w.db, "CHK-006", "REGULAR") },
                event: otherActor,
            }),
        );
        assert((await followUpsOf(w.db, findingId)).length === 1, "no second FollowUp");
    });

    await ok("G5E-62: a status_changed_at mismatch can never be treated as convergence", async () => {
        const w = await freshWorld();
        const { cell, findingId } = await singleSource(w);
        const event = voidEvent(NOW2, "ملاحظة إبطال");
        await w.corr.voidOpenFindingByLastSourceCorrection({
            findingId,
            correction: { kind: "response", cell, request: await answerReq(w.db, "CHK-006", "REGULAR") },
            event,
        });
        // raw audit drift: status_changed_at no longer equals the event datetime
        await w.db.run("UPDATE finding SET status_changed_at = ? WHERE finding_id = ?", ["2026-09-03T07:00:00.000Z", findingId]);
        await rejectsCode(APP_ERR.STATE_CONFLICT, async () =>
            w.corr.voidOpenFindingByLastSourceCorrection({
                findingId,
                correction: { kind: "response", cell, request: await answerReq(w.db, "CHK-006", "REGULAR") },
                event,
            }),
        );
        assert((await followUpsOf(w.db, findingId)).length === 1, "no second FollowUp");
    });

    await ok("G5E-63: exact T6-REHOME (existing target) event retry converges; one FollowUp only", async () => {
        const w = await freshWorld();
        const { cell, findingId } = await singleSource(w);
        const visitId = cell.visitId;
        const c10 = await cellOf(w.db, visitId, null, "CHK-010");
        const fTarget = (await singleAnswerOk(w, c10, "CHK-010", "NOT_AVAILABLE", { note: "هدف", finding: newFindingSel(), actor: "inspector-a", now: NOW })).findingId!;
        const event = voidEvent(NOW2, "إعادة إسناد خاطئة");
        const call = async () =>
            w.corr.rehomeLastSourceAndVoidFinding({
                findingId,
                source: { kind: "response", cell },
                target: { mode: "existing", findingId: fTarget, coversSameIssueConfirmed: true },
                event,
            });
        const first = await call();
        const again = await call();
        assert(first.applied === true && again.applied === false, "identical event retry converges");
        assert((await followUpsOf(w.db, findingId)).length === 1, "one FollowUp only");
        assert((await rowStateOf(w.db, await responseIdOf(w.db, cell))).findingId === fTarget, "link stable");
    });

    await ok("G5E-64: T6-REHOME retry with a DIFFERENT event_datetime is a conflict", async () => {
        const w = await freshWorld();
        const { cell, findingId } = await singleSource(w);
        const visitId = cell.visitId;
        const c10 = await cellOf(w.db, visitId, null, "CHK-010");
        const fTarget = (await singleAnswerOk(w, c10, "CHK-010", "NOT_AVAILABLE", { note: "هدف", finding: newFindingSel(), actor: "inspector-a", now: NOW })).findingId!;
        const target = { mode: "existing" as const, findingId: fTarget, coversSameIssueConfirmed: true as const };
        await w.corr.rehomeLastSourceAndVoidFinding({
            findingId,
            source: { kind: "response", cell },
            target,
            event: voidEvent(NOW2, "إعادة إسناد"),
        });
        await rejectsCode(APP_ERR.STATE_CONFLICT, async () =>
            w.corr.rehomeLastSourceAndVoidFinding({
                findingId,
                source: { kind: "response", cell },
                target,
                event: voidEvent("2026-09-03T07:00:00.000Z", "إعادة إسناد"),
            }),
        );
        assert((await followUpsOf(w.db, findingId)).length === 1, "no second FollowUp");
        assert((await findingSources(w.db, fTarget)) === 2, "target unchanged");
    });

    await ok("G5E-65: T6-REHOME retry with a DIFFERENT note/actor is a conflict", async () => {
        const w = await freshWorld();
        const { cell, findingId } = await singleSource(w);
        const visitId = cell.visitId;
        const c10 = await cellOf(w.db, visitId, null, "CHK-010");
        const fTarget = (await singleAnswerOk(w, c10, "CHK-010", "NOT_AVAILABLE", { note: "هدف", finding: newFindingSel(), actor: "inspector-a", now: NOW })).findingId!;
        const target = { mode: "existing" as const, findingId: fTarget, coversSameIssueConfirmed: true as const };
        await w.corr.rehomeLastSourceAndVoidFinding({
            findingId,
            source: { kind: "response", cell },
            target,
            event: voidEvent(NOW2, "إعادة إسناد"),
        });
        await rejectsCode(APP_ERR.STATE_CONFLICT, async () =>
            w.corr.rehomeLastSourceAndVoidFinding({
                findingId,
                source: { kind: "response", cell },
                target,
                event: voidEvent(NOW2, "ملاحظة مختلفة"),
            }),
        );
        const otherActor: FollowUpEventInput = { ...voidEvent(NOW2, "إعادة إسناد"), recordedBy: "inspector-b" };
        await rejectsCode(APP_ERR.STATE_CONFLICT, async () =>
            w.corr.rehomeLastSourceAndVoidFinding({ findingId, source: { kind: "response", cell }, target, event: otherActor }),
        );
        assert((await followUpsOf(w.db, findingId)).length === 1, "no second FollowUp");
    });

    await ok("G5E-66: exact ordinary NEW-target re-home retry converges without a second target", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const c6 = await cellOf(w.db, visitId, null, "CHK-006");
        const fOld = (await singleAnswerOk(w, c6, "CHK-006", "IRREGULAR", { note: "عطل", finding: newFindingSel(), actor: "inspector-a", now: NOW })).findingId!;
        const c7 = await cellOf(w.db, visitId, null, "CHK-007");
        await singleAnswerOk(w, c7, "CHK-007", "IRREGULAR", { note: "ثان", finding: existingFindingSel(fOld), actor: "inspector-a", now: NOW });
        const target: RehomeFindingTarget = { mode: "new", finding: { description: "هدف جديد واحد", urgency: "ROUTINE", impact: "LOW" } };
        const call = async () => w.corr.rehomeSource({ source: { kind: "response", cell: c6 }, target, actor: "inspector-a", now: NOW2 });
        const first = await call();
        const again = await call();
        assert(first.applied === true && again.applied === false, "identical NEW-target retry converges");
        assert(again.findingId === first.findingId && first.findingId !== null, "same created target");
        assert((await count(w.db, "SELECT count(*) AS c FROM finding")) === 2, "no second target Finding");
    });

    await ok("G5E-67: T6-REHOME NEW-target retry with a DIFFERENT description is a conflict", async () => {
        const w = await freshWorld();
        const { cell, findingId } = await singleSource(w);
        const t1: RehomeFindingTarget = { mode: "new", finding: { description: "الهدف الصحيح", urgency: "ROUTINE", impact: "LOW" } };
        const event = voidEvent(NOW2, "إبطال وإسناد جديد");
        await w.corr.rehomeLastSourceAndVoidFinding({ findingId, source: { kind: "response", cell }, target: t1, event });
        const t2: RehomeFindingTarget = { mode: "new", finding: { description: "وصف مختلف", urgency: "ROUTINE", impact: "LOW" } };
        const e = await rejectsCode(APP_ERR.STATE_CONFLICT, async () =>
            w.corr.rehomeLastSourceAndVoidFinding({ findingId, source: { kind: "response", cell }, target: t2, event }),
        );
        assert(e.message.includes("conflicting retry"), `message names the conflict: ${e.message}`);
        assert((await count(w.db, "SELECT count(*) AS c FROM finding")) === 2, "no second target Finding");
        assert((await followUpsOf(w.db, findingId)).length === 1, "exactly the historical VOID event remains");
    });

    await ok("G5E-68: T6-REHOME NEW-target retry with different urgency/impact is a conflict", async () => {
        const w = await freshWorld();
        const { cell, findingId } = await singleSource(w);
        const base = { description: "الهدف", urgency: "ROUTINE", impact: "LOW" };
        const event = voidEvent(NOW2, "إبطال وإسناد");
        await w.corr.rehomeLastSourceAndVoidFinding({
            findingId,
            source: { kind: "response", cell },
            target: { mode: "new", finding: { ...base } },
            event,
        });
        await rejectsCode(APP_ERR.STATE_CONFLICT, async () =>
            w.corr.rehomeLastSourceAndVoidFinding({
                findingId,
                source: { kind: "response", cell },
                target: { mode: "new", finding: { ...base, urgency: "IMMEDIATE" } },
                event,
            }),
        );
        await rejectsCode(APP_ERR.STATE_CONFLICT, async () =>
            w.corr.rehomeLastSourceAndVoidFinding({
                findingId,
                source: { kind: "response", cell },
                target: { mode: "new", finding: { ...base, impact: "HIGH" } },
                event,
            }),
        );
        assert((await count(w.db, "SELECT count(*) AS c FROM finding")) === 2, "no second target Finding");
        assert((await followUpsOf(w.db, findingId)).length === 1, "one VOID event only");
    });

    await ok("G5E-69: NEW-target retry with changed subject semantics is a conflict", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const wsA = await addWorkshopSubject(w, visitId, "WS-A");
        const wsB = await addWorkshopSubject(w, visitId, "WS-B");
        const fOld = await insertFinding(w.db, visitId);
        const obsId = await insertObservation(w.db, visitId, "ملاحظة على أ", { subjectId: wsA, findingId: fOld });
        const event = voidEvent(NOW2, "إبطال وإسناد");
        // first op: NEW target created for the observation's subject (WS-A)
        await w.corr.rehomeLastSourceAndVoidFinding({
            findingId: fOld,
            source: { kind: "observation", observationId: obsId },
            target: { mode: "new", finding: { description: "هدف على أ", urgency: "ROUTINE", impact: "LOW" } },
            event,
        });
        // retry demanding a DIFFERENT subject semantics (WS-B) => not identical
        await rejectsCode(APP_ERR.STATE_CONFLICT, async () =>
            w.corr.rehomeLastSourceAndVoidFinding({
                findingId: fOld,
                source: { kind: "observation", observationId: obsId, correctedSubjectId: wsB },
                target: { mode: "new", finding: { description: "هدف على أ", urgency: "ROUTINE", impact: "LOW" } },
                event,
            }),
        );
        assert((await count(w.db, "SELECT count(*) AS c FROM finding")) === 2, "no second target Finding");
        const fus = await followUpsOf(w.db, fOld);
        assert(fus.length === 1 && String(fus[0].note) === "إبطال وإسناد", "the exact historical VOID event remains");
        assert(await findingStatusOf(w.db, fOld) === "VOIDED", "F_old VOIDED");
    });
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------
const SUITES: Array<[string, () => Promise<void>]> = [
    ["G5E-1 ordinary corrections (single-value cells + HUMAN reversals)", tS1_ordinaryCorrections],
    ["G5E-2 finding-source ordinary discipline (detach / re-home / target rules)", tS2_findingSourceOrdinary],
    ["G5E-3 T6-VOID (voidOpenFindingByLastSourceCorrection)", tS3_void],
    ["G5E-4 T6-REHOME (rehomeLastSourceAndVoidFinding)", tS4_rehome],
    ["G5E-5 SCHEDULE corrections (overall + reconciliation row set)", tS5_schedule],
    ["G5E-6 cross-cutting + extras (invariants / neutrality / TOCTOU)", tS6_crossCutting],
    ["G5E-7 retry identity (VOID/REHOME event + NEW-target creation)", tS7_retryIdentity],
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
