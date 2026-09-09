// Gate 5L — `currentVisitState(visitId)` — restart reconstruction service
// (runtime-neutral TypeScript, no node:* imports).
//
// Implements the adopted read-only reconstruction contract of
// APPLICATION-CORE-v1.md §4.11 / RECOVERY-AND-IDEMPOTENCY-v1.md §6: rebuild
// the complete durable application state needed to resume or display ONE
// Visit after process restart, using SQLite rows as the ONLY authority.
//
//   * READ-ONLY: ZERO domain write statements. The service issues NO
//     INSERT/UPDATE/DELETE anywhere. It never auto-repairs, never persists a
//     cache/sidecar, and never trusts process memory. Same durable rows =>
//     same returned state across service instances.
//
//   * ONE COHERENT SNAPSHOT: TRANSACTION-CONTRACTS-v1.md §1.2 lets a
//     read-only call open "a `BEGIN` only when a consistent multi-statement
//     read is needed"; the adopted Gate-5B adapter seam exposes
//     `beginImmediate()` and no plain deferred `BEGIN`. This service
//     therefore runs every SELECT inside ONE explicit
//     `BEGIN IMMEDIATE … COMMIT` unit (RE-READS ONLY, then COMMIT). Under the
//     v1 single-inspector architecture (all writes on one serialized path,
//     RECOVERY §1.3) BEGIN IMMEDIATE is a conservative snapshot/serialization
//     barrier for the read set — not a domain write — and it guarantees every
//     SELECT observes the same committed SQLite snapshot. Any failure
//     ROLLBACKs; the connection is never left inside a transaction.
//
//   * Captured instrument universe (B2/B11): the Visit's institution-context
//     `checklist_response` rows (subject_id IS NULL) with their PINNED
//     `item_definition_id` values. Current ACTIVE definitions are NEVER
//     queried to discover codes or versions for an existing Visit. Each
//     pinned definition is reconstructed with its durable definition fields
//     (itemCode/versionNo/domainId/arabicQuestion/responseModel/priority/
//     applicabilityRule + parsed decisionKind/status) and the exact pinned
//     allowed-value set — even when the definition later became
//     SUPERSEDED/ARCHIVED.
//
//   * Contexts: the institution context + every distinct subject context
//     durably present in the grid, with each subject's durable
//     inspected_subject row. Subjects existing in the institution WITHOUT
//     grid rows are NOT auto-added. Deterministic order: institution first,
//     then subjects ascending by subject_id.
//
//   * Grid self-check (RECOVERY §6.1, same exact-set semantics as the closed
//     Gate-5C/Gate-5K checks): expected = captured universe × captured
//     contexts; actual = the Visit's checklist_response rows. Missing cells,
//     partial subject grids, extra/mismatched cells (a subject-context row
//     pinned to a definition outside the captured universe) and an empty
//     captured universe are surfaced as E_SCOPE_GAP. Nothing is repaired.
//
//   * Integrity signals (never a second finalization operation): beyond the
//     grid, only corruption that the schema itself cannot prevent at rest
//     and that breaks reliable reconstruction is surfaced —
//       - a deliberate NOT_INSPECTED cell whose reason is present but blank
//         matches NO adopted classification predicate (§3.3 requires a
//         meaningful reason) => E_UNINSPECTED_NEEDS_REASON (the exact
//         durable condition Gate-5K already blocks on);
//       - a Finding with origin_visit_id = this Visit, status OPEN and zero
//         recorded sources across BOTH source tables => E_ORPHAN_FINDING
//         (VOIDED findings are EXPECTED source-less and are never flagged).
//     Invariants the schema CHECKs/triggers already make unrepresentable at
//     rest (NC accountability/notes at insert, value-from-pinned-definition,
//     same-institution subjects, mixed versions per context, SCHEDULE recon
//     placement, ...) are relied on, not re-checked; defensive
//     missing-referenced-row branches exist only for fabricated reads.
//
//   * Errors: a missing Visit => E_VISIT_NOT_FOUND. Impossible Visit
//     status/finalized_at combinations => E_STATE_CONFLICT. Missing
//     mission/institution parent rows => E_CONFIG (corruption). When
//     integrity blockers exist the service ROLLBACKs and throws ONE
//     DomainError whose top-level code is the FIRST blocker's code in the
//     deterministic order below and whose `blockers` payload carries the
//     COMPLETE structured list (the adopted Gate-5K/details architecture):
//       1. E_SCOPE_GAP        empty-captured-universe
//       2. E_SCOPE_GAP        missing-cell          (contexts null-first/asc,
//                                                    then item_code)
//       3. E_SCOPE_GAP        extra-cell            (response_id order)
//       4. E_SCOPE_GAP        duplicate-cell        (response_id order; one
//                                                    blocker per duplicated
//                                                    row of a logical cell)
//       5. E_SCOPE_GAP        applicability-state-mismatch (response_id)
//       6. E_SCOPE_GAP        missing-referenced-definition  (response_id)
//       7. E_SCOPE_GAP        missing-referenced-subject     (subject_id)
//       8. E_SCOPE_GAP        missing-answered-value         (response_id)
//       9. E_SCOPE_GAP        missing-referenced-finding     (finding_id)
//      10. E_UNINSPECTED_NEEDS_REASON blank-not-inspected-reason (response_id)
//      11. E_ORPHAN_FINDING   orphan-finding          (finding_id)
//     Pending cells, active Findings, active CorrectiveActions and
//     deliberate NOT_INSPECTED cells are VALID current state and are always
//     reconstructed — currentVisitState never requires finalization
//     readiness.
//
//   * Cell classification is DERIVED ONLY from durable physical state + the
//     CELL'S CONTEXTUAL PINNED applicability outcome (never stored back,
//     never switched on item_code, never recomputed from Arabic prose).
//     The contextual outcome is evaluated per cell with the adopted generic
//     evaluator (APPLICATION-CORE §5.3) from ONLY: that exact pinned
//     definition's applicability_rule, the durable Visit.visit_type, and the
//     durable context kind reconstructed from the grid (INSTITUTION for the
//     institution context, subject_type otherwise). The definition's ROOT
//     decision_kind alone is NEVER treated as the cell's outcome: a
//     HUMAN_CONFIRMATION definition automatically excluded for a context by
//     visit_type/subject_kinds yields NOT_APPLICABLE and its durable NA cell
//     classifies as an ordinary "NA" — not as a historical explicit human
//     NOT_APPLICABLE decision. HUMAN interpretation applies ONLY when the
//     contextual outcome is actually HUMAN_CONFIRMATION:
//       contextual NOT_APPLICABLE + overlay NA                        => "NA"
//       contextual APPLICABLE:
//         pending (NOT_INSPECTED, answer NULL, reason NULL)           => "PENDING"
//         answered (answered_value_id set)                            => "ANSWERED"
//         NOT_INSPECTED + meaningful reason                           => "NOT_INSPECTED"
//       contextual HUMAN_CONFIRMATION:
//         pending                                                      => "UNRESOLVED_HUMAN"
//         answered                                                      => "HUMAN_APPLICABLE_ANSWERED"
//         NOT_INSPECTED + meaningful reason                            => "HUMAN_APPLICABLE_NOT_INSPECTED"
//         NA (explicit human NOT_APPLICABLE decision / recorded reversal) => "HUMAN_NOT_APPLICABLE"
//       NOT_INSPECTED + present-but-blank reason (corruption)         => "NOT_INSPECTED_BLANK_REASON"
//     There is no durable standalone "APPLICABLE but still pending" state.
//     The public pinned-definition metadata keeps the ROOT decisionKind;
//     every CellState carries BOTH the root decisionKind and the derived
//     contextualOutcome (never persisted) so the two are never confused.
//
//   * State-consistency self-check (same contextual pinned outcome): a
//     contradictory durable disposition is NEVER silently reconstructed.
//       contextual NOT_APPLICABLE  => disposition MUST be NA (an answered /
//                                     pending / reasoned cell contradicts the
//                                     rule) => E_SCOPE_GAP
//                                     "applicability-state-mismatch"
//       contextual APPLICABLE      => pending / answered / deliberate
//                                     NOT_INSPECTED are valid; NA contradicts
//       contextual HUMAN_CONFIRMATION => all adopted dispositions are valid
//                                     (incl. NA — the explicit human
//                                     NOT_APPLICABLE decision / reversal)
//
//   * Findings reconstructed = the union of (A) origin_visit_id = this Visit
//     and (B) findings referenced by this Visit's checklist_response.finding_id
//     or adhoc_observation.finding_id. VOIDED findings are returned
//     SEPARATELY as historical/audit state (zero sources expected — never an
//     orphan). Source maps expose only THIS Visit's durable links:
//     responseSources (responseId -> findingId) and observationSources
//     (observationId -> findingId), plus per-Finding source arrays — a source
//     is never inferred from origin_visit_id alone.
//
//   * CorrectiveActions: every action under a reconstructed Finding, ordered
//     by action_id. FollowUps: every append-only event whose finding_id
//     belongs to the reconstructed set (action transitions ride along
//     because each action belongs to one of those findings), ordered
//     chronologically by (event_datetime, followup_id) on the durable text.
//
//   * Orderings (all deterministic): universe by item_code (response_id
//     tiebreak — duplicates are schema-impossible); allowed values by
//     (item_definition_id, sort_order NULLS LAST, allowed_value_id); contexts
//     institution-first then subject_id; cells by (context null-first/asc,
//     item_code, response_id); reconciliation rows by (response_id, row_id);
//     observations by observation_id; findings by finding_id; actions by
//     action_id; classification lists by response_id.
//
// Out of scope (later gates): writes of any kind, finalization readiness,
// observation correction, Evidence, ExternalSystemTracking, reports, UI,
// sync/API, mobile packaging, backup/export.

