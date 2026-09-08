// Gate 5D — automated regression for initial response disposition:
//   T2 answerSingle (COMPLIANT | NON_COMPLIANT+NEW Finding | NON_COMPLIANT+EXISTING Finding)
//   T3 answerSchedule (T3A/T3B/COMPLIANT; atomic reconciliation rows)
//   T4 markNotInspected
//   T5 resolveHumanApplicability (HUMAN NOT_APPLICABLE)
// over EXISTING materialized true-pending cells only (B4), with Class-A
// state-based retry convergence (TRANSACTION §12 / RECOVERY §5).
//
// Run (repository root; Node.js >= 22 is the adopted development/test host,
// Gate-5A D1 — node:sqlite + native TypeScript type stripping):
//   Node 22.x:   node --experimental-strip-types tests/gate5d_regression.ts
//   Node 24.x:   node tests/gate5d_regression.ts
// Exit: 0 on success, 1 when any assertion fails.
//
// Coverage map (GATE 5D §M) is reproduced in the ok() labels 01..40 plus the
// extra schema/contract cases appended by each suite.

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
    type AnswerScheduleInput,
    type AnswerSingleInput,
    type FindingSelection,
    type InitialDispositionResult,
    type ReconciliationRowInput,
    type ResponseCellRef,
} from "../src/application/initial-disposition.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_SQL = readFileSync(join(ROOT, "docs", "schema", "schema.sql"), "utf8");
const ARTIFACT_PATH = join(ROOT, "bootstrap", "v1", "checklist-v1.json");
const COMMITTED = parseArtifact(readFileSync(ARTIFACT_PATH, "utf8"));
const EXPECTED_P0 = COMMITTED.manifest.expected_p0_item_codes;

const NOW = "2026-09-01T08:00:00.000Z";
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
    return { db, scope: new VisitScopeService(db), disp: new InitialDispositionService(db), missionId, institutionId };
}

