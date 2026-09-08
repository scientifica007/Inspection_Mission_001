// Gate 5D — initial response disposition (runtime-neutral TypeScript, no
// node:* imports).
//
// Implements the initial-disposition domain operations of the Gate-5A catalog
// over an EXISTING materialized checklist_response cell (B4 — no answer
// operation ever INSERTs a scope cell):
//   * answerSingle          — T2 (TRANSACTION-CONTRACTS §4): SINGLE_VALUE cell.
//                             COMPLIANT answer | NON_COMPLIANT linked to a NEW
//                             Finding (atomic OPEN → first-source) | NON_COMPLIANT
//                             linked to an EXISTING Finding ("covers same issue").
//   * answerSchedule        — T3/T3A/T3B (§5): SCHEDULE cell, overall value +
//                             the full reconciliation row set submitted
//                             atomically in one transaction.
//   * markNotInspected      — T4 (§6): deliberate «لا يُعاين» on a true-pending
//                             cell (reason mandatory; HUMAN cells need
//                             humanDecision=APPLICABLE in the same call).
//   * resolveHumanApplicability — T5 (§6/APPLICATION-CORE §4.4): the standalone
//                             NOT_APPLICABLE decision, ONLY on an unresolved
//                             HUMAN_CONFIRMATION pending cell (five predicates).
//
// Shared contract (GATE 5D §A, B, C, D):
//   * TRUE-PENDING means overlay_state='NOT_INSPECTED' AND answered_value_id IS
//     NULL AND not_inspected_reason IS NULL AND finding_id IS NULL. Missing row
//     => E_CELL_NOT_MATERIALIZED; existing-but-not-true-pending =>
//     E_ALREADY_DISPOSITIONED *unless* the durable state equals the already
//     applied identical target (Class-A retry convergence, TRANSACTION §12 /
//     RECOVERY §5), which returns idempotent success without writes.
//   * every answer value must belong to the response cell's PINNED
//     item_definition_id; allowed values are resolved through value_code /
//     semantic_class of the pinned definition — item_code is never switched on
//     and Arabic labels are never interpreted.
//   * note rule (APPLICATION-CORE §7): answered semantic_class=NON_COMPLIANT
//     requires a meaningful (trimmed) note; COMPLIANT never requires one.
//   * a pinned HUMAN_CONFIRMATION rule requires explicit
//     humanDecision="APPLICABLE" on the answer / mark path; no durable
//     standalone APPLICABLE state exists.
//
// Transaction rules (TRANSACTION §1/§13, RECOVERY §2/§5): every write unit is
// one explicit BEGIN IMMEDIATE … COMMIT/ROLLBACK; each guarded write expected
// to change one row passes the B5 affected-row cardinality check; a zero-row
// guarded UPDATE (after a tentative Finding INSERT) rolls the whole unit back
// — the tentative Finding disappears — then the durable cell state is
// re-read and the call converges only when it matches the adopted retry
// contract. No orphan OPEN Finding is ever committed.

import type { SqlAdapter, SqlResult, SqlValue } from "../bootstrap/adapter.ts";
import { APP_ERR, DomainError } from "./errors.ts";
import { parseApplicabilityRule } from "./applicability.ts";

// ---------------------------------------------------------------------------
// public types
// ---------------------------------------------------------------------------

/** Logical address of one scope cell (its durable unique key). */
export interface ResponseCellRef {
    visitId: number;
    /** the response's PINNED item_definition_id — never a current-ACTIVE discovery */
    itemDefinitionId: number;
    /** NULL = the institution context; otherwise the inspected_subject id */
    subjectId: number | null;
}

export const FINDING_DEFECT_TYPES = [
    "ELECTRICAL_FAULT",
    "WATER_LEAK",
    "STRUCTURE_DETERIORATION",
    "SUPPLY_CUT",
    "EQUIPMENT_FAULT",
    "SHORTAGE",
    "OTHER",
] as const;
export type FindingDefectType = (typeof FINDING_DEFECT_TYPES)[number];

export const FINDING_URGENCIES = ["IMMEDIATE", "BEFORE_ENTRY", "ROUTINE"] as const;
export type FindingUrgency = (typeof FINDING_URGENCIES)[number];

export const FINDING_IMPACTS = ["HIGH", "MEDIUM", "LOW"] as const;
export type FindingImpact = (typeof FINDING_IMPACTS)[number];

/** Explicit NEW-Finding data for the NON_COMPLIANT branches. Nothing is defaulted. */
export interface NewFindingInput {
    /** meaningful description of the defect (required, trimmed) */
    description: string;
    defectType?: FindingDefectType | null;
    /** required non-blank when defectType === "OTHER" */
    defectTypeOther?: string | null;
    location?: string | null;
    urgency: FindingUrgency;
    impact: FindingImpact;
}

export const RECON_DISCREPANCY_TYPES = [
    "QTY_SHORTAGE",
    "QTY_EXCESS",
    "NEW_UNLISTED",
    "CONSUMED_OR_DAMAGED_NOT_REMOVED",
    "OTHER",
] as const;
export type ReconDiscrepancyType = (typeof RECON_DISCREPANCY_TYPES)[number];

/** One composed equipment-reconciliation row (schema: equipment_reconciliation_row). */
export interface ReconciliationRowInput {
    /** meaningful trimmed category text */
    category: string;
    declaredQty: number;
    observedQty: number;
    discrepancyType?: ReconDiscrepancyType | null;
    /** required non-blank when discrepancyType === "OTHER" */
    discrepancyDesc?: string | null;
}

/** How the NON_COMPLIANT answer is made accountable to a Finding. */
export type FindingSelection =
    | { mode: "none" }
    | { mode: "new"; finding: NewFindingInput }
    | { mode: "existing"; findingId: number; coversSameIssueConfirmed: true };

