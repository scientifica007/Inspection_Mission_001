// Gate 5K — automated regression for T11 `finalizeVisit`
// (TRANSACTION-CONTRACTS-v1.md §11 / APPLICATION-CORE-v1.md §4.10 + §8):
//   one atomic BEGIN IMMEDIATE unit that closes the Visit's historical field
//   truth: authoritative Visit re-read (missing => E_VISIT_NOT_FOUND; not
//   finalized but status <> PREPARATION => E_VISIT_NOT_PREPARATION; already
//   finalized => Class-A idempotent return of the DURABLE final state,
//   applied:false — never reopen, never rewrite finalized_at, never
//   re-derive status) -> ALL preflight SELECT checks INSIDE the same
//   transaction (scope grid self-check E_SCOPE_GAP; unresolved pending
//   E_UNRESOLVED_PENDING; NOT_INSPECTED reasons E_UNINSPECTED_NEEDS_REASON;
//   NC accountability E_NC_UNACCOUNTED / notes E_NC_NEEDS_NOTE; SCHEDULE
//   invariants E_CHK012; orphan OPEN findings E_ORPHAN_FINDING) -> structured
//   blockers => ROLLBACK + one DomainError carrying the COMPLETE
//   deterministic blocker list -> derived final status (any durable
//   NOT_INSPECTED => COMPLETED_WITH_UNINSPECTED else COMPLETED; caller never
//   chooses; NA never counts; Finding/Action status never influences) ->
//   guarded final UPDATE (status + normalized app-supplied finalized_at
//   WHERE PREPARATION AND finalized_at IS NULL, changes == 1 B5) -> COMMIT.
//   Zero-row UPDATE => ROLLBACK then durable re-read: valid finalized row =>
//   applied:false; else E_STATE_CONFLICT; never commit zero rows.
//   Open Findings and CorrectiveActions of ANY status are never blockers and
//   are never transitioned/created/closed by T11 (remediation continues
//   after field-truth finalization); VOIDED findings are expected
//   source-less and never orphan blockers; T11 creates no FollowUp /
//   Finding / CorrectiveAction / Observation and alters no source links.
//
// Run (repository root; Node.js >= 22 is the adopted development/test host,
// Gate-5A D1 — node:sqlite + native TypeScript type stripping):
//   Node 22.x:   node --experimental-strip-types tests/gate5k_regression.ts
//   Node 24.x:   node tests/gate5k_regression.ts
// Exit: 0 on success, 1 when any assertion fails.
//
// Coverage map (GATE 5K §S TESTS, items 1..72) is reproduced in the ok()
// labels G5K-01..G5K-72, plus contract-mandated extras (G5K-73+):
//   73  E_VISIT_NOT_PREPARATION on a fabricated non-PREPARATION +
//       finalized_at-NULL Visit read (the table CHECK makes that row shape
//       unrepresentable at rest — documented DB backstop)
//   74  DB backstop: a raw NC-answer INSERT without a finding link is
//       rejected by trg_response_bi (E_NC_UNACCOUNTED unrepresentable at
//       rest; the service branch is covered by a fabricated read in G5K-29)
//   75  DB backstop: a raw reconciliation difference != observed - declared
//       is rejected by the table CHECK (unrepresentable at rest; the service
//       branch is covered by a fabricated read in G5K-37)
//   76  DB backstop: a raw visit UPDATE to COMPLETED_WITH_UNINSPECTED while
//       a reason-less pending row survives is rejected by trg_visit_bu
//   77  combined §J separation world: OPEN Finding + OPEN CorrectiveAction
//       do not block finalization and are not transitioned
//   78  finalization creates no adhoc_observation row
//   79  an empty captured universe (no institution-context rows) => E_SCOPE_GAP
//   80  an NC cell violating BOTH requirements reports both blockers in
//       deterministic order

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { SqlAdapter, SqlRow, SqlValue } from "../src/bootstrap/adapter.ts";
import { openFreshDb } from "../dev/node-sqlite-adapter.ts";
import { BootstrapLoader } from "../src/bootstrap/loader.ts";
import { parseArtifact } from "../src/bootstrap/artifact.ts";
import { APP_ERR, type FinalizationBlocker } from "../src/application/errors.ts";
import type { ContextKind } from "../src/application/applicability.ts";
import { VisitScopeService } from "../src/application/visit-scope.ts";
import {
    InitialDispositionService,
    type ResponseCellRef,
} from "../src/application/initial-disposition.ts";
import { ObservationCreateService } from "../src/application/observation-create.ts";
import { ObservationFindingService } from "../src/application/observation-finding.ts";
import { VisitFinalizationService } from "../src/application/visit-finalization.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_SQL = readFileSync(join(ROOT, "docs", "schema", "schema.sql"), "utf8");
const ARTIFACT_PATH = join(ROOT, "bootstrap", "v1", "checklist-v1.json");
const COMMITTED = parseArtifact(readFileSync(ARTIFACT_PATH, "utf8"));
const EXPECTED_P0 = COMMITTED.manifest.expected_p0_item_codes;

const NOW = "2026-09-01T08:00:00.000Z";
const VISIT_DATE = "2026-09-10";
const FIN = "2026-09-09T07:00:00Z";
const FIN2 = "2026-09-10T08:30:00.000Z";

// ---------------------------------------------------------------------------
// tiny assertion harness (same conventions as tests/gate5j_regression.ts)
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
// fault-injecting / recording adapters (same shapes as tests/gate5j_regression.ts)
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

/** one-shot read fabrication: the first matching query returns fabricated rows. */
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

/** records transaction-boundary + write calls (zero-write / rollback proofs). */
class RecordingAdapter implements SqlAdapter {
    private readonly inner: SqlAdapter;
    readonly calls: string[] = [];

    constructor(inner: SqlAdapter) {
        this.inner = inner;
    }
    async beginImmediate(): Promise<void> {
        this.calls.push("beginImmediate");
        return this.inner.beginImmediate();
    }
    async commit(): Promise<void> {
        this.calls.push("commit");
        return this.inner.commit();
    }
    async rollback(): Promise<void> {
        this.calls.push("rollback");
        return this.inner.rollback();
    }
    async run(sql: string, params: readonly SqlValue[] = []): Promise<Awaited<ReturnType<SqlAdapter["run"]>>> {
        this.calls.push("run");
        return this.inner.run(sql, params);
    }
    async query(sql: string, params: readonly SqlValue[] = []): Promise<SqlRow[]> {
        return this.inner.query(sql, params);
    }
}

// ---------------------------------------------------------------------------
// fixtures (bootstrap artifact worlds; services compose the durable scope)
// ---------------------------------------------------------------------------
interface World {
    db: SqlAdapter;
    scope: VisitScopeService;
    disp: InitialDispositionService;
    obs: ObservationCreateService;
    obsFinding: ObservationFindingService;
    fin: VisitFinalizationService;
    missionId: number;
    institutionId: number;
}

async function freshWorld(): Promise<World> {
    const db = openFreshDb(SCHEMA_SQL);
    await new BootstrapLoader(db, COMMITTED).load();
    const missionId = Number(
        (await db.run("INSERT INTO mission(name, status, created_at, created_by) VALUES ('M', 'PREPARATION', ?, 'owner')", [NOW]))
            .lastInsertRowid,
    );
    const institutionId = Number(
        (await db.run("INSERT INTO institution(name, created_at, created_by) VALUES ('Inst', ?, 'owner')", [NOW])).lastInsertRowid,
    );
    return {
        db,
        scope: new VisitScopeService(db),
        disp: new InitialDispositionService(db),
        obs: new ObservationCreateService(db),
        obsFinding: new ObservationFindingService(db),
        fin: new VisitFinalizationService(db),
        missionId,
        institutionId,
    };
}

