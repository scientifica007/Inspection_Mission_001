// Gate 5L — automated regression for `currentVisitState(visitId)`
// (APPLICATION-CORE-v1.md §4.11 / RECOVERY-AND-IDEMPOTENCY-v1.md §6):
//   READ-ONLY restart reconstruction of ONE Visit from SQLite rows as the
//   ONLY authority, inside ONE explicit BEGIN IMMEDIATE … SELECTs … COMMIT
//   unit (the adopted v1 coherent-read-snapshot barrier under the
//   single-inspector architecture — TRANSACTION §1.2 permits a BEGIN for
//   consistent multi-statement reads; the closed Gate-5B seam exposes only
//   beginImmediate). ZERO writes, no auto-repair, no volatile authority.
//   Reconstructs: Visit + mission/institution metadata; the captured
//   instrument universe (institution-context rows + PINNED definitions and
//   their allowed values — never current-ACTIVE discovery); contexts
//   (institution + subjects durably present in the grid); every durable cell
//   with pinned interpretation + derived classification
//   (PENDING / UNRESOLVED_HUMAN / ANSWERED / HUMAN_APPLICABLE_ANSWERED /
//    NOT_INSPECTED / HUMAN_APPLICABLE_NOT_INSPECTED / NA / HUMAN_NOT_APPLICABLE /
//    NOT_INSPECTED_BLANK_REASON); SCHEDULE reconciliation rows; observations;
//   Findings = origin ∪ referenced-by-sources (active vs VOIDED history);
//   source maps; corrective actions; append-only FollowUps
//   ((event_datetime, followup_id) order); derived restart summary.
//   Grid self-check with the Gate-5C/5K exact-set semantics: missing cell /
//   partial subject grid / extra-mismatched cell / empty captured universe =>
//   E_SCOPE_GAP; blank deliberate NOT_INSPECTED reason =>
//   E_UNINSPECTED_NEEDS_REASON; source-less OPEN origin Finding =>
//   E_ORPHAN_FINDING (VOIDED is expected source-less — never flagged).
//   Blockers surface as ONE DomainError carrying the COMPLETE structured list
//   (top-level code = first blocker's code in the deterministic order).
//   Missing Visit => E_VISIT_NOT_FOUND; impossible status/finalized_at
//   combinations => E_STATE_CONFLICT; missing mission/institution parent rows
//   => E_CONFIG (corruption). Pending cells / active Findings / active
//   Actions are VALID current state and never errors.
//
// Run (repository root; Node.js >= 22 is the adopted development/test host,
// Gate-5A D1 — node:sqlite + native TypeScript type stripping):
//   Node 22.x:   node --experimental-strip-types tests/gate5l_regression.ts
//   Node 24.x:   node tests/gate5l_regression.ts
// Exit: 0 on success, 1 when any assertion fails.
//
// Coverage map (GATE 5L §U TESTS, items 1..75) is reproduced in the ok()
// labels G5L-01..G5L-75, plus contract-mandated extras (G5L-76+):
//   76  blank deliberate NOT_INSPECTED reason => E_UNINSPECTED_NEEDS_REASON
//   77  missing referenced subject row => E_SCOPE_GAP (fabricated read)
//   78  missing referenced definition row => E_SCOPE_GAP (fabricated read)
//   79  empty captured universe => E_SCOPE_GAP
//   80  missing referenced answered-value row => E_SCOPE_GAP (fabricated)
//   81  missing referenced finding row => E_SCOPE_GAP (fabricated)
//   82  fabricated finalized_at + PREPARATION => E_STATE_CONFLICT
//   83  fabricated COMPLETED + finalized_at NULL => E_STATE_CONFLICT
//   84  fabricated unknown visit status => E_STATE_CONFLICT
//   85  fabricated missing mission parent row => E_CONFIG
//   86  contextual HUMAN correction: a HUMAN_CONFIRMATION definition
//       automatically excluded for a WORKSHOP context reconstructs as
//       ordinary NA (contextualOutcome NOT_APPLICABLE), NOT
//       HUMAN_NOT_APPLICABLE
//   87  a genuinely HUMAN_CONFIRMATION cell in an applicable context,
//       explicitly resolved NOT_APPLICABLE, reconstructs as
//       HUMAN_NOT_APPLICABLE (contextualOutcome HUMAN_CONFIRMATION)
//   88  reconstruction SQL never performs a current-ACTIVE lookup
//   89  duplicate logical cell (fabricated read) => E_SCOPE_GAP
//       duplicate-cell blockers with durable response ids, no auto-repair
//   90  contextual NOT_APPLICABLE + durable ANSWERED => E_SCOPE_GAP
//       applicability-state-mismatch (raw corrupt state; no auto-repair)
//   91  contextual NOT_APPLICABLE + reasoned NOT_INSPECTED => E_SCOPE_GAP
//       applicability-state-mismatch
//   92  contextual APPLICABLE + durable NA => E_SCOPE_GAP
//       applicability-state-mismatch
//   93  valid combinations stay valid: automatic NOT_APPLICABLE + NA,
//       contextual HUMAN_CONFIRMATION + NA, pending and answered cells

import { readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import type { SqlAdapter, SqlRow, SqlValue } from "../src/bootstrap/adapter.ts";
import { NodeSqliteAdapter, openFreshDb } from "../dev/node-sqlite-adapter.ts";
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
import { FindingTransitionService } from "../src/application/finding-status.ts";
import { CorrectiveActionCreateService } from "../src/application/corrective-action-create.ts";
import { CorrectiveActionStatusService } from "../src/application/corrective-action-status.ts";
import {
    CurrentVisitStateService,
    type CellClassification,
    type CurrentVisitState,
} from "../src/application/current-visit-state.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_SQL = readFileSync(join(ROOT, "docs", "schema", "schema.sql"), "utf8");
const ARTIFACT_PATH = join(ROOT, "bootstrap", "v1", "checklist-v1.json");
const COMMITTED = parseArtifact(readFileSync(ARTIFACT_PATH, "utf8"));
const EXPECTED_P0 = COMMITTED.manifest.expected_p0_item_codes;

const NOW = "2026-09-01T08:00:00.000Z";
const T1 = "2026-09-02T09:00:00.000Z";
const T2 = "2026-09-03T10:00:00.000Z";
const VISIT_DATE = "2026-09-10";
const FIN = "2026-09-09T07:00:00Z";

// ---------------------------------------------------------------------------
// tiny assertion harness (same conventions as tests/gate5k_regression.ts)
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

function assertDeepEqual(a: unknown, b: unknown, msg: string): void {
    assert(JSON.stringify(a) === JSON.stringify(b), `${msg} (deep mismatch)`);
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

function blockersOf(err: Error): FinalizationBlocker[] {
    return (err as { blockers?: FinalizationBlocker[] }).blockers ?? [];
}

// ---------------------------------------------------------------------------
// fault-injecting / recording adapters
// ---------------------------------------------------------------------------
class RecordingAdapter implements SqlAdapter {
    private readonly inner: SqlAdapter;
    readonly calls: string[] = [];
    readonly querySql: string[] = [];

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
        this.querySql.push(sql);
        return this.inner.query(sql, params);
    }
}

/** fails the first matching query with an injected fault + records boundaries. */
class FaultQueryAdapter implements SqlAdapter {
    private readonly inner: SqlAdapter;
    private readonly failOn: (sql: string) => boolean;
    readonly calls: string[] = [];

    constructor(inner: SqlAdapter, failOn: (sql: string) => boolean) {
        this.inner = inner;
        this.failOn = failOn;
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
        return this.inner.run(sql, params);
    }
    async query(sql: string, params: readonly SqlValue[] = []): Promise<SqlRow[]> {
        if (this.failOn(sql)) throw new Error("injected adapter fault");
        return this.inner.query(sql, params);
    }
}

/** on EVERY query, attempts a WRITE on a second connection (snapshot-barrier probe). */
class BusyProbeAdapter implements SqlAdapter {
    private readonly inner: SqlAdapter;
    private readonly probe: () => Promise<void>;

    constructor(inner: SqlAdapter, probe: () => Promise<void>) {
        this.inner = inner;
        this.probe = probe;
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
        await this.probe();
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
    findStatus: FindingTransitionService;
    caCreate: CorrectiveActionCreateService;
    caStatus: CorrectiveActionStatusService;
    cvs: CurrentVisitStateService;
    missionId: number;
    institutionId: number;
}

function buildServices(db: SqlAdapter, missionId: number, institutionId: number): World {
    return {
        db,
        scope: new VisitScopeService(db),
        disp: new InitialDispositionService(db),
        obs: new ObservationCreateService(db),
        obsFinding: new ObservationFindingService(db),
        fin: new VisitFinalizationService(db),
        findStatus: new FindingTransitionService(db),
        caCreate: new CorrectiveActionCreateService(db),
        caStatus: new CorrectiveActionStatusService(db),
        cvs: new CurrentVisitStateService(db),
        missionId,
        institutionId,
    };
}

async function seedIdentity(db: SqlAdapter): Promise<{ missionId: number; institutionId: number }> {
    const missionId = Number(
        (await db.run("INSERT INTO mission(name, status, created_at, created_by) VALUES ('M', 'PREPARATION', ?, 'owner')", [NOW]))
            .lastInsertRowid,
    );
    const institutionId = Number(
        (await db.run("INSERT INTO institution(name, created_at, created_by) VALUES ('Inst', ?, 'owner')", [NOW])).lastInsertRowid,
    );
    return { missionId, institutionId };
}

async function freshWorld(): Promise<World> {
    const db = openFreshDb(SCHEMA_SQL);
    await new BootstrapLoader(db, COMMITTED).load();
    const ids = await seedIdentity(db);
    return buildServices(db, ids.missionId, ids.institutionId);
}

/** a FILE-backed world (restart simulations); returns the raw connections for cleanup. */
async function fileWorld(
    path: string,
): Promise<{ w: World; conns: DatabaseSync[] }> {
    rmSync(path, { force: true }); // self-healing: never reuse a stale file
    const conn = new DatabaseSync(path);
    conn.exec(SCHEMA_SQL);
    const db = new NodeSqliteAdapter(conn);
    await new BootstrapLoader(db, COMMITTED).load();
    const ids = await seedIdentity(db);
    return { w: buildServices(db, ids.missionId, ids.institutionId), conns: [conn] };
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

async function addSubject(w: World, visitId: number, subjectType: ContextKind, name: string): Promise<number> {
    const res = await w.scope.addSubjectToScope({
        kind: "new",
        visitId,
        subject: { subjectType, name },
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

async function valueIdOfDef(db: SqlAdapter, itemDefinitionId: number, valueCode: string): Promise<number> {
    const rows = await db.query(
        "SELECT allowed_value_id FROM checklist_allowed_value WHERE item_definition_id = ? AND value_code = ?",
        [itemDefinitionId, valueCode],
    );
    assert(rows.length === 1, `expected one allowed value ${itemDefinitionId}/${valueCode}`);
    return Number(rows[0].allowed_value_id);
}

/** the NON_COMPLIANT allowed value of the PINNED definition (never a hardcode). */
async function ncValueIdOfDef(db: SqlAdapter, itemDefinitionId: number): Promise<number> {
    const rows = await db.query(
        "SELECT allowed_value_id FROM checklist_allowed_value WHERE item_definition_id = ? AND semantic_class = 'NON_COMPLIANT'",
        [itemDefinitionId],
    );
    assert(rows.length === 1, `expected one NON_COMPLIANT value for definition ${itemDefinitionId}`);
    return Number(rows[0].allowed_value_id);
}

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

/** deliberate NOT_INSPECTED + meaningful reason (AUTO cell). */
async function markNotInspectedCell(w: World, visitId: number, code: string, reason: string): Promise<void> {
    const cell = await cellOf(w.db, visitId, null, code);
    await w.disp.markNotInspected({ cell, reason });
}

/** NON_COMPLIANT answer with a NEW Finding + meaningful note (returns findingId). */
async function answerNcCell(w: World, visitId: number, code: string, note: string): Promise<number> {
    const cell = await cellOf(w.db, visitId, null, code);
    const res = await w.disp.answerSingle({
        cell,
        allowedValueId: await ncValueIdOfDef(w.db, cell.itemDefinitionId),
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

/** NC answer linked to an EXISTING Finding (covers-same-issue confirmed). */
async function answerNcExisting(w: World, visitId: number, code: string, findingId: number, note: string): Promise<void> {
    const cell = await cellOf(w.db, visitId, null, code);
    await w.disp.answerSingle({
        cell,
        allowedValueId: await ncValueIdOfDef(w.db, cell.itemDefinitionId),
        note,
        finding: { mode: "existing", findingId, coversSameIssueConfirmed: true },
    });
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

async function activeDefId(db: SqlAdapter, itemCode: string): Promise<number> {
    const rows = await db.query(
        "SELECT item_definition_id FROM checklist_item_definition WHERE item_code = ? AND status = 'ACTIVE'",
        [itemCode],
    );
    assert(rows.length === 1, `expected one ACTIVE definition for ${itemCode}`);
    return Number(rows[0].item_definition_id);
}

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

async function setFindingVoidedRaw(db: SqlAdapter, findingId: number, at = NOW): Promise<void> {
    const res = await db.run(
        "UPDATE finding SET status = 'VOIDED', status_changed_at = ? WHERE finding_id = ? AND status = 'OPEN'",
        [at, findingId] as readonly SqlValue[],
    );
    assert(res.changes === 1, `fixture finding ${findingId} -> VOIDED update failed`);
}

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

async function setActionStatusRaw(db: SqlAdapter, actionId: number, status: string): Promise<void> {
    const res = await db.run(
        "UPDATE corrective_action SET status = ? WHERE action_id = ? AND status = 'OPEN'",
        [status, actionId] as readonly SqlValue[],
    );
    assert(res.changes === 1, `fixture action ${actionId} -> ${status} update failed`);
}

/** raw follow_up insert (fixture; respects trg_fu_bi by construction). */
async function insertFollowUpRaw(
    db: SqlAdapter,
    findingId: number,
    data: { correctiveActionId?: number | null; statusTarget?: string | null; statusAfter?: string | null; eventDatetime?: string },
): Promise<number> {
    const res = await db.run(
        `INSERT INTO follow_up(finding_id, corrective_action_id, visit_id, status_target, status_after,
                               event_datetime, actor_role, actor_role_other, actor_name, note, recorded_by)
         VALUES (?, ?, NULL, ?, ?, ?, 'INSPECTOR', NULL, NULL, 'fixture transition note', 'inspector-a')`,
        [
            findingId,
            data.correctiveActionId ?? null,
            data.statusTarget ?? null,
            data.statusAfter ?? null,
            data.eventDatetime ?? NOW,
        ] as readonly SqlValue[],
    );
    assert(res.changes === 1 && res.lastInsertRowid !== null, "followup fixture insert failed");
    return Number(res.lastInsertRowid);
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

/** insert a NEW ACTIVE definition for a NEW item code (copy of baseCode's rule). */
async function insertDefinitionRaw(db: SqlAdapter, itemCode: string, baseCode = "CHK-013", priority = "P0"): Promise<number> {
    const base = await db.query(
        "SELECT * FROM checklist_item_definition WHERE item_code = ? AND status = 'ACTIVE'",
        [baseCode],
    );
    assert(base.length === 1, `expected one ACTIVE ${baseCode}`);
    const b = base[0];
    const rule = JSON.parse(String(b.applicability_rule)) as Record<string, unknown>;
    rule.item_code = itemCode;
    const res = await db.run(
        `INSERT INTO checklist_item_definition(item_code, version_no, supersedes_definition_id, effective_from, domain_id,
                                               arabic_question, response_model, priority, traceability, requirement_refs,
                                               note_rule, evidence_rule, finding_rule, applicability_rule, status)
         VALUES (?, 1, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE')`,
        [
            itemCode,
            String(b.domain_id),
            String(b.arabic_question),
            String(b.response_model),
            priority,
            String(b.traceability),
            String(b.requirement_refs),
            b.note_rule,
            b.evidence_rule,
            b.finding_rule,
            JSON.stringify(rule),
        ] as readonly SqlValue[],
    );
    assert(res.changes === 1 && res.lastInsertRowid !== null, "definition fixture insert failed");
    return Number(res.lastInsertRowid);
}

/** deterministic full-DB snapshot (zero-write proofs). */
async function fullSnapshot(db: SqlAdapter): Promise<string> {
    const mission = await db.query("SELECT * FROM mission ORDER BY mission_id");
    const institution = await db.query("SELECT * FROM institution ORDER BY institution_id");
    const subject = await db.query("SELECT * FROM inspected_subject ORDER BY subject_id");
    const visit = await db.query("SELECT * FROM visit ORDER BY visit_id");
    const responses = await db.query("SELECT * FROM checklist_response ORDER BY response_id");
    const recon = await db.query("SELECT * FROM equipment_reconciliation_row ORDER BY row_id");
    const findings = await db.query("SELECT * FROM finding ORDER BY finding_id");
    const followUps = await db.query("SELECT * FROM follow_up ORDER BY followup_id");
    const observations = await db.query("SELECT * FROM adhoc_observation ORDER BY observation_id");
    const actions = await db.query("SELECT * FROM corrective_action ORDER BY action_id");
    return JSON.stringify({ mission, institution, subject, visit, responses, recon, findings, followUps, observations, actions });
}

/** find a cell of the returned state by (subjectId, itemCode). */
function cellOfState(state: CurrentVisitState, subjectId: number | null, itemCode: string) {
    const cell = state.cells.find((c) => c.subjectId === subjectId && c.itemCode === itemCode);
    assert(cell !== undefined, `state cell (${subjectId}, ${itemCode}) missing`);
    return cell;
}

/** the DB id-set of rows matching a predicate-free query (single column). */
async function idSet(db: SqlAdapter, sql: string, params: readonly SqlValue[] = []): Promise<Set<number>> {
    const rows = await db.query(sql, params);
    const col = Object.keys(rows[0] ?? {})[0];
    return new Set(rows.map((r) => Number(r[col])));
}

// ---------------------------------------------------------------------------
// S1 — Visit / basic (GATE 5L §U items 1..6)
// ---------------------------------------------------------------------------
async function tS1_basic(): Promise<void> {
    await ok("G5L-01: missing Visit => E_VISIT_NOT_FOUND", async () => {
        const w = await freshWorld();
        await rejectsCode(APP_ERR.VISIT_NOT_FOUND, () => w.cvs.currentVisitState(999));
    });

    await ok("G5L-02: PREPARATION Visit reconstructs", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const state = await w.cvs.currentVisitState(visitId);
        assert(state.visit.status === "PREPARATION" && state.visit.visitId === visitId, "visit identity/status");
        assert(state.cells.length === 20 && state.summary.actualCellCount === 20, "20 institution cells");
        assert(state.capturedUniverse.length === 20 && state.summary.capturedDefinitionCount === 20, "20 captured definitions");
        assert(state.contexts.length === 1 && state.contexts[0].kind === "INSTITUTION", "one context: institution");
        assert(state.summary.expectedCellCount === 20 && state.summary.contextCount === 1, "expected grid");
        const pending = await count(w.db, `SELECT count(*) AS c FROM checklist_response WHERE visit_id = ? AND overlay_state = 'NOT_INSPECTED' AND not_inspected_reason IS NULL`, [visitId]);
        const na = await count(w.db, `SELECT count(*) AS c FROM checklist_response WHERE visit_id = ? AND overlay_state = 'NA'`, [visitId]);
        assert(state.summary.pendingCount === pending && state.summary.naCount === na, "pending/NA counts from durable rows");
        assert(state.summary.pendingCount === 6 && state.summary.naCount === 14, "composed universe: 6 pending, 14 NA");
        assert(state.summary.unresolvedHumanCount === 1 && state.summary.answeredCount === 0, "HUMAN/answered counts");
        assert(state.summary.deliberateUninspectedCount === 0, "no deliberate NOT_INSPECTED");
    });

    await ok("G5L-03: COMPLETED Visit reconstructs", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await disposeInstitution(w, visitId);
        const finRes = await w.fin.finalizeVisit({ visitId, finalizedAt: FIN });
        assert(finRes.status === "COMPLETED", "precondition: finalization");
        const state = await w.cvs.currentVisitState(visitId);
        assert(state.visit.status === "COMPLETED" && state.visit.finalizedAt === FIN, "finalized durable metadata");
        assert(state.summary.pendingCount === 0 && state.summary.deliberateUninspectedCount === 0, "no pending/uninspected");
        assert(state.summary.answeredCount === 5 && state.summary.naCount === 15, "5 answered (incl SCHEDULE), 15 NA");
        assert(state.cells.length === 20 && state.summary.expectedCellCount === 20, "scope intact after finalization");
        const chk006 = cellOfState(state, null, "CHK-006");
        assert(chk006.classification === "ANSWERED" && chk006.answeredValue?.valueCode === "REGULAR", "CHK-006 answered");
    });

    await ok("G5L-04: COMPLETED_WITH_UNINSPECTED Visit reconstructs", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await disposeInstitution(w, visitId, ["CHK-006"]);
        await markNotInspectedCell(w, visitId, "CHK-006", "not reachable today");
        const finRes = await w.fin.finalizeVisit({ visitId, finalizedAt: FIN });
        assert(finRes.status === "COMPLETED_WITH_UNINSPECTED", "precondition: finalization");
        const state = await w.cvs.currentVisitState(visitId);
        assert(state.visit.status === "COMPLETED_WITH_UNINSPECTED" && state.visit.finalizedAt === FIN, "durable metadata");
        assert(state.summary.deliberateUninspectedCount === 1 && state.summary.pendingCount === 0, "1 deliberate NOT_INSPECTED");
        const chk006 = cellOfState(state, null, "CHK-006");
        assert(chk006.classification === "NOT_INSPECTED" && chk006.notInspectedReason === "not reachable today", "reason preserved");
        assert(state.summary.answeredCount === 4 && state.summary.naCount === 15, "4 answered, 15 NA");
    });

    await ok("G5L-05: Visit durable metadata exact (visit + parents)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const state = await w.cvs.currentVisitState(visitId);
        assert(state.visit.visitId === visitId, "visitId");
        assert(state.visit.missionId === w.missionId && state.visit.institutionId === w.institutionId, "parent ids");
        assert(state.visit.visitType === "PLANNED" && state.visit.visitDate === VISIT_DATE, "type/date");
        assert(state.visit.inspector === "inspector-a", "inspector");
        assert(state.visit.finalizedAt === null && state.visit.startedAt === null, "unset optional fields");
        assert(state.visit.createdAt === NOW && state.visit.createdBy === "inspector-a", "visit audit");
        assert(state.mission.missionId === w.missionId && state.mission.name === "M" && state.mission.status === "PREPARATION", "mission metadata");
        assert(state.institution.institutionId === w.institutionId && state.institution.name === "Inst", "institution metadata");
        assert(state.institution.officialCode === null && state.institution.active === 1, "institution optional fields null-preserving");
    });

    await ok("G5L-06: zero writes performed by the service", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const recording = new RecordingAdapter(w.db);
        const svc = new CurrentVisitStateService(recording);
        const before = await fullSnapshot(w.db);
        await svc.currentVisitState(visitId);
        const after = await fullSnapshot(w.db);
        assertDeepEqual(before, after, "no durable row changed");
        assertDeepEqual(recording.calls, ["beginImmediate", "commit"], "exact transaction boundary calls");
        assert(!recording.calls.includes("run"), "zero run() calls");
    });
}

// ---------------------------------------------------------------------------
// S2 — captured instrument universe (GATE 5L §U items 7..12)
// ---------------------------------------------------------------------------
async function tS2_universe(): Promise<void> {
    await ok("G5L-07: institution cells define the captured universe", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const state = await w.cvs.currentVisitState(visitId);
        const instCellDefs = new Set(state.cells.filter((c) => c.subjectId === null).map((c) => c.itemDefinitionId));
        for (const def of state.capturedUniverse) {
            assert(instCellDefs.has(def.itemDefinitionId), `universe definition ${def.itemDefinitionId} has an institution cell`);
        }
        assert(state.capturedUniverse.length === instCellDefs.size, "bijection with institution cells");
    });

    await ok("G5L-08: current ACTIVE definitions are NOT consulted to expand an old Visit", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        // a NEW ACTIVE P0 code appears AFTER the Visit was composed
        const foreignDefId = await insertDefinitionRaw(w.db, "CHK-099", "CHK-013", "P0");
        await addSubject(w, visitId, "WORKSHOP", "W1");
        const state = await w.cvs.currentVisitState(visitId);
        const codes = state.capturedUniverse.map((d) => d.itemCode);
        assert(!codes.includes("CHK-099"), "new ACTIVE code never enters the old Visit");
        assert(!state.cells.some((c) => c.itemDefinitionId === foreignDefId), "no cell pins the new ACTIVE definition");
        assert(state.summary.expectedCellCount === 40 && state.summary.actualCellCount === 40, "expected grid unchanged (20 x 2)");
    });

    await ok("G5L-09: a later ACTIVE v2 does not replace the pinned v1", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const { oldId, newId } = await releaseDefinitionV2(w.db, "CHK-005");
        const subjectId = await addSubject(w, visitId, "WORKSHOP", "W1");
        const state = await w.cvs.currentVisitState(visitId);
        const chk005 = state.capturedUniverse.find((d) => d.itemCode === "CHK-005");
        assert(chk005 !== undefined && chk005.itemDefinitionId === oldId, "universe still pins v1");
        const instCell = cellOfState(state, null, "CHK-005");
        const subjCell = cellOfState(state, subjectId, "CHK-005");
        assert(instCell.itemDefinitionId === oldId && subjCell.itemDefinitionId === oldId, "cells still pin v1");
        assert(!state.cells.some((c) => c.itemDefinitionId === newId), "v2 absent from the old Visit");
        // a NEWLY composed Visit selects the fresh ACTIVE v2 — releases affect only new Visits
        const visitId2 = await standardCreate(w);
        const state2 = await w.cvs.currentVisitState(visitId2);
        assert(cellOfState(state2, null, "CHK-005").itemDefinitionId === newId, "new Visit pins v2");
        assert(cellOfState(state, null, "CHK-005").itemDefinitionId === oldId, "old Visit still v1 after the new composition");
    });

    await ok("G5L-10: returned definitionId/version are the pinned historical values", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const { oldId } = await releaseDefinitionV2(w.db, "CHK-005");
        const state = await w.cvs.currentVisitState(visitId);
        const def = state.capturedUniverse.find((d) => d.itemCode === "CHK-005");
        assert(def !== undefined, "CHK-005 in the universe");
        assert(def.itemDefinitionId === oldId && def.versionNo === 1, "pinned definition id + version_no");
        assert(def.definitionStatus === "SUPERSEDED", "historical metadata: definition now SUPERSEDED");
        assert(def.decisionKind === "AUTO" && def.responseModel === "SINGLE_VALUE", "pinned rule/decision metadata");
    });

    await ok("G5L-11: allowed values belong to the pinned definition", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await releaseDefinitionV2(w.db, "CHK-005");
        const state = await w.cvs.currentVisitState(visitId);
        for (const def of state.capturedUniverse) {
            const dbVals = await w.db.query(
                "SELECT allowed_value_id, value_code, arabic_label, semantic_class, sort_order, active FROM checklist_allowed_value WHERE item_definition_id = ? ORDER BY sort_order IS NULL, sort_order, allowed_value_id",
                [def.itemDefinitionId],
            );
            assert(
                def.allowedValues.length === dbVals.length,
                `allowed-value count for ${def.itemCode}`,
            );
            for (let i = 0; i < dbVals.length; i++) {
                const dv = dbVals[i];
                const sv = def.allowedValues[i];
                assert(sv.valueId === Number(dv.allowed_value_id) && sv.valueCode === String(dv.value_code), `value ${i} of ${def.itemCode}`);
                assert(sv.arabicLabel === String(dv.arabic_label) && sv.semanticClass === String(dv.semantic_class), `value ${i} metadata`);
                assert(sv.sortOrder === (dv.sort_order === null ? null : Number(dv.sort_order)) && sv.active === Number(dv.active), `value ${i} order/active`);
            }
        }
    });

    await ok("G5L-12: deterministic universe ordering", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const state = await w.cvs.currentVisitState(visitId);
        const codes = state.capturedUniverse.map((d) => d.itemCode);
        const sorted = [...codes].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        assertDeepEqual(codes, sorted, "universe ordered by item_code");
        assertDeepEqual(codes, EXPECTED_P0, "universe equals the composed P0 set");
    });

    await ok("G5L-88: reconstruction SQL never performs a current-ACTIVE lookup", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await addSubject(w, visitId, "WORKSHOP", "W1"); // exercises the contextual-NA HUMAN path
        const recording = new RecordingAdapter(w.db);
        const svc = new CurrentVisitStateService(recording);
        await svc.currentVisitState(visitId);
        for (const sql of recording.querySql) {
            assert(!/\bACTIVE\b/.test(sql), `no ACTIVE-status lookup in: ${sql.slice(0, 80)}`);
        }
    });
}