import type { SqlAdapter, SqlRow, SqlValue } from "../bootstrap/adapter.ts";
import { APP_ERR, DomainError, type AppErrorCode, type FinalizationBlocker } from "./errors.ts";
import {
    evaluateApplicability,
    parseApplicabilityRule,
    type DecisionKind,
    type VisitType,
} from "./applicability.ts";

// ---------------------------------------------------------------------------
// public model
// ---------------------------------------------------------------------------

/** The durable Visit row + its durable parent identity/display metadata. */
export interface VisitState {
    visitId: number;
    missionId: number;
    institutionId: number;
    visitType: VisitType;
    visitDate: string;
    status: "PREPARATION" | "COMPLETED" | "COMPLETED_WITH_UNINSPECTED";
    inspector: string;
    startedAt: string | null;
    finalizedAt: string | null;
    createdAt: string;
    createdBy: string;
}

export interface MissionState {
    missionId: number;
    name: string;
    description: string | null;
    status: string;
    startDate: string | null;
    endDate: string | null;
}

export interface InstitutionState {
    institutionId: number;
    name: string;
    officialCode: string | null;
    kindCode: string | null;
    kindOther: string | null;
    address: string | null;
    district: string | null;
    active: number;
}

/** One allowed value of an exact PINNED definition version. */
export interface CapturedAllowedValue {
    valueId: number;
    valueCode: string;
    arabicLabel: string;
    semanticClass: "COMPLIANT" | "NON_COMPLIANT";
    sortOrder: number | null;
    active: number;
}

/** One PINNED definition of the captured instrument universe. */
export interface CapturedDefinition {
    itemDefinitionId: number;
    itemCode: string;
    versionNo: number;
    domainId: string;
    arabicQuestion: string;
    responseModel: "SINGLE_VALUE" | "SCHEDULE";
    priority: string;
    /** the raw pinned applicability payload (durable JSON text, never reinterpreted) */
    applicabilityRule: string;
    /** the pinned decision kind parsed from the durable rule payload */
    decisionKind: DecisionKind;
    /** historical metadata: the definition's CURRENT status (may be SUPERSEDED/ARCHIVED) */
    definitionStatus: "ACTIVE" | "SUPERSEDED" | "ARCHIVED";
    /** the exact pinned definition's allowed values (historical interpretation) */
    allowedValues: CapturedAllowedValue[];
}

/** The durable InspectedSubject row of a captured subject context. */
export interface CapturedSubject {
    subjectId: number;
    institutionId: number;
    subjectType: string;
    subjectTypeOther: string | null;
    name: string;
    locationDesc: string | null;
    specialty: string | null;
    active: number;
}

/** One captured context: the institution context or a durably-present subject context. */
export interface VisitContext {
    /** "INSTITUTION" for the institution context; subject_type for subject contexts */
    kind: string;
    subjectId: number | null;
    /** durable inspected_subject row — present ONLY for subject contexts */
    subject: CapturedSubject | null;
}

/**
 * Derived cell classification — durable physical cell state + the cell's
 * CONTEXTUAL PINNED applicability outcome. That contextual outcome is
 * produced by the adopted evaluator (evaluateApplicability) from ONLY: the
 * exact pinned applicability_rule, the durable Visit.visit_type, and the
 * durable context kind — the definition's root decision_kind alone never
 * drives classification.
 */
export type CellClassification =
    | "PENDING"
    | "UNRESOLVED_HUMAN"
    | "ANSWERED"
    | "HUMAN_APPLICABLE_ANSWERED"
    | "NOT_INSPECTED"
    | "HUMAN_APPLICABLE_NOT_INSPECTED"
    | "NA"
    | "HUMAN_NOT_APPLICABLE"
    | "NOT_INSPECTED_BLANK_REASON";

/** One durable equipment-reconciliation row of a SCHEDULE cell. */
export interface ReconciliationRowState {
    rowId: number;
    responseId: number;
    category: string;
    declaredQty: number;
    observedQty: number;
    difference: number;
    discrepancyType: string | null;
    discrepancyDesc: string | null;
    sortOrder: number | null;
}

/** One durable checklist cell + its pinned interpretation + derived classification. */
export interface CellState {
    responseId: number;
    visitId: number;
    itemDefinitionId: number;
    subjectId: number | null;
    overlayState: "NA" | "NOT_INSPECTED" | null;
    answeredValueId: number | null;
    note: string | null;
    notInspectedReason: string | null;
    findingId: number | null;
    recordedAt: string;
    recordedBy: string;
    /** pinned interpretation */
    itemCode: string;
    responseModel: "SINGLE_VALUE" | "SCHEDULE";
    priority: string;
    /** the pinned definition's ROOT decision_kind (definition-level metadata) */
    decisionKind: DecisionKind;
    /**
     * the cell's CONTEXTUAL pinned applicability outcome, derived per cell
     * with the adopted evaluator from the pinned rule + durable
     * Visit.visit_type + durable context kind. NEVER persisted; NEVER
     * conflated with decisionKind (a HUMAN_CONFIRMATION definition can yield
     * contextual NOT_APPLICABLE for a context excluded by the rule).
     */
    contextualOutcome: "NOT_APPLICABLE" | "APPLICABLE" | "HUMAN_CONFIRMATION";
    /** answered value metadata (present exactly when answeredValueId is set) */
    answeredValue: {
        valueId: number;
        valueCode: string;
        arabicLabel: string;
        semanticClass: "COMPLIANT" | "NON_COMPLIANT";
        sortOrder: number | null;
        active: number;
    } | null;
    classification: CellClassification;
    /** durable reconciliation rows — present ONLY for SCHEDULE cells (row_id order) */
    reconciliationRows?: ReconciliationRowState[];
}