export interface AnswerSingleInput {
    cell: ResponseCellRef;
    /** an allowed value of the pinned definition (resolved by semantic_class) */
    allowedValueId: number;
    note?: string | null;
    humanDecision?: "APPLICABLE";
    /** required for NON_COMPLIANT values (new or existing Finding) */
    finding?: FindingSelection;
    /** app-supplied; used ONLY for a NEW Finding row (never response audit) */
    actor?: string;
    /** ISO-8601 UTC instant; used ONLY for a NEW Finding row */
    now?: string;
}

export interface AnswerScheduleInput {
    cell: ResponseCellRef;
    /** the SCHEDULE overall value of the pinned definition */
    allowedValueId: number;
    note?: string | null;
    /** the complete reconciliation row set, composed in memory, submitted atomically */
    rows?: readonly ReconciliationRowInput[];
    humanDecision?: "APPLICABLE";
    finding?: FindingSelection;
    actor?: string;
    now?: string;
}

export interface MarkNotInspectedInput {
    cell: ResponseCellRef;
    /** meaningful (trimmed non-blank) deliberate-«لا يُعاين» reason */
    reason: string;
    humanDecision?: "APPLICABLE";
}

export interface InitialDispositionResult {
    responseId: number;
    /** false when this call converged on the already-applied identical durable state */
    applied: boolean;
    overlayState: "NA" | "NOT_INSPECTED" | null;
    answeredValueId: number | null;
    note: string | null;
    notInspectedReason: string | null;
    findingId: number | null;
    /** reconciliation rows persisted by this call (0 on a converged retry) */
    reconciliationRowCount: number;
}

// ---------------------------------------------------------------------------
// internal model
// ---------------------------------------------------------------------------

interface CellSnapshot {
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
    visitStatus: string;
    visitFinalizedAt: string | null;
    visitInstitutionId: number;
    visitType: string;
    itemCode: string;
    responseModel: string;
    applicabilityRule: string;
}

interface AllowedValueSnapshot {
    allowedValueId: number;
    valueCode: string;
    semanticClass: "COMPLIANT" | "NON_COMPLIANT";
}

interface FindingTargetSnapshot {
    findingId: number;
    status: string;
    originVisitId: number;
    originInstitutionId: number;
    subjectId: number | null;
    hasResponseSource: boolean;
    hasObservationSource: boolean;
}

/** durable-link expectation of the requested answer target */
type LinkExpectation =
    | { kind: "none" }
    | { kind: "new"; draft: NewFindingDraft; createdBy: string; createdAt: string }
    | { kind: "existing"; findingId: number };

/** validated NEW-Finding data (nothing defaulted; all fields normalized). */
interface NewFindingDraft {
    description: string;
    defectType: FindingDefectType | null;
    defectTypeOther: string | null;
    location: string | null;
    urgency: FindingUrgency;
    impact: FindingImpact;
}

/** thrown inside a write unit to force ROLLBACK + durable-state re-read (B5) */
class ZeroRowGuard extends Error {
    constructor() {
        super("guarded UPDATE affected zero rows (B5)");
        this.name = "ZeroRowGuard";
    }
}

// ---------------------------------------------------------------------------
// normalization helpers (Arabic never parsed; only text meaning is checked)
// ---------------------------------------------------------------------------

/** trim; blank/missing => null. Used for note / reason / OTHER companions. */
function normalizeText(v: string | null | undefined): string | null {
    if (v === null || v === undefined) return null;
    const t = v.trim();
    return t.length === 0 ? null : t;
}

function isTruePending(s: CellSnapshot): boolean {
    return (
        s.overlayState === "NOT_INSPECTED" &&
        s.answeredValueId === null &&
        s.notInspectedReason === null &&
        s.findingId === null
    );
}

function config(what: string): DomainError {
    return new DomainError(APP_ERR.CONFIG, `initial disposition: ${what}`);
}

function alreadyDispositioned(op: string, s: CellSnapshot, why: string): DomainError {
    const durable = s.overlayState !== null
        ? `overlay_state='${s.overlayState}'`
        : s.answeredValueId !== null
          ? `answered_value_id=${s.answeredValueId}`
          : "not_inspected_reason set";
    return new DomainError(
        APP_ERR.ALREADY_DISPOSITIONED,
        `${op}: response ${s.responseId} (${s.itemCode}) is already dispositioned (${durable}); ` +
            `an initial disposition requires the true-pending state — ${why}. ` +
            "Changing an already dispositioned cell belongs to the T6 correction contract.",
    );
}

// ---------------------------------------------------------------------------
// service
// ---------------------------------------------------------------------------

export class InitialDispositionService {
    private readonly db: SqlAdapter;

    constructor(db: SqlAdapter) {
        this.db = db;
    }

    // -- T2 ---------------------------------------------------------------