async function standardCreate(w: World): Promise<number> {
    const res = await w.scope.createVisit({
        missionId: w.missionId,
        institutionId: w.institutionId,
        visitType: "PLANNED",
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

/** allowed value id of the PINNED definition (never a code-level lookup). */
async function valueIdOfDef(db: SqlAdapter, itemDefinitionId: number, valueCode: string): Promise<number> {
    const rows = await db.query(
        "SELECT allowed_value_id FROM checklist_allowed_value WHERE item_definition_id = ? AND value_code = ?",
        [itemDefinitionId, valueCode],
    );
    assert(rows.length === 1, `expected one allowed value ${itemDefinitionId}/${valueCode}`);
    return Number(rows[0].allowed_value_id);
}

/** response_id of a logical cell. */
async function responseIdOf(db: SqlAdapter, ref: ResponseCellRef): Promise<number> {
    const rows = await db.query(
        `SELECT response_id FROM checklist_response
          WHERE visit_id = ? AND item_definition_id = ? ${ref.subjectId === null ? "AND subject_id IS NULL" : "AND subject_id = ?"}`,
        ref.subjectId === null ? [ref.visitId, ref.itemDefinitionId] : [ref.visitId, ref.itemDefinitionId, ref.subjectId],
    );
    assert(rows.length === 1, `response row missing for (visit ${ref.visitId}, def ${ref.itemDefinitionId})`);
    return Number(rows[0].response_id);
}

const INST_COMPLIANT: ReadonlyArray<readonly [string, string]> = [
    ["CHK-006", "REGULAR"],
    ["CHK-007", "REGULAR"],
    ["CHK-010", "AVAILABLE"],
    ["CHK-011", "ALL_WORKING"],
];

const WORKSHOP_COMPLIANT: ReadonlyArray<readonly [string, string]> = [
    ["CHK-001", "ACTIVE"],
    ["CHK-002", "USED"],
    ["CHK-003", "COMPLIANT"],
    ["CHK-004", "AVAILABLE"],
    ["CHK-005", "NO_FAULT"],
    ["CHK-006", "REGULAR"],
    ["CHK-007", "REGULAR"],
    ["CHK-008", "NONE"],
    ["CHK-009", "NONE"],
    ["CHK-010", "AVAILABLE"],
    ["CHK-011", "ALL_WORKING"],
    ["CHK-013", "READY"],
];

async function answerCompliantCell(w: World, visitId: number, subjectId: number | null, code: string, value: string): Promise<void> {
    const cell = await cellOf(w.db, visitId, subjectId, code);
    await w.disp.answerSingle({ cell, allowedValueId: await valueIdOfDef(w.db, cell.itemDefinitionId, value) });
}

async function answerScheduleCompliant(w: World, visitId: number): Promise<void> {
    const cell = await cellOf(w.db, visitId, null, "CHK-012");
    await w.disp.answerSchedule({
        cell,
        allowedValueId: await valueIdOfDef(w.db, cell.itemDefinitionId, "MATCHED"),
        rows: [
            { category: "portable-extinguishers", declaredQty: 12, observedQty: 12 },
            { category: "first-aid-boxes", declaredQty: 6, observedQty: 6 },
        ],
    });
}

/** dispose the complete institution context; `skip` leaves listed codes pending. */
async function disposeInstitution(w: World, visitId: number, skip: string[] = []): Promise<void> {
    for (const [code, value] of INST_COMPLIANT) {
        if (skip.includes(code)) continue;
        await answerCompliantCell(w, visitId, null, code, value);
    }
    if (!skip.includes("CHK-012")) await answerScheduleCompliant(w, visitId);
    if (!skip.includes("CHK-020")) {
        const cell = await cellOf(w.db, visitId, null, "CHK-020");
        await w.disp.resolveHumanApplicability({ cell });
    }
}

/** dispose a workshop subject's complete grid (12 COMPLIANT answers). */
async function disposeWorkshop(w: World, visitId: number, subjectId: number): Promise<void> {
    for (const [code, value] of WORKSHOP_COMPLIANT) {
        await answerCompliantCell(w, visitId, subjectId, code, value);
    }
}

/** deliberate NOT_INSPECTED + meaningful reason (AUTO cell). */
async function markNotInspectedCell(w: World, visitId: number, code: string, reason: string): Promise<void> {
    const cell = await cellOf(w.db, visitId, null, code);
    await w.disp.markNotInspected({ cell, reason });
}

/** NON_COMPLIANT answer with a NEW Finding + meaningful note. */
async function answerNcCell(w: World, visitId: number, code: string, valueCode: string, note: string): Promise<number> {
    const cell = await cellOf(w.db, visitId, null, code);
    const res = await w.disp.answerSingle({
        cell,
        allowedValueId: await valueIdOfDef(w.db, cell.itemDefinitionId, valueCode),
        note,
        finding: {
            mode: "new",
            finding: {
                description: "defect observed on site",
                defectType: "EQUIPMENT_FAULT",
                location: "workshop",
                urgency: "IMMEDIATE",
                impact: "HIGH",
            },
        },
        actor: "inspector-a",
        now: NOW,
    });
    assert(res.findingId !== null, "NC answer must carry a finding link");
    return res.findingId;
}

// -- raw fixtures -------------------------------------------------------------

async function insertVisitRaw(db: SqlAdapter, missionId: number, institutionId: number): Promise<number> {
    const res = await db.run(
        `INSERT INTO visit(mission_id, institution_id, visit_type, visit_date, status, inspector, created_at, created_by)
         VALUES (?, ?, 'PLANNED', '2026-09-10', 'PREPARATION', 'inspector-a', ?, 'owner')`,
        [missionId, institutionId, NOW],
    );
    assert(res.changes === 1 && res.lastInsertRowid !== null, "visit fixture insert failed");
    return Number(res.lastInsertRowid);
}

async function insertSubjectRaw(db: SqlAdapter, institutionId: number, subjectType: string, name: string): Promise<number> {
    const res = await db.run(
        `INSERT INTO inspected_subject(institution_id, subject_type, name, created_at, created_by)
         VALUES (?, ?, ?, ?, 'owner')`,
        [institutionId, subjectType, name, NOW],
    );
    assert(res.changes === 1 && res.lastInsertRowid !== null, "subject fixture insert failed");
    return Number(res.lastInsertRowid);
}

/** raw pending cell (overlay NOT_INSPECTED, nothing dispositioned). */
async function insertCellRaw(
    db: SqlAdapter,
    visitId: number,
    itemDefinitionId: number,
    subjectId: number | null,
    overlay: "NA" | "NOT_INSPECTED",
): Promise<number> {
    const res = await db.run(
        `INSERT INTO checklist_response(visit_id, item_definition_id, subject_id, overlay_state, recorded_at, recorded_by)
         VALUES (?, ?, ?, ?, ?, 'inspector-a')`,
        [visitId, itemDefinitionId, subjectId, overlay, NOW],
    );
    assert(res.changes === 1, `cell fixture insert failed (def ${itemDefinitionId})`);
    return Number(res.lastInsertRowid);
}

/** the current ACTIVE definition id of a code (fresh-world fixtures only). */
async function activeDefId(db: SqlAdapter, itemCode: string): Promise<number> {
    const rows = await db.query(
        "SELECT item_definition_id FROM checklist_item_definition WHERE item_code = ? AND status = 'ACTIVE'",
        [itemCode],
    );
    assert(rows.length === 1, `expected one ACTIVE definition for ${itemCode}`);
    return Number(rows[0].item_definition_id);
}

/** raw OPEN Finding insert (fixture; origin = visit, NO sources yet). */
async function insertFindingRaw(db: SqlAdapter, visitId: number, description = "ceiling leak in the corridor"): Promise<number> {
    const res = await db.run(
        `INSERT INTO finding(origin_visit_id, description, defect_type, location, subject_id,
                             urgency, impact, status, status_changed_at, created_at, created_by)
         VALUES (?, ?, 'WATER_LEAK', 'corridor', NULL, 'IMMEDIATE', 'HIGH', 'OPEN', NULL, ?, 'inspector-a')`,
        [visitId, description, NOW] as readonly SqlValue[],
    );
    assert(res.changes === 1 && res.lastInsertRowid !== null, "finding fixture insert failed");
    return Number(res.lastInsertRowid);
}

async function insertObservationRaw(db: SqlAdapter, visitId: number, text = "leak observed in the corridor"): Promise<number> {
    const res = await db.run(
        `INSERT INTO adhoc_observation(visit_id, subject_id, text, finding_id, recorded_at, recorded_by)
         VALUES (?, NULL, ?, NULL, ?, 'inspector-a')`,
        [visitId, text, NOW] as readonly SqlValue[],
    );
    assert(res.changes === 1 && res.lastInsertRowid !== null, "observation fixture insert failed");
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

/** fixture VOIDED move for a source-less OPEN finding (trg_finding_bu allows). */
async function setFindingVoidedRaw(db: SqlAdapter, findingId: number, at = NOW): Promise<void> {
    const res = await db.run(
        "UPDATE finding SET status = 'VOIDED', status_changed_at = ? WHERE finding_id = ? AND status = 'OPEN'",
        [at, findingId] as readonly SqlValue[],
    );
    assert(res.changes === 1, `fixture finding ${findingId} -> VOIDED update failed`);
}

/** raw OPEN CorrectiveAction insert (fixture; closure fields NULL). */
async function insertActionRaw(db: SqlAdapter, findingId: number, description = "repair the corridor ceiling leak"): Promise<number> {
    const res = await db.run(
        `INSERT INTO corrective_action(finding_id, action_type, description, responsible_role,
                                       status, closed_at, verified_by, verification_note, created_at, created_by)
         VALUES (?, 'MAINTENANCE_WORK', ?, 'CONCERNED_SERVICE', 'OPEN', NULL, NULL, NULL, ?, 'inspector-a')`,
        [findingId, description, NOW] as readonly SqlValue[],
    );
    assert(res.changes === 1 && res.lastInsertRowid !== null, "action fixture insert failed");
    return Number(res.lastInsertRowid);
}

/** fixture action status move (raw). */
async function setActionStatusRaw(db: SqlAdapter, actionId: number, status: string, closedAt: string | null = null): Promise<void> {
    const res = await db.run(
        "UPDATE corrective_action SET status = ?, closed_at = ?, verified_by = CASE WHEN ? = 'RESOLVED' THEN 'director-a' ELSE NULL END WHERE action_id = ? AND status = 'OPEN'",
        [status, closedAt, status, actionId] as readonly SqlValue[],
    );
    assert(res.changes === 1, `fixture action ${actionId} -> ${status} update failed`);
}

async function visitRow(db: SqlAdapter, visitId: number): Promise<SqlRow> {
    const rows = await db.query("SELECT * FROM visit WHERE visit_id = ?", [visitId]);
    assert(rows.length === 1, `visit ${visitId} missing`);
    return rows[0];
}

async function responseRow(db: SqlAdapter, responseId: number): Promise<SqlRow> {
    const rows = await db.query("SELECT * FROM checklist_response WHERE response_id = ?", [responseId]);
    assert(rows.length === 1, `response ${responseId} missing`);
    return rows[0];
}

async function findingRow(db: SqlAdapter, findingId: number): Promise<SqlRow> {
    const rows = await db.query("SELECT * FROM finding WHERE finding_id = ?", [findingId]);
    assert(rows.length === 1, `finding ${findingId} missing`);
    return rows[0];
}

async function actionRow(db: SqlAdapter, actionId: number): Promise<SqlRow> {
    const rows = await db.query("SELECT * FROM corrective_action WHERE action_id = ?", [actionId]);
    assert(rows.length === 1, `action ${actionId} missing`);
    return rows[0];
}

/** release a definition v2 (supersede ACTIVE v1, insert v2 ACTIVE + values). */
async function releaseDefinitionV2(db: SqlAdapter, itemCode: string): Promise<{ oldId: number; newId: number }> {
    const old = await db.query("SELECT * FROM checklist_item_definition WHERE item_code = ? AND status = 'ACTIVE'", [itemCode]);
    assert(old.length === 1, `expected one ACTIVE definition for ${itemCode}`);
    const o = old[0];
    const oldId = Number(o.item_definition_id);
    await db.run("UPDATE checklist_item_definition SET status = 'SUPERSEDED' WHERE item_definition_id = ?", [oldId]);
    const newRes = await db.run(
        `INSERT INTO checklist_item_definition(item_code, version_no, supersedes_definition_id, effective_from, domain_id,
                                               arabic_question, response_model, priority, traceability, requirement_refs,
                                               note_rule, evidence_rule, finding_rule, applicability_rule, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE')`,
        [
            String(o.item_code),
            Number(o.version_no) + 1,
            oldId,
            o.effective_from,
            String(o.domain_id),
            String(o.arabic_question),
            String(o.response_model),
            String(o.priority),
            String(o.traceability),
            String(o.requirement_refs),
            o.note_rule,
            o.evidence_rule,
            o.finding_rule,
            String(o.applicability_rule),
        ] as readonly SqlValue[],
    );
    assert(newRes.changes === 1 && newRes.lastInsertRowid !== null, "definition v2 insert failed");
    const newId = Number(newRes.lastInsertRowid);
    const vals = await db.query("SELECT * FROM checklist_allowed_value WHERE item_definition_id = ?", [oldId]);
    for (const v of vals) {
        await db.run(
            `INSERT INTO checklist_allowed_value(item_definition_id, value_code, arabic_label, semantic_class, sort_order, active)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [newId, String(v.value_code), String(v.arabic_label), String(v.semantic_class), v.sort_order, v.active] as readonly SqlValue[],
        );
    }
    return { oldId, newId };
}

/** deterministic full-DB snapshot (zero-write proofs). */
async function fullSnapshot(db: SqlAdapter): Promise<string> {
    const visit = await db.query("SELECT * FROM visit ORDER BY visit_id");
    const responses = await db.query("SELECT * FROM checklist_response ORDER BY response_id");
    const recon = await db.query("SELECT * FROM equipment_reconciliation_row ORDER BY row_id");
    const findings = await db.query("SELECT * FROM finding ORDER BY finding_id");
    const followUps = await db.query("SELECT * FROM follow_up ORDER BY followup_id");
    const observations = await db.query("SELECT * FROM adhoc_observation ORDER BY observation_id");
    const actions = await db.query("SELECT * FROM corrective_action ORDER BY action_id");
    return JSON.stringify({ visit, responses, recon, findings, followUps, observations, actions });
}

// ---------------------------------------------------------------------------
// S1 — Visit / basic (GATE 5K §S items 1..7 + extra 73)
// ---------------------------------------------------------------------------
async function tS1_basic(): Promise<void> {
    await ok("G5K-01: missing Visit => E_VISIT_NOT_FOUND", async () => {
        const w = await freshWorld();
        await rejectsCode(APP_ERR.VISIT_NOT_FOUND, () => w.fin.finalizeVisit({ visitId: 999, finalizedAt: FIN }));
    });

    await ok("G5K-02: PREPARATION clean Visit finalizes (applied:true)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await disposeInstitution(w, visitId);
        const res = await w.fin.finalizeVisit({ visitId, finalizedAt: FIN });
        assert(res.applied === true, "applied");
        assert(res.visitId === visitId, "visitId in result");
        assert(res.status === "COMPLETED", "final status COMPLETED");
        assert(res.finalizedAt === FIN, "result finalizedAt");
        const row = await visitRow(w.db, visitId);
        assert(String(row.status) === "COMPLETED", "durable status");
        assert(String(row.finalized_at) === FIN, "durable finalized_at");
    });

    await ok("G5K-03: final status COMPLETED when no NOT_INSPECTED remains (NA never counts)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await disposeInstitution(w, visitId);
        const naCount = await count(
            w.db,
            "SELECT count(*) AS c FROM checklist_response WHERE visit_id = ? AND overlay_state = 'NA'",
            [visitId],
        );
        assert(naCount > 0, "precondition: NA cells exist in this world");
        const res = await w.fin.finalizeVisit({ visitId, finalizedAt: FIN });
        assert(res.status === "COMPLETED", "COMPLETED despite NA cells");
    });

    await ok("G5K-04: final status COMPLETED_WITH_UNINSPECTED with a deliberate NOT_INSPECTED + reason", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await disposeInstitution(w, visitId, ["CHK-006"]);
        await markNotInspectedCell(w, visitId, "CHK-006", "not reachable today");
        const res = await w.fin.finalizeVisit({ visitId, finalizedAt: FIN });
        assert(res.applied === true, "applied");
        assert(res.status === "COMPLETED_WITH_UNINSPECTED", "final status");
        assert(String((await visitRow(w.db, visitId)).status) === "COMPLETED_WITH_UNINSPECTED", "durable status");
    });

    await ok("G5K-05: finalized_at stored as the normalized requested timestamp (trimmed)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await disposeInstitution(w, visitId);
        const res = await w.fin.finalizeVisit({ visitId, finalizedAt: "  2026-09-09T07:00:00Z  " });
        assert(res.applied === true, "applied");
        assert(res.finalizedAt === FIN, "result carries the normalized instant");
        assert(String((await visitRow(w.db, visitId)).finalized_at) === FIN, "durable finalized_at normalized");
    });

    await ok("G5K-06: the caller cannot choose the final status (no status parameter; smuggled values are ignored)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await disposeInstitution(w, visitId, ["CHK-006"]);
        await markNotInspectedCell(w, visitId, "CHK-006", "blocked by construction work");
        const res = await w.fin.finalizeVisit({ visitId, finalizedAt: FIN, status: "COMPLETED" } as never);
        assert(res.status === "COMPLETED_WITH_UNINSPECTED", "the derived status wins over any smuggled request value");
    });

    await ok("G5K-07: the Visit row is otherwise preserved", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await disposeInstitution(w, visitId);
        const before = await visitRow(w.db, visitId);
        await w.fin.finalizeVisit({ visitId, finalizedAt: FIN });
        const after = await visitRow(w.db, visitId);
        for (const col of ["visit_id", "mission_id", "institution_id", "visit_type", "visit_date", "inspector", "started_at", "created_at", "created_by"]) {
            assert(String(after[col] ?? null) === String(before[col] ?? null), `visit column ${col} preserved`);
        }
    });

    await ok("G5K-73: E_VISIT_NOT_PREPARATION on a fabricated not-finalized non-PREPARATION read (unrepresentable at rest — CHECK backstop)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await disposeInstitution(w, visitId);
        const fab = new FabricateReadOnceAdapter(
            w.db,
            (sql) => sql.includes("SELECT status, finalized_at FROM visit"),
            () => [{ status: "COMPLETED", finalized_at: null }],
        );
        const fin = new VisitFinalizationService(fab);
        await rejectsCode(APP_ERR.VISIT_NOT_PREPARATION, () => fin.finalizeVisit({ visitId, finalizedAt: FIN }));
        // the durable row is untouched
        const row = await visitRow(w.db, visitId);
        assert(String(row.status) === "PREPARATION" && row.finalized_at === null, "durable visit untouched");
    });
}

// ---------------------------------------------------------------------------
// S2 — timestamp validation (GATE 5K §S items 8..15)
// ---------------------------------------------------------------------------
async function tS2_timestamps(): Promise<void> {
    const accepted = async (label: string, value: string, expected: string) => {
        await ok(label, async () => {
            const w = await freshWorld();
            const visitId = await standardCreate(w);
            await disposeInstitution(w, visitId);
            const res = await w.fin.finalizeVisit({ visitId, finalizedAt: value });
            assert(res.applied === true && res.finalizedAt === expected, `accepted and stored as '${expected}'`);
        });
    };
    const rejected = async (label: string, value: string) => {
        await ok(label, async () => {
            const w = await freshWorld();
            const visitId = await standardCreate(w);
            await disposeInstitution(w, visitId);
            await rejectsCode(APP_ERR.CONFIG, () => w.fin.finalizeVisit({ visitId, finalizedAt: value }));
            const row = await visitRow(w.db, visitId);
            assert(String(row.status) === "PREPARATION" && row.finalized_at === null, "rejected request writes nothing");
        });
    };

    await accepted("G5K-08: canonical Z accepted", "2026-09-09T07:00:00Z", "2026-09-09T07:00:00Z");
    await accepted("G5K-09: milliseconds accepted", "2026-09-09T07:00:00.000Z", "2026-09-09T07:00:00.000Z");
    await accepted("G5K-10: surrounding whitespace normalized", "  2026-09-09T07:00:00Z  ", "2026-09-09T07:00:00Z");
    await rejected("G5K-11: arbitrary non-date rejected", "not-a-date");
    await rejected("G5K-12: date-only rejected", "2026-09-09");
    await rejected("G5K-13: timezone-less datetime rejected", "2026-09-09T07:00:00");
    await rejected("G5K-14: offset timestamp rejected", "2026-09-09T07:00:00+01:00");
    await rejected("G5K-15a: impossible calendar date rejected", "2026-02-30T07:00:00Z");
    await rejected("G5K-15b: impossible time rejected", "2026-09-09T25:00:00Z");
    await rejected("G5K-15c: impossible month rejected", "2026-13-01T00:00:00Z");
}

// ---------------------------------------------------------------------------
// S3 — scope-grid self-check (GATE 5K §S items 16..21)
// ---------------------------------------------------------------------------
async function tS3_grid(): Promise<void> {
    await ok("G5K-16: full captured grid (institution + subject) succeeds", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const subjectId = await addWorkshopSubject(w, visitId);
        await disposeInstitution(w, visitId);
        await disposeWorkshop(w, visitId, subjectId);
        const res = await w.fin.finalizeVisit({ visitId, finalizedAt: FIN });
        assert(res.applied === true && res.status === "COMPLETED", "full grid finalizes COMPLETED");
    });

    await ok("G5K-17: missing institution cell => E_SCOPE_GAP (the shrunk universe surfaces the surviving cell)", async () => {
        const w = await freshWorld();
        // raw world: the institution grid is composed with 19 of the 20 P0
        // codes (CHK-001 missing), so the captured universe = 19 definitions;
        // the subject grid then carries the full 20-code set — CHK-001's
        // subject cell is outside the captured universe => E_SCOPE_GAP.
        const visitId = await insertVisitRaw(w.db, w.missionId, w.institutionId);
        const codes = EXPECTED_P0.filter((c) => c !== "CHK-001");
        for (const code of codes) {
            await insertCellRaw(w.db, visitId, await activeDefId(w.db, code), null, "NOT_INSPECTED");
        }
        const subjectId = await insertSubjectRaw(w.db, w.institutionId, "WORKSHOP", "W1");
        for (const code of EXPECTED_P0) {
            await insertCellRaw(w.db, visitId, await activeDefId(w.db, code), subjectId, "NOT_INSPECTED");
        }
        const err = await rejectsCode(APP_ERR.SCOPE_GAP, () => w.fin.finalizeVisit({ visitId, finalizedAt: FIN }));
        const blockers = (err as { blockers?: FinalizationBlocker[] }).blockers ?? [];
        assert(blockers.length > 0, "blockers payload present");
        const chk001 = blockers.find((b) => b.itemCode === "CHK-001");
        assert(chk001 !== undefined && chk001.kind === "extra-cell", "CHK-001 survivor identified as an extra captured cell");
    });

    await ok("G5K-18: missing subject cell => E_SCOPE_GAP (missing-cell identified)", async () => {
        const w = await freshWorld();
        const visitId = await insertVisitRaw(w.db, w.missionId, w.institutionId);
        const pinned = new Map<string, number>();
        for (const code of EXPECTED_P0) {
            const defId = await activeDefId(w.db, code);
            pinned.set(code, defId);
            await insertCellRaw(w.db, visitId, defId, null, "NOT_INSPECTED");
        }
        const subjectId = await insertSubjectRaw(w.db, w.institutionId, "WORKSHOP", "W1");
        for (const code of EXPECTED_P0) {
            if (code === "CHK-005") continue; // the missing subject cell
            await insertCellRaw(w.db, visitId, pinned.get(code) as number, subjectId, "NOT_INSPECTED");
        }
        const err = await rejectsCode(APP_ERR.SCOPE_GAP, () => w.fin.finalizeVisit({ visitId, finalizedAt: FIN }));
        const blockers = (err as { blockers?: FinalizationBlocker[] }).blockers ?? [];
        const missing = blockers.filter((b) => b.kind === "missing-cell");
        assert(missing.length === 1, `exactly one missing cell, got ${missing.length}`);
        assert(missing[0].itemCode === "CHK-005" && missing[0].subjectId === subjectId, "missing-cell identifies CHK-005 @ subject");
        assert(missing[0].itemDefinitionId === pinned.get("CHK-005"), "missing-cell carries the pinned definition");
    });

    await ok("G5K-19: partial subject grid => E_SCOPE_GAP (never silently repaired)", async () => {
        const w = await freshWorld();
        const visitId = await insertVisitRaw(w.db, w.missionId, w.institutionId);
        const pinned = new Map<string, number>();
        for (const code of EXPECTED_P0) {
            const defId = await activeDefId(w.db, code);
            pinned.set(code, defId);
            await insertCellRaw(w.db, visitId, defId, null, "NOT_INSPECTED");
        }
        const subjectId = await insertSubjectRaw(w.db, w.institutionId, "WORKSHOP", "W1");
        const half = EXPECTED_P0.slice(0, 10);
        for (const code of half) {
            await insertCellRaw(w.db, visitId, pinned.get(code) as number, subjectId, "NOT_INSPECTED");
        }
        const err = await rejectsCode(APP_ERR.SCOPE_GAP, () => w.fin.finalizeVisit({ visitId, finalizedAt: FIN }));
        const blockers = (err as { blockers?: FinalizationBlocker[] }).blockers ?? [];
        const missing = blockers.filter((b) => b.kind === "missing-cell");
        assert(missing.length === EXPECTED_P0.length - half.length, `all ${EXPECTED_P0.length - half.length} missing cells reported`);
    });

    await ok("G5K-20: extra/mismatched captured cell/context => E_SCOPE_GAP (subject-context version mismatch)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        // the institution context pins CHK-001 v1; a NEW ACTIVE v2 is released
        // afterwards, and a raw subject cell is then pinned to v2 — that cell
        // is outside the captured universe (version/context mismatch) =>
        // E_SCOPE_GAP. (An extra INSTITUTION-context row would by definition
        // enlarge the captured universe itself, so the mismatch fixture lives
        // in a subject context.)
        const { newId } = await releaseDefinitionV2(w.db, "CHK-001");
        const subjectId = await insertSubjectRaw(w.db, w.institutionId, "WORKSHOP", "W1");
        await insertCellRaw(w.db, visitId, newId, subjectId, "NOT_INSPECTED");
        const err = await rejectsCode(APP_ERR.SCOPE_GAP, () => w.fin.finalizeVisit({ visitId, finalizedAt: FIN }));
        const blockers = (err as { blockers?: FinalizationBlocker[] }).blockers ?? [];
        const extra = blockers.filter((b) => b.kind === "extra-cell");
        assert(extra.length === 1, `exactly one extra cell, got ${extra.length}`);
        assert(extra[0].itemCode === "CHK-001" && extra[0].subjectId === subjectId, "extra-cell identifies CHK-001 @ subject");
        assert(extra[0].itemDefinitionId === newId, "the v2 definition is the mismatched pinned version");
        assert(extra[0].responseId !== null && extra[0].responseId !== undefined, "extra-cell carries its responseId");
    });

    await ok("G5K-21: a later ACTIVE definition release does NOT enter an old Visit's expected finalization universe", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const { oldId, newId } = await releaseDefinitionV2(w.db, "CHK-005");
        // a subject added AFTER the release must reuse the PINNED v1 ids
        const subjectId = await addWorkshopSubject(w, visitId);
        const subjectDefs = await w.db.query(
            `SELECT DISTINCT item_definition_id FROM checklist_response WHERE visit_id = ? AND subject_id = ?`,
            [visitId, subjectId],
        );
        assert(subjectDefs.length === EXPECTED_P0.length, "subject grid is full");
        assert(subjectDefs.every((r) => Number(r.item_definition_id) !== newId), "subject grid pins only v1 definitions");
        assert(subjectDefs.some((r) => Number(r.item_definition_id) === oldId), "CHK-005 v1 pinned");
        await disposeInstitution(w, visitId);
        await disposeWorkshop(w, visitId, subjectId);
        const res = await w.fin.finalizeVisit({ visitId, finalizedAt: FIN });
        assert(res.applied === true && res.status === "COMPLETED", "the old universe finalizes untouched by the release");
        const allDefs = await w.db.query(
            `SELECT DISTINCT item_definition_id FROM checklist_response WHERE visit_id = ?`,
            [visitId],
        );
        assert(allDefs.every((r) => Number(r.item_definition_id) !== newId), "no v2 definition entered the finalized Visit");
    });
}

// ---------------------------------------------------------------------------
// S4 — unresolved pending (GATE 5K §S items 22..24)
// ---------------------------------------------------------------------------
async function tS4_pending(): Promise<void> {
    await ok("G5K-22: reason-less pending cell => E_UNRESOLVED_PENDING (identified)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await disposeInstitution(w, visitId, ["CHK-006"]);
        const cell = await cellOf(w.db, visitId, null, "CHK-006");
        const rid = await responseIdOf(w.db, cell);
        const err = await rejectsCode(APP_ERR.UNRESOLVED_PENDING, () => w.fin.finalizeVisit({ visitId, finalizedAt: FIN }));
        const blockers = (err as { blockers?: FinalizationBlocker[] }).blockers ?? [];
        const pending = blockers.filter((b) => b.kind === "unresolved-pending");
        assert(pending.length === 1 && pending[0].itemCode === "CHK-006" && pending[0].responseId === rid, "pending cell identified");
    });

    await ok("G5K-23: unresolved HUMAN_CONFIRMATION cell => E_UNRESOLVED_PENDING", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await disposeInstitution(w, visitId, ["CHK-020"]);
        const err = await rejectsCode(APP_ERR.UNRESOLVED_PENDING, () => w.fin.finalizeVisit({ visitId, finalizedAt: FIN }));
        const blockers = (err as { blockers?: FinalizationBlocker[] }).blockers ?? [];
        const pending = blockers.filter((b) => b.kind === "unresolved-pending");
        assert(pending.length === 1 && pending[0].itemCode === "CHK-020", "unresolved HUMAN cell identified");
    });

    await ok("G5K-24: a pending blocker leaves the Visit PREPARATION", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await disposeInstitution(w, visitId, ["CHK-006"]);
        await rejectsCode(APP_ERR.UNRESOLVED_PENDING, () => w.fin.finalizeVisit({ visitId, finalizedAt: FIN }));
        const row = await visitRow(w.db, visitId);
        assert(String(row.status) === "PREPARATION" && row.finalized_at === null, "Visit remains PREPARATION and unfinalized");
    });
}

// ---------------------------------------------------------------------------
// S5 — NOT_INSPECTED reason (GATE 5K §S items 25..28)
// ---------------------------------------------------------------------------
async function tS5_notInspected(): Promise<void> {
    await ok("G5K-25: deliberate NOT_INSPECTED with a meaningful reason is allowed", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await disposeInstitution(w, visitId, ["CHK-006"]);
        await markNotInspectedCell(w, visitId, "CHK-006", "equipment room locked");
        const res = await w.fin.finalizeVisit({ visitId, finalizedAt: FIN });
        assert(res.applied === true && res.status === "COMPLETED_WITH_UNINSPECTED", "finalizes CWU");
    });

    await ok("G5K-26: malformed/blank reason => E_UNINSPECTED_NEEDS_REASON ('' and whitespace representable at rest)", async () => {
        for (const bad of ["", "   "]) {
            const w = await freshWorld();
            const visitId = await standardCreate(w);
            await disposeInstitution(w, visitId, ["CHK-006"]);
            await markNotInspectedCell(w, visitId, "CHK-006", "temporary reason");
            const rid = await responseIdOf(w.db, await cellOf(w.db, visitId, null, "CHK-006"));
            await w.db.run("UPDATE checklist_response SET not_inspected_reason = ? WHERE response_id = ?", [bad, rid]);
            const err = await rejectsCode(APP_ERR.UNINSPECTED_NEEDS_REASON, () => w.fin.finalizeVisit({ visitId, finalizedAt: FIN }));
            const blockers = (err as { blockers?: FinalizationBlocker[] }).blockers ?? [];
            const reason = blockers.filter((b) => b.kind === "blank-not-inspected-reason");
            assert(reason.length === 1 && reason[0].responseId === rid && reason[0].itemCode === "CHK-006", "blank-reason cell identified");
            const row = await visitRow(w.db, visitId);
            assert(String(row.status) === "PREPARATION", "Visit stays PREPARATION");
        }
    });

    await ok("G5K-27: NOT_INSPECTED contributes to COMPLETED_WITH_UNINSPECTED", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await disposeInstitution(w, visitId, ["CHK-006", "CHK-010"]);
        await markNotInspectedCell(w, visitId, "CHK-006", "first reason");
        await markNotInspectedCell(w, visitId, "CHK-010", "second reason");
        const res = await w.fin.finalizeVisit({ visitId, finalizedAt: FIN });
        assert(res.status === "COMPLETED_WITH_UNINSPECTED", "two deliberate NI cells => CWU");
    });

    await ok("G5K-28: NA does NOT contribute to COMPLETED_WITH_UNINSPECTED", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await disposeInstitution(w, visitId);
        const naCount = await count(w.db, "SELECT count(*) AS c FROM checklist_response WHERE visit_id = ? AND overlay_state = 'NA'", [visitId]);
        assert(naCount >= 13, "precondition: many NA cells");
        const res = await w.fin.finalizeVisit({ visitId, finalizedAt: FIN });
        assert(res.status === "COMPLETED", "NA-only remainder finalizes COMPLETED");
    });
}

// ---------------------------------------------------------------------------
// S6 — NON_COMPLIANT accountability / note (GATE 5K §S items 29..32)
// ---------------------------------------------------------------------------
async function tS6_nc(): Promise<void> {
    await ok("G5K-29: NON_COMPLIANT without finding link => E_NC_UNACCOUNTED (fabricated read; DB backstop in G5K-74)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await disposeInstitution(w, visitId, ["CHK-006"]);
        await answerNcCell(w, visitId, "CHK-006", "IRREGULAR", "records not kept since May");
        const fab = new FabricateReadOnceAdapter(
            w.db,
            (sql) => sql.includes("av.semantic_class = 'NON_COMPLIANT'"),
            (rows) => rows.map((r) => ({ ...r, finding_id: null })),
        );
        const fin = new VisitFinalizationService(fab);
        const err = await rejectsCode(APP_ERR.NC_UNACCOUNTED, () => fin.finalizeVisit({ visitId, finalizedAt: FIN }));
        const blockers = (err as { blockers?: FinalizationBlocker[] }).blockers ?? [];
        const un = blockers.filter((b) => b.kind === "nc-unaccounted");
        assert(un.length === 1 && un[0].itemCode === "CHK-006", "the unlinked NC cell is identified");
        // the durable link is untouched by the blocked attempt
        const rid = await responseIdOf(w.db, await cellOf(w.db, visitId, null, "CHK-006"));
        assert((await responseRow(w.db, rid)).finding_id !== null, "durable finding link untouched");
    });

    await ok("G5K-30: NON_COMPLIANT without meaningful note => E_NC_NEEDS_NOTE", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await disposeInstitution(w, visitId, ["CHK-006"]);
        const findingId = await answerNcCell(w, visitId, "CHK-006", "IRREGULAR", "records not kept since May");
        const rid = await responseIdOf(w.db, await cellOf(w.db, visitId, null, "CHK-006"));
        await w.db.run("UPDATE checklist_response SET note = NULL WHERE response_id = ?", [rid]);
        const err = await rejectsCode(APP_ERR.NC_NEEDS_NOTE, () => w.fin.finalizeVisit({ visitId, finalizedAt: FIN }));
        const blockers = (err as { blockers?: FinalizationBlocker[] }).blockers ?? [];
        const needs = blockers.filter((b) => b.kind === "nc-needs-note");
        assert(needs.length === 1 && needs[0].responseId === rid && needs[0].findingId === findingId, "the note-less NC cell is identified with its finding");
    });

    await ok("G5K-31: valid NC + Finding + note succeeds", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await disposeInstitution(w, visitId, ["CHK-006"]);
        const findingId = await answerNcCell(w, visitId, "CHK-006", "IRREGULAR", "records not kept since May");
        const res = await w.fin.finalizeVisit({ visitId, finalizedAt: FIN });
        assert(res.applied === true && res.status === "COMPLETED", "NC cell with finding + note finalizes");
        const rid = await responseIdOf(w.db, await cellOf(w.db, visitId, null, "CHK-006"));
        const row = await responseRow(w.db, rid);
        assert(Number(row.finding_id) === findingId, "finding link preserved");
        assert(String(row.note) === "records not kept since May", "note preserved");
    });

    await ok("G5K-32: finalization never creates a Finding and never writes a note", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await disposeInstitution(w, visitId, ["CHK-006"]);
        await answerNcCell(w, visitId, "CHK-006", "IRREGULAR", "records not kept since May");
        const beforeFindings = await count(w.db, "SELECT count(*) AS c FROM finding");
        const rid = await responseIdOf(w.db, await cellOf(w.db, visitId, null, "CHK-006"));
        await w.fin.finalizeVisit({ visitId, finalizedAt: FIN });
        assert((await count(w.db, "SELECT count(*) AS c FROM finding")) === beforeFindings, "no Finding created");
        const row = await responseRow(w.db, rid);
        assert(String(row.note) === "records not kept since May", "note unchanged (never auto-written)");
    });
}

// ---------------------------------------------------------------------------
// S7 — SCHEDULE / CHK-012 consistency (GATE 5K §S items 33..38)
// ---------------------------------------------------------------------------
async function tS7_schedule(): Promise<void> {
    await ok("G5K-33: valid SCHEDULE state succeeds (COMPLIANT + zero-difference rows)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await disposeInstitution(w, visitId);
        const res = await w.fin.finalizeVisit({ visitId, finalizedAt: FIN });
        assert(res.applied === true && res.status === "COMPLETED", "valid schedule finalizes");
    });

    await ok("G5K-34: malformed schedule state => E_CHK012 (blank category, representable at rest)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await disposeInstitution(w, visitId);
        const cell = await cellOf(w.db, visitId, null, "CHK-012");
        const rid = await responseIdOf(w.db, cell);
        const rows = await w.db.query("SELECT row_id FROM equipment_reconciliation_row WHERE response_id = ? ORDER BY row_id", [rid]);
        assert(rows.length === 2, "precondition: two zero-difference rows");
        await w.db.run("UPDATE equipment_reconciliation_row SET category = '  ' WHERE row_id = ?", [Number(rows[0].row_id)]);
        const err = await rejectsCode(APP_ERR.CHK012, () => w.fin.finalizeVisit({ visitId, finalizedAt: FIN }));
        const blockers = (err as { blockers?: FinalizationBlocker[] }).blockers ?? [];
        const bad = blockers.filter((b) => b.kind === "schedule-blank-category");
        assert(bad.length === 1 && bad[0].rowId === Number(rows[0].row_id), "the blank-category row is identified");
    });

    await ok("G5K-35: COMPLIANT + discrepancy row rejected (fabricated read; the trigger pair makes it unrepresentable at rest)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await disposeInstitution(w, visitId);
        const fab = new FabricateReadOnceAdapter(
            w.db,
            (sql) => sql.includes("FROM equipment_reconciliation_row") && sql.includes("WHERE response_id = ?") && !sql.includes("JOIN"),
            (rows) => [
                ...rows,
                {
                    row_id: 9999,
                    category: "ghost-discrepancy",
                    declared_qty: 1,
                    observed_qty: 2,
                    difference: 1,
                    discrepancy_type: "QTY_SHORTAGE",
                    discrepancy_desc: null,
                },
            ],
        );
        const fin = new VisitFinalizationService(fab);
        const err = await rejectsCode(APP_ERR.CHK012, () => fin.finalizeVisit({ visitId, finalizedAt: FIN }));
        const blockers = (err as { blockers?: FinalizationBlocker[] }).blockers ?? [];
        const bad = blockers.filter((b) => b.kind === "schedule-compliant-with-discrepancy");
        assert(bad.length === 1, "COMPLIANT + discrepancy is blocked");
    });

    await ok("G5K-36: overlay + reconciliation rows rejected (fabricated read; triggers make it unrepresentable at rest)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await disposeInstitution(w, visitId);
        const fab = new FabricateReadOnceAdapter(
            w.db,
            (sql) => sql.includes("response_model = 'SCHEDULE'") && sql.includes("overlay_state"),
            (rows) => rows.map((r) => ({ ...r, overlay_state: "NOT_INSPECTED", overall_class: null })),
        );
        const fin = new VisitFinalizationService(fab);
        const err = await rejectsCode(APP_ERR.CHK012, () => fin.finalizeVisit({ visitId, finalizedAt: FIN }));
        const blockers = (err as { blockers?: FinalizationBlocker[] }).blockers ?? [];
        const bad = blockers.filter((b) => b.kind === "schedule-overlay-with-rows");
        assert(bad.length === 1, "overlay + rows is blocked");
    });

    await ok("G5K-37: inconsistent difference state rejected (fabricated read; CHECK backstop in G5K-75)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await disposeInstitution(w, visitId);
        const fab = new FabricateReadOnceAdapter(
            w.db,
            (sql) => sql.includes("FROM equipment_reconciliation_row") && sql.includes("WHERE response_id = ?") && !sql.includes("JOIN"),
            (rows) => rows.map((r, i) => (i === 0 ? { ...r, difference: Number(r.difference) + 5 } : r)),
        );
        const fin = new VisitFinalizationService(fab);
        const err = await rejectsCode(APP_ERR.CHK012, () => fin.finalizeVisit({ visitId, finalizedAt: FIN }));
        const blockers = (err as { blockers?: FinalizationBlocker[] }).blockers ?? [];
        const bad = blockers.filter((b) => b.kind === "schedule-bad-difference");
        assert(bad.length === 1, "difference != observed - declared is blocked");
    });

    await ok("G5K-38: T11 never mutates reconciliation rows", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await disposeInstitution(w, visitId);
        const cell = await cellOf(w.db, visitId, null, "CHK-012");
        const rid = await responseIdOf(w.db, cell);
        const before = await w.db.query("SELECT * FROM equipment_reconciliation_row WHERE response_id = ? ORDER BY row_id", [rid]);
        await w.fin.finalizeVisit({ visitId, finalizedAt: FIN });
        const after = await w.db.query("SELECT * FROM equipment_reconciliation_row WHERE response_id = ? ORDER BY row_id", [rid]);
        assert(JSON.stringify(after) === JSON.stringify(before), "reconciliation rows byte-identical after finalization");
    });
}

// ---------------------------------------------------------------------------
// S8 — Finding / orphan (GATE 5K §S items 39..45)
// ---------------------------------------------------------------------------
async function tS8_finding(): Promise<void> {
    await ok("G5K-39: source-less OPEN origin Finding => E_ORPHAN_FINDING (identified)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await disposeInstitution(w, visitId);
        const fid = await insertFindingRaw(w.db, visitId);
        const err = await rejectsCode(APP_ERR.ORPHAN_FINDING, () => w.fin.finalizeVisit({ visitId, finalizedAt: FIN }));
        const blockers = (err as { blockers?: FinalizationBlocker[] }).blockers ?? [];
        assert(blockers.length === 1 && blockers[0].findingId === fid && blockers[0].kind === "orphan-finding", "orphan finding identified");
        const row = await visitRow(w.db, visitId);
        assert(String(row.status) === "PREPARATION", "Visit stays PREPARATION");
    });

    await ok("G5K-40: OPEN response-sourced Finding does not block", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await disposeInstitution(w, visitId, ["CHK-006"]);
        await answerNcCell(w, visitId, "CHK-006", "IRREGULAR", "records not kept since May");
        const res = await w.fin.finalizeVisit({ visitId, finalizedAt: FIN });
        assert(res.applied === true, "response-sourced OPEN finding finalizes");
    });

    await ok("G5K-41: OPEN observation-sourced Finding does not block", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await disposeInstitution(w, visitId);
        const obs = await w.obs.createAdHocObservation({
            visitId,
            text: "leak observed in the corridor",
            recordedAt: NOW,
            recordedBy: "inspector-a",
        });
        await w.obsFinding.createFindingWithObservationSource({
            observationId: obs.observationId,
            finding: {
                description: "ceiling leak in the corridor",
                defectType: "WATER_LEAK",
                location: "corridor",
                urgency: "IMMEDIATE",
                impact: "HIGH",
            },
            actor: "inspector-a",
            now: NOW,
        });
        const res = await w.fin.finalizeVisit({ visitId, finalizedAt: FIN });
        assert(res.applied === true, "observation-sourced OPEN finding finalizes");
    });

    await ok("G5K-42: IN_TREATMENT Finding does not block", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await disposeInstitution(w, visitId, ["CHK-006"]);
        const fid = await answerNcCell(w, visitId, "CHK-006", "IRREGULAR", "records not kept since May");
        await setFindingStatusRaw(w.db, fid, "IN_TREATMENT");
        const res = await w.fin.finalizeVisit({ visitId, finalizedAt: FIN });
        assert(res.applied === true, "IN_TREATMENT finding finalizes");
    });

    await ok("G5K-43: RESOLVED Finding does not block", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await disposeInstitution(w, visitId, ["CHK-006"]);
        const fid = await answerNcCell(w, visitId, "CHK-006", "IRREGULAR", "records not kept since May");
        await setFindingStatusRaw(w.db, fid, "RESOLVED");
        const res = await w.fin.finalizeVisit({ visitId, finalizedAt: FIN });
        assert(res.applied === true, "RESOLVED finding finalizes");
    });

    await ok("G5K-44: source-less VOIDED Finding does not block (expected source-less, Gate 4B)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await disposeInstitution(w, visitId);
        const fid = await insertFindingRaw(w.db, visitId);
        await setFindingVoidedRaw(w.db, fid);
        const res = await w.fin.finalizeVisit({ visitId, finalizedAt: FIN });
        assert(res.applied === true && res.status === "COMPLETED", "source-less VOIDED finding is not an orphan");
    });

    await ok("G5K-45: T11 does not transition any Finding", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await disposeInstitution(w, visitId, ["CHK-006"]);
        const fid = await answerNcCell(w, visitId, "CHK-006", "IRREGULAR", "records not kept since May");
        const before = await findingRow(w.db, fid);
        await w.fin.finalizeVisit({ visitId, finalizedAt: FIN });
        const after = await findingRow(w.db, fid);
        assert(String(after.status) === String(before.status), "finding status unchanged");
        assert(String(after.status_changed_at ?? null) === String(before.status_changed_at ?? null), "status_changed_at unchanged");
    });
}

// ---------------------------------------------------------------------------
// S9 — CorrectiveActions are never finalization blockers (GATE 5K §S 46..49)
// ---------------------------------------------------------------------------
async function tS9_actions(): Promise<void> {
    await ok("G5K-46: OPEN CorrectiveAction does not block finalization", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await disposeInstitution(w, visitId, ["CHK-006"]);
        const fid = await answerNcCell(w, visitId, "CHK-006", "IRREGULAR", "records not kept since May");
        await insertActionRaw(w.db, fid);
        const res = await w.fin.finalizeVisit({ visitId, finalizedAt: FIN });
        assert(res.applied === true, "OPEN action does not block");
    });

    await ok("G5K-47: IN_TREATMENT CorrectiveAction does not block", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await disposeInstitution(w, visitId, ["CHK-006"]);
        const fid = await answerNcCell(w, visitId, "CHK-006", "IRREGULAR", "records not kept since May");
        const aid = await insertActionRaw(w.db, fid);
        await setActionStatusRaw(w.db, aid, "IN_TREATMENT");
        const res = await w.fin.finalizeVisit({ visitId, finalizedAt: FIN });
        assert(res.applied === true, "IN_TREATMENT action does not block");
    });

    await ok("G5K-48: RESOLVED CorrectiveAction does not block", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await disposeInstitution(w, visitId, ["CHK-006"]);
        const fid = await answerNcCell(w, visitId, "CHK-006", "IRREGULAR", "records not kept since May");
        const aid = await insertActionRaw(w.db, fid);
        await setActionStatusRaw(w.db, aid, "RESOLVED", FIN);
        const res = await w.fin.finalizeVisit({ visitId, finalizedAt: FIN });
        assert(res.applied === true, "RESOLVED action does not block");
    });

    await ok("G5K-49: T11 does not transition/close any action", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await disposeInstitution(w, visitId, ["CHK-006"]);
        const fid = await answerNcCell(w, visitId, "CHK-006", "IRREGULAR", "records not kept since May");
        const aid = await insertActionRaw(w.db, fid);
        const before = await actionRow(w.db, aid);
        await w.fin.finalizeVisit({ visitId, finalizedAt: FIN });
        const after = await actionRow(w.db, aid);
        assert(String(after.status) === String(before.status), "action status unchanged");
        assert(String(after.closed_at ?? null) === String(before.closed_at ?? null), "closed_at unchanged");
        assert(String(after.verified_by ?? null) === String(before.verified_by ?? null), "verified_by unchanged");
    });
}

// ---------------------------------------------------------------------------
// S10 — structured blocker list (GATE 5K §S items 50..53)
// ---------------------------------------------------------------------------
async function tS10_blockers(): Promise<void> {
    /** world with four simultaneous blocker types (deterministic fixture). */
    async function multiBlockerWorld(): Promise<{ w: World; visitId: number; ids: { pendingRid: number; reasonRid: number; ncRid: number; orphanFid: number } }> {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await disposeInstitution(w, visitId, ["CHK-006", "CHK-007", "CHK-010"]);
        // blocker 1: CHK-006 stays reason-less pending
        const pendingRid = await responseIdOf(w.db, await cellOf(w.db, visitId, null, "CHK-006"));
        // blocker 2: CHK-007 deliberate NOT_INSPECTED with a blank reason
        await markNotInspectedCell(w, visitId, "CHK-007", "temporary");
        const reasonRid = await responseIdOf(w.db, await cellOf(w.db, visitId, null, "CHK-007"));
        await w.db.run("UPDATE checklist_response SET not_inspected_reason = '' WHERE response_id = ?", [reasonRid]);
        // blocker 3: CHK-010 NON_COMPLIANT with a Finding but a stripped note
        const orphanFid = await answerNcCell(w, visitId, "CHK-010", "NOT_AVAILABLE", "extinguishers missing");
        const ncRid = await responseIdOf(w.db, await cellOf(w.db, visitId, null, "CHK-010"));
        await w.db.run("UPDATE checklist_response SET note = NULL WHERE response_id = ?", [ncRid]);
        // blocker 4: a source-less OPEN origin Finding
        const extraFid = await insertFindingRaw(w.db, visitId, "another uncovered defect");
        return { w, visitId, ids: { pendingRid, reasonRid, ncRid, orphanFid: extraFid } };
    }

    await ok("G5K-50: multiple simultaneous blocker types are all returned in one attempt", async () => {
        const { w, visitId } = await multiBlockerWorld();
        const err = await rejectsCode(APP_ERR.UNRESOLVED_PENDING, () => w.fin.finalizeVisit({ visitId, finalizedAt: FIN }));
        const blockers = (err as { blockers?: FinalizationBlocker[] }).blockers ?? [];
        const codes = blockers.map((b) => b.code);
        const expected = [APP_ERR.UNRESOLVED_PENDING, APP_ERR.UNINSPECTED_NEEDS_REASON, APP_ERR.NC_NEEDS_NOTE, APP_ERR.ORPHAN_FINDING];
        assert(codes.join(",") === expected.join(","), `complete deterministic list, got [${codes.join(", ")}]`);
    });

    await ok("G5K-51: blocker ordering is deterministic across identical worlds", async () => {
        const a = await multiBlockerWorld();
        const b = await multiBlockerWorld();
        const errA = await rejectsCode(APP_ERR.UNRESOLVED_PENDING, () => a.w.fin.finalizeVisit({ visitId: a.visitId, finalizedAt: FIN }));
        const errB = await rejectsCode(APP_ERR.UNRESOLVED_PENDING, () => b.w.fin.finalizeVisit({ visitId: b.visitId, finalizedAt: FIN }));
        const seqA = JSON.stringify(((errA as { blockers?: FinalizationBlocker[] }).blockers ?? []).map((x) => [x.code, x.kind, x.itemCode ?? x.findingId ?? null]));
        const seqB = JSON.stringify(((errB as { blockers?: FinalizationBlocker[] }).blockers ?? []).map((x) => [x.code, x.kind, x.itemCode ?? x.findingId ?? null]));
        assert(seqA === seqB, "identical worlds produce identical blocker sequences");
    });

    await ok("G5K-52: blocker payload identifies durable problem records", async () => {
        const { w, visitId, ids } = await multiBlockerWorld();
        const err = await rejectsCode(APP_ERR.UNRESOLVED_PENDING, () => w.fin.finalizeVisit({ visitId, finalizedAt: FIN }));
        const blockers = (err as { blockers?: FinalizationBlocker[] }).blockers ?? [];
        const byKind = new Map(blockers.map((b) => [b.kind, b]));
        const pending = byKind.get("unresolved-pending");
        assert(pending !== undefined && pending.responseId === ids.pendingRid && pending.itemCode === "CHK-006", "pending blocker locates the cell");
        const reason = byKind.get("blank-not-inspected-reason");
        assert(reason !== undefined && reason.responseId === ids.reasonRid && reason.itemCode === "CHK-007", "reason blocker locates the cell");
        const needs = byKind.get("nc-needs-note");
        assert(needs !== undefined && needs.responseId === ids.ncRid && needs.itemCode === "CHK-010", "note blocker locates the cell");
        const orphan = byKind.get("orphan-finding");
        assert(orphan !== undefined && orphan.findingId === ids.orphanFid, "orphan blocker locates the finding");
        assert(blockers.every((b) => b.visitId === visitId), "every blocker carries the visitId");
    });

    await ok("G5K-53: a blocker attempt performs zero writes (rollback, no run(), no commit)", async () => {
        const { w, visitId } = await multiBlockerWorld();
        const before = await fullSnapshot(w.db);
        const rec = new RecordingAdapter(w.db);
        const fin = new VisitFinalizationService(rec);
        await rejectsCode(APP_ERR.UNRESOLVED_PENDING, () => fin.finalizeVisit({ visitId, finalizedAt: FIN }));
        const after = await fullSnapshot(w.db);
        assert(after === before, "durable state byte-identical after the blocked attempt");
        assert(rec.calls.includes("beginImmediate") && rec.calls.includes("rollback"), "BEGIN IMMEDIATE then ROLLBACK");
        assert(!rec.calls.includes("commit"), "never COMMIT on blockers");
        assert(!rec.calls.includes("run"), "zero write statements issued (SELECT-only preflight)");
    });
}

// ---------------------------------------------------------------------------
// S11 — atomicity / TOCTOU (GATE 5K §S items 54..58)
// ---------------------------------------------------------------------------
async function tS11_atomicity(): Promise<void> {
    const finalUpdate = (sql: string): boolean => sql.includes("UPDATE visit") && sql.includes("finalized_at");

    await ok("G5K-54: injected failure before the guarded final UPDATE leaves the Visit PREPARATION", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await disposeInstitution(w, visitId);
        const fault = new FaultAdapter(w.db, finalUpdate);
        const fin = new VisitFinalizationService(fault);
        await rejectsAny(() => fin.finalizeVisit({ visitId, finalizedAt: FIN }));
        const row = await visitRow(w.db, visitId);
        assert(String(row.status) === "PREPARATION" && row.finalized_at === null, "Visit stays PREPARATION and unfinalized");
    });

    await ok("G5K-55: guarded final UPDATE changes==0 => ROLLBACK (never COMMIT) then durable re-read", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await disposeInstitution(w, visitId);
        const rec = new RecordingAdapter(w.db);
        const fake = new FakeChangesAdapter(rec, finalUpdate);
        const fin = new VisitFinalizationService(fake);
        await rejectsCode(APP_ERR.STATE_CONFLICT, () => fin.finalizeVisit({ visitId, finalizedAt: FIN }));
        assert(rec.calls.includes("rollback") && !rec.calls.includes("commit"), "zero-row UPDATE rolled back, never committed");
        const row = await visitRow(w.db, visitId);
        assert(String(row.status) === "PREPARATION" && row.finalized_at === null, "durable Visit untouched");
    });

    await ok("G5K-56: zero-row convergence to an already-finalized durable Visit => applied:false", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await disposeInstitution(w, visitId);
        await w.fin.finalizeVisit({ visitId, finalizedAt: FIN });
        // a fabricated stale PREPARATION read simulates the race the B5 guard
        // defends: the in-tx read believes PREPARATION, but the durable row is
        // already finalized — the guarded UPDATE affects 0 rows and the
        // durable re-read converges on the existing final state.
        const fab = new FabricateReadOnceAdapter(
            w.db,
            (sql) => sql.includes("SELECT status, finalized_at FROM visit"),
            () => [{ status: "PREPARATION", finalized_at: null }],
        );
        const fin = new VisitFinalizationService(fab);
        const res = await fin.finalizeVisit({ visitId, finalizedAt: FIN2 });
        assert(res.applied === false, "converged, not applied");
        assert(res.status === "COMPLETED" && res.finalizedAt === FIN, "durable final state returned");
        const row = await visitRow(w.db, visitId);
        assert(String(row.finalized_at) === FIN, "durable finalized_at untouched");
    });

    await ok("G5K-57: zero-row conflicting durable state => E_STATE_CONFLICT", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await disposeInstitution(w, visitId);
        const fake = new FakeChangesAdapter(w.db, finalUpdate);
        const fin = new VisitFinalizationService(fake);
        await rejectsCode(APP_ERR.STATE_CONFLICT, () => fin.finalizeVisit({ visitId, finalizedAt: FIN }));
        const row = await visitRow(w.db, visitId);
        assert(String(row.status) === "PREPARATION" && row.finalized_at === null, "no partial state committed");
    });

    await ok("G5K-58: no partial finalization state exists after any failed attempt", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await disposeInstitution(w, visitId, ["CHK-006"]);
        const before = await fullSnapshot(w.db);
        await rejectsCode(APP_ERR.UNRESOLVED_PENDING, () => w.fin.finalizeVisit({ visitId, finalizedAt: FIN }));
        const after = await fullSnapshot(w.db);
        assert(after === before, "nothing changed anywhere in the DB");
        const row = await visitRow(w.db, visitId);
        assert(String(row.status) === "PREPARATION" && row.finalized_at === null, "all-or-nothing holds");
    });
}

// ---------------------------------------------------------------------------
// S12 — Class-A idempotent retry (GATE 5K §S items 59..63)
// ---------------------------------------------------------------------------
async function tS12_retry(): Promise<void> {
    await ok("G5K-59: identical retry after commit => applied:false (durable state returned)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await disposeInstitution(w, visitId);
        const first = await w.fin.finalizeVisit({ visitId, finalizedAt: FIN });
        assert(first.applied === true, "first call applies");
        const retry = await w.fin.finalizeVisit({ visitId, finalizedAt: FIN });
        assert(retry.applied === false, "retry converges");
        assert(retry.status === "COMPLETED" && retry.finalizedAt === FIN, "retry returns the durable final state");
    });

    await ok("G5K-60: a retry with a fresh/different finalizedAt still returns the durable original final state", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await disposeInstitution(w, visitId);
        await w.fin.finalizeVisit({ visitId, finalizedAt: FIN });
        const retry = await w.fin.finalizeVisit({ visitId, finalizedAt: FIN2 });
        assert(retry.applied === false, "converged");
        assert(retry.finalizedAt === FIN, "the durable original finalized_at is returned, not the fresh clock");
    });

    await ok("G5K-61: a retry does not rewrite finalized_at", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await disposeInstitution(w, visitId);
        await w.fin.finalizeVisit({ visitId, finalizedAt: FIN });
        await w.fin.finalizeVisit({ visitId, finalizedAt: FIN2 });
        assert(String((await visitRow(w.db, visitId)).finalized_at) === FIN, "durable finalized_at never rewritten");
    });

    await ok("G5K-62: a retry does not recalculate/change the final status", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await disposeInstitution(w, visitId, ["CHK-006"]);
        await markNotInspectedCell(w, visitId, "CHK-006", "not reachable today");
        await w.fin.finalizeVisit({ visitId, finalizedAt: FIN });
        const retry = await w.fin.finalizeVisit({ visitId, finalizedAt: FIN2 });
        assert(retry.applied === false && retry.status === "COMPLETED_WITH_UNINSPECTED", "CWU status returned verbatim, never re-derived");
        assert(String((await visitRow(w.db, visitId)).status) === "COMPLETED_WITH_UNINSPECTED", "durable status unchanged");
    });

    await ok("G5K-63: corrupt finalized_at/status combination => E_STATE_CONFLICT (fabricated read; CHECK makes it unrepresentable at rest)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await disposeInstitution(w, visitId);
        const fab = new FabricateReadOnceAdapter(
            w.db,
            (sql) => sql.includes("SELECT status, finalized_at FROM visit"),
            () => [{ status: "PREPARATION", finalized_at: FIN }],
        );
        const fin = new VisitFinalizationService(fab);
        await rejectsCode(APP_ERR.STATE_CONFLICT, () => fin.finalizeVisit({ visitId, finalizedAt: FIN }));
        const row = await visitRow(w.db, visitId);
        assert(String(row.status) === "PREPARATION" && row.finalized_at === null, "durable Visit untouched");
    });
}

// ---------------------------------------------------------------------------
// S13 — post-finalization immutability (GATE 5K §S items 64..67)
// ---------------------------------------------------------------------------
async function tS13_immutability(): Promise<void> {
    await ok("G5K-64: response modification after finalization remains rejected", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await disposeInstitution(w, visitId);
        const rid = await responseIdOf(w.db, await cellOf(w.db, visitId, null, "CHK-006"));
        await w.fin.finalizeVisit({ visitId, finalizedAt: FIN });
        await rejectsAny(() => w.db.run("UPDATE checklist_response SET note = 'x' WHERE response_id = ?", [rid]));
        await rejectsAny(() =>
            w.db.run(
                "UPDATE checklist_response SET answered_value_id = NULL, overlay_state = 'NA' WHERE response_id = ?",
                [rid],
            ),
        );
    });

    await ok("G5K-65: observation modification after finalization remains rejected", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await disposeInstitution(w, visitId);
        const obs = await w.obs.createAdHocObservation({ visitId, text: "note", recordedAt: NOW, recordedBy: "inspector-a" });
        await w.fin.finalizeVisit({ visitId, finalizedAt: FIN });
        await rejectsAny(() => w.db.run("UPDATE adhoc_observation SET text = 'changed' WHERE observation_id = ?", [obs.observationId]));
    });

    await ok("G5K-66: reconciliation-row mutation/deletion after finalization remains rejected", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await disposeInstitution(w, visitId);
        const rid = await responseIdOf(w.db, await cellOf(w.db, visitId, null, "CHK-012"));
        const rows = await w.db.query("SELECT row_id FROM equipment_reconciliation_row WHERE response_id = ? ORDER BY row_id", [rid]);
        assert(rows.length === 2, "precondition: rows exist");
        await w.fin.finalizeVisit({ visitId, finalizedAt: FIN });
        await rejectsAny(() => w.db.run("UPDATE equipment_reconciliation_row SET category = 'x' WHERE row_id = ?", [Number(rows[0].row_id)]));
        await rejectsAny(() => w.db.run("DELETE FROM equipment_reconciliation_row WHERE row_id = ?", [Number(rows[0].row_id)]));
    });

    await ok("G5K-67: Visit reopen remains rejected (schema trigger + service)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await disposeInstitution(w, visitId);
        await w.fin.finalizeVisit({ visitId, finalizedAt: FIN });
        await rejectsAny(() => w.db.run("UPDATE visit SET status = 'PREPARATION' WHERE visit_id = ?", [visitId]));
        // the service-level answer path also refuses a finalized Visit
        const cell = await cellOf(w.db, visitId, null, "CHK-006");
        const valueId = await valueIdOfDef(w.db, cell.itemDefinitionId, "REGULAR");
        await rejectsCode(APP_ERR.VISIT_NOT_PREPARATION, () =>
            w.disp.answerSingle({ cell, allowedValueId: valueId }),
        );
    });
}

// ---------------------------------------------------------------------------
// S14 — cross-cutting (GATE 5K §S items 68..72 + extras 74..78)
// ---------------------------------------------------------------------------
async function tS14_crosscutting(): Promise<void> {
    await ok("G5K-68: finalization does not create FollowUp", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await disposeInstitution(w, visitId);
        await w.fin.finalizeVisit({ visitId, finalizedAt: FIN });
        assert((await count(w.db, "SELECT count(*) AS c FROM follow_up")) === 0, "no FollowUp rows exist");
    });

    await ok("G5K-69: finalization does not create Finding", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await disposeInstitution(w, visitId, ["CHK-006"]);
        await answerNcCell(w, visitId, "CHK-006", "IRREGULAR", "records not kept since May");
        const before = await count(w.db, "SELECT count(*) AS c FROM finding");
        await w.fin.finalizeVisit({ visitId, finalizedAt: FIN });
        assert((await count(w.db, "SELECT count(*) AS c FROM finding")) === before, "finding count unchanged");
    });

    await ok("G5K-70: finalization does not create CorrectiveAction", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await disposeInstitution(w, visitId, ["CHK-006"]);
        const fid = await answerNcCell(w, visitId, "CHK-006", "IRREGULAR", "records not kept since May");
        await insertActionRaw(w.db, fid);
        await w.fin.finalizeVisit({ visitId, finalizedAt: FIN });
        assert((await count(w.db, "SELECT count(*) AS c FROM corrective_action")) === 1, "the pre-existing action only");
    });

    await ok("G5K-71: finalization does not alter source links", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await disposeInstitution(w, visitId, ["CHK-006"]);
        const fid = await answerNcCell(w, visitId, "CHK-006", "IRREGULAR", "records not kept since May");
        const obs = await w.obs.createAdHocObservation({ visitId, text: "leak observed", recordedAt: NOW, recordedBy: "inspector-a" });
        const t7 = await w.obsFinding.createFindingWithObservationSource({
            observationId: obs.observationId,
            finding: { description: "leak", defectType: "WATER_LEAK", location: "corridor", urgency: "IMMEDIATE", impact: "HIGH" },
            actor: "inspector-a",
            now: NOW,
        });
        const rid = await responseIdOf(w.db, await cellOf(w.db, visitId, null, "CHK-006"));
        await w.fin.finalizeVisit({ visitId, finalizedAt: FIN });
        assert(Number((await responseRow(w.db, rid)).finding_id) === fid, "response finding link unchanged");
        const obsRows = await w.db.query("SELECT finding_id FROM adhoc_observation WHERE observation_id = ?", [obs.observationId]);
        assert(Number(obsRows[0].finding_id) === t7.findingId, "observation finding link unchanged");
    });

    await ok("G5K-72: no node:* import in the production core", async () => {
        const finText = readFileSync(join(ROOT, "src", "application", "visit-finalization.ts"), "utf8");
        const errText = readFileSync(join(ROOT, "src", "application", "errors.ts"), "utf8");
        assert(!/\bfrom\s+["']node:/.test(finText), "visit-finalization.ts imports no node:* API");
        assert(!/\bfrom\s+["']node:/.test(errText), "errors.ts imports no node:* API");
    });

    await ok("G5K-74: DB backstop — a raw NC answer without a finding link is rejected by trg_response_bi", async () => {
        const w = await freshWorld();
        const visitId = await insertVisitRaw(w.db, w.missionId, w.institutionId);
        const defId = await activeDefId(w.db, "CHK-006");
        const valueId = Number(
            (
                await w.db.query(
                    "SELECT allowed_value_id FROM checklist_allowed_value WHERE item_definition_id = ? AND value_code = 'IRREGULAR'",
                    [defId],
                )
            )[0].allowed_value_id,
        );
        await rejectsAny(() =>
            w.db.run(
                `INSERT INTO checklist_response(visit_id, item_definition_id, subject_id, overlay_state,
                                                answered_value_id, note, recorded_at, recorded_by)
                 VALUES (?, ?, NULL, NULL, ?, NULL, ?, 'inspector-a')`,
                [visitId, defId, valueId, NOW] as readonly SqlValue[],
            ),
        );
    });

    await ok("G5K-75: DB backstop — a raw reconciliation difference != observed - declared is rejected by the table CHECK", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await disposeInstitution(w, visitId);
        const rid = await responseIdOf(w.db, await cellOf(w.db, visitId, null, "CHK-012"));
        const rows = await w.db.query("SELECT row_id FROM equipment_reconciliation_row WHERE response_id = ? ORDER BY row_id", [rid]);
        await rejectsAny(() =>
            w.db.run("UPDATE equipment_reconciliation_row SET difference = difference + 1 WHERE row_id = ?", [Number(rows[0].row_id)]),
        );
    });

    await ok("G5K-76: DB backstop — raw closure with a surviving reason-less pending row is rejected by trg_visit_bu", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await disposeInstitution(w, visitId, ["CHK-006"]);
        await rejectsAny(() =>
            w.db.run(
                "UPDATE visit SET status = 'COMPLETED_WITH_UNINSPECTED', finalized_at = ? WHERE visit_id = ?",
                [FIN, visitId] as readonly SqlValue[],
            ),
        );
        const row = await visitRow(w.db, visitId);
        assert(String(row.status) === "PREPARATION", "DB backstop refuses the malformed closure");
    });

    await ok("G5K-77: combined separation world — OPEN Finding + OPEN CorrectiveAction neither block nor move", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await disposeInstitution(w, visitId, ["CHK-006"]);
        const fid = await answerNcCell(w, visitId, "CHK-006", "IRREGULAR", "records not kept since May");
        const aid = await insertActionRaw(w.db, fid);
        const res = await w.fin.finalizeVisit({ visitId, finalizedAt: FIN });
        assert(res.applied === true, "remediation-open world finalizes");
        assert(String((await findingRow(w.db, fid)).status) === "OPEN", "Finding still OPEN");
        assert(String((await actionRow(w.db, aid)).status) === "OPEN", "action still OPEN");
    });

    await ok("G5K-78: finalization creates no adhoc_observation row", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await disposeInstitution(w, visitId);
        await w.fin.finalizeVisit({ visitId, finalizedAt: FIN });
        assert((await count(w.db, "SELECT count(*) AS c FROM adhoc_observation")) === 0, "no observation created");
    });

    await ok("G5K-79: an empty captured universe (no institution-context rows) => E_SCOPE_GAP", async () => {
        const w = await freshWorld();
        const visitId = await insertVisitRaw(w.db, w.missionId, w.institutionId);
        const err = await rejectsCode(APP_ERR.SCOPE_GAP, () => w.fin.finalizeVisit({ visitId, finalizedAt: FIN }));
        const blockers = (err as { blockers?: FinalizationBlocker[] }).blockers ?? [];
        assert(blockers.length === 1 && blockers[0].kind === "empty-captured-universe", "unrecoverable scope identified");
        assert(String((await visitRow(w.db, visitId)).status) === "PREPARATION", "Visit stays PREPARATION");
    });

    await ok("G5K-80: an NC cell violating BOTH accountability and note requirements reports both blockers (deterministic order)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await disposeInstitution(w, visitId, ["CHK-006"]);
        await answerNcCell(w, visitId, "CHK-006", "IRREGULAR", "records not kept since May");
        const fab = new FabricateReadOnceAdapter(
            w.db,
            (sql) => sql.includes("av.semantic_class = 'NON_COMPLIANT'"),
            (rows) => rows.map((r) => ({ ...r, finding_id: null, note: null })),
        );
        const fin = new VisitFinalizationService(fab);
        const err = await rejectsCode(APP_ERR.NC_UNACCOUNTED, () => fin.finalizeVisit({ visitId, finalizedAt: FIN }));
        const blockers = (err as { blockers?: FinalizationBlocker[] }).blockers ?? [];
        const codes = blockers.map((b) => b.code);
        assert(
            codes.join(",") === `${APP_ERR.NC_UNACCOUNTED},${APP_ERR.NC_NEEDS_NOTE}`,
            `both independent violations reported in deterministic order, got [${codes.join(", ")}]`,
        );
    });
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------
const SUITES: Array<[string, () => Promise<void>]> = [
    ["S1 Visit/basic", tS1_basic],
    ["S2 timestamps", tS2_timestamps],
    ["S3 scope grid", tS3_grid],
    ["S4 pending", tS4_pending],
    ["S5 NOT_INSPECTED", tS5_notInspected],
    ["S6 NC accountability", tS6_nc],
    ["S7 SCHEDULE/CHK-012", tS7_schedule],
    ["S8 Finding/orphan", tS8_finding],
    ["S9 CorrectiveActions", tS9_actions],
    ["S10 structured blockers", tS10_blockers],
    ["S11 atomicity", tS11_atomicity],
    ["S12 Class-A retry", tS12_retry],
    ["S13 immutability", tS13_immutability],
    ["S14 cross-cutting", tS14_crosscutting],
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