export interface ObservationState {
    observationId: number;
    visitId: number;
    subjectId: number | null;
    text: string;
    findingId: number | null;
    recordedAt: string;
    recordedBy: string;
}

export type FindingStatus = "OPEN" | "IN_TREATMENT" | "RESOLVED" | "VOIDED";

/** One reconstructed Finding + this Visit's durable source links to it. */
export interface FindingState {
    findingId: number;
    originVisitId: number;
    subjectId: number | null;
    description: string;
    defectType: string | null;
    defectTypeOther: string | null;
    location: string | null;
    urgency: string;
    impact: string;
    status: FindingStatus;
    statusChangedAt: string | null;
    createdAt: string;
    createdBy: string;
    /** this Visit's checklist_response ids pointing at this Finding (ascending) */
    sourceResponseIds: number[];
    /** this Visit's adhoc_observation ids pointing at this Finding (ascending) */
    sourceObservationIds: number[];
}

export interface ResponseSourceLink {
    responseId: number;
    findingId: number;
}

export interface ObservationSourceLink {
    observationId: number;
    findingId: number;
}

export interface CorrectiveActionState {
    actionId: number;
    findingId: number;
    actionType: string;
    actionTypeOther: string | null;
    description: string;
    responsibleRole: string;
    responsibleRoleOther: string | null;
    responsibleName: string | null;
    dueDate: string | null;
    status: string;
    closedAt: string | null;
    verifiedBy: string | null;
    verificationNote: string | null;
    createdAt: string;
    createdBy: string;
}

export interface FollowUpState {
    followUpId: number;
    findingId: number;
    correctiveActionId: number | null;
    visitId: number | null;
    statusTarget: string | null;
    statusAfter: string | null;
    eventDatetime: string;
    actorRole: string;
    actorRoleOther: string | null;
    actorName: string | null;
    note: string;
    recordedBy: string;
}

/** Derived restart summary — never persisted. */
export interface RestartSummary {
    capturedDefinitionCount: number;
    contextCount: number;
    expectedCellCount: number;
    actualCellCount: number;
    pendingCount: number;
    unresolvedHumanCount: number;
    deliberateUninspectedCount: number;
    answeredCount: number;
    naCount: number;
    observationCount: number;
    activeFindingCount: number;
    voidedFindingCount: number;
    correctiveActionCount: number;
    followUpCount: number;
}

/** The complete reconstructed durable state of ONE Visit. */
export interface CurrentVisitState {
    visit: VisitState;
    mission: MissionState;
    institution: InstitutionState;
    capturedUniverse: CapturedDefinition[];
    contexts: VisitContext[];
    cells: CellState[];
    classifications: {
        pendingResponseIds: number[];
        unresolvedHumanResponseIds: number[];
        deliberateUninspectedResponseIds: number[];
        answeredResponseIds: number[];
        naResponseIds: number[];
    };
    observations: ObservationState[];
    /** OPEN/IN_TREATMENT/RESOLVED findings (finding_id order) */
    activeFindings: FindingState[];
    /** VOIDED findings — historical/audit state, zero sources expected (finding_id order) */
    voidedFindings: FindingState[];
    responseSources: ResponseSourceLink[];
    observationSources: ObservationSourceLink[];
    correctiveActions: CorrectiveActionState[];
    followUps: FollowUpState[];
    summary: RestartSummary;
}

// ---------------------------------------------------------------------------
// internal model
// ---------------------------------------------------------------------------

/** thrown inside the read unit to surface the complete structured blocker list */
class StateBlocked extends Error {
    readonly blockers: readonly FinalizationBlocker[];

    constructor(blockers: readonly FinalizationBlocker[]) {
        super(`visit state reconstruction blocked by ${blockers.length} integrity issue(s)`);
        this.name = "StateBlocked";
        this.blockers = blockers;
    }
}

interface RawUniverseRow {
    itemDefinitionId: number;
    itemCode: string;
    versionNo: number;
    domainId: string;
    arabicQuestion: string;
    responseModel: string;
    priority: string;
    applicabilityRule: string;
    definitionStatus: string;
}

interface DefinitionMeta {
    itemCode: string;
    responseModel: string;
    priority: string;
    decisionKind: DecisionKind;
    /** the pinned rule payload text — needed for the per-cell contextual evaluation */
    applicabilityRule: string;
}

interface RawCellRow {
    responseId: number;
    visitId: number;
    itemDefinitionId: number;
    subjectId: number | null;
    overlayState: string | null;
    answeredValueId: number | null;
    note: string | null;
    notInspectedReason: string | null;
    findingId: number | null;
    recordedAt: string;
    recordedBy: string;
    defId: number | null;
    itemCode: string | null;
    applicabilityRule: string | null;
    answeredValue: {
        valueId: number;
        valueCode: string;
        arabicLabel: string;
        semanticClass: string;
        sortOrder: number | null;
        active: number;
    } | null;
}

/** trim; blank/missing => null. */
function normalizeText(v: string | null | undefined): string | null {
    if (v === null || v === undefined) return null;
    const t = v.trim();
    return t.length === 0 ? null : t;
}

function num(v: SqlValue): number {
    return Number(v);
}

function textOrNull(v: SqlValue | null | undefined): string | null {
    return v === null || v === undefined ? null : String(v);
}

// ---------------------------------------------------------------------------
// service
// ---------------------------------------------------------------------------

export class CurrentVisitStateService {
    private readonly db: SqlAdapter;

    constructor(db: SqlAdapter) {
        this.db = db;
    }

    /**
     * Reconstruct the complete durable state of ONE Visit from SQLite rows
     * (the ONLY authority). One explicit BEGIN IMMEDIATE … SELECTs … COMMIT
     * unit — never a write; a failure ROLLBACKs. Integrity blockers surface
     * as ONE DomainError carrying the complete structured list (top-level
     * code = first blocker's code in the deterministic order above).
     */
    async currentVisitState(visitId: number): Promise<CurrentVisitState> {
        await this.db.beginImmediate();
        try {
            const state = await this.build(visitId);
            await this.db.commit();
            return state;
        } catch (e) {
            try {
                await this.db.rollback();
            } catch {
                // rollback must never mask the original failure
            }
            if (e instanceof StateBlocked) {
                const first = e.blockers[0];
                throw new DomainError(first.code, blockedMessage(e.blockers), e.blockers);
            }
            throw e;
        }
    }

    // -- the whole reconstruction (SELECTs only; deterministic order) ----------