    async answerSingle(input: AnswerSingleInput): Promise<InitialDispositionResult> {
        const snap = await this.resolveCell(input.cell);
        this.assertVisitPreparation(snap, "answerSingle");
        if (snap.responseModel !== "SINGLE_VALUE") {
            throw config(
                `answerSingle: response ${snap.responseId} (${snap.itemCode}) pins response_model ` +
                    `'${snap.responseModel}'; SINGLE_VALUE required (use answerSchedule for SCHEDULE cells)`,
            );
        }
        const value = await this.resolveValue(snap.itemDefinitionId, input.allowedValueId, "answerSingle");
        this.requireHumanDecisionIfHumanRule(snap, "answerSingle", input.humanDecision);

        const note = normalizeText(input.note);
        let link: LinkExpectation = { kind: "none" };
        if (value.semanticClass === "COMPLIANT") {
            const sel = input.finding ?? { mode: "none" as const };
            if (sel.mode !== "none") {
                throw config(
                    `answerSingle: a COMPLIANT answer of ${snap.itemCode} must never be linked to a Finding ` +
                        "(schema: compliant answers are never finding sources)",
                );
            }
        } else {
            if (note === null) {
                throw config(
                    `answerSingle: NON_COMPLIANT answer of ${snap.itemCode} requires a meaningful (non-blank) note ` +
                        "(APPLICATION-CORE §7 note rule)",
                );
            }
            link = await this.resolveFindingLink(snap, input.finding, input.actor, input.now, "answerSingle");
        }

        // Class-A retry convergence / durable-state gate
        if (await this.durableMatchesAnswer(snap, value.allowedValueId, note, link)) {
            return this.resultFromState(snap, false);
        }
        if (!isTruePending(snap)) {
            throw alreadyDispositioned(
                "answerSingle",
                snap,
                link.kind === "none" ? "an initial answer consumes the true-pending state only" : "an initial NC answer consumes the true-pending state only",
            );
        }

        return this.commitAnswerUnit({
            op: "answerSingle",
            snap,
            valueId: value.allowedValueId,
            note,
            link,
            rows: null,
        });
    }

    // -- T3 ---------------------------------------------------------------

    async answerSchedule(input: AnswerScheduleInput): Promise<InitialDispositionResult> {
        const snap = await this.resolveCell(input.cell);
        this.assertVisitPreparation(snap, "answerSchedule");
        if (snap.responseModel !== "SCHEDULE") {
            throw config(
                `answerSchedule: response ${snap.responseId} (${snap.itemCode}) pins response_model ` +
                    `'${snap.responseModel}'; SCHEDULE required (use answerSingle for SINGLE_VALUE cells)`,
            );
        }
        const value = await this.resolveValue(snap.itemDefinitionId, input.allowedValueId, "answerSchedule");
        this.requireHumanDecisionIfHumanRule(snap, "answerSchedule", input.humanDecision);

        const note = normalizeText(input.note);
        const rows = this.validateReconciliationRows(input.rows ?? [], value.semanticClass, snap);
        let link: LinkExpectation = { kind: "none" };
        if (value.semanticClass === "COMPLIANT") {
            const sel = input.finding ?? { mode: "none" as const };
            if (sel.mode !== "none") {
                throw config(
                    `answerSchedule: a COMPLIANT overall result of ${snap.itemCode} must never be linked to a Finding`,
                );
            }
        } else {
            if (note === null) {
                throw config(
                    `answerSchedule: NON_COMPLIANT overall result of ${snap.itemCode} requires a meaningful ` +
                        "(non-blank) note listing the discrepancies (APPLICATION-CORE §7 note rule)",
                );
            }
            link = await this.resolveFindingLink(snap, input.finding, input.actor, input.now, "answerSchedule");
        }

        if ((await this.durableMatchesScheduleAnswer(snap, value.allowedValueId, note, link, rows))) {
            return this.resultFromState(snap, false);
        }
        if (!isTruePending(snap)) {
            throw alreadyDispositioned("answerSchedule", snap, "an initial schedule answer consumes the true-pending state only");
        }

        return this.commitAnswerUnit({
            op: "answerSchedule",
            snap,
            valueId: value.allowedValueId,
            note,
            link,
            rows,
        });
    }

    // -- T4 ---------------------------------------------------------------

    async markNotInspected(input: MarkNotInspectedInput): Promise<InitialDispositionResult> {
        const snap = await this.resolveCell(input.cell);
        this.assertVisitPreparation(snap, "markNotInspected");
        const reason = normalizeText(input.reason);
        if (reason === null) {
            throw config(
                `markNotInspected: deliberate NOT_INSPECTED requires a meaningful (non-blank) reason`,
            );
        }
        this.requireHumanDecisionIfHumanRule(snap, "markNotInspected", input.humanDecision);

        // identical retry (the deliberate NOT_INSPECTED + same reason is durable)
        if (
            snap.overlayState === "NOT_INSPECTED" &&
            snap.answeredValueId === null &&
            snap.findingId === null &&
            normalizeText(snap.notInspectedReason) === reason
        ) {
            return this.resultFromState(snap, false);
        }
        if (!isTruePending(snap)) {
            throw alreadyDispositioned(
                "markNotInspected",
                snap,
                "a deliberate NOT_INSPECTED reason is an initial disposition only on the true-pending state " +
                    "(replacing a prior answer or a prior reason is T6)",
            );
        }

        return this.runUnit(async () => {
            const res = await this.db.run(
                `UPDATE checklist_response
                    SET overlay_state = 'NOT_INSPECTED', not_inspected_reason = ?, answered_value_id = NULL
                  WHERE response_id = ?
                    AND overlay_state = 'NOT_INSPECTED' AND answered_value_id IS NULL
                    AND not_inspected_reason IS NULL AND finding_id IS NULL
                    AND (SELECT v.status FROM visit v WHERE v.visit_id = checklist_response.visit_id) = 'PREPARATION'
                    AND (SELECT v.finalized_at FROM visit v WHERE v.visit_id = checklist_response.visit_id) IS NULL`,
                [reason, snap.responseId] as readonly SqlValue[],
            );
            if (res.changes !== 1) throw new ZeroRowGuard();
            return {
                responseId: snap.responseId,
                applied: true,
                overlayState: "NOT_INSPECTED",
                answeredValueId: null,
                note: null,
                notInspectedReason: reason,
                findingId: null,
                reconciliationRowCount: 0,
            } satisfies InitialDispositionResult;
        }, () => this.convergeMarkNotInspected(snap, reason));
    }

    // -- T5 ---------------------------------------------------------------