async function standardCreate(world: World, visitType: VisitType = "PLANNED"): Promise<number> {
    const res = await world.scope.createVisit({
        missionId: world.missionId,
        institutionId: world.institutionId,
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
async function createVisitFor(world: World, institutionId: number, visitType: VisitType = "PLANNED"): Promise<number> {
    const res = await world.scope.createVisit({
        missionId: world.missionId,
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

async function addWorkshopSubject(world: World, visitId: number, name = "W1"): Promise<number> {
    const res = await world.scope.addSubjectToScope({
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

/** ACTIVE definition id of an item code (fixtures only — fresh visits pin these). */
async function activeDefId(db: SqlAdapter, itemCode: string): Promise<number> {
    const rows = await db.query(
        "SELECT item_definition_id FROM checklist_item_definition WHERE item_code = ? AND status = 'ACTIVE'",
        [itemCode],
    );
    assert(rows.length === 1, `expected one ACTIVE definition for ${itemCode}`);
    return Number(rows[0].item_definition_id);
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

function newFindingSel(extra: Partial<{ urgency: string; impact: string; description: string; defectType: string | null }> = {}): FindingSelection {
    return {
        mode: "new",
        finding: {
            description: extra.description ?? "equipment defective",
            defectType: (extra.defectType ?? "EQUIPMENT_FAULT") as never,
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

/** read reconciliation rows of a response sorted by sort_order (durable shape). */
async function reconRowsOf(db: SqlAdapter, responseId: number): Promise<Array<Record<string, SqlValue>>> {
    return db.query(
        `SELECT category, declared_qty, observed_qty, difference, discrepancy_type, discrepancy_desc
           FROM equipment_reconciliation_row WHERE response_id = ? ORDER BY sort_order, row_id`,
        [responseId],
    );
}

// fault-injecting adapter (same shape as tests/gate5c_regression.ts)
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
// COMMON / T2
// ---------------------------------------------------------------------------
async function tT2_answerSingle(): Promise<void> {
    await ok("G5D-01: missing cell => E_CELL_NOT_MATERIALIZED (no scope INSERT)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        // CHK-021 is a P1 code — never materialized in the P0 universe, so the
        // logical cell (visit, CHK-021 def, institution context) has no row.
        const defId = await activeDefId(w.db, "CHK-021");
        const before = await count(w.db, "SELECT count(*) AS c FROM checklist_response");
        await rejectsCode(APP_ERR.CELL_NOT_MATERIALIZED, async () =>
            singleAnswerOk(w, { visitId, itemDefinitionId: defId, subjectId: null }, "CHK-021", "SUITABLE"),
        );
        const after = await count(w.db, "SELECT count(*) AS c FROM checklist_response");
        assert(after === before, `no answer operation may INSERT a scope cell (${before} -> ${after})`);
    });

    await ok("G5D-02: reasoned NOT_INSPECTED cell is rejected as an initial answer (E_ALREADY_DISPOSITIONED)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const cell = await cellOf(w.db, visitId, null, "CHK-006");
        await w.disp.markNotInspected({ cell, reason: "تعذر الوصول" });
        const e = await rejectsCode(APP_ERR.ALREADY_DISPOSITIONED, async () => singleAnswerOk(w, cell, "CHK-006", "REGULAR"));
        assert((e as Error).message.includes("T6"), `message should point to T6: ${(e as Error).message}`);
    });

    await ok("G5D-03: already differently-answered cell rejected as an initial answer", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const cell = await cellOf(w.db, visitId, null, "CHK-006");
        await singleAnswerOk(w, cell, "CHK-006", "REGULAR");
        await rejectsCode(APP_ERR.ALREADY_DISPOSITIONED, async () =>
            singleAnswerOk(w, cell, "CHK-006", "IRREGULAR", {
                note: "now broken",
                finding: newFindingSel(),
                actor: "inspector-a",
                now: NOW,
            }),
        );
    });

    await ok("G5D-04: allowed value must belong to the pinned definition (E_CONFIG)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const cell = await cellOf(w.db, visitId, null, "CHK-006");
        // value belongs to CHK-007's pinned definition, not CHK-006's
        const foreignValue = await valueIdOf(w.db, "CHK-007", "REGULAR");
        await rejectsCode(APP_ERR.CONFIG, async () =>
            w.disp.answerSingle({ cell, allowedValueId: foreignValue }),
        );
    });

    await ok("G5D-05: COMPLIANT SINGLE_VALUE answer succeeds on a true-pending cell", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const cell = await cellOf(w.db, visitId, null, "CHK-006");
        const rid = await responseIdOf(w.db, cell);
        const res = await singleAnswerOk(w, cell, "CHK-006", "REGULAR");
        assert(res.applied === true, "must be applied");
        const st = await rowStateOf(w.db, rid);
        assert(st.overlayState === null, `overlay must clear, got ${st.overlayState}`);
        assert(st.answeredValueId !== null, "answered value must be set");
        assert(st.notInspectedReason === null, "reason must stay NULL");
    });

    await ok("G5D-06: COMPLIANT answer leaves finding_id NULL", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const cell = await cellOf(w.db, visitId, null, "CHK-007");
        const rid = await responseIdOf(w.db, cell);
        await singleAnswerOk(w, cell, "CHK-007", "REGULAR");
        const st = await rowStateOf(w.db, rid);
        assert(st.findingId === null, "COMPLIANT answer must carry no finding link");
        assert((await count(w.db, "SELECT count(*) AS c FROM finding")) === 0, "no finding may be created");
    });

    await ok("G5D-07: NON_COMPLIANT requires a meaningful note (E_CONFIG)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const cell = await cellOf(w.db, visitId, null, "CHK-006");
        const finding = newFindingSel();
        const base = { cell, allowedValueId: await valueIdOf(w.db, "CHK-006", "IRREGULAR"), finding, actor: "a", now: NOW };
        await rejectsCode(APP_ERR.CONFIG, async () => w.disp.answerSingle({ ...base, note: undefined }));
        await rejectsCode(APP_ERR.CONFIG, async () => w.disp.answerSingle({ ...base, note: "   " }));
        assert((await count(w.db, "SELECT count(*) AS c FROM finding")) === 0, "no finding may be created on note failure");
    });

    await ok("G5D-08: HUMAN answer without APPLICABLE decision rejected (E_HUMAN_NEEDS_DECISION)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const cell = await cellOf(w.db, visitId, null, "CHK-020");
        await rejectsCode(APP_ERR.HUMAN_NEEDS_DECISION, async () => singleAnswerOk(w, cell, "CHK-020", "AVAILABLE"));
    });

    await ok("G5D-09: HUMAN answer with explicit APPLICABLE succeeds", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const cell = await cellOf(w.db, visitId, null, "CHK-020");
        const rid = await responseIdOf(w.db, cell);
        const res = await singleAnswerOk(w, cell, "CHK-020", "AVAILABLE", { humanDecision: "APPLICABLE" });
        assert(res.applied === true, "must apply");
        const st = await rowStateOf(w.db, rid);
        assert(st.answeredValueId !== null && st.overlayState === null && st.findingId === null, "answered HUMAN cell state");
    });

    await ok("G5D-10: NC + NEW Finding creates exactly one Finding and links atomically", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const cell = await cellOf(w.db, visitId, null, "CHK-006");
        const rid = await responseIdOf(w.db, cell);
        const res = await singleAnswerOk(w, cell, "CHK-006", "IRREGULAR", {
            note: "انقطاعات متكررة",
            finding: newFindingSel({ urgency: "IMMEDIATE", impact: "HIGH" }),
            actor: "inspector-a",
            now: NOW,
        });
        const findings = await w.db.query("SELECT * FROM finding");
        assert(findings.length === 1, `exactly one finding expected, got ${findings.length}`);
        assert(Number(findings[0].origin_visit_id) === visitId, "finding origin must be the response's visit");
        assert(String(findings[0].status) === "OPEN", `status ${findings[0].status}`);
        assert(String(findings[0].urgency) === "IMMEDIATE" && String(findings[0].impact) === "HIGH", "explicit urgency/impact preserved");
        assert(Number(findings[0].subject_id ?? -1) === -1, "institution-context finding carries subject NULL");
        assert(res.findingId !== null && Number(findings[0].finding_id) === res.findingId, "result finding id");
        const st = await rowStateOf(w.db, rid);
        assert(st.findingId === res.findingId && st.answeredValueId !== null, "response linked atomically");
        assert(st.note === "انقطاعات متكررة", `note stored trimmed: ${st.note}`);
    });

    await ok("G5D-11: injected failure after Finding INSERT leaves zero new Finding and cell pending", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const cell = await cellOf(w.db, visitId, null, "CHK-006");
        const rid = await responseIdOf(w.db, cell);
        let faulted = false;
        const inner = new FaultAdapter(w.db, (sql) => {
            if (!faulted && sql.includes("UPDATE checklist_response") && sql.includes("SET answered_value_id")) {
                faulted = true;
                return true;
            }
            return false;
        });
        const disp = new InitialDispositionService(inner);
        await rejectsAny(async () =>
            disp.answerSingle({
                cell,
                allowedValueId: await valueIdOf(w.db, "CHK-006", "IRREGULAR"),
                note: "broken",
                finding: newFindingSel(),
                actor: "inspector-a",
                now: NOW,
            }),
        );
        assert(faulted, "fault injection did not trigger");
        assert((await count(w.db, "SELECT count(*) AS c FROM finding")) === 0, "tentative Finding must roll back");
        const st = await rowStateOf(w.db, rid);
        assert(st.overlayState === "NOT_INSPECTED" && st.answeredValueId === null && st.findingId === null, "cell must stay true-pending");
    });

    await ok("G5D-12: committed NEW-Finding retry converges without a second Finding", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const cell = await cellOf(w.db, visitId, null, "CHK-006");
        const rid = await responseIdOf(w.db, cell);
        const first = await singleAnswerOk(w, cell, "CHK-006", "IRREGULAR", {
            note: "same issue",
            finding: newFindingSel(),
            actor: "inspector-a",
            now: NOW,
        });
        assert(first.applied === true && first.findingId !== null, "first call applies");
        const again = await singleAnswerOk(w, cell, "CHK-006", "IRREGULAR", {
            note: "same issue",
            finding: newFindingSel(),
            actor: "inspector-a",
            now: NOW,
        });
        assert(again.applied === false, "identical retry must converge, not rewrite");
        assert(again.findingId === first.findingId, "durable finding_id must be returned");
        assert((await count(w.db, "SELECT count(*) AS c FROM finding")) === 1, "no second Finding on retry");
        const st = await rowStateOf(w.db, rid);
        assert(st.findingId === first.findingId, "response link untouched");
    });

    await ok("G5D-13: NC + existing valid Finding links correctly (same visit, same institution)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const cellA = await cellOf(w.db, visitId, null, "CHK-006");
        const cellB = await cellOf(w.db, visitId, null, "CHK-007");
        const first = await singleAnswerOk(w, cellA, "CHK-006", "IRREGULAR", {
            note: "issue A",
            finding: newFindingSel(),
            actor: "inspector-a",
            now: NOW,
        });
        const ridB = await responseIdOf(w.db, cellB);
        const second = await singleAnswerOk(w, cellB, "CHK-007", "IRREGULAR", {
            note: "same issue A",
            finding: existingFindingSel(first.findingId!),
            actor: "inspector-a",
            now: NOW,
        });
        assert(second.applied === true && second.findingId === first.findingId, "existing target linked");
        assert((await count(w.db, "SELECT count(*) AS c FROM finding")) === 1, "still exactly one finding");
        assert((await count(w.db, "SELECT count(*) AS c FROM checklist_response WHERE finding_id = ?", [first.findingId])) === 2, "two sources on the finding");
        const stB = await rowStateOf(w.db, ridB);
        assert(stB.findingId === first.findingId, "response B linked");
    });

    await ok("G5D-13x: subject-A Finding cannot link a subject-B response (E_CONTEXT; stays pending; no source)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const subjectA = await addWorkshopSubject(w, visitId, "WS-A");
        const subjectB = await addWorkshopSubject(w, visitId, "WS-B");
        // NC answer on subject A creates a Finding recorded for subject A
        const cellA1 = await cellOf(w.db, visitId, subjectA, "CHK-001");
        const first = await singleAnswerOk(w, cellA1, "CHK-001", "INACTIVE", {
            note: "issue at WS-A",
            finding: newFindingSel(),
            actor: "inspector-a",
            now: NOW,
        });
        const fRow = await w.db.query("SELECT subject_id FROM finding WHERE finding_id = ?", [first.findingId]);
        assert(Number(fRow[0].subject_id) === subjectA, "fixture: finding must be recorded for subject A");
        // same issue claim from subject B's cell (same institution, same visit)
        const cellB = await cellOf(w.db, visitId, subjectB, "CHK-006");
        const ridB = await responseIdOf(w.db, cellB);
        const e = await rejectsCode(APP_ERR.CONTEXT, async () =>
            singleAnswerOk(w, cellB, "CHK-006", "IRREGULAR", {
                note: "claims same issue",
                finding: existingFindingSel(first.findingId!),
                actor: "inspector-a",
                now: NOW,
            }),
        );
        assert((e as Error).message.includes("subject"), `message should name the subject mismatch: ${(e as Error).message}`);
        const stB = await rowStateOf(w.db, ridB);
        assert(stB.overlayState === "NOT_INSPECTED" && stB.answeredValueId === null && stB.findingId === null, "subject-B response stays true-pending");
        assert(
            (await count(w.db, "SELECT count(*) AS c FROM checklist_response WHERE finding_id = ?", [first.findingId])) === 1,
            "no new source may be attached to the subject-A finding",
        );
    });

    await ok("G5D-13y: same-subject existing Finding link succeeds", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const subjectA = await addWorkshopSubject(w, visitId, "WS-A");
        const cellA1 = await cellOf(w.db, visitId, subjectA, "CHK-001");
        const first = await singleAnswerOk(w, cellA1, "CHK-001", "INACTIVE", {
            note: "issue at WS-A",
            finding: newFindingSel(),
            actor: "inspector-a",
            now: NOW,
        });
        // another NON_COMPLIANT cell OF THE SAME SUBJECT links the same Finding
        const cellA6 = await cellOf(w.db, visitId, subjectA, "CHK-006");
        const rid = await responseIdOf(w.db, cellA6);
        const second = await singleAnswerOk(w, cellA6, "CHK-006", "IRREGULAR", {
            note: "same WS-A issue",
            finding: existingFindingSel(first.findingId!),
            actor: "inspector-a",
            now: NOW,
        });
        assert(second.applied === true && second.findingId === first.findingId, "same-subject existing target linked");
        assert((await rowStateOf(w.db, rid)).findingId === first.findingId, "same-subject response linked");
        assert(
            (await count(w.db, "SELECT count(*) AS c FROM checklist_response WHERE finding_id = ?", [first.findingId])) === 2,
            "two sources on the same-subject finding",
        );
    });

    await ok("G5D-14a: VOIDED Finding target rejected (E_FINDING_TARGET_INVALID)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        // fixture: OPEN finding created and immediately VOIDED (zero sources, origin PREPARATION)
        const fId = Number(
            (
                await w.db.run(
                    `INSERT INTO finding(origin_visit_id, description, urgency, impact, status, status_changed_at, created_at, created_by)
                     VALUES (?, 'void fixture', 'ROUTINE', 'LOW', 'OPEN', NULL, ?, 'owner')`,
                    [visitId, NOW],
                )
            ).lastInsertRowid,
        );
        await w.db.run("UPDATE finding SET status = 'VOIDED', status_changed_at = ? WHERE finding_id = ? AND status = 'OPEN'", [NOW, fId]);
        const cell = await cellOf(w.db, visitId, null, "CHK-006");
        const e = await rejectsCode(APP_ERR.FINDING_TARGET_INVALID, async () =>
            singleAnswerOk(w, cell, "CHK-006", "IRREGULAR", {
                note: "n",
                finding: existingFindingSel(fId),
                actor: "inspector-a",
                now: NOW,
            }),
        );
        assert((e as Error).message.includes("VOIDED"), `message should name VOIDED: ${(e as Error).message}`);
    });

    await ok("G5D-14b: RESOLVED Finding target rejected (E_FINDING_TARGET_INVALID)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const cellA = await cellOf(w.db, visitId, null, "CHK-006");
        const first = await singleAnswerOk(w, cellA, "CHK-006", "IRREGULAR", {
            note: "issue",
            finding: newFindingSel(),
            actor: "inspector-a",
            now: NOW,
        });
        // direct transition OPEN -> RESOLVED is schema-legal once a source exists
        await w.db.run("UPDATE finding SET status = 'RESOLVED', status_changed_at = ? WHERE finding_id = ?", [NOW, first.findingId]);
        const cellB = await cellOf(w.db, visitId, null, "CHK-007");
        const e = await rejectsCode(APP_ERR.FINDING_TARGET_INVALID, async () =>
            singleAnswerOk(w, cellB, "CHK-007", "IRREGULAR", {
                note: "n",
                finding: existingFindingSel(first.findingId!),
                actor: "inspector-a",
                now: NOW,
            }),
        );
        assert((e as Error).message.includes("RESOLVED"), `message should name RESOLVED: ${(e as Error).message}`);
    });

    await ok("G5D-14c: TOCTOU — target turned RESOLVED right before BEGIN IMMEDIATE is rejected (E_FINDING_TARGET_INVALID)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const cellA = await cellOf(w.db, visitId, null, "CHK-006");
        const first = await singleAnswerOk(w, cellA, "CHK-006", "IRREGULAR", {
            note: "issue",
            finding: newFindingSel(),
            actor: "inspector-a",
            now: NOW,
        });
        // deterministic TOCTOU simulation: a writer resolves the target in the
        // window immediately before this operation's BEGIN IMMEDIATE. The
        // admissibility read must happen INSIDE the transaction, so the service
        // sees RESOLVED and refuses to create a NEW link.
        const hook = new BeginHookAdapter(w.db, async () => {
            await w.db.run("UPDATE finding SET status = 'RESOLVED', status_changed_at = ? WHERE finding_id = ? AND status = 'OPEN'", [
                NOW,
                first.findingId,
            ]);
        });
        const disp = new InitialDispositionService(hook);
        const cellB = await cellOf(w.db, visitId, null, "CHK-007");
        const ridB = await responseIdOf(w.db, cellB);
        await rejectsCode(APP_ERR.FINDING_TARGET_INVALID, async () =>
            disp.answerSingle({
                cell: cellB,
                allowedValueId: await valueIdOf(w.db, "CHK-007", "IRREGULAR"),
                note: "n",
                finding: existingFindingSel(first.findingId!),
                actor: "inspector-a",
                now: NOW,
            }),
        );
        const stB = await rowStateOf(w.db, ridB);
        assert(stB.overlayState === "NOT_INSPECTED" && stB.answeredValueId === null && stB.findingId === null, "response stays true-pending");
        assert(
            (await count(w.db, "SELECT count(*) AS c FROM checklist_response WHERE finding_id = ?", [first.findingId])) === 1,
            "no new source may be attached after the TOCTOU rejection",
        );
    });

    await ok("G5D-14d: historical retry after the linked Finding becomes RESOLVED converges (no rewrite / duplicate source)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const cellA = await cellOf(w.db, visitId, null, "CHK-006");
        const cellB = await cellOf(w.db, visitId, null, "CHK-007");
        // NC on A creates the finding; NC on B links it as an existing target
        const first = await singleAnswerOk(w, cellA, "CHK-006", "IRREGULAR", {
            note: "issue",
            finding: newFindingSel(),
            actor: "inspector-a",
            now: NOW,
        });
        const ridB = await responseIdOf(w.db, cellB);
        await singleAnswerOk(w, cellB, "CHK-007", "IRREGULAR", {
            note: "same issue",
            finding: existingFindingSel(first.findingId!),
            actor: "inspector-a",
            now: NOW,
        });
        // the linked Finding later legitimately becomes RESOLVED (T8 territory)
        await w.db.run("UPDATE finding SET status = 'RESOLVED', status_changed_at = ? WHERE finding_id = ?", [NOW, first.findingId]);
        // identical retry of the B answer: durable history is recognized —
        // the retry must NOT require the linked Finding to still be selectable
        const again = await singleAnswerOk(w, cellB, "CHK-007", "IRREGULAR", {
            note: "same issue",
            finding: existingFindingSel(first.findingId!),
            actor: "inspector-a",
            now: NOW,
        });
        assert(again.applied === false && again.findingId === first.findingId, "historical retry returns applied:false + existing finding_id");
        const stB = await rowStateOf(w.db, ridB);
        assert(stB.answeredValueId !== null && stB.findingId === first.findingId, "durable answer untouched");
        assert(
            (await count(w.db, "SELECT count(*) AS c FROM checklist_response WHERE finding_id = ?", [first.findingId])) === 2,
            "no duplicate / extra source from the historical retry",
        );
    });

    await ok("G5D-15: cross-institution Finding target rejected (E_CONTEXT)", async () => {
        const w = await freshWorld();
        const visitA = await standardCreate(w);
        const otherInst = Number(
            (await w.db.run("INSERT INTO institution(name, created_at, created_by) VALUES ('Other', ?, 'owner')", [NOW])).lastInsertRowid,
        );
        const visitB = await createVisitFor(w, otherInst);
        const foreignCell = await cellOf(w.db, visitB, null, "CHK-006");
        const foreign = await singleAnswerOk(w, foreignCell, "CHK-006", "IRREGULAR", {
            note: "foreign issue",
            finding: newFindingSel(),
            actor: "inspector-b",
            now: NOW,
        });
        const cellA = await cellOf(w.db, visitA, null, "CHK-006");
        const e = await rejectsCode(APP_ERR.CONTEXT, async () =>
            singleAnswerOk(w, cellA, "CHK-006", "IRREGULAR", {
                note: "n",
                finding: existingFindingSel(foreign.findingId!),
                actor: "inspector-a",
                now: NOW,
            }),
        );
        assert((e as Error).message.includes("institution"), `message should mention institution: ${(e as Error).message}`);
    });

    await ok("G5D-15x: existing Finding without explicit covers-same-issue confirmation rejected", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const cellA = await cellOf(w.db, visitId, null, "CHK-006");
        const first = await singleAnswerOk(w, cellA, "CHK-006", "IRREGULAR", {
            note: "issue",
            finding: newFindingSel(),
            actor: "inspector-a",
            now: NOW,
        });
        const cellB = await cellOf(w.db, visitId, null, "CHK-007");
        const bad = { mode: "existing", findingId: first.findingId, coversSameIssueConfirmed: false } as unknown as FindingSelection;
        await rejectsCode(APP_ERR.FINDING_TARGET_INVALID, async () =>
            w.disp.answerSingle({
                cell: cellB,
                allowedValueId: await valueIdOf(w.db, "CHK-007", "IRREGULAR"),
                note: "n",
                finding: bad,
                actor: "inspector-a",
                now: NOW,
            }),
        );
    });

    await ok("G5D-15y: zero-source cross-visit target rejected (first-source integrity)", async () => {
        const w = await freshWorld();
        const visitA = await standardCreate(w);
        const visitB = await createVisitFor(w, w.institutionId); // same institution, different visit
        const fId = Number(
            (
                await w.db.run(
                    `INSERT INTO finding(origin_visit_id, description, urgency, impact, status, status_changed_at, created_at, created_by)
                     VALUES (?, 'fresh finding', 'ROUTINE', 'LOW', 'OPEN', NULL, ?, 'owner')`,
                    [visitB, NOW],
                )
            ).lastInsertRowid,
        );
        const cellA = await cellOf(w.db, visitA, null, "CHK-006");
        await rejectsCode(APP_ERR.FINDING_TARGET_INVALID, async () =>
            singleAnswerOk(w, cellA, "CHK-006", "IRREGULAR", {
                note: "n",
                finding: existingFindingSel(fId),
                actor: "inspector-a",
                now: NOW,
            }),
        );
    });

    await ok("G5D-16x: answerSingle refuses a SCHEDULE cell (E_CONFIG)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const cell = await cellOf(w.db, visitId, null, "CHK-012");
        await rejectsCode(APP_ERR.CONFIG, async () => singleAnswerOk(w, cell, "CHK-012", "MATCHED"));
    });
}