// ---------------------------------------------------------------------------
// S3 — contexts (GATE 5L §U items 13..16)
// ---------------------------------------------------------------------------
async function tS3_contexts(): Promise<void> {
    await ok("G5L-13: the institution context is always reconstructed first", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const subjectId = await addSubject(w, visitId, "WORKSHOP", "W1");
        const state = await w.cvs.currentVisitState(visitId);
        assert(state.contexts.length === 2, "two contexts");
        assert(state.contexts[0].kind === "INSTITUTION" && state.contexts[0].subjectId === null && state.contexts[0].subject === null, "institution context");
        assert(state.contexts[1].subjectId === subjectId, "subject context second");
    });

    await ok("G5L-14: subject contexts come only from durable grid rows (with their durable rows)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const subjectId = await addSubject(w, visitId, "WORKSHOP", "W1");
        const state = await w.cvs.currentVisitState(visitId);
        const ctx = state.contexts.find((c) => c.subjectId === subjectId);
        assert(ctx !== undefined && ctx.kind === "WORKSHOP", "context kind = subject_type");
        assert(ctx.subject !== null && ctx.subject.name === "W1", "durable subject row loaded");
        assert(ctx.subject.institutionId === w.institutionId && ctx.subject.subjectType === "WORKSHOP", "subject metadata");
    });

    await ok("G5L-15: a same-institution subject existing OUTSIDE the grid is NOT auto-added", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await insertSubjectRaw(w.db, w.institutionId, "LAB", "L-ghost");
        const state = await w.cvs.currentVisitState(visitId);
        assert(state.contexts.length === 1 && state.contexts[0].kind === "INSTITUTION", "no ghost subject context");
        assert(!state.contexts.some((c) => c.subject?.name === "L-ghost"), "ghost subject absent");
    });

    await ok("G5L-16: deterministic context ordering (institution first, then subject_id)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const w1 = await addSubject(w, visitId, "WORKSHOP", "W1");
        const l1 = await addSubject(w, visitId, "LAB", "L1");
        assert(w1 < l1, "precondition: insertion order matches subject_id order");
        const state = await w.cvs.currentVisitState(visitId);
        assertDeepEqual(
            state.contexts.map((c) => c.subjectId),
            [null, w1, l1],
            "institution first, then subjects ascending",
        );
        assertDeepEqual(
            state.contexts.map((c) => c.kind),
            ["INSTITUTION", "WORKSHOP", "LAB"],
            "context kinds",
        );
    });
}

// ---------------------------------------------------------------------------
// S4 — grid self-check (GATE 5L §U items 17..22)
// ---------------------------------------------------------------------------
async function tS4_grid(): Promise<void> {
    await ok("G5L-17: full grid (institution + subject) reconstructs", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await addSubject(w, visitId, "WORKSHOP", "W1");
        const state = await w.cvs.currentVisitState(visitId);
        assert(state.summary.expectedCellCount === 40 && state.summary.actualCellCount === 40, "40/40 cells");
        assert(state.cells.length === 40, "all cells returned");
    });

    await ok("G5L-18: missing subject cell => E_SCOPE_GAP (missing-cell identified)", async () => {
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
            if (code === "CHK-005") continue;
            await insertCellRaw(w.db, visitId, pinned.get(code) as number, subjectId, "NOT_INSPECTED");
        }
        const err = await rejectsCode(APP_ERR.SCOPE_GAP, () => w.cvs.currentVisitState(visitId));
        const missing = blockersOf(err).filter((b) => b.kind === "missing-cell");
        assert(missing.length === 1, `exactly one missing cell, got ${missing.length}`);
        assert(missing[0].itemCode === "CHK-005" && missing[0].subjectId === subjectId, "missing-cell identifies CHK-005 @ subject");
        assert(missing[0].itemDefinitionId === pinned.get("CHK-005"), "missing-cell carries the pinned definition");
    });

    await ok("G5L-19: partial subject grid => E_SCOPE_GAP (never silently repaired)", async () => {
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
        const err = await rejectsCode(APP_ERR.SCOPE_GAP, () => w.cvs.currentVisitState(visitId));
        const missing = blockersOf(err).filter((b) => b.kind === "missing-cell");
        assert(missing.length === EXPECTED_P0.length - half.length, `all ${EXPECTED_P0.length - half.length} missing cells reported`);
    });

    await ok("G5L-20: subject-definition mismatch => E_SCOPE_GAP (extra-cell identified)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const { newId } = await releaseDefinitionV2(w.db, "CHK-001");
        const subjectId = await insertSubjectRaw(w.db, w.institutionId, "WORKSHOP", "W1");
        await insertCellRaw(w.db, visitId, newId, subjectId, "NOT_INSPECTED");
        const err = await rejectsCode(APP_ERR.SCOPE_GAP, () => w.cvs.currentVisitState(visitId));
        const extra = blockersOf(err).filter((b) => b.kind === "extra-cell");
        assert(extra.length === 1, `exactly one extra cell, got ${extra.length}`);
        assert(extra[0].itemCode === "CHK-001" && extra[0].subjectId === subjectId, "extra-cell identifies CHK-001 @ subject");
        assert(extra[0].itemDefinitionId === newId && extra[0].responseId !== null && extra[0].responseId !== undefined, "extra-cell carries v2 id + responseId");
    });

    await ok("G5L-21: no auto-repair occurs (durable rows unchanged by a failed read)", async () => {
        const w = await freshWorld();
        const visitId = await insertVisitRaw(w.db, w.missionId, w.institutionId);
        const pinned = new Map<string, number>();
        for (const code of EXPECTED_P0) {
            const defId = await activeDefId(w.db, code);
            pinned.set(code, defId);
            await insertCellRaw(w.db, visitId, defId, null, "NOT_INSPECTED");
        }
        const subjectId = await insertSubjectRaw(w.db, w.institutionId, "WORKSHOP", "W1");
        // a PARTIAL subject grid (10 of 20 codes) makes the subject a captured
        // context with a real scope gap
        for (const code of EXPECTED_P0.slice(0, 10)) {
            await insertCellRaw(w.db, visitId, pinned.get(code) as number, subjectId, "NOT_INSPECTED");
        }
        const before = await fullSnapshot(w.db);
        const err1 = await rejectsCode(APP_ERR.SCOPE_GAP, () => w.cvs.currentVisitState(visitId));
        const after = await fullSnapshot(w.db);
        assertDeepEqual(before, after, "corrupt grid unchanged after the failed read");
        const err2 = await rejectsCode(APP_ERR.SCOPE_GAP, () => w.cvs.currentVisitState(visitId));
        assertDeepEqual(blockersOf(err1), blockersOf(err2), "deterministic repeated blockers, still unrepaired");
    });

    await ok("G5L-22: actual/expected counts accurate", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await addSubject(w, visitId, "WORKSHOP", "W1");
        let state = await w.cvs.currentVisitState(visitId);
        assert(state.summary.expectedCellCount === 40 && state.summary.actualCellCount === 40, "40/40");
        await addSubject(w, visitId, "LAB", "L1");
        state = await w.cvs.currentVisitState(visitId);
        assert(state.summary.expectedCellCount === 60 && state.summary.actualCellCount === 60, "60/60 after the second context");
        assert(state.summary.capturedDefinitionCount === 20 && state.summary.contextCount === 3, "universe/context counts");
    });
}