    /**
     * Standalone HUMAN NOT_APPLICABLE resolution. Operates ONLY on the
     * unresolved true-pending HUMAN state and writes overlay_state='NA'.
     * There is no T5 APPLICABLE operation; AUTO cells are never changed here.
     */
    async resolveHumanApplicability(input: { cell: ResponseCellRef }): Promise<InitialDispositionResult> {
        const snap = await this.resolveCell(input.cell);
        this.assertVisitPreparation(snap, "resolveHumanApplicability");
        if (parseApplicabilityRule(snap.applicabilityRule).decisionKind !== "HUMAN_CONFIRMATION") {
            throw config(
                `resolveHumanApplicability: response ${snap.responseId} (${snap.itemCode}) pins a rule whose ` +
                    "decision_kind is not HUMAN_CONFIRMATION; T5 (NOT_APPLICABLE) may only resolve a HUMAN cell",
            );
        }

        // duplicate call on the already-resolved HUMAN NA state converges (Class A)
        if (
            snap.overlayState === "NA" &&
            snap.answeredValueId === null &&
            snap.notInspectedReason === null &&
            snap.findingId === null
        ) {
            return this.resultFromState(snap, false);
        }
        if (!isTruePending(snap)) {
            throw alreadyDispositioned(
                "resolveHumanApplicability",
                snap,
                "T5 may only resolve the unresolved true-pending HUMAN state " +
                    "(reversing an answered/reasoned HUMAN cell is a T6 correction)",
            );
        }

        return this.runUnit(async () => {
            const res = await this.db.run(
                `UPDATE checklist_response
                    SET overlay_state = 'NA', answered_value_id = NULL
                  WHERE response_id = ?
                    AND overlay_state = 'NOT_INSPECTED' AND answered_value_id IS NULL
                    AND not_inspected_reason IS NULL AND finding_id IS NULL
                    AND (SELECT v.status FROM visit v WHERE v.visit_id = checklist_response.visit_id) = 'PREPARATION'
                    AND (SELECT v.finalized_at FROM visit v WHERE v.visit_id = checklist_response.visit_id) IS NULL`,
                [snap.responseId] as readonly SqlValue[],
            );
            if (res.changes !== 1) throw new ZeroRowGuard();
            return {
                responseId: snap.responseId,
                applied: true,
                overlayState: "NA",
                answeredValueId: null,
                note: null,
                notInspectedReason: null,
                findingId: null,
                reconciliationRowCount: 0,
            } satisfies InitialDispositionResult;
        }, () => this.convergeHumanNa(snap));
    }

    // -- shared resolution / validation -----------------------------------

    private async resolveCell(ref: ResponseCellRef): Promise<CellSnapshot> {
        const subjectWhere = ref.subjectId === null ? "cr.subject_id IS NULL" : "cr.subject_id = ?";
        const params: SqlValue[] =
            ref.subjectId === null ? [ref.visitId, ref.itemDefinitionId] : [ref.visitId, ref.itemDefinitionId, ref.subjectId];
        const rows = await this.db.query(
            `SELECT cr.response_id, cr.visit_id, cr.item_definition_id, cr.subject_id,
                    cr.overlay_state, cr.answered_value_id, cr.note, cr.not_inspected_reason, cr.finding_id,
                    cr.recorded_at, cr.recorded_by,
                    v.status AS visit_status, v.finalized_at AS visit_finalized_at,
                    v.institution_id AS visit_institution_id, v.visit_type,
                    d.item_code, d.response_model, d.applicability_rule
               FROM checklist_response cr
               JOIN visit v ON v.visit_id = cr.visit_id
               JOIN checklist_item_definition d ON d.item_definition_id = cr.item_definition_id
              WHERE cr.visit_id = ? AND cr.item_definition_id = ? AND ${subjectWhere}`,
            params,
        );
        if (rows.length === 0) {
            throw new DomainError(
                APP_ERR.CELL_NOT_MATERIALIZED,
                `no materialized checklist_response cell for (visit ${ref.visitId}, item_definition ${ref.itemDefinitionId}, ` +
                    `subject ${ref.subjectId === null ? "NULL" : ref.subjectId}); answer/disposition operations never INSERT a scope cell`,
            );
        }
        const r = rows[0];
        return {
            responseId: Number(r.response_id),
            visitId: Number(r.visit_id),
            itemDefinitionId: Number(r.item_definition_id),
            subjectId: r.subject_id === null ? null : Number(r.subject_id),
            overlayState: r.overlay_state === null ? null : String(r.overlay_state),
            answeredValueId: r.answered_value_id === null ? null : Number(r.answered_value_id),
            note: r.note === null ? null : String(r.note),
            notInspectedReason: r.not_inspected_reason === null ? null : String(r.not_inspected_reason),
            findingId: r.finding_id === null ? null : Number(r.finding_id),
            recordedAt: String(r.recorded_at),
            recordedBy: String(r.recorded_by),
            visitStatus: String(r.visit_status),
            visitFinalizedAt: r.visit_finalized_at === null ? null : String(r.visit_finalized_at),
            visitInstitutionId: Number(r.visit_institution_id),
            visitType: String(r.visit_type),
            itemCode: String(r.item_code),
            responseModel: String(r.response_model),
            applicabilityRule: String(r.applicability_rule),
        };
    }

    private assertVisitPreparation(snap: CellSnapshot, op: string): void {
        if (snap.visitStatus !== "PREPARATION" || snap.visitFinalizedAt !== null) {
            throw new DomainError(
                APP_ERR.VISIT_NOT_PREPARATION,
                `${op}: visit ${snap.visitId} is '${snap.visitStatus}'` +
                    (snap.visitFinalizedAt !== null ? " (finalized)" : "") +
                    "; initial dispositions only apply while the Visit is PREPARATION and not finalized",
            );
        }
    }

