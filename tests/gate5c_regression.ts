// Gate 5C — automated regression for the first executable Application-Core
// slice: evaluateApplicability (pure) + createVisit (T0) + addSubjectToScope
// (T1) + captured-universe / version freezing.
//
// Run (repository root; Node.js >= 22 is the adopted development/test host,
// Gate-5A D1 — node:sqlite + native TypeScript type stripping):
//   Node 22.x:   node --experimental-strip-types tests/gate5c_regression.ts
//   Node 24.x:   node tests/gate5c_regression.ts
// Exit: 0 on success, 1 when any assertion fails.
//
// Coverage (requirement F, Gate 5C):
//   A1  AUTO payload is APPLICABLE
//   A2  subject-kind mismatch => NOT_APPLICABLE
//   A3  visit-type mismatch => NOT_APPLICABLE
//   A4  HUMAN_CONFIRMATION carries missing_context
//   A5  malformed / unknown payloads raise E_CONFIG (never a silent decision)
//   T0-6   mission PREPARATION accepted
//   T0-7   mission ACTIVE accepted
//   T0-8   mission COMPLETED / ARCHIVED rejected with E_MISSION_CLOSED
//   T0-9   an expected P0 code without an ACTIVE definition blocks creation
//   T0-10  an unexpected ACTIVE-P0 code blocks creation (E_BOOTSTRAP_DRIFT)
//   T0-11  P1 never enters the captured universe
//   T0-12  institution cells == manifest P0 universe (one ACTIVE def each)
//   T0-13  correct NA / true-pending (incl. HUMAN) materialization
//   T0-14  injected failure rolls back the whole unit (zero Visit/cells)
//   T1-15  existing subject + zero grid => complete atomic composition
//   T1-16  existing subject + full grid => idempotent no-INSERT success
//   T1-17  existing subject + partial grid => E_SCOPE_GAP (never repaired)
//   T1-18  cross-institution subject rejected (E_CONTEXT)
//   T1-19  new subject + full grid atomic together
//   T1-20  injected failure leaves no new subject/cells
//   VF-21  a later ACTIVE/version release never alters a captured universe;
//          only a NEW Visit composes with the new version
//   VF-22  addSubjectToScope reuses the exact pinned item_definition_id values
//   NN-23  production core files import no node:* module
//
// The domain service under test never hard-codes CHK codes: the manifest's
// expected_p0_item_codes (artifact authority) is the code-set input, exactly
// as T0 requires. The pure evaluator is checked first; DB assertions then use
// it only as a data-driven oracle after the pure contract is proven.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { SqlAdapter, SqlRow, SqlValue } from "../src/bootstrap/adapter.ts";
import { openFreshDb } from "../dev/node-sqlite-adapter.ts";
import { BootstrapLoader } from "../src/bootstrap/loader.ts";
import { parseArtifact } from "../src/bootstrap/artifact.ts";
import { APP_ERR } from "../src/application/errors.ts";
import {
    evaluateApplicability,
    overlayStateForOutcome,
    type ApplicabilityOutcome,
    type ContextKind,
    type VisitType,
} from "../src/application/applicability.ts";
import { VisitScopeService } from "../src/application/visit-scope.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_SQL = readFileSync(join(ROOT, "docs", "schema", "schema.sql"), "utf8");
const ARTIFACT_PATH = join(ROOT, "bootstrap", "v1", "checklist-v1.json");
const COMMITTED = parseArtifact(readFileSync(ARTIFACT_PATH, "utf8"));
const EXPECTED_P0 = COMMITTED.manifest.expected_p0_item_codes;
const EXPECTED_P1 = COMMITTED.manifest.expected_p1_item_codes;

const NOW = "2026-09-01T08:00:00.000Z";
const VISIT_DATE = "2026-09-10";

// ---------------------------------------------------------------------------
// tiny assertion harness (same conventions as tests/gate5b_regression.ts)
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

/** Expect the promise to reject with a `.code` equal to `code`. */
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

/** Expect rejection with any error (adapter fault injection). */
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
    service: VisitScopeService;
    missionId: number;
    institutionId: number;
}

async function freshWorld(missionStatus = "PREPARATION"): Promise<World> {
    const db = openFreshDb(SCHEMA_SQL);
    await new BootstrapLoader(db, COMMITTED).load();
    const missionId = Number(
        (
            await db.run("INSERT INTO mission(name, status, created_at, created_by) VALUES ('M', ?, ?, 'owner')", [
                missionStatus,
                NOW,
            ])
        ).lastInsertRowid,
    );
    const institutionId = Number(
        (
            await db.run("INSERT INTO institution(name, created_at, created_by) VALUES ('Inst', ?, 'owner')", [NOW])
        ).lastInsertRowid,
    );
    return { db, service: new VisitScopeService(db), missionId, institutionId };
}

async function insertSubject(db: SqlAdapter, institutionId: number, subjectType: ContextKind, name: string): Promise<number> {
    return Number(
        (
            await db.run(
                `INSERT INTO inspected_subject(institution_id, subject_type, name, created_at, created_by)
                 VALUES (?, ?, ?, ?, 'owner')`,
                [institutionId, subjectType, name, NOW],
            )
        ).lastInsertRowid,
    );
}

interface Cell {
    code: string;
    itemDefinitionId: number;
    overlay: string | null;
    answeredValueId: number | null;
    reason: string | null;
    findingId: number | null;
}