// ---------------------------------------------------------------------------
// S5 — cells & classifications (GATE 5L §U items 23..32)
// ---------------------------------------------------------------------------
async function tS5_cells(): Promise<void> {
    await ok("G5L-23: pending classification correct (physical predicate)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const state = await w.cvs.currentVisitState(visitId);
        const expectedPending = await idSet(
            w.db,
            `SELECT response_id FROM checklist_response
              WHERE visit_id = ? AND overlay_state = 'NOT_INSPECTED' AND answered_value_id IS NULL AND not_inspected_reason IS NULL`,
            [visitId],
        );
        assertDeepEqual(
            [...state.classifications.pendingResponseIds].sort((a, b) => a - b),
            [...expectedPending].sort((a, b) => a - b),
            "pending list == durable pending rows",
        );
        for (const id of state.classifications.pendingResponseIds) {
            const cell = state.cells.find((c) => c.responseId === id);
            assert(cell !== undefined && (cell.classification === "PENDING" || cell.classification === "UNRESOLVED_HUMAN"), `cell ${id} pending-classified`);
        }
    });

    await ok("G5L-24: HUMAN pending => unresolved HUMAN (subset of pending)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const state = await w.cvs.currentVisitState(visitId);
        const chk020 = cellOfState(state, null, "CHK-020");
        assert(chk020.classification === "UNRESOLVED_HUMAN", "CHK-020 unresolved HUMAN");
        assert(chk020.contextualOutcome === "HUMAN_CONFIRMATION", "contextual outcome is genuinely HUMAN_CONFIRMATION");
        assert(state.classifications.unresolvedHumanResponseIds.includes(chk020.responseId), "in unresolved HUMAN list");
        assert(state.classifications.pendingResponseIds.includes(chk020.responseId), "also in the pending list");
        assert(state.classifications.unresolvedHumanResponseIds.length === 1, "exactly one unresolved HUMAN");
        const autoPending = cellOfState(state, null, "CHK-006");
        assert(autoPending.classification === "PENDING", "AUTO pending is plain PENDING");
    });

    await ok("G5L-25: answered classification correct + value metadata", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await answerCompliantCell(w, visitId, null, "CHK-006", "REGULAR");
        const state = await w.cvs.currentVisitState(visitId);
        const cell = cellOfState(state, null, "CHK-006");
        assert(cell.classification === "ANSWERED", "CHK-006 ANSWERED");
        assert(state.classifications.answeredResponseIds.includes(cell.responseId), "in answered list");
        assert(cell.overlayState === null && cell.answeredValueId !== null, "physical answered state");
        assert(cell.answeredValue?.valueCode === "REGULAR" && cell.answeredValue.semanticClass === "COMPLIANT", "value metadata");
        assert((cell.answeredValue.arabicLabel ?? "").length > 0, "arabic label present");
        assert(cell.note === null && cell.findingId === null, "no note/finding on compliant answer");
    });

    await ok("G5L-26: HUMAN answered classified resolved APPLICABLE/answered", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const cell = await cellOf(w.db, visitId, null, "CHK-020");
        await w.disp.answerSingle({
            cell,
            allowedValueId: await valueIdOfDef(w.db, cell.itemDefinitionId, "AVAILABLE"),
            humanDecision: "APPLICABLE",
        });
        const state = await w.cvs.currentVisitState(visitId);
        const c = cellOfState(state, null, "CHK-020");
        assert(c.classification === "HUMAN_APPLICABLE_ANSWERED", "explicit APPLICABLE + answered");
        assert(c.contextualOutcome === "HUMAN_CONFIRMATION", "contextual outcome HUMAN_CONFIRMATION");
        assert(state.classifications.answeredResponseIds.includes(c.responseId), "in answered list");
        assert(state.classifications.unresolvedHumanResponseIds.length === 0, "no unresolved HUMAN left");
    });

    await ok("G5L-27: deliberate NOT_INSPECTED classification correct", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await markNotInspectedCell(w, visitId, "CHK-006", "not reachable today");
        const state = await w.cvs.currentVisitState(visitId);
        const c = cellOfState(state, null, "CHK-006");
        assert(c.classification === "NOT_INSPECTED", "deliberate NOT_INSPECTED");
        assert(c.notInspectedReason === "not reachable today" && c.answeredValueId === null, "reason preserved, unanswered");
        assert(state.classifications.deliberateUninspectedResponseIds.includes(c.responseId), "in deliberate list");
        assert(!state.classifications.pendingResponseIds.includes(c.responseId), "not pending");
    });

    await ok("G5L-28: HUMAN reasoned NOT_INSPECTED interpreted APPLICABLE/not inspected", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const cell = await cellOf(w.db, visitId, null, "CHK-020");
        await w.disp.markNotInspected({ cell, reason: "المعدات خارج المبنى اليوم", humanDecision: "APPLICABLE" });
        const state = await w.cvs.currentVisitState(visitId);
        const c = cellOfState(state, null, "CHK-020");
        assert(c.classification === "HUMAN_APPLICABLE_NOT_INSPECTED", "explicit APPLICABLE, not inspected");
        assert(c.contextualOutcome === "HUMAN_CONFIRMATION", "contextual outcome HUMAN_CONFIRMATION");
        assert(state.classifications.deliberateUninspectedResponseIds.includes(c.responseId), "in deliberate list");
        assert(state.classifications.unresolvedHumanResponseIds.length === 0, "no unresolved HUMAN left");
    });

    await ok("G5L-29: NA classification correct", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const state = await w.cvs.currentVisitState(visitId);
        const c = cellOfState(state, null, "CHK-001");
        assert(c.classification === "NA", "CHK-001 NA in the institution context");
        assert(c.overlayState === "NA" && c.answeredValueId === null, "physical NA state");
        assert(state.classifications.naResponseIds.includes(c.responseId), "in NA list");
    });

    await ok("G5L-30: HUMAN NA interpreted NOT_APPLICABLE", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const cell = await cellOf(w.db, visitId, null, "CHK-020");
        await w.disp.resolveHumanApplicability({ cell });
        const state = await w.cvs.currentVisitState(visitId);
        const c = cellOfState(state, null, "CHK-020");
        assert(c.classification === "HUMAN_NOT_APPLICABLE", "explicit NOT_APPLICABLE decision");
        assert(c.contextualOutcome === "HUMAN_CONFIRMATION", "contextual outcome HUMAN_CONFIRMATION");
        assert(state.classifications.naResponseIds.includes(c.responseId), "in NA list");
    });

    await ok("G5L-86: a HUMAN_CONFIRMATION definition automatically excluded for a context reconstructs as ordinary NA", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const subjectId = await addSubject(w, visitId, "WORKSHOP", "W1");
        // CHK-020's pinned rule is HUMAN_CONFIRMATION with subject_kinds
        // [INSTITUTION] — in a WORKSHOP context the adopted evaluator returns
        // NOT_APPLICABLE automatically, so the scope service materialized a
        // plain automatic NA. currentVisitState must NOT misread that durable
        // NA as a historical explicit human NOT_APPLICABLE decision.
        const state = await w.cvs.currentVisitState(visitId);
        const cell = cellOfState(state, subjectId, "CHK-020");
        assert(cell.overlayState === "NA", "durable automatic NA in the WORKSHOP context");
        assert(cell.decisionKind === "HUMAN_CONFIRMATION", "definition-level root decision_kind preserved as metadata");
        assert(cell.contextualOutcome === "NOT_APPLICABLE", "contextual pinned outcome: rule excludes WORKSHOP");
        assert(cell.classification === "NA", "ordinary NA — NOT HUMAN_NOT_APPLICABLE");
        assert(state.classifications.naResponseIds.includes(cell.responseId), "in the NA list");
        // the same definition in the INSTITUTION context is genuinely HUMAN
        assert(
            cellOfState(state, null, "CHK-020").contextualOutcome === "HUMAN_CONFIRMATION",
            "institution-context cell is HUMAN-confirmable",
        );
    });

    await ok("G5L-87: a genuinely HUMAN cell explicitly resolved NOT_APPLICABLE reconstructs as HUMAN_NOT_APPLICABLE", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const ref = await cellOf(w.db, visitId, null, "CHK-020");
        await w.disp.resolveHumanApplicability({ cell: ref });
        const state = await w.cvs.currentVisitState(visitId);
        const c = cellOfState(state, null, "CHK-020");
        assert(c.overlayState === "NA", "durable NA overlay");
        assert(c.contextualOutcome === "HUMAN_CONFIRMATION", "contextual outcome is HUMAN_CONFIRMATION in the applicable context");
        assert(c.classification === "HUMAN_NOT_APPLICABLE", "explicit human NOT_APPLICABLE decision / recorded reversal");
        assert(state.classifications.naResponseIds.includes(c.responseId), "in NA list");
    });

    await ok("G5L-31: recordedAt/recordedBy preserved on every cell", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await answerCompliantCell(w, visitId, null, "CHK-006", "REGULAR");
        const state = await w.cvs.currentVisitState(visitId);
        for (const c of state.cells) {
            assert(c.recordedAt === NOW && c.recordedBy === "inspector-a", `cell ${c.responseId} scope-entry audit`);
        }
    });

    await ok("G5L-32: answered value semantic metadata reconstructed from the pinned definition", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const cellRef = await cellOf(w.db, visitId, null, "CHK-007");
        await w.disp.answerSingle({
            cell: cellRef,
            allowedValueId: await valueIdOfDef(w.db, cellRef.itemDefinitionId, "REGULAR"),
        });
        const state = await w.cvs.currentVisitState(visitId);
        const c = cellOfState(state, null, "CHK-007");
        const dbRow = await w.db.query(
            "SELECT value_code, arabic_label, semantic_class, sort_order, active FROM checklist_allowed_value WHERE allowed_value_id = ?",
            [c.answeredValueId],
        );
        assert(dbRow.length === 1, "durable value row exists");
        assert(c.answeredValue?.valueCode === String(dbRow[0].value_code), "valueCode");
        assert(c.answeredValue?.arabicLabel === String(dbRow[0].arabic_label), "arabicLabel");
        assert(c.answeredValue?.semanticClass === String(dbRow[0].semantic_class), "semanticClass");
        assert(c.itemDefinitionId === cellRef.itemDefinitionId, "pinned interpretation id");
        assert(c.decisionKind === "AUTO" && c.responseModel === "SINGLE_VALUE", "pinned decision/model");
    });
}

// ---------------------------------------------------------------------------
// S6 — SCHEDULE reconstruction (GATE 5L §U items 33..35)
// ---------------------------------------------------------------------------
async function tS6_schedule(): Promise<void> {
    await ok("G5L-33: SCHEDULE reconciliation rows reconstructed", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await answerScheduleCompliant(w, visitId);
        const state = await w.cvs.currentVisitState(visitId);
        const c = cellOfState(state, null, "CHK-012");
        assert(c.responseModel === "SCHEDULE" && c.answeredValue?.valueCode === "MATCHED", "schedule overall answered");
        assert(c.reconciliationRows !== undefined && c.reconciliationRows.length === 2, "two reconciliation rows");
        const rows = await w.db.query(
            "SELECT row_id, category, declared_qty, observed_qty, difference, discrepancy_type, discrepancy_desc, sort_order FROM equipment_reconciliation_row ORDER BY row_id",
        );
        assert(rows.length === 2, "durable row count");
        for (let i = 0; i < 2; i++) {
            const s = c.reconciliationRows[i];
            const d = rows[i];
            assert(s.rowId === Number(d.row_id) && s.category === String(d.category), `row ${i} id/category`);
            assert(s.declaredQty === Number(d.declared_qty) && s.observedQty === Number(d.observed_qty), `row ${i} quantities`);
            assert(s.difference === Number(d.difference) && s.discrepancyType === null && s.discrepancyDesc === null, `row ${i} no discrepancy`);
        }
        // a non-SCHEDULE cell never carries the field
        assert(cellOfState(state, null, "CHK-006").reconciliationRows === undefined, "non-SCHEDULE cell has no recon field");
    });

    await ok("G5L-34: stable reconciliation ordering (row_id)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await answerScheduleCompliant(w, visitId);
        const state = await w.cvs.currentVisitState(visitId);
        const c = cellOfState(state, null, "CHK-012");
        assertDeepEqual(
            c.reconciliationRows?.map((r) => r.category),
            ["portable-extinguishers", "first-aid-boxes"],
            "rows in durable insertion (row_id) order",
        );
    });

    await ok("G5L-35: reconciliation rows are not mutated", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await answerScheduleCompliant(w, visitId);
        const before = await fullSnapshot(w.db);
        await w.cvs.currentVisitState(visitId);
        const after = await fullSnapshot(w.db);
        assertDeepEqual(before, after, "reconciliation rows (and everything else) unchanged");
    });
}