    /** allowed value must belong to the EXACT pinned item_definition_id (B). */
    private async resolveValue(
        itemDefinitionId: number,
        allowedValueId: number,
        op: string,
    ): Promise<AllowedValueSnapshot> {
        const rows = await this.db.query(
            `SELECT allowed_value_id, value_code, semantic_class
               FROM checklist_allowed_value
              WHERE allowed_value_id = ? AND item_definition_id = ?`,
            [allowedValueId, itemDefinitionId],
        );
        if (rows.length === 0) {
            throw config(
                `${op}: allowed_value_id ${allowedValueId} does not belong to the pinned item_definition_id ` +
                    `${itemDefinitionId} (every answer value must come from the pinned definition's allowed values)`,
            );
        }
        return {
            allowedValueId: Number(rows[0].allowed_value_id),
            valueCode: String(rows[0].value_code),
            semanticClass: String(rows[0].semantic_class) as "COMPLIANT" | "NON_COMPLIANT",
        };
    }

    /** HUMAN_CONFIRMATION cells need explicit humanDecision=APPLICABLE in the same call. */
    private requireHumanDecisionIfHumanRule(
        snap: CellSnapshot,
        op: string,
        humanDecision: "APPLICABLE" | undefined,
    ): void {
        if (parseApplicabilityRule(snap.applicabilityRule).decisionKind === "HUMAN_CONFIRMATION" && humanDecision !== "APPLICABLE") {
            throw new DomainError(
                APP_ERR.HUMAN_NEEDS_DECISION,
                `${op}: response ${snap.responseId} (${snap.itemCode}) pins a HUMAN_CONFIRMATION rule; ` +
                    "explicit humanDecision='APPLICABLE' is required in the same operation " +
                    "(there is no durable standalone APPLICABLE state)",
            );
        }
    }

    /** NON_COMPLIANT branch: resolve + validate the NEW / EXISTING Finding selection. */
    private async resolveFindingLink(
        snap: CellSnapshot,
        selection: FindingSelection | undefined,
        actor: string | undefined,
        now: string | undefined,
        op: string,
    ): Promise<LinkExpectation> {
        const sel = selection ?? { mode: "none" as const };
        if (sel.mode === "none") {
            throw config(
                `${op}: NON_COMPLIANT answer of ${snap.itemCode} requires Finding accountability — ` +
                    "supply finding.mode='new' or finding.mode='existing' (schema: NC answers are always linked)",
            );
        }
        if (sel.mode === "new") {
            const draft = this.validateNewFinding(sel.finding, op);
            if (typeof actor !== "string" || actor.trim().length === 0 || typeof now !== "string" || now.trim().length === 0) {
                throw config(`${op}: a NEW Finding requires op-level actor and now (app-supplied creation audit)`);
            }
            return { kind: "new", draft, createdBy: actor, createdAt: now };
        }
        // existing — pure request-shape validation only (the covers-same-issue
        // confirmation is the inspector's explicit decision). The mutable
        // admissibility read of the target Finding (exists / status /
        // institution / subject context / first-source-origin) must happen
        // INSIDE the write transaction so no TOCTOU window exists between
        // validation and the guarded link (Gate-5D review correction B).
        if (sel.coversSameIssueConfirmed !== true) {
            throw new DomainError(
                APP_ERR.FINDING_TARGET_INVALID,
                `${op}: linking NON_COMPLIANT ${snap.itemCode} to an existing Finding requires the inspector's ` +
                    "explicit covers-same-issue confirmation (never an automatic semantic inference)",
            );
        }
        return { kind: "existing", findingId: sel.findingId };
    }

    /** NEW Finding fields are explicit; nothing is invented or defaulted. */
    private validateNewFinding(f: NewFindingInput, op: string): NewFindingDraft {
        const description = normalizeText(f.description);
        if (description === null) {
            throw config(`${op}: a NEW Finding requires a meaningful description`);
        }
        if (!(FINDING_URGENCIES as readonly string[]).includes(f.urgency)) {
            throw config(`${op}: finding urgency must be one of ${FINDING_URGENCIES.join(" | ")}`);
        }
        if (!(FINDING_IMPACTS as readonly string[]).includes(f.impact)) {
            throw config(`${op}: finding impact must be one of ${FINDING_IMPACTS.join(" | ")}`);
        }
        let defectType: FindingDefectType | null = null;
        if (f.defectType !== undefined && f.defectType !== null) {
            if (!(FINDING_DEFECT_TYPES as readonly string[]).includes(f.defectType)) {
                throw config(`${op}: finding defect_type must be one of ${FINDING_DEFECT_TYPES.join(" | ")}`);
            }
            defectType = f.defectType;
        }
        const defectTypeOther = normalizeText(f.defectTypeOther);
        if (defectType === "OTHER" && defectTypeOther === null) {
            throw config(`${op}: defect_type=OTHER requires a meaningful defect_type_other`);
        }
        return {
            description,
            defectType,
            defectTypeOther,
            location: normalizeText(f.location ?? null),
            urgency: f.urgency,
            impact: f.impact,
        };
    }