/** Read the cells of one context of a Visit (deterministic item-code order). */
async function cellsOf(db: SqlAdapter, visitId: number, subjectId: number | null): Promise<Cell[]> {
    const rows = await db.query(
        `SELECT d.item_code, cr.item_definition_id, cr.overlay_state, cr.answered_value_id,
                cr.not_inspected_reason, cr.finding_id
           FROM checklist_response cr
           JOIN checklist_item_definition d ON d.item_definition_id = cr.item_definition_id
          WHERE cr.visit_id = ? ${subjectId === null ? "AND cr.subject_id IS NULL" : "AND cr.subject_id = ?"}
          ORDER BY d.item_code`,
        subjectId === null ? [visitId] : [visitId, subjectId],
    );
    return rows.map((r: SqlRow) => ({
        code: String(r.item_code),
        itemDefinitionId: Number(r.item_definition_id),
        overlay: r.overlay_state === null ? null : String(r.overlay_state),
        answeredValueId: r.answered_value_id === null ? null : Number(r.answered_value_id),
        reason: r.not_inspected_reason === null ? null : String(r.not_inspected_reason),
        findingId: r.finding_id === null ? null : Number(r.finding_id),
    }));
}

/** Pure-model oracle: expected overlay per P0 code from the LIVE ACTIVE rules. */
async function modelOverlayByCode(db: SqlAdapter, kind: ContextKind, visitType: VisitType): Promise<Map<string, string>> {
    const defs = await db.query(
        `SELECT item_code, applicability_rule
           FROM checklist_item_definition
          WHERE status = 'ACTIVE' AND priority = 'P0'
          ORDER BY item_code`,
    );
    const map = new Map<string, string>();
    for (const r of defs) {
        const outcome = evaluateApplicability(String(r.applicability_rule), kind, visitType);
        map.set(String(r.item_code), overlayStateForOutcome(outcome));
    }
    return map;
}

function assertCellGridMatchesModel(cells: readonly Cell[], expectedByCode: Map<string, string>, subjectCountLabel: string): void {
    assert(cells.length === EXPECTED_P0.length, `${subjectCountLabel}: expected ${EXPECTED_P0.length} cells, got ${cells.length}`);
    assert(
        cells.every((c) => EXPECTED_P0.includes(c.code)),
        `${subjectCountLabel}: cell code(s) outside the manifest P0 universe: ${cells.map((c) => c.code).join(",")}`,
    );
    for (const c of cells) {
        const want = expectedByCode.get(c.code);
        assert(want !== undefined, `${subjectCountLabel}: model has no outcome for ${c.code}`);
        assert(c.overlay === want, `${subjectCountLabel}: ${c.code} overlay ${c.overlay}, model says ${want}`);
        if (c.overlay === "NOT_INSPECTED") {
            assert(c.answeredValueId === null, `${subjectCountLabel}: pending ${c.code} must be unanswered`);
            assert(c.reason === null, `${subjectCountLabel}: pending ${c.code} must carry no NOT_INSPECTED reason yet`);
            assert(c.findingId === null, `${subjectCountLabel}: pending ${c.code} must not be linked to a finding`);
        } else {
            assert(c.overlay === "NA", `${subjectCountLabel}: ${c.code} unexpected overlay ${c.overlay}`);
            assert(c.answeredValueId === null, `${subjectCountLabel}: NA ${c.code} must be unanswered`);
            assert(c.findingId === null, `${subjectCountLabel}: NA ${c.code} must not be linked to a finding`);
        }
    }
    const codes = new Set(cells.map((c) => c.code));
    assert(codes.size === EXPECTED_P0.length, `${subjectCountLabel}: duplicate code in the grid`);
}

function visitRowCounts(db: SqlAdapter, visitId: number): Promise<{ visits: number; cells: number; subjectCells: number }> {
    return Promise.all([
        count(db, "SELECT count(*) AS c FROM visit WHERE visit_id = ?", [visitId]),
        count(db, "SELECT count(*) AS c FROM checklist_response WHERE visit_id = ?", [visitId]),
        count(db, "SELECT count(*) AS c FROM checklist_response WHERE visit_id = ? AND subject_id IS NOT NULL", [visitId]),
    ]).then(([visits, cells, subjectCells]) => ({ visits, cells, subjectCells }));
}

/** Release a SUPERSEDED + new ACTIVE v2 definition for an item code. */
async function releaseNextVersion(db: SqlAdapter, itemCode: string): Promise<{ oldId: number; newId: number }> {
    const oldRow = await db.query(
        "SELECT item_definition_id FROM checklist_item_definition WHERE item_code = ? AND status = 'ACTIVE'",
        [itemCode],
    );
    assert(oldRow.length === 1, `expected one ACTIVE ${itemCode}`);
    const oldId = Number(oldRow[0].item_definition_id);
    const src = await db.query("SELECT * FROM checklist_item_definition WHERE item_definition_id = ?", [oldId]);
    assert(src.length === 1, "source def row missing");
    const s = src[0];
    await db.beginImmediate();
    await db.run("UPDATE checklist_item_definition SET status = 'SUPERSEDED' WHERE item_definition_id = ?", [oldId]);
    const newIdRes = await db.run(
        `INSERT INTO checklist_item_definition
           (item_code, version_no, supersedes_definition_id, domain_id, arabic_question, response_model,
            priority, traceability, requirement_refs, note_rule, evidence_rule, finding_rule,
            applicability_rule, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE')`,
        [
            itemCode,
            2,
            oldId,
            String(s.domain_id),
            `${String(s.arabic_question)} (v2)`,
            String(s.response_model),
            String(s.priority),
            String(s.traceability),
            String(s.requirement_refs),
            s.note_rule === null ? null : String(s.note_rule),
            s.evidence_rule === null ? null : String(s.evidence_rule),
            s.finding_rule === null ? null : String(s.finding_rule),
            String(s.applicability_rule),
        ] as readonly SqlValue[],
    );
    await db.commit();
    return { oldId, newId: Number(newIdRes.lastInsertRowid) };
}

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

/** Rules text of the canonical payloads used by the pure evaluator tests. */
function ruleTextOf(itemCode: string): string {
    const def = COMMITTED.definitions.find((d) => d.item_code === itemCode);
    assert(def !== undefined, `no artifact definition for ${itemCode}`);
    return JSON.stringify(def.applicability_rule);
}