// ---------------------------------------------------------------------------
// S7 — observations (GATE 5L §U items 36..40)
// ---------------------------------------------------------------------------
async function tS7_observations(): Promise<void> {
    await ok("G5L-36: Visit observations reconstructed", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await w.obs.createAdHocObservation({ visitId, text: "first note", recordedAt: NOW, recordedBy: "inspector-a" });
        await w.obs.createAdHocObservation({ visitId, text: "second note", recordedAt: NOW, recordedBy: "inspector-a" });
        const state = await w.cvs.currentVisitState(visitId);
        assert(state.observations.length === 2 && state.summary.observationCount === 2, "two observations");
        assertDeepEqual(
            state.observations.map((o) => o.text),
            ["first note", "second note"],
            "observation texts reconstructed",
        );
    });

    await ok("G5L-37: general observation subject NULL preserved", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const obs = await w.obs.createAdHocObservation({ visitId, text: "general", recordedAt: NOW, recordedBy: "inspector-a" });
        const state = await w.cvs.currentVisitState(visitId);
        assert(state.observations.length === 1, "one observation");
        assert(state.observations[0].observationId === obs.observationId && state.observations[0].subjectId === null, "subject NULL preserved");
        assert(state.observations[0].recordedAt === NOW && state.observations[0].recordedBy === "inspector-a", "audit preserved");
    });

    await ok("G5L-38: subject observation preserved", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const subjectId = await addSubject(w, visitId, "WORKSHOP", "W1");
        await w.obs.createAdHocObservation({ visitId, subjectId, text: "workshop note", recordedAt: NOW, recordedBy: "inspector-a" });
        const state = await w.cvs.currentVisitState(visitId);
        assert(state.observations[0].subjectId === subjectId, "subject observation preserved");
    });

    await ok("G5L-39: linked findingId preserved", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const obs = await w.obs.createAdHocObservation({ visitId, text: "leak seen", recordedAt: NOW, recordedBy: "inspector-a" });
        const link = await w.obsFinding.createFindingWithObservationSource({
            observationId: obs.observationId,
            finding: { description: "ceiling leak", defectType: "WATER_LEAK", urgency: "IMMEDIATE", impact: "HIGH" },
            actor: "inspector-a",
            now: NOW,
        });
        const state = await w.cvs.currentVisitState(visitId);
        assert(state.observations[0].findingId === link.findingId, "observation findingId preserved");
        assertDeepEqual(
            state.observationSources,
            [{ observationId: obs.observationId, findingId: link.findingId }],
            "observation-source map",
        );
    });

    await ok("G5L-40: observation ordering deterministic (observation_id)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await w.obs.createAdHocObservation({ visitId, text: "a", recordedAt: NOW, recordedBy: "inspector-a" });
        await w.obs.createAdHocObservation({ visitId, text: "b", recordedAt: NOW, recordedBy: "inspector-a" });
        await w.obs.createAdHocObservation({ visitId, text: "c", recordedAt: NOW, recordedBy: "inspector-a" });
        const state = await w.cvs.currentVisitState(visitId);
        const ids = state.observations.map((o) => o.observationId);
        assertDeepEqual(ids, [...ids].sort((a, b) => a - b), "observation_id ascending");
    });
}

// ---------------------------------------------------------------------------
// S8 — findings (GATE 5L §U items 41..49)
// ---------------------------------------------------------------------------
async function tS8_findings(): Promise<void> {
    await ok("G5L-41: Finding originated in the Visit reconstructed", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const findingId = await answerNcCell(w, visitId, "CHK-006", "not compliant: regulator");
        const state = await w.cvs.currentVisitState(visitId);
        assert(state.activeFindings.length === 1 && state.voidedFindings.length === 0, "one active finding");
        const f = state.activeFindings[0];
        assert(f.findingId === findingId && f.originVisitId === visitId, "origin visit");
        assert(f.description === "defect observed on site" && f.defectType === "EQUIPMENT_FAULT", "durable fields");
        assert(f.location === "workshop" && f.urgency === "IMMEDIATE" && f.impact === "HIGH", "classification fields");
        assert(f.status === "OPEN" && f.statusChangedAt === null && f.createdAt === NOW && f.createdBy === "inspector-a", "status/audit");
        assert(f.subjectId === null, "institution-context finding");
    });

    await ok("G5L-42: externally-originated Finding referenced by a Visit source reconstructed", async () => {
        const w = await freshWorld();
        const visitB = await standardCreate(w);
        const findingId = await answerNcCell(w, visitB, "CHK-006", "B defect");
        const visitA = await standardCreate(w);
        await answerNcExisting(w, visitA, "CHK-006", findingId, "same issue confirmed in A");
        const stateA = await w.cvs.currentVisitState(visitA);
        const f = stateA.activeFindings.find((x) => x.findingId === findingId);
        assert(f !== undefined && f.originVisitId === visitB, "external-origin Finding resolved from A's source link");
        const aCell = cellOfState(stateA, null, "CHK-006");
        assert(f.sourceResponseIds.includes(aCell.responseId), "per-finding source array carries A's cell");
        assertDeepEqual(
            stateA.responseSources,
            [{ responseId: aCell.responseId, findingId }],
            "response-source map of A",
        );
    });

    await ok("G5L-43: unrelated Finding excluded", async () => {
        const w = await freshWorld();
        const visitA = await standardCreate(w);
        const findingA = await answerNcCell(w, visitA, "CHK-006", "A defect");
        const visitC = await standardCreate(w);
        const findingC = await answerNcCell(w, visitC, "CHK-006", "C defect");
        const stateA = await w.cvs.currentVisitState(visitA);
        assert(stateA.activeFindings.some((f) => f.findingId === findingA), "A's own finding present");
        assert(!stateA.activeFindings.some((f) => f.findingId === findingC), "C's finding excluded");
    });

    await ok("G5L-44: active Finding list correct across statuses", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const findingId = await answerNcCell(w, visitId, "CHK-006", "defect A");
        const tr = await w.findStatus.transitionFindingStatus({
            findingId,
            to: "IN_TREATMENT",
            event: { eventDatetime: T1, actorRole: "DIRECTOR", actorName: "director-a", note: "treatment started", recordedBy: "director-a" },
        });
        assert(tr.status === "IN_TREATMENT", "precondition: transition");
        const state = await w.cvs.currentVisitState(visitId);
        const f = state.activeFindings.find((x) => x.findingId === findingId);
        assert(f !== undefined && f.status === "IN_TREATMENT" && f.statusChangedAt === T1, "active list carries IN_TREATMENT");
        assert(state.voidedFindings.length === 0, "not voided");
    });

    await ok("G5L-45: VOIDED Finding history retained separately", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const findingId = await insertFindingRaw(w.db, visitId);
        await setFindingVoidedRaw(w.db, findingId);
        const state = await w.cvs.currentVisitState(visitId);
        assert(state.voidedFindings.length === 1 && state.voidedFindings[0].findingId === findingId, "in the voided list");
        assert(state.voidedFindings[0].status === "VOIDED", "VOIDED status");
        assert(!state.activeFindings.some((f) => f.findingId === findingId), "not in the active list");
    });

    await ok("G5L-46: zero-source VOIDED is valid (never an orphan)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const findingId = await insertFindingRaw(w.db, visitId);
        await setFindingVoidedRaw(w.db, findingId);
        const state = await w.cvs.currentVisitState(visitId);
        assert(state.summary.voidedFindingCount === 1 && state.summary.activeFindingCount === 0, "healthy read with a source-less VOIDED");
        assert(state.voidedFindings[0].sourceResponseIds.length === 0 && state.voidedFindings[0].sourceObservationIds.length === 0, "zero sources visible");
    });

    await ok("G5L-47: source-less OPEN => E_ORPHAN_FINDING", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const findingId = await insertFindingRaw(w.db, visitId);
        const err = await rejectsCode(APP_ERR.ORPHAN_FINDING, () => w.cvs.currentVisitState(visitId));
        const orphans = blockersOf(err).filter((b) => b.kind === "orphan-finding");
        assert(orphans.length === 1 && orphans[0].findingId === findingId, "orphan identified with its durable id");
    });

    await ok("G5L-48: response-source map correct", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const findingId = await answerNcCell(w, visitId, "CHK-006", "defect A");
        const state = await w.cvs.currentVisitState(visitId);
        const cell = cellOfState(state, null, "CHK-006");
        assert(cell.findingId === findingId, "cell carries the durable link");
        assertDeepEqual(
            state.responseSources,
            [{ responseId: cell.responseId, findingId }],
            "responseSources map",
        );
        assert(state.observationSources.length === 0, "no observation sources in this world");
    });

    await ok("G5L-49: observation-source map correct", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const obs = await w.obs.createAdHocObservation({ visitId, text: "leak seen", recordedAt: NOW, recordedBy: "inspector-a" });
        const link = await w.obsFinding.createFindingWithObservationSource({
            observationId: obs.observationId,
            finding: { description: "ceiling leak", defectType: "WATER_LEAK", urgency: "IMMEDIATE", impact: "HIGH" },
            actor: "inspector-a",
            now: NOW,
        });
        const state = await w.cvs.currentVisitState(visitId);
        assertDeepEqual(
            state.observationSources,
            [{ observationId: obs.observationId, findingId: link.findingId }],
            "observationSources map",
        );
        const f = state.activeFindings.find((x) => x.findingId === link.findingId);
        assert(f !== undefined && f.sourceObservationIds.length === 1 && f.sourceObservationIds[0] === obs.observationId, "per-finding observation source");
        assert(state.responseSources.length === 0, "no response sources in this world");
    });
}

// ---------------------------------------------------------------------------
// S9 — corrective actions (GATE 5L §U items 50..53)
// ---------------------------------------------------------------------------
async function tS9_actions(): Promise<void> {
    await ok("G5L-50: actions under reconstructed Findings included", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const findingId = await answerNcCell(w, visitId, "CHK-006", "defect A");
        const created = await w.caCreate.createCorrectiveAction({
            findingId,
            actionType: "MAINTENANCE_WORK",
            description: "repair the regulator",
            responsibleRole: "CONCERNED_SERVICE",
            responsibleName: "maintenance-team",
            dueDate: "2026-09-20",
            createdAt: NOW,
            createdBy: "inspector-a",
        });
        const state = await w.cvs.currentVisitState(visitId);
        assert(state.correctiveActions.length === 1 && state.summary.correctiveActionCount === 1, "one action");
        const a = state.correctiveActions[0];
        assert(a.actionId === created.actionId && a.findingId === findingId, "identity");
        assert(a.actionType === "MAINTENANCE_WORK" && a.actionTypeOther === null, "type");
        assert(a.description === "repair the regulator" && a.responsibleRole === "CONCERNED_SERVICE", "description/role");
        assert(a.responsibleName === "maintenance-team" && a.dueDate === "2026-09-20", "name/due date");
        assert(a.status === "OPEN" && a.closedAt === null && a.verifiedBy === null && a.verificationNote === null, "born OPEN, closure NULL");
        assert(a.createdAt === NOW && a.createdBy === "inspector-a", "audit");
    });

    await ok("G5L-51: unrelated actions excluded", async () => {
        const w = await freshWorld();
        const visitA = await standardCreate(w);
        const findingA = await answerNcCell(w, visitA, "CHK-006", "A defect");
        const visitC = await standardCreate(w);
        const findingC = await answerNcCell(w, visitC, "CHK-006", "C defect");
        await w.caCreate.createCorrectiveAction({
            findingId: findingC,
            actionType: "ADMIN_ORGANIZATIONAL",
            description: "C action",
            responsibleRole: "DIRECTOR",
            createdAt: NOW,
            createdBy: "inspector-a",
        });
        const stateA = await w.cvs.currentVisitState(visitA);
        assert(stateA.correctiveActions.every((a) => a.findingId === findingA), "only A's actions reconstructed");
        assert(stateA.correctiveActions.length === 0, "A has no actions");
    });

    await ok("G5L-52: OPEN/IN_TREATMENT/RESOLVED action states preserved", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const findingId = await answerNcCell(w, visitId, "CHK-006", "defect A");
        const openId = await insertActionRaw(w.db, findingId, "open action");
        const inTxId = await insertActionRaw(w.db, findingId, "in-treatment action");
        await setActionStatusRaw(w.db, inTxId, "IN_TREATMENT");
        const state = await w.cvs.currentVisitState(visitId);
        const byId = new Map(state.correctiveActions.map((a) => [a.actionId, a]));
        assert(byId.get(openId)?.status === "OPEN", "OPEN preserved");
        assert(byId.get(inTxId)?.status === "IN_TREATMENT" && byId.get(inTxId)?.closedAt === null, "IN_TREATMENT preserved (closure NULL)");
        assert(state.correctiveActions.length === 2, "both actions reconstructed");
    });

    await ok("G5L-53: RESOLVED closure fields preserved", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const findingId = await answerNcCell(w, visitId, "CHK-006", "defect A");
        const actionId = await insertActionRaw(w.db, findingId, "resolve me");
        const res = await w.caStatus.transitionCorrectiveActionStatus({
            actionId,
            to: "RESOLVED",
            event: { eventDatetime: T2, actorRole: "DIRECTOR", actorName: "director-a", note: "verified fixed", recordedBy: "director-a" },
            resolution: { verifiedBy: "director-a", verificationNote: "on-site check passed" },
        });
        assert(res.status === "RESOLVED", "precondition: resolved");
        const state = await w.cvs.currentVisitState(visitId);
        const a = state.correctiveActions.find((x) => x.actionId === actionId);
        assert(a !== undefined && a.status === "RESOLVED", "RESOLVED preserved");
        assert(a.closedAt === T2 && a.verifiedBy === "director-a" && a.verificationNote === "on-site check passed", "closure fields preserved");
    });
}