    /**
     * Minimal existing-Finding target admissibility read (Gate-5A §4.7 +
     * T2(c)/T3B): the target must exist, belong to the same institution, be in
     * a selectable status (OPEN | IN_TREATMENT), SHARE the subject context
     * when the response has one (review correction A), and respect
     * source/origin integrity. VOIDED/RESOLVED and cross-institution /
     * cross-subject targets are refused.
     *
     * Called ONLY from inside the write transaction for a new link
     * (review correction B) — never from the pre-transaction request phase —
     * so no writer can change the target between this read and the link.
     */
    private async validateExistingFinding(snap: CellSnapshot, findingId: number, op: string): Promise<FindingTargetSnapshot> {
        const rows = await this.db.query(
            `SELECT f.finding_id, f.status, f.origin_visit_id, f.subject_id,
                    (SELECT v.institution_id FROM visit v WHERE v.visit_id = f.origin_visit_id) AS origin_institution_id,
                    EXISTS (SELECT 1 FROM checklist_response cr WHERE cr.finding_id = f.finding_id) AS has_response_source,
                    EXISTS (SELECT 1 FROM adhoc_observation o WHERE o.finding_id = f.finding_id) AS has_obs_source
               FROM finding f
              WHERE f.finding_id = ?`,
            [findingId],
        );
        if (rows.length === 0) {
            throw new DomainError(APP_ERR.FINDING_NOT_FOUND, `${op}: finding ${findingId} does not exist`);
        }
        const t: FindingTargetSnapshot = {
            findingId: Number(rows[0].finding_id),
            status: String(rows[0].status),
            originVisitId: Number(rows[0].origin_visit_id),
            originInstitutionId: Number(rows[0].origin_institution_id),
            subjectId: rows[0].subject_id === null ? null : Number(rows[0].subject_id),
            hasResponseSource: Boolean(rows[0].has_response_source),
            hasObservationSource: Boolean(rows[0].has_obs_source),
        };
        if (t.originInstitutionId !== snap.visitInstitutionId) {
            throw new DomainError(
                APP_ERR.CONTEXT,
                `${op}: finding ${findingId} belongs to institution ${t.originInstitutionId} but response ` +
                    `${snap.responseId} is in visit ${snap.visitId} of institution ${snap.visitInstitutionId} (E_CONTEXT)`,
            );
        }
        // subject-context sharing (APPLICATION-CORE §4.7): when the response
        // belongs to a subject context, the existing Finding must be recorded
        // for that SAME subject. An institution-context response (subject NULL)
        // carries no additional subject-match restriction.
        if (snap.subjectId !== null && t.subjectId !== snap.subjectId) {
            const findingSubject =
                t.subjectId === null
                    ? "the institution context (subject_id NULL)"
                    : `subject ${t.subjectId}`;
            throw new DomainError(
                APP_ERR.CONTEXT,
                `${op}: finding ${findingId} is recorded for ${findingSubject} but response ${snap.responseId} ` +
                    `is for subject ${snap.subjectId}; an existing Finding must share the response's subject context (E_CONTEXT)`,
            );
        }
        if (t.status !== "OPEN" && t.status !== "IN_TREATMENT") {
            throw new DomainError(
                APP_ERR.FINDING_TARGET_INVALID,
                `${op}: finding ${findingId} has status '${t.status}'; only OPEN (or IN_TREATMENT at the ` +
                    "inspector's explicit choice) findings are selectable targets — VOIDED/RESOLVED never regain a source",
            );
        }
        // first-source integrity: a finding with no recorded source may only be
        // linked from its origin_visit_id (mirrors trg_response_finding_bu)
        if (!t.hasResponseSource && !t.hasObservationSource && t.originVisitId !== snap.visitId) {
            throw new DomainError(
                APP_ERR.FINDING_TARGET_INVALID,
                `${op}: finding ${findingId} has no recorded source yet; its first source must belong to its ` +
                    `origin visit ${t.originVisitId} (linking from visit ${snap.visitId} would violate first-source integrity)`,
            );
        }
        return t;
    }

    // -- reconciliation row validation / durability ------------------------

    private validateReconciliationRows(
        input: readonly ReconciliationRowInput[],
        overall: "COMPLIANT" | "NON_COMPLIANT",
        snap: CellSnapshot,
    ): ReconRow[] {
        const rows: ReconRow[] = [];
        for (const [i, r] of input.entries()) {
            const category = normalizeText(r.category);
            if (category === null) throw config(`answerSchedule: reconciliation row ${i + 1} requires a meaningful category`);
            if (!Number.isInteger(r.declaredQty) || r.declaredQty < 0) {
                throw config(`answerSchedule: row ${i + 1} declared_qty must be a non-negative integer`);
            }
            if (!Number.isInteger(r.observedQty) || r.observedQty < 0) {
                throw config(`answerSchedule: row ${i + 1} observed_qty must be a non-negative integer`);
            }
            const difference = r.observedQty - r.declaredQty;
            let type: ReconDiscrepancyType | null = null;
            if (r.discrepancyType !== undefined && r.discrepancyType !== null) {
                if (!(RECON_DISCREPANCY_TYPES as readonly string[]).includes(r.discrepancyType)) {
                    throw config(`answerSchedule: row ${i + 1} discrepancy_type must be one of ${RECON_DISCREPANCY_TYPES.join(" | ")}`);
                }
                type = r.discrepancyType;
            }
            const desc = normalizeText(r.discrepancyDesc);
            if (type === "OTHER" && desc === null) {
                throw config(`answerSchedule: row ${i + 1} discrepancy_type=OTHER requires a meaningful discrepancy_desc`);
            }
            if (overall === "COMPLIANT" && (difference !== 0 || type !== null)) {
                throw config(
                    `answerSchedule: overall COMPLIANT result of ${snap.itemCode} may not carry a discrepancy row ` +
                        `(row ${i + 1}: difference ${difference}, type ${type ?? "NULL"}) — discrepancy rows imply a NON_COMPLIANT overall`,
                );
            }
            rows.push({ category, declaredQty: r.declaredQty, observedQty: r.observedQty, difference, discrepancyType: type, discrepancyDesc: desc });
        }
        return rows;
    }