// ---------------------------------------------------------------------------
// T3 — answerSchedule
// ---------------------------------------------------------------------------
async function tT3_answerSchedule(): Promise<void> {
    await ok("G5D-16: correct SCHEDULE response_model required (answerSchedule refuses SINGLE_VALUE)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const cell = await cellOf(w.db, visitId, null, "CHK-006");
        const rid = await responseIdOf(w.db, cell);
        await rejectsCode(APP_ERR.CONFIG, async () =>
            w.disp.answerSchedule({
                cell,
                allowedValueId: await valueIdOf(w.db, "CHK-006", "REGULAR"),
                rows: [{ category: "x", declaredQty: 1, observedQty: 1 }],
            }),
        );
        assert((await count(w.db, "SELECT count(*) AS c FROM equipment_reconciliation_row")) === 0, "no rows on SINGLE_VALUE cell");
        assert((await rowStateOf(w.db, rid)).overlayState === "NOT_INSPECTED", "cell untouched");
    });

    await ok("G5D-16y: NON_COMPLIANT schedule overall requires a meaningful note (E_CONFIG)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const cell = await cellOf(w.db, visitId, null, "CHK-012");
        await rejectsCode(APP_ERR.CONFIG, async () =>
            w.disp.answerSchedule({
                cell,
                allowedValueId: await valueIdOf(w.db, "CHK-012", "MISMATCHED"),
                rows: [{ category: "a", declaredQty: 4, observedQty: 2, discrepancyType: "QTY_SHORTAGE" }],
                finding: newFindingSel(),
                actor: "inspector-a",
                now: NOW,
            }),
        );
        assert((await count(w.db, "SELECT count(*) AS c FROM finding")) === 0, "no finding may be created");
    });

    await ok("G5D-16z: overall COMPLIANT may not carry a discrepancy row (E_CONFIG)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const cell = await cellOf(w.db, visitId, null, "CHK-012");
        const rid = await responseIdOf(w.db, cell);
        await rejectsCode(APP_ERR.CONFIG, async () =>
            w.disp.answerSchedule({
                cell,
                allowedValueId: await valueIdOf(w.db, "CHK-012", "MATCHED"),
                rows: [{ category: "a", declaredQty: 5, observedQty: 3, discrepancyType: "QTY_SHORTAGE" }],
            }),
        );
        assert((await count(w.db, "SELECT count(*) AS c FROM equipment_reconciliation_row WHERE response_id = ?", [rid])) === 0, "no partial rows");
        assert((await rowStateOf(w.db, rid)).overlayState === "NOT_INSPECTED", "response untouched");
    });

    await ok("G5D-17: COMPLIANT schedule + zero-discrepancy rows succeeds atomically", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const cell = await cellOf(w.db, visitId, null, "CHK-012");
        const rid = await responseIdOf(w.db, cell);
        const rows: ReconciliationRowInput[] = [
            { category: "cat-a", declaredQty: 5, observedQty: 5 },
            { category: "cat-b", declaredQty: 3, observedQty: 3 },
        ];
        const res = await w.disp.answerSchedule({ cell, allowedValueId: await valueIdOf(w.db, "CHK-012", "MATCHED"), rows });
        assert(res.applied === true && res.reconciliationRowCount === 2, "rows inserted atomically");
        const st = await rowStateOf(w.db, rid);
        assert(st.overlayState === null && st.findingId === null && st.notInspectedReason === null, "compliant schedule state");
        const durable = await reconRowsOf(w.db, rid);
        assert(durable.length === 2, "two durable rows");
        assert(Number(durable[0].declared_qty) === 5 && Number(durable[0].difference) === 0, "row 1 shape");
        assert(durable.every((r) => Number(r.difference) === 0 && r.discrepancy_type === null), "all rows zero-difference");
    });

    await ok("G5D-18: NC schedule + NEW Finding + reconciliation rows succeeds atomically", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const cell = await cellOf(w.db, visitId, null, "CHK-012");
        const rid = await responseIdOf(w.db, cell);
        const rows: ReconciliationRowInput[] = [
            { category: "cat-a", declaredQty: 10, observedQty: 7, discrepancyType: "QTY_SHORTAGE", discrepancyDesc: "3 missing" },
            { category: "cat-b", declaredQty: 2, observedQty: 5, discrepancyType: "QTY_EXCESS" },
        ];
        const res = await w.disp.answerSchedule({
            cell,
            allowedValueId: await valueIdOf(w.db, "CHK-012", "MISMATCHED"),
            note: "فوارق في الجرد",
            rows,
            finding: newFindingSel(),
            actor: "inspector-a",
            now: NOW,
        });
        assert(res.applied === true && res.reconciliationRowCount === 2 && res.findingId !== null, "T3A result");
        const findings = await w.db.query("SELECT * FROM finding WHERE finding_id = ?", [res.findingId]);
        assert(findings.length === 1 && Number(findings[0].origin_visit_id) === visitId && String(findings[0].status) === "OPEN", "finding origin/status");
        const st = await rowStateOf(w.db, rid);
        assert(st.answeredValueId !== null && st.findingId === res.findingId && st.note === "فوارق في الجرد", "overall NC state");
        const durable = await reconRowsOf(w.db, rid);
        assert(durable.length === 2 && Number(durable[0].difference) === -3 && String(durable[1].discrepancy_type) === "QTY_EXCESS", "row shapes");
    });

    await ok("G5D-19: NC schedule + existing Finding succeeds atomically (T3B)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const cellA = await cellOf(w.db, visitId, null, "CHK-006");
        const first = await singleAnswerOk(w, cellA, "CHK-006", "IRREGULAR", {
            note: "inventory issue",
            finding: newFindingSel(),
            actor: "inspector-a",
            now: NOW,
        });
        const schedCell = await cellOf(w.db, visitId, null, "CHK-012");
        const rid = await responseIdOf(w.db, schedCell);
        const res = await w.disp.answerSchedule({
            cell: schedCell,
            allowedValueId: await valueIdOf(w.db, "CHK-012", "MISMATCHED"),
            note: "جرد غير مطابق",
            rows: [{ category: "cat-a", declaredQty: 4, observedQty: 2, discrepancyType: "QTY_SHORTAGE" }],
            finding: existingFindingSel(first.findingId!),
            actor: "inspector-a",
            now: NOW,
        });
        assert(res.applied === true && res.findingId === first.findingId, "T3B existing finding link");
        assert((await count(w.db, "SELECT count(*) AS c FROM finding")) === 1, "no second finding");
        assert((await count(w.db, "SELECT count(*) AS c FROM checklist_response WHERE finding_id = ?", [first.findingId])) === 2, "two sources");
        assert((await count(w.db, "SELECT count(*) AS c FROM equipment_reconciliation_row WHERE response_id = ?", [rid])) === 1, "one row");
    });

    await ok("G5D-20: row failure rolls back response + rows + NEW Finding", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const cell = await cellOf(w.db, visitId, null, "CHK-012");
        const rid = await responseIdOf(w.db, cell);
        let reconSeen = 0;
        let faulted = false;
        const inner = new FaultAdapter(w.db, (sql) => {
            if (sql.includes("INSERT INTO equipment_reconciliation_row")) {
                reconSeen += 1;
                if (reconSeen === 3) {
                    faulted = true;
                    return true;
                }
            }
            return false;
        });
        const disp = new InitialDispositionService(inner);
        await rejectsAny(async () =>
            disp.answerSchedule({
                cell,
                allowedValueId: await valueIdOf(w.db, "CHK-012", "MISMATCHED"),
                note: "فوارق",
                rows: [
                    { category: "a", declaredQty: 1, observedQty: 0, discrepancyType: "QTY_SHORTAGE" },
                    { category: "b", declaredQty: 2, observedQty: 3, discrepancyType: "QTY_EXCESS" },
                    { category: "c", declaredQty: 5, observedQty: 5 },
                ],
                finding: newFindingSel(),
                actor: "inspector-a",
                now: NOW,
            }),
        );
        assert(faulted && reconSeen === 3, "fault injection did not trigger on the 3rd reconciliation row");
        const st = await rowStateOf(w.db, rid);
        assert(st.overlayState === "NOT_INSPECTED" && st.answeredValueId === null && st.findingId === null, "response rolled back to true-pending");
        assert((await count(w.db, "SELECT count(*) AS c FROM equipment_reconciliation_row WHERE response_id = ?", [rid])) === 0, "zero rows survive");
        assert((await count(w.db, "SELECT count(*) AS c FROM finding")) === 0, "tentative NEW Finding rolled back");
    });

    await ok("G5D-21: identical T3 retry creates no duplicate rows or Finding", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const cell = await cellOf(w.db, visitId, null, "CHK-012");
        const rid = await responseIdOf(w.db, cell);
        const rows: ReconciliationRowInput[] = [
            { category: "cat-a", declaredQty: 10, observedQty: 6, discrepancyType: "QTY_SHORTAGE", discrepancyDesc: "4" },
        ];
        const call = async () =>
            w.disp.answerSchedule({
                cell,
                allowedValueId: await valueIdOf(w.db, "CHK-012", "MISMATCHED"),
                note: "ناقص",
                rows,
                finding: newFindingSel(),
                actor: "inspector-a",
                now: NOW,
            });
        const first = await call();
        const again = await call();
        assert(first.applied === true && again.applied === false, "identical retry converges without rewriting");
        assert(again.findingId === first.findingId, "durable finding returned");
        assert((await count(w.db, "SELECT count(*) AS c FROM finding")) === 1, "no second Finding");
        assert((await count(w.db, "SELECT count(*) AS c FROM equipment_reconciliation_row WHERE response_id = ?", [rid])) === 1, "no duplicate rows");
    });

    await ok("G5D-22: conflicting T3 retry payload does not silently converge", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const cell = await cellOf(w.db, visitId, null, "CHK-012");
        await w.disp.answerSchedule({
            cell,
            allowedValueId: await valueIdOf(w.db, "CHK-012", "MATCHED"),
            rows: [{ category: "cat-a", declaredQty: 4, observedQty: 4 }],
        });
        // different reconciliation payload on the already-dispositioned cell
        const e = await rejectsCode(APP_ERR.ALREADY_DISPOSITIONED, async () =>
            w.disp.answerSchedule({
                cell,
                allowedValueId: await valueIdOf(w.db, "CHK-012", "MATCHED"),
                rows: [{ category: "cat-b", declaredQty: 9, observedQty: 9 }],
            }),
        );
        assert((e as Error).message.includes("T6"), `message should point to T6: ${(e as Error).message}`);
        assert((await count(w.db, "SELECT count(*) AS c FROM equipment_reconciliation_row")) === 1, "durable rows untouched");
    });

    await ok("G5D-23: no reconciliation row survives a failed COMPLIANT transaction", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const cell = await cellOf(w.db, visitId, null, "CHK-012");
        const rid = await responseIdOf(w.db, cell);
        let reconSeen = 0;
        const inner = new FaultAdapter(w.db, (sql) => {
            if (sql.includes("INSERT INTO equipment_reconciliation_row")) {
                reconSeen += 1;
                if (reconSeen === 2) return true;
            }
            return false;
        });
        const disp = new InitialDispositionService(inner);
        await rejectsAny(async () =>
            disp.answerSchedule({
                cell,
                allowedValueId: await valueIdOf(w.db, "CHK-012", "MATCHED"),
                rows: [
                    { category: "a", declaredQty: 1, observedQty: 1 },
                    { category: "b", declaredQty: 2, observedQty: 2 },
                ],
            }),
        );
        assert(reconSeen === 2, "fault did not trigger on the 2nd row");
        const st = await rowStateOf(w.db, rid);
        assert(st.overlayState === "NOT_INSPECTED" && st.answeredValueId === null, "overall rollback to true-pending");
        assert((await count(w.db, "SELECT count(*) AS c FROM equipment_reconciliation_row WHERE response_id = ?", [rid])) === 0, "zero rows survive");
    });
}