// ---------------------------------------------------------------------------
// S10 — follow-ups (GATE 5L §U items 54..58)
// ---------------------------------------------------------------------------
async function tS10_followups(): Promise<void> {
    await ok("G5L-54: Finding FollowUps reconstructed", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const findingId = await answerNcCell(w, visitId, "CHK-006", "defect A");
        await w.findStatus.transitionFindingStatus({
            findingId,
            to: "IN_TREATMENT",
            event: { eventDatetime: T1, actorRole: "DIRECTOR", actorName: "director-a", note: "treatment started", recordedBy: "director-a" },
        });
        const state = await w.cvs.currentVisitState(visitId);
        assert(state.followUps.length === 1, "one follow-up");
        const fu = state.followUps[0];
        assert(fu.findingId === findingId && fu.correctiveActionId === null, "finding event");
        assert(fu.statusTarget === "FINDING" && fu.statusAfter === "IN_TREATMENT", "status event");
        assert(fu.eventDatetime === T1 && fu.actorRole === "DIRECTOR" && fu.actorName === "director-a", "audit fields");
        assert(fu.note === "treatment started" && fu.recordedBy === "director-a", "note/recordedBy");
    });

    await ok("G5L-55: Action FollowUps reconstructed", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const findingId = await answerNcCell(w, visitId, "CHK-006", "defect A");
        const actionId = await insertActionRaw(w.db, findingId, "resolve me");
        await w.caStatus.transitionCorrectiveActionStatus({
            actionId,
            to: "RESOLVED",
            event: { eventDatetime: T2, actorRole: "DIRECTOR", note: "verified fixed", recordedBy: "director-a" },
            resolution: { verifiedBy: "director-a" },
        });
        const state = await w.cvs.currentVisitState(visitId);
        assert(state.followUps.length === 1, "one follow-up");
        const fu = state.followUps[0];
        assert(fu.correctiveActionId === actionId && fu.findingId === findingId, "action event under its finding");
        assert(fu.statusTarget === "CORRECTIVE_ACTION" && fu.statusAfter === "RESOLVED", "action status event");
    });

    await ok("G5L-56: unrelated FollowUps excluded", async () => {
        const w = await freshWorld();
        const visitA = await standardCreate(w);
        const findingA = await answerNcCell(w, visitA, "CHK-006", "A defect");
        const visitC = await standardCreate(w);
        const findingC = await answerNcCell(w, visitC, "CHK-006", "C defect");
        await w.findStatus.transitionFindingStatus({
            findingId: findingC,
            to: "IN_TREATMENT",
            event: { eventDatetime: T1, actorRole: "DIRECTOR", note: "C in treatment", recordedBy: "director-a" },
        });
        const stateA = await w.cvs.currentVisitState(visitA);
        assert(stateA.followUps.length === 0, "C's follow-up not reconstructed for A");
        assert(stateA.activeFindings.some((f) => f.findingId === findingA), "A's finding still present");
    });

    await ok("G5L-57: chronological + id deterministic ordering", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const f1 = await answerNcCell(w, visitId, "CHK-006", "defect 1");
        const f2 = await answerNcCell(w, visitId, "CHK-007", "defect 2");
        await w.findStatus.transitionFindingStatus({
            findingId: f1,
            to: "IN_TREATMENT",
            event: { eventDatetime: T1, actorRole: "DIRECTOR", note: "f1 in treatment", recordedBy: "director-a" },
        });
        await w.findStatus.transitionFindingStatus({
            findingId: f2,
            to: "IN_TREATMENT",
            event: { eventDatetime: T1, actorRole: "DIRECTOR", note: "f2 in treatment", recordedBy: "director-a" },
        });
        await w.findStatus.transitionFindingStatus({
            findingId: f1,
            to: "RESOLVED",
            event: { eventDatetime: T2, actorRole: "DIRECTOR", note: "f1 resolved", recordedBy: "director-a" },
        });
        const state = await w.cvs.currentVisitState(visitId);
        assert(state.followUps.length === 3, "three follow-ups");
        const seq = state.followUps.map((fu) => `${fu.eventDatetime}|${fu.followUpId}|${fu.findingId}|${fu.statusAfter}`);
        // same-datetime pair orders by followup_id (insertion order: f1 then f2)
        assert(
            state.followUps[0].eventDatetime === T1 && state.followUps[0].findingId === f1 && state.followUps[0].statusAfter === "IN_TREATMENT",
            "first: f1 @ T1",
        );
        assert(
            state.followUps[1].eventDatetime === T1 && state.followUps[1].findingId === f2 && state.followUps[1].statusAfter === "IN_TREATMENT",
            "second: f2 @ T1 (same datetime, id order)",
        );
        assert(
            state.followUps[2].eventDatetime === T2 && state.followUps[2].findingId === f1 && state.followUps[2].statusAfter === "RESOLVED",
            "third: f1 @ T2",
        );
        const sorted = [...seq].sort();
        assertDeepEqual(seq, sorted, "(event_datetime, followup_id) ordering holds");
    });

    await ok("G5L-58: VOIDED history event retained", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const findingId = await insertFindingRaw(w.db, visitId);
        await setFindingVoidedRaw(w.db, findingId, T1);
        await insertFollowUpRaw(w.db, findingId, { statusTarget: "FINDING", statusAfter: "VOIDED", eventDatetime: T1 });
        const state = await w.cvs.currentVisitState(visitId);
        assert(state.voidedFindings.length === 1, "voided finding retained");
        const fu = state.followUps.find((x) => x.findingId === findingId);
        assert(fu !== undefined && fu.statusAfter === "VOIDED" && fu.statusTarget === "FINDING", "VOIDED audit event retained");
        assert(fu.eventDatetime === T1, "event datetime retained");
    });
}

// ---------------------------------------------------------------------------
// S11 — restart / no volatile memory (GATE 5L §U items 59..62)
// ---------------------------------------------------------------------------
async function tS11_restart(): Promise<void> {
    await ok("G5L-59: same DB + new service instance => deep-equivalent state", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await addSubject(w, visitId, "WORKSHOP", "W1");
        await disposeInstitution(w, visitId, ["CHK-010"]);
        const findingId = await answerNcCell(w, visitId, "CHK-010", "defect");
        const s1 = await w.cvs.currentVisitState(visitId);
        const second = new CurrentVisitStateService(w.db);
        const s2 = await second.currentVisitState(visitId);
        assertDeepEqual(s1, s2, "two service instances reconstruct identically");
    });

    await ok("G5L-60: simulated process restart (new connection, cleared process memory) => deep-equivalent state", async () => {
        const path = join(ROOT, ".tmp-gate5l-restart.sqlite");
        const { w, conns } = await fileWorld(path);
        try {
            const visitId = await standardCreate(w);
            await addSubject(w, visitId, "WORKSHOP", "W1");
            await disposeInstitution(w, visitId, ["CHK-010"]);
            await answerNcCell(w, visitId, "CHK-010", "defect");
            const s1 = await w.cvs.currentVisitState(visitId);

            // "process restart": a brand-new connection + brand-new services
            // (the schema already lives in the file; only the per-connection
            // pragma must be re-established)
            const conn2 = new DatabaseSync(path);
            conn2.exec("PRAGMA foreign_keys = ON");
            conns.push(conn2);
            const db2 = new NodeSqliteAdapter(conn2);
            const ids = { missionId: w.missionId, institutionId: w.institutionId };
            const w2 = buildServices(db2, ids.missionId, ids.institutionId);
            const s2 = await w2.cvs.currentVisitState(visitId);
            assertDeepEqual(s1, s2, "restart reconstruction is deep-equivalent");
        } finally {
            for (const c of conns) c.close();
            rmSync(path, { force: true });
        }
    });

    await ok("G5L-61: durable DB mutation through an adopted operation is reflected on the next read", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const s1 = await w.cvs.currentVisitState(visitId);
        assert(cellOfState(s1, null, "CHK-006").classification === "PENDING", "before: pending");
        await answerCompliantCell(w, visitId, null, "CHK-006", "REGULAR");
        const s2 = await w.cvs.currentVisitState(visitId);
        assert(cellOfState(s2, null, "CHK-006").classification === "ANSWERED", "after: answered");
        assert(s2.summary.pendingCount === s1.summary.pendingCount - 1, "pending count reflects the durable change");
        assert(s2.summary.answeredCount === s1.summary.answeredCount + 1, "answered count reflects the durable change");
    });

    await ok("G5L-62: no hidden process cache authority (repeated reads identical until durable change)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const s1 = await w.cvs.currentVisitState(visitId);
        const s2 = await w.cvs.currentVisitState(visitId);
        assertDeepEqual(s1, s2, "repeated reads identical");
        const s3 = await new CurrentVisitStateService(w.db).currentVisitState(visitId);
        assertDeepEqual(s1, s3, "fresh instance identical (no in-memory authority)");
    });
}