    // -- durable retry-convergence comparisons -----------------------------
    //
    // Gate-5E owner-authorized narrow correction (retry identity): a durable
    // response already linked to a Finding converges on a request that says
    // `finding.mode = "new"` ONLY when the linked durable Finding matches the
    // requested NEW-Finding semantic creation target:
    //   * origin_visit_id == the response's Visit
    //   * subject_id == the response's subject context (null-safe)
    //   * normalized description / defect_type / defect_type_other / location
    //   * urgency / impact
    //   * created_by == the request-supplied actor — the actor is part of the
    //     requested durable creation target because the request carries it
    //     explicitly and no adopted contract lets it vary on a retry.
    // Deliberately NOT compared: created_at (a retry generates a fresh clock
    // and must not defeat otherwise identical historical convergence) and the
    // Finding's CURRENT status (it may legitimately have transitioned later —
    // recognizing the historical retry never re-authorizes a new link).

    private async durableMatchesAnswer(
        s: CellSnapshot,
        avId: number,
        note: string | null,
        link: LinkExpectation,
    ): Promise<boolean> {
        if (s.overlayState !== null) return false;
        if (s.notInspectedReason !== null) return false;
        if (s.answeredValueId !== avId) return false;
        if (normalizeText(s.note) !== note) return false;
        if (link.kind === "none") return s.findingId === null;
        if (link.kind === "existing") return s.findingId === link.findingId;
        // NEW: durable Finding identity must equal the requested creation target
        return this.findingMatchesNewDraft(s, link);
    }

    /** durable linked Finding vs the requested NEW-Finding creation identity. */
    private async findingMatchesNewDraft(
        s: CellSnapshot,
        link: Extract<LinkExpectation, { kind: "new" }>,
    ): Promise<boolean> {
        if (s.findingId === null) return false;
        const rows = await this.db.query(
            `SELECT origin_visit_id, subject_id, description, defect_type, defect_type_other, location,
                    urgency, impact, created_by
               FROM finding WHERE finding_id = ?`,
            [s.findingId],
        );
        if (rows.length === 0) return false;
        const f = rows[0];
        const d = link.draft;
        return (
            Number(f.origin_visit_id) === s.visitId &&
            (f.subject_id === null ? s.subjectId === null : s.subjectId !== null && Number(f.subject_id) === s.subjectId) &&
            String(f.description) === d.description &&
            (f.defect_type === null ? d.defectType === null : d.defectType !== null && String(f.defect_type) === d.defectType) &&
            (f.defect_type_other === null
                ? d.defectTypeOther === null
                : d.defectTypeOther !== null && String(f.defect_type_other) === d.defectTypeOther) &&
            (f.location === null ? d.location === null : d.location !== null && String(f.location) === d.location) &&
            String(f.urgency) === d.urgency &&
            String(f.impact) === d.impact &&
            String(f.created_by) === link.createdBy
        );
    }

    private async durableMatchesScheduleAnswer(
        s: CellSnapshot,
        avId: number,
        note: string | null,
        link: LinkExpectation,
        rows: readonly ReconRow[],
    ): Promise<boolean> {
        if (!(await this.durableMatchesAnswer(s, avId, note, link))) return false;
        return this.reconciliationRowsEqual(s.responseId, rows);
    }

    private async reconciliationRowsEqual(responseId: number, expected: readonly ReconRow[]): Promise<boolean> {
        const durable = await this.readReconciliationRows(responseId);
        if (durable.length !== expected.length) return false;
        for (let i = 0; i < durable.length; i += 1) {
            const a = durable[i];
            const b = expected[i];
            if (
                a.category !== b.category ||
                a.declaredQty !== b.declaredQty ||
                a.observedQty !== b.observedQty ||
                a.difference !== b.difference ||
                a.discrepancyType !== b.discrepancyType ||
                a.discrepancyDesc !== b.discrepancyDesc
            ) {
                return false;
            }
        }
        return true;
    }

    private async readReconciliationRows(responseId: number): Promise<ReconRow[]> {
        const rows = await this.db.query(
            `SELECT category, declared_qty, observed_qty, difference, discrepancy_type, discrepancy_desc
               FROM equipment_reconciliation_row
              WHERE response_id = ?
              ORDER BY sort_order, row_id`,
            [responseId],
        );
        return rows.map((r) => ({
            category: String(r.category),
            declaredQty: Number(r.declared_qty),
            observedQty: Number(r.observed_qty),
            difference: Number(r.difference),
            discrepancyType: r.discrepancy_type === null ? null : (String(r.discrepancy_type) as ReconDiscrepancyType),
            discrepancyDesc: r.discrepancy_desc === null ? null : String(r.discrepancy_desc),
        }));
    }

    // -- the guarded write unit --------------------------------------------