// ---------------------------------------------------------------------------
// A — pure applicability evaluator
// ---------------------------------------------------------------------------
async function tA_applicability(): Promise<void> {
    await ok("A1: AUTO payload applicable (data-driven, no item_code switch)", async () => {
        const inst = evaluateApplicability(ruleTextOf("CHK-006"), "INSTITUTION", "SURPRISE");
        assert(inst.outcome === "APPLICABLE", `CHK-006@INSTITUTION/SURPRISE => ${inst.outcome}`);
        const ws = evaluateApplicability(ruleTextOf("CHK-001"), "WORKSHOP", "PLANNED");
        assert(ws.outcome === "APPLICABLE", `CHK-001@WORKSHOP/PLANNED => ${ws.outcome}`);
        // CHK-001 explicitly allows both visit types (SURPRISE or PLANNED)
        const surprise = evaluateApplicability(ruleTextOf("CHK-001"), "WORKSHOP", "SURPRISE");
        assert(surprise.outcome === "APPLICABLE", `CHK-001@WORKSHOP/SURPRISE => ${surprise.outcome}`);
    });

    await ok("A2: subject-kind mismatch => NOT_APPLICABLE", () => {
        assert(evaluateApplicability(ruleTextOf("CHK-001"), "LAB", "SURPRISE").outcome === "NOT_APPLICABLE", "CHK-001@LAB");
        assert(evaluateApplicability(ruleTextOf("CHK-012"), "WORKSHOP", "PLANNED").outcome === "NOT_APPLICABLE", "CHK-012@WORKSHOP");
        assert(evaluateApplicability(ruleTextOf("CHK-014"), "CANTEEN", "PLANNED").outcome === "NOT_APPLICABLE", "CHK-014@CANTEEN");
        // OTHER is never auto-assigned an item (closed-set member but never a target)
        assert(evaluateApplicability(ruleTextOf("CHK-003"), "OTHER", "PLANNED").outcome === "NOT_APPLICABLE", "CHK-003@OTHER");
    });

    await ok("A3: visit-type mismatch => NOT_APPLICABLE", () => {
        const payload = JSON.parse(ruleTextOf("CHK-001")) as Record<string, unknown>;
        payload.visit_type = { allowed: ["SURPRISE"] };
        const text = JSON.stringify(payload);
        assert(
            evaluateApplicability(text, "WORKSHOP", "PLANNED").outcome === "NOT_APPLICABLE",
            "SURPRISE-only payload must be NOT_APPLICABLE for a PLANNED visit",
        );
        assert(
            evaluateApplicability(text, "WORKSHOP", "SURPRISE").outcome === "APPLICABLE",
            "SURPRISE-only payload must stay APPLICABLE for a SURPRISE visit",
        );
        // absent visit_type => no restriction
        const noVt = JSON.parse(ruleTextOf("CHK-002")) as Record<string, unknown>;
        delete noVt.visit_type;
        assert(evaluateApplicability(JSON.stringify(noVt), "WORKSHOP", "PLANNED").outcome === "APPLICABLE", "no visit_type key");
    });

    await ok("A4: HUMAN_CONFIRMATION outcome carries exactly missing_context", () => {
        const doc = COMMITTED.definitions.find((d) => d.item_code === "CHK-020")!;
        const outcome = evaluateApplicability(JSON.stringify(doc.applicability_rule), "INSTITUTION", "SURPRISE");
        assert(outcome.outcome === "HUMAN_CONFIRMATION", `CHK-020@INSTITUTION => ${outcome.outcome}`);
        const human = outcome as Extract<ApplicabilityOutcome, { outcome: "HUMAN_CONFIRMATION" }>;
        const docMissing = (doc.applicability_rule as { missing_context: string[] }).missing_context;
        assert(human.missingContext.length === docMissing.length, "missing_context length");
        assert(
            human.missingContext.every((m, i) => m === docMissing[i]),
            "missing_context content must mirror the payload",
        );
    });

    // builder for a structurally valid AUTO payload with extra keys appended
    const autoPayload = (extra: Record<string, unknown>): string =>
        JSON.stringify({
            rule_schema_version: 1,
            item_code: "CHK-X",
            decision_kind: "AUTO",
            subject_kinds: ["WORKSHOP"],
            source_ar: "s",
            ...extra,
        });

    const malformedVariants: Array<[string, string]> = [
        ["not JSON at all", "this is not json"],
        ["JSON null root", "null"],
        ["JSON array root", "[1,2]"],
        ["empty object root", "{}"],
        ["rule_schema_version true", JSON.stringify({ rule_schema_version: true })],
        ["rule_schema_version 2", JSON.stringify({ rule_schema_version: 2 })],
        ["missing item_code", JSON.stringify({ rule_schema_version: 1, decision_kind: "AUTO", subject_kinds: ["WORKSHOP"], source_ar: "s" })],
        ["blank item_code", JSON.stringify({ rule_schema_version: 1, item_code: "  ", decision_kind: "AUTO", subject_kinds: ["WORKSHOP"], source_ar: "s" })],
        ["unknown decision_kind", JSON.stringify({ rule_schema_version: 1, item_code: "CHK-X", decision_kind: "MAYBE", subject_kinds: ["WORKSHOP"], source_ar: "s" })],
        ["missing subject_kinds", JSON.stringify({ rule_schema_version: 1, item_code: "CHK-X", decision_kind: "AUTO", source_ar: "s" })],
        ["empty subject_kinds", JSON.stringify({ rule_schema_version: 1, item_code: "CHK-X", decision_kind: "AUTO", subject_kinds: [], source_ar: "s" })],
        ["unknown subject_kinds member", JSON.stringify({ rule_schema_version: 1, item_code: "CHK-X", decision_kind: "AUTO", subject_kinds: ["SHOP"], source_ar: "s" })],
        ["missing source_ar", JSON.stringify({ rule_schema_version: 1, item_code: "CHK-X", decision_kind: "AUTO", subject_kinds: ["WORKSHOP"] })],
        ["blank source_ar", JSON.stringify({ rule_schema_version: 1, item_code: "CHK-X", decision_kind: "AUTO", subject_kinds: ["WORKSHOP"], source_ar: "  " })],
        ["HUMAN without missing_context", JSON.stringify({ rule_schema_version: 1, item_code: "CHK-X", decision_kind: "HUMAN_CONFIRMATION", subject_kinds: ["INSTITUTION"], source_ar: "s" })],
        ["HUMAN with empty missing_context", JSON.stringify({ rule_schema_version: 1, item_code: "CHK-X", decision_kind: "HUMAN_CONFIRMATION", subject_kinds: ["INSTITUTION"], source_ar: "s", missing_context: [] })],
        ["HUMAN with blank missing_context member", JSON.stringify({ rule_schema_version: 1, item_code: "CHK-X", decision_kind: "HUMAN_CONFIRMATION", subject_kinds: ["INSTITUTION"], source_ar: "s", missing_context: ["  "] })],
        ["visit_type is an array", JSON.stringify({ rule_schema_version: 1, item_code: "CHK-X", decision_kind: "AUTO", subject_kinds: ["WORKSHOP"], source_ar: "s", visit_type: [] })],
        ["visit_type.allowed missing", JSON.stringify({ rule_schema_version: 1, item_code: "CHK-X", decision_kind: "AUTO", subject_kinds: ["WORKSHOP"], source_ar: "s", visit_type: {} })],
        ["visit_type.allowed empty", JSON.stringify({ rule_schema_version: 1, item_code: "CHK-X", decision_kind: "AUTO", subject_kinds: ["WORKSHOP"], source_ar: "s", visit_type: { allowed: [] } })],
        ["visit_type.allowed unknown member", JSON.stringify({ rule_schema_version: 1, item_code: "CHK-X", decision_kind: "AUTO", subject_kinds: ["WORKSHOP"], source_ar: "s", visit_type: { allowed: ["YEARLY"] } })],
        // review correction A — optional §4.1 metadata fields must be text when present
        ["note_ar numeric", autoPayload({ note_ar: 123 })],
        ["note_ar object", autoPayload({ note_ar: {} })],
        ["note_ar array", autoPayload({ note_ar: ["x"] })],
        ["not_applicable_when_ar numeric", autoPayload({ not_applicable_when_ar: 123 })],
        ["not_applicable_when_ar object", autoPayload({ not_applicable_when_ar: {} })],
        ["not_applicable_when_ar array", autoPayload({ not_applicable_when_ar: ["x"] })],
        // review correction A — missing_context present on a non-HUMAN kind must
        // still be structurally an array of text (never silently malformed)
        ["AUTO with non-array missing_context", autoPayload({ missing_context: "nope" })],
        ["AUTO with object missing_context", autoPayload({ missing_context: { a: 1 } })],
        ["AUTO with non-text missing_context member", autoPayload({ missing_context: [1, "two"] })],
    ];
    for (const [label, text] of malformedVariants) {
        await ok(`A5: malformed rule => E_CONFIG (${label})`, async () => {
            const e = await rejectsCode(APP_ERR.CONFIG, () => Promise.resolve(evaluateApplicability(text, "WORKSHOP", "PLANNED") as unknown));
            assert((e as Error).message.includes("applicability_rule"), `message should name the payload: ${(e as Error).message}`);
        });
    }

    await ok("A6: optional §4.1 metadata fields are optional — absent and text forms stay valid (metadata never decides)", () => {
        // absent optional metadata is allowed
        const minimal = JSON.stringify({
            rule_schema_version: 1,
            item_code: "CHK-X",
            decision_kind: "AUTO",
            subject_kinds: ["WORKSHOP"],
            source_ar: "s",
        });
        assert(evaluateApplicability(minimal, "WORKSHOP", "PLANNED").outcome === "APPLICABLE", "absent optional metadata must be allowed");
        // text-valued metadata is accepted and must not alter the decision
        const withMeta = JSON.parse(minimal) as Record<string, unknown>;
        withMeta.note_ar = "نص إيضاحي";
        withMeta.not_applicable_when_ar = "غير معني";
        assert(
            evaluateApplicability(JSON.stringify(withMeta), "WORKSHOP", "PLANNED").outcome === "APPLICABLE",
            "text metadata must not change the decision",
        );
    });

    await ok("B1: unknown context kind => E_CONTEXT, never NOT_APPLICABLE", async () => {
        const e = await rejectsCode(APP_ERR.CONTEXT, () =>
            Promise.resolve(evaluateApplicability(ruleTextOf("CHK-001"), "BOGUS" as ContextKind, "SURPRISE") as unknown),
        );
        assert((e as Error).message.includes("BOGUS"), `message should name the unknown kind: ${(e as Error).message}`);
        // a HUMAN payload must equally refuse an unknown kind (no silent NA path)
        await rejectsCode(APP_ERR.CONTEXT, () =>
            Promise.resolve(evaluateApplicability(ruleTextOf("CHK-020"), "BOGUS" as ContextKind, "PLANNED") as unknown),
        );
        // a KNOWN kind that simply is not targeted still yields NOT_APPLICABLE
        assert(evaluateApplicability(ruleTextOf("CHK-012"), "WORKSHOP", "PLANNED").outcome === "NOT_APPLICABLE", "known-but-untargeted kind stays NOT_APPLICABLE");
    });
}