// ---------------------------------------------------------------------------
// T4 — markNotInspected
// ---------------------------------------------------------------------------
async function tT4_markNotInspected(): Promise<void> {
    await ok("G5D-24: meaningful (non-blank) reason required (E_CONFIG)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const cell = await cellOf(w.db, visitId, null, "CHK-006");
        await rejectsCode(APP_ERR.CONFIG, async () => w.disp.markNotInspected({ cell, reason: "" }));
        await rejectsCode(APP_ERR.CONFIG, async () => w.disp.markNotInspected({ cell, reason: "   " }));
    });

    await ok("G5D-25: true-pending AUTO cell => deliberate NOT_INSPECTED", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const cell = await cellOf(w.db, visitId, null, "CHK-006");
        const rid = await responseIdOf(w.db, cell);
        const res = await w.disp.markNotInspected({ cell, reason: "ورشة مغلقة" });
        assert(res.applied === true, "applied");
        const st = await rowStateOf(w.db, rid);
        assert(st.overlayState === "NOT_INSPECTED" && st.notInspectedReason === "ورشة مغلقة", "reasoned deliberate state");
        assert(st.answeredValueId === null && st.findingId === null, "no answer / no finding");
    });

    await ok("G5D-25x: deliberate NOT_INSPECTED on a SCHEDULE cell uses the same T4 semantics (zero reconciliation rows)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const cell = await cellOf(w.db, visitId, null, "CHK-012");
        const rid = await responseIdOf(w.db, cell);
        const res = await w.disp.markNotInspected({ cell, reason: "تعذر إجراء المطابقة" });
        assert(res.applied === true, "applied");
        const st = await rowStateOf(w.db, rid);
        assert(
            st.overlayState === "NOT_INSPECTED" && st.notInspectedReason === "تعذر إجراء المطابقة" && st.answeredValueId === null,
            "schedule cell deliberately NOT_INSPECTED",
        );
        assert(
            (await count(w.db, "SELECT count(*) AS c FROM equipment_reconciliation_row WHERE response_id = ?", [rid])) === 0,
            "a deliberate NOT_INSPECTED leaves zero reconciliation rows",
        );
    });

    await ok("G5D-26: HUMAN without APPLICABLE decision rejected (E_HUMAN_NEEDS_DECISION)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const cell = await cellOf(w.db, visitId, null, "CHK-020");
        await rejectsCode(APP_ERR.HUMAN_NEEDS_DECISION, async () => w.disp.markNotInspected({ cell, reason: "غير متاح" }));
    });

    await ok("G5D-27: HUMAN + APPLICABLE + reason succeeds", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const cell = await cellOf(w.db, visitId, null, "CHK-020");
        const rid = await responseIdOf(w.db, cell);
        const res = await w.disp.markNotInspected({ cell, reason: "غير متاح حالياً", humanDecision: "APPLICABLE" });
        assert(res.applied === true, "applied");
        const st = await rowStateOf(w.db, rid);
        assert(st.overlayState === "NOT_INSPECTED" && st.notInspectedReason === "غير متاح حالياً", "reasoned HUMAN deliberate state");
    });

    await ok("G5D-28: identical T4 retry converges", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const cell = await cellOf(w.db, visitId, null, "CHK-006");
        const rid = await responseIdOf(w.db, cell);
        const first = await w.disp.markNotInspected({ cell, reason: "ورشة مغلقة" });
        const again = await w.disp.markNotInspected({ cell, reason: "ورشة مغلقة" });
        assert(first.applied === true && again.applied === false, "second identical call converges");
        assert((await rowStateOf(w.db, rid)).notInspectedReason === "ورشة مغلقة", "reason unchanged");
    });

    await ok("G5D-29: changing an existing reason is T6-out-of-scope (E_ALREADY_DISPOSITIONED)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const cell = await cellOf(w.db, visitId, null, "CHK-006");
        await w.disp.markNotInspected({ cell, reason: "reason one" });
        await rejectsCode(APP_ERR.ALREADY_DISPOSITIONED, async () => w.disp.markNotInspected({ cell, reason: "different reason" }));
    });

    await ok("G5D-29x: prior answer / prior NA cells are not re-markable by initial T4", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const answeredCell = await cellOf(w.db, visitId, null, "CHK-006");
        await singleAnswerOk(w, answeredCell, "CHK-006", "REGULAR");
        await rejectsCode(APP_ERR.ALREADY_DISPOSITIONED, async () => w.disp.markNotInspected({ cell: answeredCell, reason: "later" }));
        const naCell = await cellOf(w.db, visitId, null, "CHK-013"); // AUTO-NA at institution context
        await rejectsCode(APP_ERR.ALREADY_DISPOSITIONED, async () => w.disp.markNotInspected({ cell: naCell, reason: "later" }));
    });
}