// ---------------------------------------------------------------------------
// S12 — snapshot / transaction (GATE 5L §U items 63..66)
// ---------------------------------------------------------------------------
async function tS12_snapshot(): Promise<void> {
    await ok("G5L-63: one coherent transaction — beginImmediate once, queries only, commit once", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await addSubject(w, visitId, "WORKSHOP", "W1");
        const recording = new RecordingAdapter(w.db);
        const svc = new CurrentVisitStateService(recording);
        const state = await svc.currentVisitState(visitId);
        assertDeepEqual(recording.calls, ["beginImmediate", "commit"], "exactly one begin/commit pair");
        assert(recording.querySql.length >= 5, `multi-query reconstruction (${recording.querySql.length} queries)`);
        assert(!recording.calls.includes("run") && !recording.calls.includes("rollback"), "no run/rollback on success");
        assert(state.summary.expectedCellCount === 40 && state.summary.actualCellCount === 40, "snapshot content sane");
    });

    await ok("G5L-63b: the chosen realization does NOT allow mixed snapshots (concurrent writer blocked for the whole read)", async () => {
        const path = join(ROOT, ".tmp-gate5l-busy.sqlite");
        const { w, conns } = await fileWorld(path);
        // a SECOND connection to the SAME file (the schema already lives in
        // the file) with an immediate busy timeout: every write attempt while
        // the read unit holds BEGIN IMMEDIATE must fail with SQLITE_BUSY.
        const probeConn = new DatabaseSync(path);
        probeConn.exec("PRAGMA busy_timeout = 0");
        conns.push(probeConn);
        const probeDb = new NodeSqliteAdapter(probeConn);
        try {
            const visitId = await standardCreate(w);
            const before = await fullSnapshot(w.db);
            let probeAttempts = 0;
            let probeBusy = 0;
            const probeErrors: string[] = [];
            const wrapped = new BusyProbeAdapter(w.db, async () => {
                probeAttempts += 1;
                try {
                    await probeDb.run(
                        "INSERT INTO mission(name, status, created_at, created_by) VALUES ('BUSYPROBE', 'PREPARATION', ?, 'probe')",
                        [NOW],
                    );
                } catch (e) {
                    probeBusy += 1;
                    probeErrors.push(e instanceof Error ? e.message : String(e));
                }
            });
            const svc = new CurrentVisitStateService(wrapped);
            const state = await svc.currentVisitState(visitId);
            assert(probeAttempts > 0, "the probe writer attempted at least once");
            assert(probeBusy === probeAttempts, `every probe write was BLOCKED while the read unit was open (${probeBusy}/${probeAttempts})`);
            assert(probeErrors.every((m) => /locked|busy/i.test(m)), `busy errors observed: ${probeErrors.join(" | ")}`);
            assert(state.summary.actualCellCount === 20 && state.cells.length === 20, "the reconstructed snapshot is the pre-write committed state");
            const during = await fullSnapshot(w.db);
            assertDeepEqual(before, during, "no writer state leaked into the read unit");
            // the barrier releases at COMMIT: the same write now succeeds
            const afterProbe = await probeDb.run(
                "INSERT INTO mission(name, status, created_at, created_by) VALUES ('BUSYPROBE', 'PREPARATION', ?, 'probe')",
                [NOW],
            );
            assert(afterProbe.changes === 1, "writer proceeds once the read unit committed");
        } finally {
            for (const c of conns) c.close();
            rmSync(path, { force: true });
        }
    });

    await ok("G5L-64: no run()/write SQL issued inside reconstruction", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const recording = new RecordingAdapter(w.db);
        const svc = new CurrentVisitStateService(recording);
        await svc.currentVisitState(visitId);
        assert(!recording.calls.includes("run"), "zero run() calls");
        for (const sql of recording.querySql) {
            assert(!/^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql.trim()), `no write SQL: ${sql.slice(0, 60)}`);
            assert(/^\s*SELECT\b/i.test(sql.trim()), `every statement is a SELECT: ${sql.slice(0, 60)}`);
        }
    });

    await ok("G5L-65: transaction commits/ends cleanly after the read", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const recording = new RecordingAdapter(w.db);
        const svc = new CurrentVisitStateService(recording);
        await svc.currentVisitState(visitId);
        assertDeepEqual(recording.calls, ["beginImmediate", "commit"], "clean begin/commit");
        // the connection is not left inside a transaction: a follow-up write
        // operation on the raw adapter succeeds immediately
        const cell = await cellOf(w.db, visitId, null, "CHK-006");
        await w.disp.answerSingle({ cell, allowedValueId: await valueIdOfDef(w.db, cell.itemDefinitionId, "REGULAR") });
        const state = await w.cvs.currentVisitState(visitId);
        assert(cellOfState(state, null, "CHK-006").classification === "ANSWERED", "no dangling transaction blocks later work");
    });

    await ok("G5L-66: a read failure rolls back and ends the transaction cleanly", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await answerNcCell(w, visitId, "CHK-006", "defect"); // ensures the follow_up query is reached
        const faulting = new FaultQueryAdapter(w.db, (sql) => sql.includes("FROM follow_up"));
        const svc = new CurrentVisitStateService(faulting);
        const err = await rejectsAny(() => svc.currentVisitState(visitId));
        assert(err.message === "injected adapter fault", "original failure propagated");
        assertDeepEqual(faulting.calls, ["beginImmediate", "rollback"], "rollback exactly once, no commit");
        const before = await fullSnapshot(w.db);
        const after = await fullSnapshot(w.db);
        assertDeepEqual(before, after, "no durable row changed by the failed read");
        // the connection is clean: a fresh full reconstruction succeeds
        const state = await w.cvs.currentVisitState(visitId);
        assert(state.summary.activeFindingCount === 1, "subsequent reconstruction succeeds");
    });
}

// ---------------------------------------------------------------------------
// S13 — derived restart summary (GATE 5L §U items 67..69)
// ---------------------------------------------------------------------------
async function tS13_summary(): Promise<void> {
    await ok("G5L-67: expected/actual cell counts correct", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        let state = await w.cvs.currentVisitState(visitId);
        assert(state.summary.expectedCellCount === 20 && state.summary.actualCellCount === 20, "institution-only world");
        await addSubject(w, visitId, "WORKSHOP", "W1");
        state = await w.cvs.currentVisitState(visitId);
        assert(state.summary.expectedCellCount === 40 && state.summary.actualCellCount === 40, "two-context world");
        await addSubject(w, visitId, "LAB", "L1");
        state = await w.cvs.currentVisitState(visitId);
        assert(state.summary.expectedCellCount === 60 && state.summary.actualCellCount === 60, "three-context world");
    });

    await ok("G5L-68: pending/HUMAN/uninspected/answered/NA counts correct", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await disposeInstitution(w, visitId, ["CHK-006"]);
        await markNotInspectedCell(w, visitId, "CHK-006", "not reachable");
        const state = await w.cvs.currentVisitState(visitId);
        const s = state.summary;
        assert(s.pendingCount === state.classifications.pendingResponseIds.length, "pending count == list length");
        assert(s.unresolvedHumanCount === state.classifications.unresolvedHumanResponseIds.length, "HUMAN count == list length");
        assert(s.deliberateUninspectedCount === state.classifications.deliberateUninspectedResponseIds.length, "uninspected count == list length");
        assert(s.answeredCount === state.classifications.answeredResponseIds.length, "answered count == list length");
        assert(s.naCount === state.classifications.naResponseIds.length, "NA count == list length");
        assert(s.pendingCount === 0 && s.unresolvedHumanCount === 0, "fully dispositioned");
        assert(s.deliberateUninspectedCount === 1 && s.answeredCount === 4 && s.naCount === 15, "exact disposition counts");
    });

    await ok("G5L-69: observation/finding/action counts correct", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await w.obs.createAdHocObservation({ visitId, text: "a", recordedAt: NOW, recordedBy: "inspector-a" });
        await w.obs.createAdHocObservation({ visitId, text: "b", recordedAt: NOW, recordedBy: "inspector-a" });
        const f1 = await answerNcCell(w, visitId, "CHK-006", "defect 1");
        const f2 = await answerNcCell(w, visitId, "CHK-007", "defect 2");
        await w.caCreate.createCorrectiveAction({
            findingId: f1,
            actionType: "MAINTENANCE_WORK",
            description: "fix 1",
            responsibleRole: "CONCERNED_SERVICE",
            createdAt: NOW,
            createdBy: "inspector-a",
        });
        await insertFindingRaw(w.db, visitId, "voided one");
        const rawVoid = await w.db.query("SELECT finding_id FROM finding WHERE description = 'voided one'");
        await setFindingVoidedRaw(w.db, Number(rawVoid[0].finding_id));
        const state = await w.cvs.currentVisitState(visitId);
        const s = state.summary;
        assert(s.observationCount === 2, "observation count");
        assert(s.activeFindingCount === 2 && s.voidedFindingCount === 1, "active/voided finding counts");
        assert(s.correctiveActionCount === 1, "action count");
        assert(s.followUpCount === state.followUps.length, "follow-up count == list length");
        assert(s.followUpCount === 0, "no transitions recorded in this world");
    });
}