    private async commitAnswerUnit(a: {
        op: string;
        snap: CellSnapshot;
        valueId: number;
        note: string | null;
        link: LinkExpectation;
        rows: readonly ReconRow[] | null;
    }): Promise<InitialDispositionResult> {
        return this.runUnit(async () => {
            let findingId: number | null = null;
            if (a.link.kind === "existing") {
                // admissibility read INSIDE the transaction: while BEGIN IMMEDIATE
                // is held no other writer can change the target Finding between
                // this validation and the guarded link (review correction B)
                await this.validateExistingFinding(a.snap, a.link.findingId, a.op);
                findingId = a.link.findingId;
            } else if (a.link.kind === "new") {
                const d = a.link.draft;
                // Finding first (OPEN, origin = this response's Visit), then the
                // guarded response UPDATE links it — the NC-must-link trigger is
                // satisfied at the UPDATE statement boundary.
                const fRes = await this.db.run(
                    `INSERT INTO finding(origin_visit_id, description, defect_type, defect_type_other, location,
                                         subject_id, urgency, impact, status, status_changed_at, created_at, created_by)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', NULL, ?, ?)`,
                    [
                        a.snap.visitId,
                        d.description,
                        d.defectType,
                        d.defectTypeOther,
                        d.location,
                        a.snap.subjectId,
                        d.urgency,
                        d.impact,
                        a.link.createdAt,
                        a.link.createdBy,
                    ] as readonly SqlValue[],
                );
                this.guardInsert(fRes, "finding");
                if (fRes.lastInsertRowid === null) {
                    throw new DomainError(APP_ERR.STATE_CONFLICT, `${a.op}: finding insert returned no rowid`);
                }
                findingId = Number(fRes.lastInsertRowid);
            }
            const res = await this.db.run(
                `UPDATE checklist_response
                    SET answered_value_id = ?, overlay_state = NULL, note = ?, not_inspected_reason = NULL, finding_id = ?
                  WHERE response_id = ?
                    AND overlay_state = 'NOT_INSPECTED' AND answered_value_id IS NULL
                    AND not_inspected_reason IS NULL AND finding_id IS NULL
                    AND (SELECT v.status FROM visit v WHERE v.visit_id = checklist_response.visit_id) = 'PREPARATION'
                    AND (SELECT v.finalized_at FROM visit v WHERE v.visit_id = checklist_response.visit_id) IS NULL`,
                [a.valueId, a.note, findingId, a.snap.responseId] as readonly SqlValue[],
            );
            if (res.changes !== 1) throw new ZeroRowGuard();
            if (a.rows !== null) {
                for (const [i, row] of a.rows.entries()) {
                    const rr = await this.db.run(
                        `INSERT INTO equipment_reconciliation_row
                            (response_id, category, declared_qty, observed_qty, difference,
                             discrepancy_type, discrepancy_desc, sort_order)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                        [
                            a.snap.responseId,
                            row.category,
                            row.declaredQty,
                            row.observedQty,
                            row.difference,
                            row.discrepancyType,
                            row.discrepancyDesc,
                            i + 1,
                        ] as readonly SqlValue[],
                    );
                    this.guardInsert(rr, `reconciliation row ${i + 1}`);
                }
            }
            return {
                responseId: a.snap.responseId,
                applied: true,
                overlayState: null,
                answeredValueId: a.valueId,
                note: a.note,
                notInspectedReason: null,
                findingId,
                reconciliationRowCount: a.rows === null ? 0 : a.rows.length,
            } satisfies InitialDispositionResult;
        }, async () => {
            // zero-row guarded UPDATE: the whole unit rolled back (any tentative
            // NEW Finding disappeared with it) — re-read the durable cell state
            const durable = await this.resolveCell({ visitId: a.snap.visitId, itemDefinitionId: a.snap.itemDefinitionId, subjectId: a.snap.subjectId });
            if (a.rows === null) {
                if (await this.durableMatchesAnswer(durable, a.valueId, a.note, a.link)) return this.resultFromState(durable, false);
            } else if (await this.durableMatchesScheduleAnswer(durable, a.valueId, a.note, a.link, a.rows)) {
                return this.resultFromState(durable, false);
            }
            throw alreadyDispositioned(a.op, durable, "the durable state does not match the identical retry target");
        });
    }

    private async convergeMarkNotInspected(snap: CellSnapshot, reason: string): Promise<InitialDispositionResult> {
        const durable = await this.resolveCell({ visitId: snap.visitId, itemDefinitionId: snap.itemDefinitionId, subjectId: snap.subjectId });
        if (
            durable.overlayState === "NOT_INSPECTED" &&
            durable.answeredValueId === null &&
            durable.findingId === null &&
            normalizeText(durable.notInspectedReason) === reason
        ) {
            return this.resultFromState(durable, false);
        }
        throw alreadyDispositioned("markNotInspected", durable, "the durable state does not match the identical retry target");
    }

    private async convergeHumanNa(snap: CellSnapshot): Promise<InitialDispositionResult> {
        const durable = await this.resolveCell({ visitId: snap.visitId, itemDefinitionId: snap.itemDefinitionId, subjectId: snap.subjectId });
        if (
            durable.overlayState === "NA" &&
            durable.answeredValueId === null &&
            durable.notInspectedReason === null &&
            durable.findingId === null
        ) {
            return this.resultFromState(durable, false);
        }
        throw alreadyDispositioned("resolveHumanApplicability", durable, "the durable state does not match the identical retry target");
    }

    /** one BEGIN IMMEDIATE … COMMIT unit; a ZeroRowGuard rolls back and hands over to `converge`. */
    private async runUnit<T>(work: () => Promise<T>, converge: () => Promise<T>): Promise<T> {
        await this.db.beginImmediate();
        try {
            const result = await work();
            await this.db.commit();
            return result;
        } catch (e) {
            try {
                await this.db.rollback();
            } catch {
                // rollback must never mask the original failure
            }
            if (e instanceof ZeroRowGuard) {
                return converge();
            }
            throw e;
        }
    }

    private guardInsert(res: SqlResult, what: string): void {
        if (res.changes !== 1) {
            throw new DomainError(APP_ERR.STATE_CONFLICT, `initial disposition: ${what} insert expected one row, got ${res.changes}`);
        }
    }

    // -- result assembly ---------------------------------------------------

    private resultFromState(s: CellSnapshot, applied: boolean): InitialDispositionResult {
        return {
            responseId: s.responseId,
            applied,
            overlayState: (s.overlayState as "NA" | "NOT_INSPECTED" | null) ?? null,
            answeredValueId: s.answeredValueId,
            note: s.note,
            notInspectedReason: s.notInspectedReason,
            findingId: s.findingId,
            reconciliationRowCount: 0,
        };
    }
}

interface ReconRow {
    category: string;
    declaredQty: number;
    observedQty: number;
    difference: number;
    discrepancyType: ReconDiscrepancyType | null;
    discrepancyDesc: string | null;
}