// ---------------------------------------------------------------------------
// T5 — HUMAN NOT_APPLICABLE
// ---------------------------------------------------------------------------
async function tT5_humanNotApplicable(): Promise<void> {
    await ok("G5D-30: T5 accepts only a HUMAN_CONFIRMATION cell (AUTO pending rejected)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const cell = await cellOf(w.db, visitId, null, "CHK-006");
        await rejectsCode(APP_ERR.CONFIG, async () => w.disp.resolveHumanApplicability({ cell }));
    });

    await ok("G5D-31: unresolved HUMAN pending => NA", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const cell = await cellOf(w.db, visitId, null, "CHK-020");
        const rid = await responseIdOf(w.db, cell);
        const res = await w.disp.resolveHumanApplicability({ cell });
        assert(res.applied === true, "applied");
        const st = await rowStateOf(w.db, rid);
        assert(st.overlayState === "NA" && st.answeredValueId === null && st.notInspectedReason === null && st.findingId === null, "NA state");
    });

    await ok("G5D-32: AUTO cell is never changed through T5 (E_CONFIG, incl. durable AUTO-NA)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const pendingAuto = await cellOf(w.db, visitId, null, "CHK-006");
        await rejectsCode(APP_ERR.CONFIG, async () => w.disp.resolveHumanApplicability({ cell: pendingAuto }));
        const autoNa = await cellOf(w.db, visitId, null, "CHK-013"); // institution AUTO-NA
        const e = await rejectsCode(APP_ERR.CONFIG, async () => w.disp.resolveHumanApplicability({ cell: autoNa }));
        assert((e as Error).message.includes("HUMAN_CONFIRMATION"), `message names the HUMAN-only rule: ${(e as Error).message}`);
    });

    await ok("G5D-33: answered HUMAN cell cannot be T5-redispositioned (E_ALREADY_DISPOSITIONED)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const cell = await cellOf(w.db, visitId, null, "CHK-020");
        await singleAnswerOk(w, cell, "CHK-020", "AVAILABLE", { humanDecision: "APPLICABLE" });
        await rejectsCode(APP_ERR.ALREADY_DISPOSITIONED, async () => w.disp.resolveHumanApplicability({ cell }));
    });

    await ok("G5D-34: reasoned HUMAN cell cannot be T5-redispositioned (E_ALREADY_DISPOSITIONED)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const cell = await cellOf(w.db, visitId, null, "CHK-020");
        await w.disp.markNotInspected({ cell, reason: "غير متاح", humanDecision: "APPLICABLE" });
        await rejectsCode(APP_ERR.ALREADY_DISPOSITIONED, async () => w.disp.resolveHumanApplicability({ cell }));
    });

    await ok("G5D-35: duplicate HUMAN NA resolution converges safely", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const cell = await cellOf(w.db, visitId, null, "CHK-020");
        const rid = await responseIdOf(w.db, cell);
        const first = await w.disp.resolveHumanApplicability({ cell });
        const again = await w.disp.resolveHumanApplicability({ cell });
        assert(first.applied === true && again.applied === false, "second identical call converges");
        const st = await rowStateOf(w.db, rid);
        assert(st.overlayState === "NA", "durable NA untouched");
    });
}