    private async build(visitId: number): Promise<CurrentVisitState> {
        const op = "currentVisitState";

        // 1) Visit + parent identity/display metadata (LEFT JOINs so a
        //    fabricated missing parent is detected, never silently dropped).
        const visitRows = await this.db.query(
            `SELECT v.visit_id, v.mission_id, v.institution_id, v.visit_type, v.visit_date,
                    v.status, v.inspector, v.started_at, v.finalized_at, v.created_at, v.created_by,
                    m.name AS mission_name, m.description AS mission_description,
                    m.status AS mission_status, m.start_date AS mission_start_date, m.end_date AS mission_end_date,
                    i.name AS institution_name, i.official_code, i.kind_code, i.kind_other,
                    i.address, i.district, i.active AS institution_active
               FROM visit v
               LEFT JOIN mission m ON m.mission_id = v.mission_id
               LEFT JOIN institution i ON i.institution_id = v.institution_id
              WHERE v.visit_id = ?`,
            [visitId],
        );
        if (visitRows.length === 0) {
            throw new DomainError(APP_ERR.VISIT_NOT_FOUND, `${op}: visit ${visitId} does not exist`);
        }
        const v = visitRows[0];
        if (v.mission_name === null || v.mission_name === undefined) {
            throw new DomainError(
                APP_ERR.CONFIG,
                `${op}: visit ${visitId} references a missing mission row (corruption)`,
            );
        }
        if (v.institution_name === null || v.institution_name === undefined) {
            throw new DomainError(
                APP_ERR.CONFIG,
                `${op}: visit ${visitId} references a missing institution row (corruption)`,
            );
        }
        const status = String(v.status);
        const finalizedAt = textOrNull(v.finalized_at);
        // impossible visit status/finalized_at combinations (schema-CHECK-
        // unrepresentable at rest; the branches exist so a fabricated read
        // never silently converges)
        if (!["PREPARATION", "COMPLETED", "COMPLETED_WITH_UNINSPECTED"].includes(status)) {
            throw new DomainError(
                APP_ERR.STATE_CONFLICT,
                `${op}: visit ${visitId} carries an unknown durable status '${status}' (corruption)`,
            );
        }
        if (finalizedAt !== null && status === "PREPARATION") {
            throw new DomainError(
                APP_ERR.STATE_CONFLICT,
                `${op}: visit ${visitId} carries finalized_at '${finalizedAt}' but status PREPARATION — ` +
                    "this impossible combination is a typed conflict, never silent convergence",
            );
        }
        if (finalizedAt === null && status !== "PREPARATION") {
            throw new DomainError(
                APP_ERR.STATE_CONFLICT,
                `${op}: visit ${visitId} is '${status}' with finalized_at NULL — a final status requires ` +
                    "a durable finalized_at (corruption)",
            );
        }

        const visit: VisitState = {
            visitId,
            missionId: num(v.mission_id),
            institutionId: num(v.institution_id),
            visitType: String(v.visit_type) as VisitType,
            visitDate: String(v.visit_date),
            status: status as VisitState["status"],
            inspector: String(v.inspector),
            startedAt: textOrNull(v.started_at),
            finalizedAt,
            createdAt: String(v.created_at),
            createdBy: String(v.created_by),
        };
        const mission: MissionState = {
            missionId: num(v.mission_id),
            name: String(v.mission_name),
            description: textOrNull(v.mission_description),
            status: String(v.mission_status),
            startDate: textOrNull(v.mission_start_date),
            endDate: textOrNull(v.mission_end_date),
        };
        const institution: InstitutionState = {
            institutionId: num(v.institution_id),
            name: String(v.institution_name),
            officialCode: textOrNull(v.official_code),
            kindCode: textOrNull(v.kind_code),
            kindOther: textOrNull(v.kind_other),
            address: textOrNull(v.address),
            district: textOrNull(v.district),
            active: num(v.institution_active),
        };

        // 2) captured instrument universe = institution-context rows + their
        //    PINNED definitions (never a current-ACTIVE discovery).
        const universeRows = await this.db.query(
            `SELECT cr.item_definition_id, cr.response_id,
                    d.item_code, d.version_no, d.domain_id, d.arabic_question,
                    d.response_model, d.priority, d.applicability_rule, d.status AS definition_status
               FROM checklist_response cr
               LEFT JOIN checklist_item_definition d ON d.item_definition_id = cr.item_definition_id
              WHERE cr.visit_id = ? AND cr.subject_id IS NULL
              ORDER BY d.item_code ASC, cr.response_id ASC`,
            [visitId],
        );
        const universeDefs: RawUniverseRow[] = [];
        const defMeta = new Map<number, DefinitionMeta>();
        for (const r of universeRows) {
            const itemDefinitionId = num(r.item_definition_id);
            if (r.item_code === null || r.item_code === undefined) {
                // unrepresentable at rest (FK + no-delete trigger); defensive
                // fabricated-read branch — recorded as a grid integrity issue
                universeDefs.push({
                    itemDefinitionId,
                    itemCode: "",
                    versionNo: 0,
                    domainId: "",
                    arabicQuestion: "",
                    responseModel: "",
                    priority: "",
                    applicabilityRule: "",
                    definitionStatus: "",
                });
                continue;
            }
            const applicabilityRule = String(r.applicability_rule);
            // the pinned rule payload is parsed here (full §4.1 grammar):
            // a corrupt payload raises E_CONFIG and blocks the reconstruction.
            const parsed = parseApplicabilityRule(applicabilityRule);
            universeDefs.push({
                itemDefinitionId,
                itemCode: String(r.item_code),
                versionNo: num(r.version_no),
                domainId: String(r.domain_id),
                arabicQuestion: String(r.arabic_question),
                responseModel: String(r.response_model),
                priority: String(r.priority),
                applicabilityRule,
                definitionStatus: String(r.definition_status),
            });
            defMeta.set(itemDefinitionId, {
                itemCode: String(r.item_code),
                responseModel: String(r.response_model),
                priority: String(r.priority),
                decisionKind: parsed.decisionKind,
                applicabilityRule,
            });
        }

        // 3) allowed values of the exact pinned definitions
        const allowedByDef = new Map<number, CapturedAllowedValue[]>();
        if (universeDefs.length > 0) {
            const placeholders = universeDefs.map(() => "?").join(", ");
            const valueRows = await this.db.query(
                `SELECT allowed_value_id, item_definition_id, value_code, arabic_label,
                        semantic_class, sort_order, active
                   FROM checklist_allowed_value
                  WHERE item_definition_id IN (${placeholders})
                  ORDER BY item_definition_id ASC, sort_order IS NULL ASC, sort_order ASC, allowed_value_id ASC`,
                universeDefs.map((d) => d.itemDefinitionId) as readonly SqlValue[],
            );
            for (const r of valueRows) {
                const defId = num(r.item_definition_id);
                const list = allowedByDef.get(defId) ?? [];
                list.push({
                    valueId: num(r.allowed_value_id),
                    valueCode: String(r.value_code),
                    arabicLabel: String(r.arabic_label),
                    semanticClass: String(r.semantic_class) as CapturedAllowedValue["semanticClass"],
                    sortOrder: r.sort_order === null ? null : num(r.sort_order),
                    active: num(r.active),
                });
                allowedByDef.set(defId, list);
            }
        }

        // 4) contexts: institution context + every distinct subject context
        //    durably present in the grid (never discovered outside it).
        const ctxRows = await this.db.query(
            `SELECT DISTINCT COALESCE(subject_id, 0) AS ctx
               FROM checklist_response
              WHERE visit_id = ?
              ORDER BY ctx`,
            [visitId],
        );
        const contextKeys: (number | null)[] = ctxRows.map((r) => (num(r.ctx) === 0 ? null : num(r.ctx)));
        const subjectById = new Map<number, CapturedSubject>();
        const subjectKeys = contextKeys.filter((k): k is number => k !== null);
        if (subjectKeys.length > 0) {
            const placeholders = subjectKeys.map(() => "?").join(", ");
            const subjectRows = await this.db.query(
                `SELECT subject_id, institution_id, subject_type, subject_type_other,
                        name, location_desc, specialty, active
                   FROM inspected_subject
                  WHERE subject_id IN (${placeholders})`,
                subjectKeys as readonly SqlValue[],
            );
            for (const r of subjectRows) {
                const subjectId = num(r.subject_id);
                subjectById.set(subjectId, {
                    subjectId,
                    institutionId: num(r.institution_id),
                    subjectType: String(r.subject_type),
                    subjectTypeOther: textOrNull(r.subject_type_other),
                    name: String(r.name),
                    locationDesc: textOrNull(r.location_desc),
                    specialty: textOrNull(r.specialty),
                    active: num(r.active),
                });
            }
        }

        // 5) all durable cells + pinned interpretation + answered-value metadata
        const cellRows = await this.db.query(
            `SELECT cr.response_id, cr.visit_id, cr.item_definition_id, cr.subject_id, cr.overlay_state,
                    cr.answered_value_id, cr.note, cr.not_inspected_reason, cr.finding_id,
                    cr.recorded_at, cr.recorded_by,
                    d.item_definition_id AS def_id, d.item_code, d.response_model, d.priority,
                    d.applicability_rule,
                    av.allowed_value_id AS av_id, av.value_code AS av_code,
                    av.arabic_label AS av_label, av.semantic_class AS av_class,
                    av.sort_order AS av_sort, av.active AS av_active
               FROM checklist_response cr
               LEFT JOIN checklist_item_definition d ON d.item_definition_id = cr.item_definition_id
               LEFT JOIN checklist_allowed_value av ON av.allowed_value_id = cr.answered_value_id
              WHERE cr.visit_id = ?
              ORDER BY COALESCE(cr.subject_id, 0) ASC, d.item_code ASC, cr.response_id ASC`,
            [visitId],
        );
        const rawCells: RawCellRow[] = [];
        for (const r of cellRows) {
            const itemDefinitionId = num(r.item_definition_id);
            const answeredValueId = r.answered_value_id === null ? null : num(r.answered_value_id);
            const raw: RawCellRow = {
                responseId: num(r.response_id),
                visitId: num(r.visit_id),
                itemDefinitionId,
                subjectId: r.subject_id === null ? null : num(r.subject_id),
                overlayState: textOrNull(r.overlay_state),
                answeredValueId,
                note: textOrNull(r.note),
                notInspectedReason: textOrNull(r.not_inspected_reason),
                findingId: r.finding_id === null ? null : num(r.finding_id),
                recordedAt: String(r.recorded_at),
                recordedBy: String(r.recorded_by),
                defId: r.def_id === null || r.def_id === undefined ? null : num(r.def_id),
                itemCode: textOrNull(r.item_code),
                applicabilityRule: textOrNull(r.applicability_rule),
                answeredValue:
                    r.av_id === null || r.av_id === undefined
                        ? null
                        : {
                              valueId: num(r.av_id),
                              valueCode: String(r.av_code),
                              arabicLabel: String(r.av_label),
                              semanticClass: String(r.av_class),
                              sortOrder: r.av_sort === null ? null : num(r.av_sort),
                              active: num(r.av_active),
                          },
            };
            rawCells.push(raw);
            // pinned interpretation for this cell's definition (lazy parse
            // for definitions outside the universe — such cells are always
            // extra-cell blockers and never reach assembly)
            if (!defMeta.has(itemDefinitionId) && raw.applicabilityRule !== null) {
                const parsed = parseApplicabilityRule(raw.applicabilityRule);
                defMeta.set(itemDefinitionId, {
                    itemCode: String(r.item_code),
                    responseModel: String(r.response_model),
                    priority: String(r.priority),
                    decisionKind: parsed.decisionKind,
                    applicabilityRule: raw.applicabilityRule,
                });
            }
        }

        // 5b) per-cell CONTEXTUAL pinned applicability outcome (adopted
        //     evaluator, computed ONCE per read): ONLY the pinned rule
        //     payload, the durable Visit.visit_type and the durable context
        //     kind — never a current-ACTIVE definition, never item_code,
        //     never Arabic prose. Cells whose pinned rule or subject row is
        //     unreadable are skipped here: their corruption is surfaced by
        //     the referenced-row blockers, never by a fabricated outcome.
        const contextualOutcomes = new Map<number, "NOT_APPLICABLE" | "APPLICABLE" | "HUMAN_CONFIRMATION">();
        for (const c of rawCells) {
            const meta = defMeta.get(c.itemDefinitionId);
            if (meta === undefined) continue; // missing pinned rule => missing-referenced-definition blocker
            if (c.subjectId !== null && !subjectById.has(c.subjectId)) continue; // missing subject row => its blocker
            const contextKind =
                c.subjectId === null ? "INSTITUTION" : String(subjectById.get(c.subjectId)?.subjectType);
            const outcome = evaluateApplicability(meta.applicabilityRule, contextKind, visit.visitType);
            contextualOutcomes.set(c.responseId, outcome.outcome);
        }

        // 6) durable reconciliation rows under this Visit's SCHEDULE cells
        //    (stable order: response_id, then row_id)
        const scheduleResponseIds = rawCells
            .filter((c) => {
                const meta = defMeta.get(c.itemDefinitionId);
                return meta !== undefined && meta.responseModel === "SCHEDULE";
            })
            .map((c) => c.responseId);
        const reconByResponse = new Map<number, ReconciliationRowState[]>();
        if (scheduleResponseIds.length > 0) {
            const placeholders = scheduleResponseIds.map(() => "?").join(", ");
            const reconRows = await this.db.query(
                `SELECT row_id, response_id, category, declared_qty, observed_qty,
                        difference, discrepancy_type, discrepancy_desc, sort_order
                   FROM equipment_reconciliation_row
                  WHERE response_id IN (${placeholders})
                  ORDER BY response_id ASC, row_id ASC`,
                scheduleResponseIds as readonly SqlValue[],
            );
            for (const r of reconRows) {
                const responseId = num(r.response_id);
                const list = reconByResponse.get(responseId) ?? [];
                list.push({
                    rowId: num(r.row_id),
                    responseId,
                    category: String(r.category),
                    declaredQty: num(r.declared_qty),
                    observedQty: num(r.observed_qty),
                    difference: num(r.difference),
                    discrepancyType: textOrNull(r.discrepancy_type),
                    discrepancyDesc: textOrNull(r.discrepancy_desc),
                    sortOrder: r.sort_order === null ? null : num(r.sort_order),
                });
                reconByResponse.set(responseId, list);
            }
        }

        // 7) observations (stable order: observation_id)
        const obsRows = await this.db.query(
            `SELECT observation_id, visit_id, subject_id, text, finding_id, recorded_at, recorded_by
               FROM adhoc_observation
              WHERE visit_id = ?
              ORDER BY observation_id ASC`,
            [visitId],
        );
        const observations: ObservationState[] = obsRows.map((r) => ({
            observationId: num(r.observation_id),
            visitId: num(r.visit_id),
            subjectId: r.subject_id === null ? null : num(r.subject_id),
            text: String(r.text),
            findingId: r.finding_id === null ? null : num(r.finding_id),
            recordedAt: String(r.recorded_at),
            recordedBy: String(r.recorded_by),
        }));

        // 8) reconstructed Finding set = union of (A) origin = this Visit and
        //    (B) findings referenced by this Visit's durable sources.
        const findingIdRows = await this.db.query(
            `SELECT finding_id FROM (
                 SELECT f.finding_id FROM finding f WHERE f.origin_visit_id = ?
                 UNION
                 SELECT cr.finding_id FROM checklist_response cr
                  WHERE cr.visit_id = ? AND cr.finding_id IS NOT NULL
                 UNION
                 SELECT o.finding_id FROM adhoc_observation o
                  WHERE o.visit_id = ? AND o.finding_id IS NOT NULL
             ) ORDER BY finding_id`,
            [visitId, visitId, visitId],
        );
        const findingIds = findingIdRows.map((r) => num(r.finding_id));
        const findingById = new Map<number, FindingState>();
        if (findingIds.length > 0) {
            const placeholders = findingIds.map(() => "?").join(", ");
            const findingRows = await this.db.query(
                `SELECT finding_id, origin_visit_id, subject_id, description, defect_type,
                        defect_type_other, location, urgency, impact, status, status_changed_at,
                        created_at, created_by
                   FROM finding
                  WHERE finding_id IN (${placeholders})
                  ORDER BY finding_id ASC`,
                findingIds as readonly SqlValue[],
            );
            for (const r of findingRows) {
                const findingId = num(r.finding_id);
                findingById.set(findingId, {
                    findingId,
                    originVisitId: num(r.origin_visit_id),
                    subjectId: r.subject_id === null ? null : num(r.subject_id),
                    description: String(r.description),
                    defectType: textOrNull(r.defect_type),
                    defectTypeOther: textOrNull(r.defect_type_other),
                    location: textOrNull(r.location),
                    urgency: String(r.urgency),
                    impact: String(r.impact),
                    status: String(r.status) as FindingStatus,
                    statusChangedAt: textOrNull(r.status_changed_at),
                    createdAt: String(r.created_at),
                    createdBy: String(r.created_by),
                    sourceResponseIds: [],
                    sourceObservationIds: [],
                });
            }
        }

        // 9) corrective actions under the reconstructed Findings (action_id order)
        let actions: CorrectiveActionState[] = [];
        if (findingIds.length > 0) {
            const placeholders = findingIds.map(() => "?").join(", ");
            const actionRows = await this.db.query(
                `SELECT action_id, finding_id, action_type, action_type_other, description,
                        responsible_role, responsible_role_other, responsible_name, due_date,
                        status, closed_at, verified_by, verification_note, created_at, created_by
                   FROM corrective_action
                  WHERE finding_id IN (${placeholders})
                  ORDER BY action_id ASC`,
                findingIds as readonly SqlValue[],
            );
            actions = actionRows.map((r) => ({
                actionId: num(r.action_id),
                findingId: num(r.finding_id),
                actionType: String(r.action_type),
                actionTypeOther: textOrNull(r.action_type_other),
                description: String(r.description),
                responsibleRole: String(r.responsible_role),
                responsibleRoleOther: textOrNull(r.responsible_role_other),
                responsibleName: textOrNull(r.responsible_name),
                dueDate: textOrNull(r.due_date),
                status: String(r.status),
                closedAt: textOrNull(r.closed_at),
                verifiedBy: textOrNull(r.verified_by),
                verificationNote: textOrNull(r.verification_note),
                createdAt: String(r.created_at),
                createdBy: String(r.created_by),
            }));
        }

        // 10) append-only FollowUp history of the reconstructed Findings
        //     (chronological + id order on the durable text)
        let followUps: FollowUpState[] = [];
        if (findingIds.length > 0) {
            const placeholders = findingIds.map(() => "?").join(", ");
            const fuRows = await this.db.query(
                `SELECT followup_id, finding_id, corrective_action_id, visit_id, status_target,
                        status_after, event_datetime, actor_role, actor_role_other, actor_name,
                        note, recorded_by
                   FROM follow_up
                  WHERE finding_id IN (${placeholders})
                  ORDER BY event_datetime ASC, followup_id ASC`,
                findingIds as readonly SqlValue[],
            );
            followUps = fuRows.map((r) => ({
                followUpId: num(r.followup_id),
                findingId: num(r.finding_id),
                correctiveActionId: r.corrective_action_id === null ? null : num(r.corrective_action_id),
                visitId: r.visit_id === null ? null : num(r.visit_id),
                statusTarget: textOrNull(r.status_target),
                statusAfter: textOrNull(r.status_after),
                eventDatetime: String(r.event_datetime),
                actorRole: String(r.actor_role),
                actorRoleOther: textOrNull(r.actor_role_other),
                actorName: textOrNull(r.actor_name),
                note: String(r.note),
                recordedBy: String(r.recorded_by),
            }));
        }

        // 11) orphan OPEN Findings originated by this Visit with zero
        //     recorded sources across BOTH source tables (the Gate-5K §8
        //     semantics). VOIDED findings are EXPECTED source-less and never
        //     orphans (Gate 4B); IN_TREATMENT/RESOLVED are not flagged.
        const orphanRows = await this.db.query(
            `SELECT f.finding_id
               FROM finding f
              WHERE f.origin_visit_id = ?
                AND f.status = 'OPEN'
                AND NOT EXISTS (SELECT 1 FROM checklist_response cr WHERE cr.finding_id = f.finding_id)
                AND NOT EXISTS (SELECT 1 FROM adhoc_observation o WHERE o.finding_id = f.finding_id)
              ORDER BY f.finding_id`,
            [visitId],
        );
        const orphanFindingIds = orphanRows.map((r) => num(r.finding_id));

        // 12) integrity blockers — collected in the deterministic order
        //     documented in the header (grid exact-set first, then referenced
        //     rows, then the blank-reason condition, then orphan findings).
        const blockers = this.collectBlockers(
            visitId,
            universeDefs,
            contextKeys,
            subjectKeys,
            subjectById,
            rawCells,
            findingIds,
            findingById,
            orphanFindingIds,
            contextualOutcomes,
        );
        if (blockers.length > 0) {
            throw new StateBlocked(blockers);
        }

        // 13) assembly (reachable only when the durable state is healthy)
        const capturedUniverse: CapturedDefinition[] = universeDefs.map((d) => ({
            itemDefinitionId: d.itemDefinitionId,
            itemCode: d.itemCode,
            versionNo: d.versionNo,
            domainId: d.domainId,
            arabicQuestion: d.arabicQuestion,
            responseModel: d.responseModel as CapturedDefinition["responseModel"],
            priority: d.priority,
            applicabilityRule: d.applicabilityRule,
            decisionKind: defMeta.get(d.itemDefinitionId)?.decisionKind ?? "AUTO",
            definitionStatus: d.definitionStatus as CapturedDefinition["definitionStatus"],
            allowedValues: allowedByDef.get(d.itemDefinitionId) ?? [],
        }));

        const contexts: VisitContext[] = contextKeys.map((subjectId) => ({
            kind: subjectId === null ? "INSTITUTION" : String(subjectById.get(subjectId)?.subjectType),
            subjectId,
            subject: subjectId === null ? null : subjectById.get(subjectId) ?? null,
        }));

        const cells: CellState[] = rawCells.map((c) => {
            const meta = defMeta.get(c.itemDefinitionId);
            // the contextual pinned outcome computed once per read above —
            // populated for every raw cell with an evaluable pinned rule and
            // subject context (cells without one never reach assembly:
            // referenced-row blockers throw first).
            const contextualOutcome = contextualOutcomes.get(c.responseId)!;
            const classification = classifyCell(
                c.overlayState,
                c.notInspectedReason,
                contextualOutcome === "HUMAN_CONFIRMATION",
            );
            const cell: CellState = {
                responseId: c.responseId,
                visitId: c.visitId,
                itemDefinitionId: c.itemDefinitionId,
                subjectId: c.subjectId,
                overlayState: c.overlayState as CellState["overlayState"],
                answeredValueId: c.answeredValueId,
                note: c.note,
                notInspectedReason: c.notInspectedReason,
                findingId: c.findingId,
                recordedAt: c.recordedAt,
                recordedBy: c.recordedBy,
                itemCode: meta?.itemCode ?? "",
                responseModel: (meta?.responseModel ?? "SINGLE_VALUE") as CellState["responseModel"],
                priority: meta?.priority ?? "",
                decisionKind: meta?.decisionKind ?? "AUTO",
                contextualOutcome,
                answeredValue: c.answeredValue,
                classification,
            };
            if (meta !== undefined && meta.responseModel === "SCHEDULE") {
                cell.reconciliationRows = reconByResponse.get(c.responseId) ?? [];
            }
            return cell;
        });

        const responseSources: ResponseSourceLink[] = cells
            .filter((c) => c.findingId !== null)
            .sort((a, b) => a.responseId - b.responseId)
            .map((c) => ({ responseId: c.responseId, findingId: c.findingId as number }));
        const observationSources: ObservationSourceLink[] = observations
            .filter((o) => o.findingId !== null)
            .map((o) => ({ observationId: o.observationId, findingId: o.findingId as number }));
        for (const link of responseSources) {
            findingById.get(link.findingId)?.sourceResponseIds.push(link.responseId);
        }
        for (const link of observationSources) {
            findingById.get(link.findingId)?.sourceObservationIds.push(link.observationId);
        }

        const activeFindings: FindingState[] = [];
        const voidedFindings: FindingState[] = [];
        for (const f of findingById.values()) {
            if (f.status === "VOIDED") voidedFindings.push(f);
            else activeFindings.push(f);
        }

        const pendingResponseIds: number[] = [];
        const unresolvedHumanResponseIds: number[] = [];
        const deliberateUninspectedResponseIds: number[] = [];
        const answeredResponseIds: number[] = [];
        const naResponseIds: number[] = [];
        for (const c of cells) {
            switch (c.classification) {
                case "PENDING":
                case "UNRESOLVED_HUMAN":
                    pendingResponseIds.push(c.responseId);
                    if (c.classification === "UNRESOLVED_HUMAN") unresolvedHumanResponseIds.push(c.responseId);
                    break;
                case "NOT_INSPECTED":
                case "HUMAN_APPLICABLE_NOT_INSPECTED":
                    deliberateUninspectedResponseIds.push(c.responseId);
                    break;
                case "ANSWERED":
                case "HUMAN_APPLICABLE_ANSWERED":
                    answeredResponseIds.push(c.responseId);
                    break;
                case "NA":
                case "HUMAN_NOT_APPLICABLE":
                    naResponseIds.push(c.responseId);
                    break;
                // NOT_INSPECTED_BLANK_REASON never reaches assembly (it is
                // always accompanied by a thrown integrity blocker)
            }
        }
        const sortIds = (a: number, b: number) => a - b;
        pendingResponseIds.sort(sortIds);
        unresolvedHumanResponseIds.sort(sortIds);
        deliberateUninspectedResponseIds.sort(sortIds);
        answeredResponseIds.sort(sortIds);
        naResponseIds.sort(sortIds);

        const summary: RestartSummary = {
            capturedDefinitionCount: capturedUniverse.length,
            contextCount: contexts.length,
            expectedCellCount: capturedUniverse.length * contexts.length,
            actualCellCount: cells.length,
            pendingCount: pendingResponseIds.length,
            unresolvedHumanCount: unresolvedHumanResponseIds.length,
            deliberateUninspectedCount: deliberateUninspectedResponseIds.length,
            answeredCount: answeredResponseIds.length,
            naCount: naResponseIds.length,
            observationCount: observations.length,
            activeFindingCount: activeFindings.length,
            voidedFindingCount: voidedFindings.length,
            correctiveActionCount: actions.length,
            followUpCount: followUps.length,
        };

        return {
            visit,
            mission,
            institution,
            capturedUniverse,
            contexts,
            cells,
            classifications: {
                pendingResponseIds,
                unresolvedHumanResponseIds,
                deliberateUninspectedResponseIds,
                answeredResponseIds,
                naResponseIds,
            },
            observations,
            activeFindings,
            voidedFindings,
            responseSources,
            observationSources,
            correctiveActions: actions,
            followUps,
            summary,
        };
    }