// ---------------------------------------------------------------------------
// T0 — createVisit
// ---------------------------------------------------------------------------
async function standardCreate(world: World, visitType: VisitType = "PLANNED"): Promise<number> {
    const res = await world.service.createVisit({
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

async function tT0_createVisit(): Promise<void> {
    await ok("T0-6: mission PREPARATION accepted (Visit PREPARATION + captured universe)", async () => {
        const world = await freshWorld("PREPARATION");
        const visitId = await standardCreate(world);
        const rows = await world.db.query(
            "SELECT status, finalized_at, mission_id, institution_id, visit_type FROM visit WHERE visit_id = ?",
            [visitId],
        );
        assert(rows.length === 1, "visit row exists");
        assert(String(rows[0].status) === "PREPARATION", `status ${rows[0].status}`);
        assert(rows[0].finalized_at === null, "finalized_at must be NULL");
        assert(Number(rows[0].mission_id) === world.missionId && Number(rows[0].institution_id) === world.institutionId, "links");
        const cells = await cellsOf(world.db, visitId, null);
        assert(cells.length === EXPECTED_P0.length, `institution cells ${cells.length}`);
    });

    await ok("T0-7: mission ACTIVE accepted", async () => {
        const world = await freshWorld("ACTIVE");
        const visitId = await standardCreate(world);
        const cells = await cellsOf(world.db, visitId, null);
        assert(cells.length === EXPECTED_P0.length, `institution cells ${cells.length}`);
    });

    for (const closedStatus of ["COMPLETED", "ARCHIVED"] as const) {
        await ok(`T0-8: mission ${closedStatus} rejected with E_MISSION_CLOSED (no Visit/cells)`, async () => {
            const world = await freshWorld(closedStatus);
            const e = await rejectsCode(APP_ERR.MISSION_CLOSED, () =>
                world.service.createVisit({
                    missionId: world.missionId,
                    institutionId: world.institutionId,
                    visitType: "PLANNED",
                    visitDate: VISIT_DATE,
                    inspector: "inspector-a",
                    expectedP0ItemCodes: EXPECTED_P0,
                    actor: "inspector-a",
                    now: NOW,
                }),
            );
            assert((e as Error).message.includes(closedStatus), `message should name the mission status: ${(e as Error).message}`);
            const all = await count(world.db, "SELECT count(*) AS c FROM visit");
            const responses = await count(world.db, "SELECT count(*) AS c FROM checklist_response");
            assert(all === 0 && responses === 0, `rollback must leave zero rows (visit ${all}, responses ${responses})`);
        });
    }

    await ok("T0-9: expected P0 code missing an ACTIVE definition blocks creation (E_NO_ACTIVE_DEFINITION)", async () => {
        const world = await freshWorld();
        await world.db.run("UPDATE checklist_item_definition SET status = 'ARCHIVED' WHERE item_code = 'CHK-005' AND status = 'ACTIVE'");
        const e = await rejectsCode(APP_ERR.NO_ACTIVE_DEFINITION, () =>
            world.service.createVisit({
                missionId: world.missionId,
                institutionId: world.institutionId,
                visitType: "PLANNED",
                visitDate: VISIT_DATE,
                inspector: "inspector-a",
                expectedP0ItemCodes: EXPECTED_P0,
                actor: "inspector-a",
                now: NOW,
            }),
        );
        assert((e as Error).message.includes("CHK-005"), `message should name the missing code: ${(e as Error).message}`);
        const all = await count(world.db, "SELECT count(*) AS c FROM visit");
        const responses = await count(world.db, "SELECT count(*) AS c FROM checklist_response");
        assert(all === 0 && responses === 0, `rollback must leave zero rows (visit ${all}, responses ${responses})`);
    });

    await ok("T0-10: unexpected ACTIVE-P0 code blocks creation (E_BOOTSTRAP_DRIFT)", async () => {
        const world = await freshWorld();
        const base = JSON.parse(ruleTextOf("CHK-001")) as Record<string, unknown>;
        base.item_code = "CHK-099";
        const payload = JSON.stringify(base);
        await world.db.run(
            `INSERT INTO checklist_item_definition
               (item_code, version_no, domain_id, arabic_question, response_model, priority,
                traceability, requirement_refs, note_rule, evidence_rule, finding_rule, applicability_rule, status)
             VALUES ('CHK-099', 1, 'DOM-02', 'extra?', 'SINGLE_VALUE', 'P0', 'DIRECT', '["REQ-000"]',
                     'x', 'x', 'x', ?, 'ACTIVE')`,
            [payload],
        );
        const e = await rejectsCode(APP_ERR.BOOTSTRAP_DRIFT, () =>
            world.service.createVisit({
                missionId: world.missionId,
                institutionId: world.institutionId,
                visitType: "PLANNED",
                visitDate: VISIT_DATE,
                inspector: "inspector-a",
                expectedP0ItemCodes: EXPECTED_P0,
                actor: "inspector-a",
                now: NOW,
            }),
        );
        assert((e as Error).message.includes("CHK-099"), `message should name the unexpected code: ${(e as Error).message}`);
        const all = await count(world.db, "SELECT count(*) AS c FROM visit");
        assert(all === 0, "no visit may remain after a drift rejection");
    });

    await ok("T0-11: P1 never enters the captured universe", async () => {
        const world = await freshWorld();
        const visitId = await standardCreate(world);
        const cells = await cellsOf(world.db, visitId, null);
        for (const code of EXPECTED_P1) {
            assert(!cells.some((c) => c.code === code), `${code} (P1) leaked into the captured universe`);
        }
        // every manifest P0 code IS present, and nothing else
        const cellCodes = new Set(cells.map((c) => c.code));
        assert(EXPECTED_P0.every((code) => cellCodes.has(code)), "a manifest P0 code is missing from the universe");
    });

    await ok("T0-12: institution cells == manifest P0 universe (one ACTIVE definition each, deterministic order)", async () => {
        const world = await freshWorld();
        const visitId = await standardCreate(world, "SURPRISE");
        const cells = await cellsOf(world.db, visitId, null);
        assert(cells.length === EXPECTED_P0.length, `cell count ${cells.length}`);
        assert(cells.map((c) => c.code).join(",") === [...EXPECTED_P0].sort().join(","), "deterministic item-code order");
        const active = await world.db.query(
            "SELECT item_code, item_definition_id FROM checklist_item_definition WHERE status='ACTIVE' AND priority='P0'",
        );
        const activeIdByCode = new Map(active.map((r) => [String(r.item_code), Number(r.item_definition_id)]));
        for (const c of cells) {
            assert(c.itemDefinitionId === activeIdByCode.get(c.code), `${c.code} must pin the current ACTIVE definition`);
        }
        // each ACTIVE+P0 code appears exactly once as an institution cell
        const seen = new Set<string>();
        for (const c of cells) {
            assert(!seen.has(c.code), `duplicate cell ${c.code}`);
            seen.add(c.code);
        }
        const subjects = await world.db.query(
            "SELECT count(*) AS c FROM checklist_response WHERE visit_id = ? AND subject_id IS NOT NULL",
            [visitId],
        );
        assert(Number(subjects[0].c) === 0, "no subject cells may exist right after createVisit");
    });

    await ok("T0-13: correct NA / true-pending (incl. HUMAN) materialization", async () => {
        const world = await freshWorld();
        const visitId = await standardCreate(world, "SURPRISE");
        const cells = await cellsOf(world.db, visitId, null);
        const model = await modelOverlayByCode(world.db, "INSTITUTION", "SURPRISE");
        assertCellGridMatchesModel(cells, model, "institution");

        const byCode = new Map(cells.map((c) => [c.code, c]));
        // WORKSHOP-only item at the institution context => NA
        assert(byCode.get("CHK-013")!.overlay === "NA", "CHK-013 must be NA for the institution context");
        // institution-level AUTO item => true-pending NOT_INSPECTED
        const chk006 = byCode.get("CHK-006")!;
        assert(chk006.overlay === "NOT_INSPECTED" && chk006.answeredValueId === null && chk006.reason === null && chk006.findingId === null, "CHK-006 pending");
        // HUMAN_CONFIRMATION item (CHK-020) materializes as the SAME true-pending state (B1)
        const chk020 = byCode.get("CHK-020")!;
        assert(chk020.overlay === "NOT_INSPECTED", "CHK-020 must be unresolved pending NOT_INSPECTED (B1)");
        assert(chk020.answeredValueId === null && chk020.reason === null && chk020.findingId === null, "CHK-020 pending must be NULL everywhere");
    });

    await ok("T0-14: injected failure rolls back the entire unit (zero Visit/cells)", async () => {
        const world = await freshWorld();
        // fail on the first institution-context cell INSERT (after the Visit row
        // was inserted inside the same transaction). Institution cells bind the
        // subject as the SQL literal NULL, so they carry 5 parameters (subject
        // cells carry 6) — that is the discriminating signal.
        let faulted = false;
        const inner = new FaultAdapter(world.db, (sql, params) => {
            if (!faulted && sql.includes("INSERT INTO checklist_response") && params.length === 5) {
                faulted = true;
                return true;
            }
            return false;
        });
        const service = new VisitScopeService(inner);
        await rejectsAny(() =>
            service.createVisit({
                missionId: world.missionId,
                institutionId: world.institutionId,
                visitType: "PLANNED",
                visitDate: VISIT_DATE,
                inspector: "inspector-a",
                expectedP0ItemCodes: EXPECTED_P0,
                actor: "inspector-a",
                now: NOW,
            }),
        );
        assert(faulted, "fault injection did not trigger");
        const visits = await count(world.db, "SELECT count(*) AS c FROM visit");
        const responses = await count(world.db, "SELECT count(*) AS c FROM checklist_response");
        assert(visits === 0, `visit rows must be zero after rollback, got ${visits}`);
        assert(responses === 0, `response rows must be zero after rollback, got ${responses}`);
    });
}

// ---------------------------------------------------------------------------
// T1 — addSubjectToScope
// ---------------------------------------------------------------------------
async function tT1_addSubject(): Promise<void> {
    await ok("T1-15: existing subject with zero grid => complete atomic composition", async () => {
        const world = await freshWorld();
        const visitId = await standardCreate(world, "PLANNED");
        const subjectId = await insertSubject(world.db, world.institutionId, "WORKSHOP", "W1");
        const res = await world.service.addSubjectToScope({
            kind: "existing",
            visitId,
            subjectId,
            actor: "inspector-a",
            now: NOW,
        });
        assert(res.subjectId === subjectId && res.materialized === true && res.materializedCount === EXPECTED_P0.length, "branch B result");
        const cells = await cellsOf(world.db, visitId, subjectId);
        const model = await modelOverlayByCode(world.db, "WORKSHOP", "PLANNED");
        assertCellGridMatchesModel(cells, model, `WORKSHOP subject ${subjectId}`);
        // targeted: CHK-012 is institution-only => NA for a WORKSHOP subject;
        // CHK-001 (workshop) is pending; CHK-020 HUMAN but institution-only => NA here
        const byCode = new Map(cells.map((c) => [c.code, c]));
        assert(byCode.get("CHK-012")!.overlay === "NA", "CHK-012 NA for WORKSHOP subject");
        assert(byCode.get("CHK-014")!.overlay === "NA", "CHK-014 (LAB) NA for WORKSHOP subject");
        assert(byCode.get("CHK-020")!.overlay === "NA", "CHK-020 (INSTITUTION-only HUMAN) NA for WORKSHOP subject");
        assert(byCode.get("CHK-001")!.overlay === "NOT_INSPECTED", "CHK-001 pending for WORKSHOP subject");
    });

    await ok("T1-16: existing subject with the full grid => idempotent no-INSERT success", async () => {
        const world = await freshWorld();
        const visitId = await standardCreate(world, "PLANNED");
        const subjectId = await insertSubject(world.db, world.institutionId, "WORKSHOP", "W1");
        const first = await world.service.addSubjectToScope({ kind: "existing", visitId, subjectId, actor: "inspector-a", now: NOW });
        assert(first.materialized === true && first.materializedCount === EXPECTED_P0.length, "first call must materialize");
        const before = await cellsOf(world.db, visitId, subjectId);
        const again = await world.service.addSubjectToScope({ kind: "existing", visitId, subjectId, actor: "inspector-a", now: NOW });
        assert(again.materialized === false && again.materializedCount === 0, "branch A: no INSERT on the idempotent retry");
        const after = await cellsOf(world.db, visitId, subjectId);
        assert(after.length === before.length, "grid size must not change");
        assert(
            after.every((c, i) => c.itemDefinitionId === before[i].itemDefinitionId && c.overlay === before[i].overlay),
            "grid content must be untouched by the idempotent retry",
        );
        // a third retry after dispositions would still be scope-idempotent (row presence only)
        const third = await world.service.addSubjectToScope({ kind: "existing", visitId, subjectId, actor: "inspector-a", now: NOW });
        assert(third.materialized === false, "third retry must stay a no-op");
    });

    await ok("T1-17: existing subject with a partial grid => E_SCOPE_GAP, never silently repaired", async () => {
        const world = await freshWorld();
        const visitId = await standardCreate(world, "PLANNED");
        const subjectId = await insertSubject(world.db, world.institutionId, "WORKSHOP", "W1");
        // craft a partial grid directly (5 pinned definitions of the captured universe)
        const pinned = await cellsOf(world.db, visitId, null);
        const partial = pinned.slice(0, 5);
        for (const c of partial) {
            await world.db.run(
                `INSERT INTO checklist_response(visit_id, item_definition_id, subject_id, overlay_state, recorded_at, recorded_by)
                 VALUES (?, ?, ?, 'NOT_INSPECTED', ?, 'owner')`,
                [visitId, c.itemDefinitionId, subjectId, NOW],
            );
        }
        const e = await rejectsCode(APP_ERR.SCOPE_GAP, () =>
            world.service.addSubjectToScope({ kind: "existing", visitId, subjectId, actor: "inspector-a", now: NOW }),
        );
        assert((e as Error).message.includes("5"), `message should state the actual count: ${(e as Error).message}`);
        const cells = await cellsOf(world.db, visitId, subjectId);
        assert(cells.length === 5, "partial grid must be untouched (no silent repair)");
    });

    await ok("T1-18: cross-institution subject rejected (E_CONTEXT)", async () => {
        const world = await freshWorld();
        const visitId = await standardCreate(world, "PLANNED");
        // second institution + subject of it
        const otherInst = Number(
            (await world.db.run("INSERT INTO institution(name, created_at, created_by) VALUES ('Other', ?, 'owner')", [NOW]))
                .lastInsertRowid,
        );
        const foreignSubject = await insertSubject(world.db, otherInst, "WORKSHOP", "W-other");
        const e = await rejectsCode(APP_ERR.CONTEXT, () =>
            world.service.addSubjectToScope({ kind: "existing", visitId, subjectId: foreignSubject, actor: "inspector-a", now: NOW }),
        );
        assert((e as Error).message.includes("E_CONTEXT"), (e as Error).message);
        const counts = await visitRowCounts(world.db, visitId);
        assert(counts.visits === 1 && counts.cells === EXPECTED_P0.length && counts.subjectCells === 0, "no subject cells added");
    });

    await ok("T1-19: new subject + full grid atomic together", async () => {
        const world = await freshWorld();
        const visitId = await standardCreate(world, "PLANNED");
        const res = await world.service.addSubjectToScope({
            kind: "new",
            visitId,
            subject: { subjectType: "LAB", name: "Lab 1" },
            actor: "inspector-a",
            now: NOW,
        });
        assert(res.materialized === true && res.materializedCount === EXPECTED_P0.length, "new subject result");
        const subj = await world.db.query("SELECT institution_id, subject_type FROM inspected_subject WHERE subject_id = ?", [res.subjectId]);
        assert(subj.length === 1 && Number(subj[0].institution_id) === world.institutionId && String(subj[0].subject_type) === "LAB", "subject row");
        const cells = await cellsOf(world.db, visitId, res.subjectId);
        const model = await modelOverlayByCode(world.db, "LAB", "PLANNED");
        assertCellGridMatchesModel(cells, model, `LAB subject ${res.subjectId}`);
        const counts = await visitRowCounts(world.db, visitId);
        assert(counts.cells === EXPECTED_P0.length * 2 && counts.subjectCells === EXPECTED_P0.length, "institution + subject grids both present");
    });

    await ok("T1-20: injected failure leaves no new subject/cells (single tx)", async () => {
        const world = await freshWorld();
        const visitId = await standardCreate(world, "PLANNED");
        // fail on the 5th subject-context cell INSERT (the subject row itself was
        // already inserted inside the same transaction)
        let subjectCellsSeen = 0;
        let faulted = false;
        const inner = new FaultAdapter(world.db, (sql, params) => {
            if (sql.includes("INSERT INTO checklist_response") && params[2] !== null) {
                subjectCellsSeen += 1;
                if (subjectCellsSeen === 5) {
                    faulted = true;
                    return true;
                }
            }
            return false;
        });
        const service = new VisitScopeService(inner);
        const subjectsBefore = await count(world.db, "SELECT count(*) AS c FROM inspected_subject");
        const responsesBefore = await count(world.db, "SELECT count(*) AS c FROM checklist_response");
        await rejectsAny(() =>
            service.addSubjectToScope({
                kind: "new",
                visitId,
                subject: { subjectType: "CLASSROOM", name: "Room 9" },
                actor: "inspector-a",
                now: NOW,
            }),
        );
        assert(faulted && subjectCellsSeen === 5, "fault injection did not trigger at the 5th subject cell");
        const subjectsAfter = await count(world.db, "SELECT count(*) AS c FROM inspected_subject");
        const responsesAfter = await count(world.db, "SELECT count(*) AS c FROM checklist_response");
        assert(subjectsAfter === subjectsBefore, `new subject must roll back (${subjectsBefore} -> ${subjectsAfter})`);
        assert(responsesAfter === responsesBefore, `new subject cells must roll back (${responsesBefore} -> ${responsesAfter})`);
    });
}

// ---------------------------------------------------------------------------
// VF — captured-universe / version freezing
// ---------------------------------------------------------------------------
async function tVF_freezing(): Promise<void> {
    await ok("VF-21: a later ACTIVE v2 release never alters an existing captured universe; only a NEW Visit composes the new version", async () => {
        const world = await freshWorld();
        const visitA = await standardCreate(world, "PLANNED");
        const universeA = new Map((await cellsOf(world.db, visitA, null)).map((c) => [c.code, c.itemDefinitionId]));

        // release CHK-007 v2 (supersede the ACTIVE v1, then ACTIVE v2)
        const released = await releaseNextVersion(world.db, "CHK-007");
        assert(universeA.get("CHK-007") === released.oldId, "precondition: visit A pinned the v1 def");

        // the first Visit's institution rows are untouched (rows are the frozen universe)
        const universeAfter = new Map((await cellsOf(world.db, visitA, null)).map((c) => [c.code, c.itemDefinitionId]));
        for (const [code, id] of universeA) {
            assert(universeAfter.get(code) === id, `captured universe changed for ${code} after the release`);
        }

        // a brand-new Visit composes with the NEW ACTIVE version (selection instant)
        const visitB = await world.service.createVisit({
            missionId: world.missionId,
            institutionId: world.institutionId,
            visitType: "PLANNED",
            visitDate: VISIT_DATE,
            inspector: "inspector-b",
            expectedP0ItemCodes: EXPECTED_P0,
            actor: "inspector-b",
            now: NOW,
        });
        const universeB = new Map((await cellsOf(world.db, visitB.visitId, null)).map((c) => [c.code, c.itemDefinitionId]));
        assert(universeB.get("CHK-007") === released.newId, "a new Visit must select the newly ACTIVE v2 definition");
        assert(universeB.get("CHK-007") !== universeA.get("CHK-007"), "v1 and v2 must differ");
        for (const code of EXPECTED_P0) {
            if (code !== "CHK-007") assert(universeB.get(code) === universeA.get(code), `${code} should keep the same definition`);
        }
    });

    await ok("VF-22: addSubjectToScope reuses the exact pinned item_definition_id values of the captured universe", async () => {
        const world = await freshWorld();
        const visitId = await standardCreate(world, "PLANNED");
        const pinned = new Map((await cellsOf(world.db, visitId, null)).map((c) => [c.code, c.itemDefinitionId]));

        // release CHK-007 v2 AFTER the Visit was created
        const released = await releaseNextVersion(world.db, "CHK-007");

        const subjectId = await insertSubject(world.db, world.institutionId, "WORKSHOP", "W1");
        const res = await world.service.addSubjectToScope({ kind: "existing", visitId, subjectId, actor: "inspector-a", now: NOW });
        assert(res.materialized === true && res.materializedCount === EXPECTED_P0.length, "grid composed after the release");

        const subjectCells = await cellsOf(world.db, visitId, subjectId);
        const actualById = new Map(subjectCells.map((c) => [c.code, c.itemDefinitionId]));
        for (const [code, id] of pinned) {
            assert(actualById.get(code) === id, `${code}: subject cell must pin the captured definition id ${id} (got ${actualById.get(code)})`);
        }
        assert(actualById.get("CHK-007") === released.oldId, "CHK-007 subject cell must use the pinned v1 id");
        assert(actualById.get("CHK-007") !== released.newId, "a later ACTIVE v2 must never retro-enter the existing Visit");
        const currentActive = await world.db.query(
            "SELECT item_definition_id FROM checklist_item_definition WHERE item_code = 'CHK-007' AND status = 'ACTIVE'",
        );
        assert(Number(currentActive[0].item_definition_id) === released.newId, "precondition: v2 is currently ACTIVE");
    });
}

// ---------------------------------------------------------------------------
// NN — runtime neutrality of the production core
// ---------------------------------------------------------------------------
async function tNN_neutrality(): Promise<void> {
    await ok("NN-23: production core (src/application/*) imports no node:* module", async () => {
        const files = ["errors.ts", "applicability.ts", "visit-scope.ts"].map((f) => join(ROOT, "src", "application", f));
        for (const file of files) {
            const text = readFileSync(file, "utf8");
            const m = /(?:from\s+|require\()\s*["']node:/.exec(text);
            assert(m === null, `${file} imports a node:* module: ${m ? m[0] : ""}`);
            assert(!/node:sqlite/.test(text), `${file} must not reference node:sqlite`);
        }
        // the seam types + bootstrap helpers are runtime-neutral (Gate 5B verified);
        // domain core must not import the dev adapter either
        for (const file of files) {
            const text = readFileSync(file, "utf8");
            assert(!/node-sqlite-adapter/.test(text), `${file} must not import the dev/test adapter`);
        }
    });
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------
const SUITES: Array<[string, () => Promise<void>]> = [
    ["G5C-A applicability evaluator (pure)", tA_applicability],
    ["G5C-T0 createVisit (mission gate + universe capture)", tT0_createVisit],
    ["G5C-T1 addSubjectToScope (A/B/C branches + new subject)", tT1_addSubject],
    ["G5C-VF captured-universe / version freezing", tVF_freezing],
    ["G5C-NN runtime neutrality of production core", tNN_neutrality],
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