// ---------------------------------------------------------------------------
// S14 — cross-cutting (GATE 5L §U items 70..75)
// ---------------------------------------------------------------------------
async function tS14_crosscutting(): Promise<void> {
    await ok("G5L-70: pending cells are NOT treated as errors", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const state = await w.cvs.currentVisitState(visitId);
        assert(state.summary.pendingCount === 6, "pending cells present and healthy");
    });

    await ok("G5L-71: active Findings are NOT treated as errors", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await answerNcCell(w, visitId, "CHK-006", "defect");
        const state = await w.cvs.currentVisitState(visitId);
        assert(state.summary.activeFindingCount === 1, "OPEN finding present and healthy");
    });

    await ok("G5L-72: active Actions are NOT treated as errors", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const findingId = await answerNcCell(w, visitId, "CHK-006", "defect");
        await insertActionRaw(w.db, findingId);
        const state = await w.cvs.currentVisitState(visitId);
        assert(state.summary.correctiveActionCount === 1, "OPEN action present and healthy");
    });

    await ok("G5L-73: deliberate NOT_INSPECTED is reconstructable", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await markNotInspectedCell(w, visitId, "CHK-006", "not reachable today");
        const state = await w.cvs.currentVisitState(visitId);
        const c = cellOfState(state, null, "CHK-006");
        assert(c.classification === "NOT_INSPECTED" && c.notInspectedReason === "not reachable today", "reconstructed with reason");
    });

    await ok("G5L-74: no finalization readiness requirement", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const findingId = await answerNcCell(w, visitId, "CHK-006", "defect");
        await insertActionRaw(w.db, findingId);
        // pending cells remain (e.g. CHK-007), a Finding is OPEN, an Action is
        // OPEN — all of it must reconstruct without any finalization demand.
        const state = await w.cvs.currentVisitState(visitId);
        assert(state.summary.pendingCount > 0, "pending cells coexist");
        assert(state.summary.activeFindingCount === 1 && state.summary.correctiveActionCount === 1, "active finding/action coexist");
        assert(cellOfState(state, null, "CHK-007").classification === "PENDING", "pending cell reconstructed");
        assert(state.visit.status === "PREPARATION", "Visit stays PREPARATION");
    });

    await ok("G5L-75: no node:* import in the production core", async () => {
        const files: string[] = [];
        const walk = (dir: string): void => {
            for (const e of readdirSync(dir, { withFileTypes: true })) {
                const p = join(dir, e.name);
                if (e.isDirectory()) walk(p);
                else if (e.name.endsWith(".ts")) files.push(p);
            }
        };
        walk(join(ROOT, "src"));
        assert(files.length > 0, "production sources found");
        for (const f of files) {
            const text = readFileSync(f, "utf8");
            assert(!/(?:from\s+["']node:|import\s*\(\s*["']node:)/.test(text), `${f} imports node:*`);
        }
    });
}

// ---------------------------------------------------------------------------
// S15 — extra integrity/corruption cases (G5L-76+)
// ---------------------------------------------------------------------------
async function tS15_extras(): Promise<void> {
    await ok("G5L-76: blank deliberate NOT_INSPECTED reason => E_UNINSPECTED_NEEDS_REASON", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const cell = await cellOf(w.db, visitId, null, "CHK-006");
        const responseId = await responseIdOf(w.db, cell);
        const res = await w.db.run("UPDATE checklist_response SET not_inspected_reason = '' WHERE response_id = ?", [responseId]);
        assert(res.changes === 1, "fixture blank reason applied");
        const err = await rejectsCode(APP_ERR.UNINSPECTED_NEEDS_REASON, () => w.cvs.currentVisitState(visitId));
        const blank = blockersOf(err).filter((b) => b.kind === "blank-not-inspected-reason");
        assert(blank.length === 1 && blank[0].responseId === responseId && blank[0].itemCode === "CHK-006", "blank-reason cell identified");
    });

    await ok("G5L-77: missing referenced subject row => E_SCOPE_GAP (fabricated read)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await addSubject(w, visitId, "WORKSHOP", "W1");
        const fabricating = new FabricateReadOnceAdapter(
            w.db,
            (sql) => sql.includes("FROM inspected_subject"),
            () => [],
        );
        const svc = new CurrentVisitStateService(fabricating);
        const err = await rejectsCode(APP_ERR.SCOPE_GAP, () => svc.currentVisitState(visitId));
        const missing = blockersOf(err).filter((b) => b.kind === "missing-referenced-subject");
        assert(missing.length === 1 && missing[0].subjectId !== null, "missing subject identified");
    });

    await ok("G5L-78: missing referenced definition row => E_SCOPE_GAP (fabricated read)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const fabricating = new FabricateReadOnceAdapter(
            w.db,
            (sql) => sql.includes("av.allowed_value_id AS av_id"),
            (rows) => rows.map((r, i) => (i === 0 ? { ...r, def_id: null, item_code: null, response_model: null, priority: null, applicability_rule: null } : r)),
        );
        const svc = new CurrentVisitStateService(fabricating);
        const err = await rejectsCode(APP_ERR.SCOPE_GAP, () => svc.currentVisitState(visitId));
        const missing = blockersOf(err).filter((b) => b.kind === "missing-referenced-definition");
        assert(missing.length === 1 && missing[0].responseId !== null, "missing definition identified with its responseId");
    });

    await ok("G5L-79: empty captured universe => E_SCOPE_GAP", async () => {
        const w = await freshWorld();
        const visitId = await insertVisitRaw(w.db, w.missionId, w.institutionId);
        const err = await rejectsCode(APP_ERR.SCOPE_GAP, () => w.cvs.currentVisitState(visitId));
        const blockers = blockersOf(err);
        assert(blockers.length === 1 && blockers[0].kind === "empty-captured-universe", "unrecoverable scope identified");
    });

    await ok("G5L-80: missing referenced answered-value row => E_SCOPE_GAP (fabricated read)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await answerCompliantCell(w, visitId, null, "CHK-006", "REGULAR");
        const fabricating = new FabricateReadOnceAdapter(
            w.db,
            (sql) => sql.includes("av.allowed_value_id AS av_id"),
            (rows) =>
                rows.map((r) =>
                    r.answered_value_id !== null
                        ? { ...r, av_id: null, av_code: null, av_label: null, av_class: null, av_sort: null, av_active: null }
                        : r,
                ),
        );
        const svc = new CurrentVisitStateService(fabricating);
        const err = await rejectsCode(APP_ERR.SCOPE_GAP, () => svc.currentVisitState(visitId));
        const missing = blockersOf(err).filter((b) => b.kind === "missing-answered-value");
        assert(missing.length === 1 && missing[0].itemCode === "CHK-006", "missing value identified");
    });

    await ok("G5L-81: missing referenced finding row => E_SCOPE_GAP (fabricated read)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        await answerNcCell(w, visitId, "CHK-006", "defect");
        const fabricating = new FabricateReadOnceAdapter(
            w.db,
            (sql) => sql.includes("FROM finding") && sql.includes("WHERE finding_id IN"),
            () => [],
        );
        const svc = new CurrentVisitStateService(fabricating);
        const err = await rejectsCode(APP_ERR.SCOPE_GAP, () => svc.currentVisitState(visitId));
        const missing = blockersOf(err).filter((b) => b.kind === "missing-referenced-finding");
        assert(missing.length === 1 && missing[0].findingId !== null, "missing finding identified");
    });

    await ok("G5L-82: fabricated finalized_at + PREPARATION => E_STATE_CONFLICT", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const fabricating = new FabricateReadOnceAdapter(
            w.db,
            (sql) => sql.includes("LEFT JOIN mission m"),
            (rows) => rows.map((r) => ({ ...r, status: "PREPARATION", finalized_at: "2026-09-09T07:00:00Z" })),
        );
        const svc = new CurrentVisitStateService(fabricating);
        await rejectsCode(APP_ERR.STATE_CONFLICT, () => svc.currentVisitState(visitId));
    });

    await ok("G5L-83: fabricated COMPLETED + finalized_at NULL => E_STATE_CONFLICT", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const fabricating = new FabricateReadOnceAdapter(
            w.db,
            (sql) => sql.includes("LEFT JOIN mission m"),
            (rows) => rows.map((r) => ({ ...r, status: "COMPLETED", finalized_at: null })),
        );
        const svc = new CurrentVisitStateService(fabricating);
        await rejectsCode(APP_ERR.STATE_CONFLICT, () => svc.currentVisitState(visitId));
    });

    await ok("G5L-84: fabricated unknown visit status => E_STATE_CONFLICT", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const fabricating = new FabricateReadOnceAdapter(
            w.db,
            (sql) => sql.includes("LEFT JOIN mission m"),
            (rows) => rows.map((r) => ({ ...r, status: "BOGUS" })),
        );
        const svc = new CurrentVisitStateService(fabricating);
        await rejectsCode(APP_ERR.STATE_CONFLICT, () => svc.currentVisitState(visitId));
    });

    await ok("G5L-85: fabricated missing mission parent row => E_CONFIG", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const fabricating = new FabricateReadOnceAdapter(
            w.db,
            (sql) => sql.includes("LEFT JOIN mission m"),
            (rows) => rows.map((r) => ({ ...r, mission_name: null, mission_status: null })),
        );
        const svc = new CurrentVisitStateService(fabricating);
        await rejectsCode(APP_ERR.CONFIG, () => svc.currentVisitState(visitId));
    });

    await ok("G5L-89: duplicate logical cell (fabricated read) => E_SCOPE_GAP duplicate-cell, no auto-repair", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const before = await fullSnapshot(w.db);
        // uq_response_ctx makes duplicate logical cells unrepresentable at
        // rest — fabricate a second actual row for ONE logical cell so the
        // defensive reconstruction check is exercised.
        let originalId: number | null = null;
        const fabricating = new FabricateReadOnceAdapter(
            w.db,
            (sql) => sql.includes("av.allowed_value_id AS av_id"),
            (rows) => {
                originalId = Number(rows[0].response_id);
                return [...rows, { ...rows[0], response_id: 999999 }];
            },
        );
        const svc = new CurrentVisitStateService(fabricating);
        const err = await rejectsCode(APP_ERR.SCOPE_GAP, () => svc.currentVisitState(visitId));
        const dup = blockersOf(err).filter((b) => b.kind === "duplicate-cell");
        assert(dup.length === 2, `one blocker per duplicated row, got ${dup.length}`);
        const ids = dup.map((b) => b.responseId).sort((a, b) => (a ?? 0) - (b ?? 0));
        assert(originalId !== null && ids[0] === originalId && ids[1] === 999999, "both durable response ids surfaced");
        assert(
            dup.every((b) => b.itemDefinitionId !== null && b.itemCode !== null),
            "duplicate-cell blockers carry the pinned definition identifiers",
        );
        assert(
            blockersOf(err).every((b) => b.kind === "duplicate-cell"),
            "no missing/extra noise: the duplicated cell is otherwise a normal universe cell",
        );
        const after = await fullSnapshot(w.db);
        assertDeepEqual(before, after, "no durable row changed (no auto-repair)");
        // the healthy read still succeeds after the fabricated one
        const state = await w.cvs.currentVisitState(visitId);
        assert(state.summary.actualCellCount === 20, "healthy reconstruction unaffected");
    });

    await ok("G5L-90: contextual NOT_APPLICABLE + durable ANSWERED => E_SCOPE_GAP applicability-state-mismatch", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        // CHK-013 @ institution is a durable AUTO-NA (rule excludes
        // INSTITUTION); corrupt it at rest into an answered cell — the raw
        // UPDATE is trigger-legal, so only the reconstruction self-check
        // catches the contradiction.
        const c13 = await cellOf(w.db, visitId, null, "CHK-013");
        const rid = await responseIdOf(w.db, c13);
        const readyId = await valueIdOfDef(w.db, c13.itemDefinitionId, "READY");
        const upd = await w.db.run(
            `UPDATE checklist_response
                SET overlay_state = NULL, answered_value_id = ?, note = NULL,
                    not_inspected_reason = NULL, finding_id = NULL
              WHERE response_id = ?`,
            [readyId, rid] as readonly SqlValue[],
        );
        assert(upd.changes === 1, "corrupt fixture applied");
        const before = await fullSnapshot(w.db);
        const err = await rejectsCode(APP_ERR.SCOPE_GAP, () => w.cvs.currentVisitState(visitId));
        const mismatch = blockersOf(err).filter((b) => b.kind === "applicability-state-mismatch");
        assert(mismatch.length === 1, `exactly one mismatch blocker, got ${mismatch.length}`);
        assert(mismatch[0].responseId === rid && mismatch[0].itemCode === "CHK-013", "durable identifiers surfaced");
        assert(mismatch[0].itemDefinitionId === c13.itemDefinitionId && mismatch[0].subjectId === null, "pinned definition + context");
        assert(blockersOf(err).length === 1, "no noise blockers");
        const after = await fullSnapshot(w.db);
        assertDeepEqual(before, after, "no durable row changed (no auto-repair)");
        const err2 = await rejectsCode(APP_ERR.SCOPE_GAP, () => w.cvs.currentVisitState(visitId));
        assertDeepEqual(blockersOf(err), blockersOf(err2), "deterministic repeated blockers, still unrepaired");
    });

    await ok("G5L-91: contextual NOT_APPLICABLE + reasoned NOT_INSPECTED => E_SCOPE_GAP applicability-state-mismatch", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const c13 = await cellOf(w.db, visitId, null, "CHK-013");
        const rid = await responseIdOf(w.db, c13);
        const upd = await w.db.run(
            `UPDATE checklist_response
                SET overlay_state = 'NOT_INSPECTED', answered_value_id = NULL, note = NULL,
                    not_inspected_reason = 'reopened by hand', finding_id = NULL
              WHERE response_id = ?`,
            [rid] as readonly SqlValue[],
        );
        assert(upd.changes === 1, "corrupt fixture applied");
        const err = await rejectsCode(APP_ERR.SCOPE_GAP, () => w.cvs.currentVisitState(visitId));
        const mismatch = blockersOf(err).filter((b) => b.kind === "applicability-state-mismatch");
        assert(mismatch.length === 1 && mismatch[0].responseId === rid && mismatch[0].itemCode === "CHK-013", "mismatch identified");
    });

    await ok("G5L-92: contextual APPLICABLE + durable NA => E_SCOPE_GAP applicability-state-mismatch", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        // CHK-006 @ institution is contextually APPLICABLE (pending);
        // corrupt it at rest into NA.
        const c6 = await cellOf(w.db, visitId, null, "CHK-006");
        const rid = await responseIdOf(w.db, c6);
        const upd = await w.db.run(
            `UPDATE checklist_response
                SET overlay_state = 'NA', answered_value_id = NULL, note = NULL,
                    not_inspected_reason = NULL, finding_id = NULL
              WHERE response_id = ?`,
            [rid] as readonly SqlValue[],
        );
        assert(upd.changes === 1, "corrupt fixture applied");
        const err = await rejectsCode(APP_ERR.SCOPE_GAP, () => w.cvs.currentVisitState(visitId));
        const mismatch = blockersOf(err).filter((b) => b.kind === "applicability-state-mismatch");
        assert(mismatch.length === 1 && mismatch[0].responseId === rid && mismatch[0].itemCode === "CHK-006", "mismatch identified");
        const before = await fullSnapshot(w.db);
        const after = await fullSnapshot(w.db);
        assertDeepEqual(before, after, "no durable row changed");
    });

    await ok("G5L-93: valid applicability/disposition combinations remain valid (automatic NA, HUMAN NA, pending, answered)", async () => {
        const w = await freshWorld();
        const visitId = await standardCreate(w);
        const subjectId = await addSubject(w, visitId, "WORKSHOP", "W1");
        // explicit human NOT_APPLICABLE in the applicable context
        const c20 = await cellOf(w.db, visitId, null, "CHK-020");
        await w.disp.resolveHumanApplicability({ cell: c20 });
        // an ordinary APPLICABLE answer
        await answerCompliantCell(w, visitId, null, "CHK-006", "REGULAR");
        const state = await w.cvs.currentVisitState(visitId);
        // automatic NOT_APPLICABLE + NA (AUTO definition, wrong context)
        const c13 = cellOfState(state, null, "CHK-013");
        assert(c13.classification === "NA" && c13.contextualOutcome === "NOT_APPLICABLE", "automatic NA valid");
        // automatic NOT_APPLICABLE + NA (HUMAN_CONFIRMATION definition, excluded context)
        const c20ws = cellOfState(state, subjectId, "CHK-020");
        assert(c20ws.classification === "NA" && c20ws.contextualOutcome === "NOT_APPLICABLE", "contextual automatic NA valid");
        // contextual HUMAN_CONFIRMATION + NA (explicit human decision)
        const c20inst = cellOfState(state, null, "CHK-020");
        assert(c20inst.classification === "HUMAN_NOT_APPLICABLE" && c20inst.contextualOutcome === "HUMAN_CONFIRMATION", "HUMAN NA valid");
        // contextual APPLICABLE + answered / pending
        assert(cellOfState(state, null, "CHK-006").classification === "ANSWERED", "APPLICABLE answered valid");
        assert(cellOfState(state, null, "CHK-007").classification === "PENDING", "APPLICABLE pending valid");
        assert(state.summary.actualCellCount === 40, "full two-context grid reconstructed without blockers");
    });
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------
const SUITES: Array<[string, () => Promise<void>]> = [
    ["S1 Visit/basic", tS1_basic],
    ["S2 captured universe", tS2_universe],
    ["S3 contexts", tS3_contexts],
    ["S4 grid self-check", tS4_grid],
    ["S5 cells/classifications", tS5_cells],
    ["S6 SCHEDULE", tS6_schedule],
    ["S7 observations", tS7_observations],
    ["S8 findings", tS8_findings],
    ["S9 corrective actions", tS9_actions],
    ["S10 follow-ups", tS10_followups],
    ["S11 restart/no-memory", tS11_restart],
    ["S12 snapshot/transaction", tS12_snapshot],
    ["S13 summary", tS13_summary],
    ["S14 cross-cutting", tS14_crosscutting],
    ["S15 extra integrity cases", tS15_extras],
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