    // -- integrity blockers (SELECT-derived only; never a write) --------------

    private collectBlockers(
        visitId: number,
        universeDefs: RawUniverseRow[],
        contextKeys: readonly (number | null)[],
        subjectKeys: readonly number[],
        subjectById: Map<number, CapturedSubject>,
        rawCells: RawCellRow[],
        findingIds: readonly number[],
        findingById: Map<number, FindingState>,
        orphanFindingIds: readonly number[],
        contextualOutcomes: ReadonlyMap<number, "NOT_APPLICABLE" | "APPLICABLE" | "HUMAN_CONFIRMATION">,
    ): FinalizationBlocker[] {
        const blockers: FinalizationBlocker[] = [];

        const block = (
            code: AppErrorCode,
            kind: string,
            extra: Partial<FinalizationBlocker> = {},
        ): void => {
            blockers.push({ code, kind, visitId, ...extra });
        };

        // (1) grid self-check — the Gate-5C/Gate-5K exact-set semantics.
        //     An empty captured universe makes the intended durable scope
        //     unrecoverable (only reachable through out-of-band tampering).
        if (universeDefs.length === 0) {
            block(APP_ERR.SCOPE_GAP, "empty-captured-universe");
        } else {
            const universeIdSet = new Set(universeDefs.map((d) => d.itemDefinitionId));
            const contextSet = new Set(contextKeys.map((s) => (s === null ? 0 : s)));

            // missing expected cells (deterministic: context null-first/
            // ascending, then item_code order)
            const actualKey = new Set(rawCells.map((c) => `${c.itemDefinitionId}|${c.subjectId === null ? 0 : c.subjectId}`));
            for (const subjectId of contextKeys) {
                const ctxKey = subjectId === null ? 0 : subjectId;
                for (const def of universeDefs) {
                    if (!actualKey.has(`${def.itemDefinitionId}|${ctxKey}`)) {
                        block(APP_ERR.SCOPE_GAP, "missing-cell", {
                            itemDefinitionId: def.itemDefinitionId,
                            subjectId,
                            itemCode: def.itemCode === "" ? null : def.itemCode,
                        });
                    }
                }
            }

            // extra / mismatched actual cells (deterministic: response_id
            // order) — a cell pinned to a definition outside the captured
            // universe (a foreign/P1 definition or a different version) or in
            // a non-captured context makes actual != expected.
            const byResponseId = [...rawCells].sort((a, b) => a.responseId - b.responseId);
            for (const c of byResponseId) {
                const ctx = c.subjectId === null ? 0 : c.subjectId;
                if (!universeIdSet.has(c.itemDefinitionId) || !contextSet.has(ctx)) {
                    block(APP_ERR.SCOPE_GAP, "extra-cell", {
                        responseId: c.responseId,
                        itemDefinitionId: c.itemDefinitionId,
                        subjectId: c.subjectId,
                        itemCode: c.itemCode,
                    });
                }
            }
        }

        // duplicate logical cells — the exact-set comparison above dedupes
        // (item_definition_id, context) through a Set, so a multiplicity of
        // actual rows for ONE logical cell would otherwise be hidden. The
        // UNIQUE index uq_response_ctx makes this unrepresentable at rest;
        // this is ONLY a defensive reconstruction check for corrupt/fabricated
        // reads. One blocker per duplicated row of a logical cell, in
        // response_id order; never repaired.
        {
            const logical = new Map<string, RawCellRow[]>();
            for (const c of [...rawCells].sort((a, b) => a.responseId - b.responseId)) {
                const key = `${c.itemDefinitionId}|${c.subjectId === null ? 0 : c.subjectId}`;
                const rows = logical.get(key) ?? [];
                rows.push(c);
                logical.set(key, rows);
            }
            for (const rows of logical.values()) {
                if (rows.length < 2) continue;
                for (const c of rows) {
                    block(APP_ERR.SCOPE_GAP, "duplicate-cell", {
                        responseId: c.responseId,
                        itemDefinitionId: c.itemDefinitionId,
                        subjectId: c.subjectId,
                        itemCode: c.itemCode,
                    });
                }
            }
        }

        // applicability-state-mismatch — the durable disposition must be
        // consistent with the cell's CONTEXTUAL pinned outcome (pinned rule +
        // durable visit_type + durable context kind):
        //   NOT_APPLICABLE   => disposition MUST be NA (answered / pending /
        //                       deliberate NOT_INSPECTED contradict the rule);
        //   APPLICABLE       => pending / answered / deliberate NOT_INSPECTED
        //                       are valid; NA contradicts;
        //   HUMAN_CONFIRMATION => all adopted dispositions are valid (incl.
        //                       NA — the explicit human decision/reversal).
        // A contradictory combination cannot arise from adopted operations
        // and is never silently reconstructed (no auto-repair). Cells with no
        // evaluable outcome are skipped: the referenced-row blockers above
        // own that corruption.
        for (const c of [...rawCells].sort((a, b) => a.responseId - b.responseId)) {
            const outcome = contextualOutcomes.get(c.responseId);
            if (outcome === undefined) continue;
            const inconsistent =
                (outcome === "NOT_APPLICABLE" && c.overlayState !== "NA") ||
                (outcome === "APPLICABLE" && c.overlayState === "NA");
            if (inconsistent) {
                block(APP_ERR.SCOPE_GAP, "applicability-state-mismatch", {
                    responseId: c.responseId,
                    itemDefinitionId: c.itemDefinitionId,
                    subjectId: c.subjectId,
                    itemCode: c.itemCode,
                });
            }
        }

        // (6) missing referenced definition rows (fabricated reads only at
        //     rest: FK + no-delete trigger)
        for (const c of [...rawCells].sort((a, b) => a.responseId - b.responseId)) {
            if (c.defId === null) {
                block(APP_ERR.SCOPE_GAP, "missing-referenced-definition", {
                    responseId: c.responseId,
                    itemDefinitionId: c.itemDefinitionId,
                    subjectId: c.subjectId,
                });
            }
        }

        // (7) missing referenced subject rows
        for (const subjectId of [...subjectKeys].sort((a, b) => a - b)) {
            if (!subjectById.has(subjectId)) {
                block(APP_ERR.SCOPE_GAP, "missing-referenced-subject", { subjectId });
            }
        }

        // (8) missing referenced answered-value rows
        for (const c of [...rawCells].sort((a, b) => a.responseId - b.responseId)) {
            if (c.answeredValueId !== null && c.answeredValue === null) {
                block(APP_ERR.SCOPE_GAP, "missing-answered-value", {
                    responseId: c.responseId,
                    itemDefinitionId: c.itemDefinitionId,
                    subjectId: c.subjectId,
                    itemCode: c.itemCode,
                });
            }
        }

        // (9) missing referenced finding rows (a durable source link points
        //     at a gone Finding — fabricated only at rest)
        for (const findingId of findingIds) {
            if (!findingById.has(findingId)) {
                block(APP_ERR.SCOPE_GAP, "missing-referenced-finding", { findingId });
            }
        }

        // (10) deliberate NOT_INSPECTED with a PRESENT-but-BLANK reason
        //     matches no adopted classification predicate (§3.3 requires a
        //     meaningful reason) — the exact durable condition Gate-5K
        //     blocks on; surfaced, never auto-filled.
        for (const c of [...rawCells].sort((a, b) => a.responseId - b.responseId)) {
            if (
                c.overlayState === "NOT_INSPECTED" &&
                c.answeredValueId === null &&
                c.notInspectedReason !== null &&
                normalizeText(c.notInspectedReason) === null
            ) {
                block(APP_ERR.UNINSPECTED_NEEDS_REASON, "blank-not-inspected-reason", {
                    responseId: c.responseId,
                    itemDefinitionId: c.itemDefinitionId,
                    subjectId: c.subjectId,
                    itemCode: c.itemCode,
                });
            }
        }

        // (11) orphan OPEN Findings originated by this Visit with zero
        //     recorded sources across BOTH source tables. VOIDED findings
        //     are EXPECTED source-less and never orphans (Gate 4B);
        //     IN_TREATMENT/RESOLVED are not flagged (Gate-5K agreement).
        for (const findingId of orphanFindingIds) {
            block(APP_ERR.ORPHAN_FINDING, "orphan-finding", { findingId });
        }

        return blockers;
    }
}