// ---------------------------------------------------------------------------
// cross-cutting
// ---------------------------------------------------------------------------
async function tX_crossCutting(): Promise<void> {
    await ok("G5D-36: a non-PREPARATION (finalized) Visit rejects every write op", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        // give every pending NOT_INSPECTED cell a reason, then close the visit
        const reasoned = await w.db.run(
            `UPDATE checklist_response SET not_inspected_reason = 'closed by owner'
              WHERE visit_id = ? AND overlay_state = 'NOT_INSPECTED' AND not_inspected_reason IS NULL`,
            [visitId],
        );
        assert(reasoned.changes >= 1, "pending cells must be reasoned");
        const fin = await w.db.run(
            `UPDATE visit SET status = 'COMPLETED_WITH_UNINSPECTED', finalized_at = ?
              WHERE visit_id = ? AND status = 'PREPARATION' AND finalized_at IS NULL`,
            [NOW, visitId],
        );
        assert(fin.changes === 1, "visit must finalize");
        const c6 = await cellOf(w.db, visitId, null, "CHK-006");
        const c12 = await cellOf(w.db, visitId, null, "CHK-012");
        const c20 = await cellOf(w.db, visitId, null, "CHK-020");
        await rejectsCode(APP_ERR.VISIT_NOT_PREPARATION, async () => singleAnswerOk(w, c6, "CHK-006", "REGULAR"));
        await rejectsCode(APP_ERR.VISIT_NOT_PREPARATION, async () =>
            w.disp.answerSchedule({
                cell: c12,
                allowedValueId: await valueIdOf(w.db, "CHK-012", "MATCHED"),
                rows: [{ category: "a", declaredQty: 1, observedQty: 1 }],
            }),
        );
        await rejectsCode(APP_ERR.VISIT_NOT_PREPARATION, async () => w.disp.markNotInspected({ cell: c6, reason: "x" }));
        await rejectsCode(APP_ERR.VISIT_NOT_PREPARATION, async () => w.disp.resolveHumanApplicability({ cell: c20 }));
    });

    await ok("G5D-37: no answer operation INSERTs a missing scope cell (count stable)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const before = await count(w.db, "SELECT count(*) AS c FROM checklist_response");
        const defId = await activeDefId(w.db, "CHK-021");
        await rejectsCode(APP_ERR.CELL_NOT_MATERIALIZED, async () =>
            w.disp.answerSingle({
                cell: { visitId, itemDefinitionId: defId, subjectId: null },
                allowedValueId: await valueIdOf(w.db, "CHK-021", "SUITABLE"),
            }),
        );
        assert(
            (await count(w.db, "SELECT count(*) AS c FROM checklist_response")) === before,
            "row count must stay stable (no scope INSERT fallback)",
        );
    });

    await ok("G5D-38: recorded_at / recorded_by are unchanged by disposition", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const cell = await cellOf(w.db, visitId, null, "CHK-006");
        const rid = await responseIdOf(w.db, cell);
        const before = await rowStateOf(w.db, rid);
        await singleAnswerOk(w, cell, "CHK-006", "REGULAR", { note: "ok" });
        const after = await rowStateOf(w.db, rid);
        assert(after.recordedAt === before.recordedAt, `recorded_at changed: ${before.recordedAt} -> ${after.recordedAt}`);
        assert(after.recordedBy === before.recordedBy, "recorded_by changed");
    });

    await ok("G5D-39: production application core imports no node:* module", async () => {
        const files = ["errors.ts", "applicability.ts", "visit-scope.ts", "initial-disposition.ts"].map((f) =>
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

    await ok("G5D-40: no orphan OPEN Finding remains after failure/retry windows", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const c6 = await cellOf(w.db, visitId, null, "CHK-006");
        const c7 = await cellOf(w.db, visitId, null, "CHK-007");
        // committed NC+NEW (1 finding, 1 source)
        const good = await singleAnswerOk(w, c6, "CHK-006", "IRREGULAR", {
            note: "issue",
            finding: newFindingSel(),
            actor: "inspector-a",
            now: NOW,
        });
        // identical retry converges
        await singleAnswerOk(w, c6, "CHK-006", "IRREGULAR", {
            note: "issue",
            finding: newFindingSel(),
            actor: "inspector-a",
            now: NOW,
        });
        // injected mid-transaction failure on a second NC+NEW answer (rollback)
        const inner = new FaultAdapter(w.db, (sql) => sql.includes("UPDATE checklist_response") && sql.includes("SET answered_value_id"));
        const disp = new InitialDispositionService(inner);
        await rejectsAny(async () =>
            disp.answerSingle({
                cell: c7,
                allowedValueId: await valueIdOf(w.db, "CHK-007", "IRREGULAR"),
                note: "would-be orphan",
                finding: newFindingSel(),
                actor: "inspector-a",
                now: NOW,
            }),
        );
        const findings = await w.db.query("SELECT finding_id, status, origin_visit_id FROM finding");
        assert(findings.length === 1, `exactly one committed finding expected, got ${findings.length}`);
        assert(String(findings[0].status) === "OPEN" && Number(findings[0].finding_id) === good.findingId, "only the committed finding");
        for (const f of findings) {
            if (String(f.status) === "OPEN") {
                const sources =
                    (await count(w.db, "SELECT count(*) AS c FROM checklist_response WHERE finding_id = ?", [Number(f.finding_id)])) +
                    (await count(w.db, "SELECT count(*) AS c FROM adhoc_observation WHERE finding_id = ?", [Number(f.finding_id)]));
                assert(sources >= 1, `OPEN finding ${f.finding_id} must keep >= 1 source (orphan detected)`);
            }
        }
    });
}

// ---------------------------------------------------------------------------
// R — NEW-Finding retry identity (Gate-5E owner-authorized narrow correction)
//
// A durable response linked to a Finding converges on a `finding.mode = "new"`
// retry ONLY when the linked Finding matches the requested NEW-Finding
// semantic creation target (origin visit, subject context, normalized
// description/defect/location, urgency/impact, and the request-supplied
// actor as created_by). created_at and the Finding's CURRENT status are
// deliberately excluded (fresh retry clock / later legitimate transitions).
// ---------------------------------------------------------------------------
async function tR_newFindingRetryIdentity(): Promise<void> {
    await ok("G5D-41: identical semantic NEW-Finding retry converges even with a fresh retry clock", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const cell = await cellOf(w.db, visitId, null, "CHK-006");
        const sel = newFindingSel({ urgency: "BEFORE_ENTRY", impact: "MEDIUM", description: "لوحة توزيع مكشوفة" });
        const first = await singleAnswerOk(w, cell, "CHK-006", "IRREGULAR", {
            note: "ملاحظة",
            finding: sel,
            actor: "inspector-a",
            now: NOW,
        });
        // identical semantic payload; different retry clock + same actor
        const again = await singleAnswerOk(w, cell, "CHK-006", "IRREGULAR", {
            note: "ملاحظة",
            finding: sel,
            actor: "inspector-a",
            now: "2026-09-02T10:00:00.000Z",
        });
        assert(first.applied === true && again.applied === false, "identical semantic retry converges");
        assert(again.findingId === first.findingId && first.findingId !== null, "same durable finding returned");
        assert((await count(w.db, "SELECT count(*) AS c FROM finding")) === 1, "no second Finding");
    });

    await ok("G5D-42: same answer/note but DIFFERENT NEW-Finding description is rejected (conflicting retry)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const cell = await cellOf(w.db, visitId, null, "CHK-006");
        await singleAnswerOk(w, cell, "CHK-006", "IRREGULAR", {
            note: "ملاحظة",
            finding: newFindingSel({ description: "الوصف الأول" }),
            actor: "inspector-a",
            now: NOW,
        });
        const e = await rejectsCode(APP_ERR.ALREADY_DISPOSITIONED, async () =>
            singleAnswerOk(w, cell, "CHK-006", "IRREGULAR", {
                note: "ملاحظة",
                finding: newFindingSel({ description: "وصف مختلف كلياً" }),
                actor: "inspector-a",
                now: NOW,
            }),
        );
        assert(e.message.includes("T6"), `message points to T6: ${e.message}`);
        const findings = await w.db.query("SELECT description FROM finding");
        assert(findings.length === 1 && String(findings[0].description) === "الوصف الأول", "no rewrite of the historical Finding");
    });

    await ok("G5D-43: different urgency is rejected as a conflicting retry", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const cell = await cellOf(w.db, visitId, null, "CHK-006");
        await singleAnswerOk(w, cell, "CHK-006", "IRREGULAR", {
            note: "n",
            finding: newFindingSel({ urgency: "IMMEDIATE" }),
            actor: "inspector-a",
            now: NOW,
        });
        await rejectsCode(APP_ERR.ALREADY_DISPOSITIONED, async () =>
            singleAnswerOk(w, cell, "CHK-006", "IRREGULAR", {
                note: "n",
                finding: newFindingSel({ urgency: "ROUTINE" }),
                actor: "inspector-a",
                now: NOW,
            }),
        );
        assert((await count(w.db, "SELECT count(*) AS c FROM finding")) === 1, "no second Finding");
    });

    await ok("G5D-44: different impact is rejected as a conflicting retry", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const cell = await cellOf(w.db, visitId, null, "CHK-006");
        await singleAnswerOk(w, cell, "CHK-006", "IRREGULAR", {
            note: "n",
            finding: newFindingSel({ impact: "HIGH" }),
            actor: "inspector-a",
            now: NOW,
        });
        await rejectsCode(APP_ERR.ALREADY_DISPOSITIONED, async () =>
            singleAnswerOk(w, cell, "CHK-006", "IRREGULAR", {
                note: "n",
                finding: newFindingSel({ impact: "LOW" }),
                actor: "inspector-a",
                now: NOW,
            }),
        );
        assert((await count(w.db, "SELECT count(*) AS c FROM finding")) === 1, "no second Finding");
    });

    await ok("G5D-44x: different actor (created_by) is rejected — actor is part of the requested creation target", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const cell = await cellOf(w.db, visitId, null, "CHK-006");
        await singleAnswerOk(w, cell, "CHK-006", "IRREGULAR", {
            note: "n",
            finding: newFindingSel(),
            actor: "inspector-a",
            now: NOW,
        });
        await rejectsCode(APP_ERR.ALREADY_DISPOSITIONED, async () =>
            singleAnswerOk(w, cell, "CHK-006", "IRREGULAR", {
                note: "n",
                finding: newFindingSel(),
                actor: "inspector-b",
                now: NOW,
            }),
        );
        const findings = await w.db.query("SELECT created_by FROM finding");
        assert(findings.length === 1 && String(findings[0].created_by) === "inspector-a", "historical created_by untouched");
    });

    await ok("G5D-45: a NEW-Finding retry cannot converge across a different subject context", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const wsA = await addWorkshopSubject(w, visitId, "WS-A");
        // Finding created FOR subject A by WS-A's cell
        const cellA = await cellOf(w.db, visitId, wsA, "CHK-006");
        const f = (await singleAnswerOk(w, cellA, "CHK-006", "IRREGULAR", { note: "عطل أ", finding: newFindingSel(), actor: "inspector-a", now: NOW })).findingId!;
        // an INSTITUTION-context cell (subject NULL) links the same Finding as
        // an existing target (legal: no subject-match restriction for NULL)
        const cellNull = await cellOf(w.db, visitId, null, "CHK-007");
        await singleAnswerOk(w, cellNull, "CHK-007", "IRREGULAR", { note: "نفس العطل", finding: existingFindingSel(f), actor: "inspector-a", now: NOW });
        // a "new" retry of the NULL-subject answer would claim a Finding with
        // subject NULL — the durable Finding is recorded for subject A
        await rejectsCode(APP_ERR.ALREADY_DISPOSITIONED, async () =>
            singleAnswerOk(w, cellNull, "CHK-007", "IRREGULAR", {
                note: "نفس العطل",
                finding: newFindingSel(),
                actor: "inspector-a",
                now: NOW,
            }),
        );
        assert((await count(w.db, "SELECT count(*) AS c FROM finding")) === 1, "no second Finding");
    });

    await ok("G5D-45x: a NEW-Finding retry cannot converge across a different origin Visit", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const secondVisit = await createVisitFor(w, w.institutionId);
        // Finding created in the SECOND visit (origin = secondVisit)
        const cellB = await cellOf(w.db, secondVisit, null, "CHK-006");
        const f = (await singleAnswerOk(w, cellB, "CHK-006", "IRREGULAR", { note: "عطل ب", finding: newFindingSel(), actor: "inspector-b", now: NOW })).findingId!;
        // the first visit's cell links the same Finding as an existing target
        const cellA = await cellOf(w.db, visitId, null, "CHK-006");
        await singleAnswerOk(w, cellA, "CHK-006", "IRREGULAR", { note: "نفس العطل", finding: existingFindingSel(f), actor: "inspector-a", now: NOW });
        // a "new" retry would claim origin == the first visit; durable origin is
        // the second visit => conflicting
        await rejectsCode(APP_ERR.ALREADY_DISPOSITIONED, async () =>
            singleAnswerOk(w, cellA, "CHK-006", "IRREGULAR", {
                note: "نفس العطل",
                finding: newFindingSel(),
                actor: "inspector-a",
                now: NOW,
            }),
        );
        assert((await count(w.db, "SELECT count(*) AS c FROM finding")) === 1, "no second Finding");
    });

    await ok("G5D-46: RESOLVED Finding with an identical creation payload still converges historically", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const cell = await cellOf(w.db, visitId, null, "CHK-006");
        const sel = newFindingSel({ urgency: "ROUTINE", impact: "LOW", description: "نقص تاريخي" });
        const first = await singleAnswerOk(w, cell, "CHK-006", "IRREGULAR", {
            note: "n",
            finding: sel,
            actor: "inspector-a",
            now: NOW,
        });
        // the linked Finding later legitimately transitions (T8 territory)
        await w.db.run("UPDATE finding SET status = 'RESOLVED', status_changed_at = ? WHERE finding_id = ?", [NOW, first.findingId]);
        const again = await singleAnswerOk(w, cell, "CHK-006", "IRREGULAR", {
            note: "n",
            finding: sel,
            actor: "inspector-a",
            now: "2026-09-02T11:00:00.000Z",
        });
        assert(again.applied === false && again.findingId === first.findingId, "historical retry converges without re-linking");
        const st = await rowStateOf(w.db, await responseIdOf(w.db, cell));
        assert(st.answeredValueId !== null && st.findingId === first.findingId, "durable answer/link untouched");
        assert(
            (await count(w.db, "SELECT count(*) AS c FROM checklist_response WHERE finding_id = ?", [first.findingId])) === 1,
            "no extra source from the historical retry",
        );
    });
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------
const SUITES: Array<[string, () => Promise<void>]> = [
    ["G5D-T2 answerSingle (common true-pending + NEW/EXISTING Finding)", tT2_answerSingle],
    ["G5D-T3 answerSchedule (T3A/T3B/COMPLIANT + atomic rows)", tT3_answerSchedule],
    ["G5D-T4 markNotInspected", tT4_markNotInspected],
    ["G5D-T5 HUMAN NOT_APPLICABLE resolution", tT5_humanNotApplicable],
    ["G5D-X cross-cutting (finalization gate / neutrality / orphan scan)", tX_crossCutting],
    ["G5D-R NEW-Finding retry identity (Gate-5E narrow correction)", tR_newFindingRetryIdentity],
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