// ---------------------------------------------------------------------------
// pure classification — durable physical cell state + the cell's CONTEXTUAL
// PINNED applicability outcome (`contextualHuman`, produced by the adopted
// evaluator from the exact pinned applicability_rule, the durable
// Visit.visit_type and the durable context kind); the definition's root
// decision_kind alone never drives classification
// ---------------------------------------------------------------------------

function classifyCell(
    overlayState: string | null,
    notInspectedReason: string | null,
    contextualHuman: boolean,
): CellClassification {
    // `contextualHuman` is TRUE only when the cell's CONTEXTUAL pinned
    // applicability outcome is HUMAN_CONFIRMATION (never the definition's
    // root decision_kind alone).
    if (overlayState === "NA") {
        return contextualHuman ? "HUMAN_NOT_APPLICABLE" : "NA";
    }
    if (overlayState === "NOT_INSPECTED") {
        if (notInspectedReason === null) {
            return contextualHuman ? "UNRESOLVED_HUMAN" : "PENDING";
        }
        if (normalizeText(notInspectedReason) === null) {
            return "NOT_INSPECTED_BLANK_REASON";
        }
        return contextualHuman ? "HUMAN_APPLICABLE_NOT_INSPECTED" : "NOT_INSPECTED";
    }
    // overlay NULL => answered (schema CHECK: overlay NULL iff answered set)
    return contextualHuman ? "HUMAN_APPLICABLE_ANSWERED" : "ANSWERED";
}

/** deterministic, machine-readable blocker summary (no Arabic display prose). */
function blockedMessage(blockers: readonly FinalizationBlocker[]): string {
    const visitId = blockers[0].visitId;
    const parts = blockers.map((b) => {
        const ids = [
            b.responseId !== undefined && b.responseId !== null ? `response=${b.responseId}` : "",
            b.itemDefinitionId !== undefined && b.itemDefinitionId !== null ? `definition=${b.itemDefinitionId}` : "",
            b.subjectId !== undefined && b.subjectId !== null ? `subject=${b.subjectId}` : "",
            b.itemCode !== undefined && b.itemCode !== null ? `item=${b.itemCode}` : "",
            b.findingId !== undefined && b.findingId !== null ? `finding=${b.findingId}` : "",
        ]
            .filter((s) => s.length > 0)
            .join(" ");
        return `${b.code}:${b.kind}${ids.length > 0 ? `(${ids})` : ""}`;
    });
    return (
        `currentVisitState: visit ${visitId} reconstruction is blocked by ${blockers.length} integrity issue(s): ` +
        parts.join("; ")
    );
}
