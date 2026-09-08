// Gate 5E — T6 corrections & Finding-source lifecycle (runtime-neutral
// TypeScript, no node:* imports).
//
// Implements the adopted T6 correction family of TRANSACTION-CONTRACTS-v1.md
// §7 / APPLICATION-CORE-v1.md §4.4/§4.7/§4.9 over EXISTING materialized cells
// and recorded sources (no schema change, no new entity):
//
//   * correctSingle / correctSchedule — ordinary response corrections while
//     the source Visit is PREPARATION and not finalized: answer -> answer,
//     reasoned NOT_INSPECTED -> answer, answer -> reasoned NOT_INSPECTED, and
//     the explicit HUMAN decision reversals (NA <-> answered/reasoned). The
//     cell's PINNED definition and allowed values are authoritative; a
//     dispositioned cell never returns to the reason-less pending state; an
//     AUTO-NA cell has no transition; NON_COMPLIANT answers always need a
//     meaningful note and end linked to a Finding (existing confirmed / NEW
//     created atomically).
//   * rehomeSource — ordinary source re-home (response NON_COMPLIANT source or
//     observation source) while F_old keeps >= 1 OTHER source: the source
//     moves to a validated existing target or to a NEW target created
//     atomically; F_old remains active and is never VOIDED.
//   * voidOpenFindingByLastSourceCorrection (T6-VOID) — the LAST source is
//     corrected/retracted so it ceases to be a source, then F_old is VOIDED in
//     the same transaction (FollowUp FINDING/VOIDED; one shared event_datetime
//     == finding.status_changed_at).
//   * rehomeLastSourceAndVoidFinding (T6-REHOME) — the LAST source stays valid
//     (still NON_COMPLIANT / still a valid observation) but its Finding
//     association was wrong: guarded re-assignment to an existing target (A)
//     or a NEW target (B, origin_visit_id = the SOURCE's Visit) + F_old VOIDED.
//
// Finding-source discipline (TRANSACTION §7): a committed OPEN finding never
// rests with zero sources. If F_old keeps >= 1 other source an ordinary
// correction/re-home is allowed; when this source is the LAST one an ordinary
// detach/re-home is refused (E_LAST_SOURCE) — the dedicated T6-VOID /
// T6-REHOME branches own the last-source case. If F_old is IN_TREATMENT /
// RESOLVED the last-source retraction stays refused in v1 (E_STATE_CONFLICT);
// if F_old carries a CorrectiveAction the VOID paths stay refused
// (E_VOID_HAS_ACTIONS).
//
// Transaction rules (TRANSACTION §1/§13, RECOVERY §2/§5): every mutable
// admissibility check used to authorize a correction is re-read INSIDE one
// explicit BEGIN IMMEDIATE unit (Gate-5D review correction B — no TOCTOU
// window between validation and write); every guarded write expected to affect
// exactly one row passes the B5 cardinality check; a zero-row guarded write
// ROLLS THE WHOLE UNIT BACK, then the durable state is re-read and the call
// converges ONLY on the identical durable target (Class A — no idempotency
// table, no duplicate FollowUp, no second target Finding). All timestamps are
// app-supplied ISO-8601 UTC text; one transaction reuses the same instant for
// follow_up.event_datetime and finding.status_changed_at.
//
// Reconciliation rows: a SCHEDULE correction replaces the COMPLETE row set
// atomically (Gate-5E owner-authorized narrow schema correction: DELETE is
// legal while the owning response's Visit is PREPARATION and not finalized —
// trg_recon_bd; after finalization the rows are immutable historical truth).
// The corrected set may shrink, grow, or change content; any failure rolls the
// whole unit back, restoring the old overall disposition AND the old row set.
// No dummy/neutralized rows are ever invented.
//
// Observation rows are used ONLY as existing T6 sources (retraction /
// re-home); the text/subject of an observation changes only when the request
// explicitly carries the corrected value. T7 (observation creation /
// ensure-accounted), T8+ transitions, finalization and UI stay out of scope.

import type { SqlAdapter, SqlResult, SqlValue } from "../bootstrap/adapter.ts";
import { APP_ERR, DomainError } from "./errors.ts";
import { parseApplicabilityRule } from "./applicability.ts";
import {
    FINDING_DEFECT_TYPES,
    FINDING_IMPACTS,
    FINDING_URGENCIES,
    RECON_DISCREPANCY_TYPES,
    type FindingImpact,
    type FindingSelection,
    type FindingUrgency,
    type NewFindingInput,
    type ReconciliationRowInput,
    type ResponseCellRef,
} from "./initial-disposition.ts";

// ---------------------------------------------------------------------------
// public types
// ---------------------------------------------------------------------------

/** The source of a correction: a materialized response cell or an observation. */
export type CorrectionSource =
    | { kind: "response"; cell: ResponseCellRef }
    | {
          kind: "observation";
          observationId: number;
          /** explicit text correction riding along (unchanged when absent) */
          correctedText?: string;
          /** explicit subject correction riding along (unchanged when absent) */
          correctedSubjectId?: number | null;
      };

/** New disposition of a corrected cell (the adopted T6 target shapes). */
export type CorrectionTarget =
    | { kind: "answer"; allowedValueId: number }
    | { kind: "notInspected"; reason: string }
    | { kind: "notApplicable" };

/**
 * The cell-correction request shared by correctSingle / correctSchedule and by
 * the T6-VOID response-source branch. Semantics are validated against the
 * cell's PINNED definition (response_model, applicability rule, allowed
 * values) and against the durable pre-state; nothing is invented.
 */
export interface CellCorrectionRequest {
    target: CorrectionTarget;
    /** answer note (meaningful and mandatory for NON_COMPLIANT; optional otherwise) */
    note?: string | null;
    /** SCHEDULE answers only: the complete replacement reconciliation row content set */
    rows?: readonly ReconciliationRowInput[] | null;
    /** explicit APPLICABLE decision — required when a HUMAN cell leaves NA */
    humanDecision?: "APPLICABLE";
    /** explicit NOT_APPLICABLE decision — required when a HUMAN cell enters NA */
    decision?: "NOT_APPLICABLE";
}

/** Ordinary response-content correction (SINGLE_VALUE / SCHEDULE cell). */
export interface CorrectCellInput {
    cell: ResponseCellRef;
    request: CellCorrectionRequest;
    /** NON_COMPLIANT answer accountability (never "none" for an NC target). */
    finding?: FindingSelection;
    /** app-supplied creation audit — required only for a NEW Finding target */
    actor?: string;
    /** ISO-8601 UTC instant — required only for a NEW Finding target */
    now?: string;
}

/** Target Finding selection of a re-home (existing confirmed / new, never "none"). */
export type RehomeFindingTarget =
    | { mode: "existing"; findingId: number; coversSameIssueConfirmed: true }
    | { mode: "new"; finding: NewFindingInput };

/** Ordinary source re-home: F_old keeps >= 1 other source, F_old stays active. */
export interface RehomeSourceInput {
    source: CorrectionSource;
    target: RehomeFindingTarget;
    /** app-supplied creation audit — required only for a NEW target Finding */
    actor?: string;
    /** ISO-8601 UTC instant — required only for a NEW target Finding */
    now?: string;
}

export const FOLLOW_UP_ACTOR_ROLES = ["DIRECTOR", "CONCERNED_SERVICE", "INSPECTOR", "OTHER"] as const;
export type FollowUpActorRole = (typeof FOLLOW_UP_ACTOR_ROLES)[number];

/** The append-only FollowUp event of a VOID / re-home+VOID correction. */
export interface FollowUpEventInput {
    /** ISO-8601 UTC instant; shared by follow_up.event_datetime and status_changed_at */
    now: string;
    actorRole: FollowUpActorRole;
    /** required non-blank when actorRole === "OTHER" */
    actorRoleOther?: string | null;
    actorName?: string | null;
    recordedBy: string;
    /** meaningful void / correction note (follow_up.note) */
    note: string;
}

/** T6-VOID — `voidOpenFindingByLastSourceCorrection`. */
export interface VoidLastSourceInput {
    /** F_old: the OPEN finding whose LAST source is corrected/retracted */
    findingId: number;
    correction:
        | { kind: "response"; cell: ResponseCellRef; request: CellCorrectionRequest }
        | { kind: "observation"; observationId: number; correctedText?: string; correctedSubjectId?: number | null };
    event: FollowUpEventInput;
}

/** T6-REHOME — `rehomeLastSourceAndVoidFinding` (existing target A / new target B). */
export interface RehomeLastSourceInput {
    /** F_old: the OPEN finding whose LAST source keeps its validity */
    findingId: number;
    source: CorrectionSource;
    target: RehomeFindingTarget;
    event: FollowUpEventInput;
}

export interface CorrectionResult {
    /** false when the call converged on the already-applied identical durable target */
    applied: boolean;
    sourceKind: "response" | "observation";
    responseId: number | null;
    observationId: number | null;
    overlayState: "NA" | "NOT_INSPECTED" | null;
    answeredValueId: number | null;
    note: string | null;
    notInspectedReason: string | null;
    /** durable Finding link of the source after the correction */
    findingId: number | null;
    reconciliationRowCount: number;
    /** F_old when a T6-VOID / T6-REHOME call VOIDED it, else null */
    voidedFindingId: number | null;
    /** target Finding created by this call, else null */
    createdFindingId: number | null;
    /** FollowUp rows written by this call (1 on the VOID flows, else 0) */
    followUpCount: number;
}

// ---------------------------------------------------------------------------
// internal model
// ---------------------------------------------------------------------------

type SemanticClass = "COMPLIANT" | "NON_COMPLIANT";

/** durable state of the response row of a source cell (+ pinned-definition facts). */
interface CellSnapshot {
    responseId: number;
    visitId: number;
    itemDefinitionId: number;
    subjectId: number | null;
    overlayState: "NA" | "NOT_INSPECTED" | null;
    answeredValueId: number | null;
    /** semantic class of the durable answered value (null when unanswered) */
    answeredClass: SemanticClass | null;
    note: string | null;
    notInspectedReason: string | null;
    findingId: number | null;
    recordedAt: string;
    recordedBy: string;
    visitStatus: string;
    visitFinalizedAt: string | null;
    visitInstitutionId: number;
    itemCode: string;
    responseModel: string;
    applicabilityRule: string;
}

interface AllowedValueSnapshot {
    allowedValueId: number;
    valueCode: string;
    semanticClass: SemanticClass;
}

/** durable row of an adhoc_observation used as a source. */
interface ObservationSnapshot {
    observationId: number;
    visitId: number;
    subjectId: number | null;
    text: string;
    findingId: number | null;
    recordedAt: string;
    recordedBy: string;
    visitStatus: string;
    visitFinalizedAt: string | null;
    visitInstitutionId: number;
}

interface FindingSnapshot {
    findingId: number;
    status: string;
    originVisitId: number;
    subjectId: number | null;
    originInstitutionId: number;
    originVisitStatus: string;
    originVisitFinalizedAt: string | null;
}

/** durable (or intended) equipment_reconciliation_row content of a SCHEDULE response. */
interface ReconRow {
    rowId: number;
    category: string;
    declaredQty: number;
    observedQty: number;
    difference: number;
    discrepancyType: string | null;
    discrepancyDesc: string | null;
}

/** validated NEW-Finding data (nothing defaulted; all fields normalized). */
interface NewFindingDraft {
    description: string;
    defectType: string | null;
    defectTypeOther: string | null;
    location: string | null;
    urgency: FindingUrgency;
    impact: FindingImpact;
}

/** durable-link expectation of the requested answer target. */
type LinkExpectation =
    | { kind: "none" }
    | { kind: "new"; draft: NewFindingDraft; createdBy: string; createdAt: string }
    | { kind: "existing"; findingId: number };

interface ValidatedEvent {
    now: string;
    actorRole: FollowUpActorRole;
    actorRoleOther: string | null;
    actorName: string | null;
    note: string;
    recordedBy: string;
}

/** thrown inside a write unit to force ROLLBACK + durable-state re-read (B5) */
class ZeroRowGuard extends Error {
    constructor() {
        super("guarded write affected zero rows (B5)");
        this.name = "ZeroRowGuard";
    }
}

// ---------------------------------------------------------------------------
// normalization / message helpers (Arabic never parsed; only text meaning is
// checked)
// ---------------------------------------------------------------------------

function normalizeText(v: string | null | undefined): string | null {
    if (v === null || v === undefined) return null;
    const t = v.trim();
    return t.length === 0 ? null : t;
}

function config(what: string): DomainError {
    return new DomainError(APP_ERR.CONFIG, `corrections: ${what}`);
}

function stateConflict(what: string): DomainError {
    return new DomainError(APP_ERR.STATE_CONFLICT, `corrections: ${what}`);
}

function lastSource(what: string): DomainError {
    return new DomainError(APP_ERR.LAST_SOURCE, `corrections: ${what}`);
}

function hasActions(findingId: number, n: number): DomainError {
    return new DomainError(
        APP_ERR.VOID_HAS_ACTIONS,
        `corrections: finding ${findingId} carries ${n} corrective action(s); ` +
            "last-source VOID / re-home+VOID is refused in v1 while any CorrectiveAction exists (E_VOID_HAS_ACTIONS)",
    );
}

function isTruePending(s: CellSnapshot): boolean {
    return (
        s.overlayState === "NOT_INSPECTED" &&
        s.answeredValueId === null &&
        s.notInspectedReason === null &&
        s.findingId === null
    );
}

// ---------------------------------------------------------------------------
// service
// ---------------------------------------------------------------------------

export class CorrectionsService {
    private readonly db: SqlAdapter;

    constructor(db: SqlAdapter) {
        this.db = db;
    }

    // -- ordinary response corrections --------------------------------------

    /** T6 ordinary correction of a dispositioned SINGLE_VALUE cell. */
    async correctSingle(input: CorrectCellInput): Promise<CorrectionResult> {
        return this.correctCell(input, "SINGLE_VALUE");
    }

    /** T6 ordinary correction of a dispositioned SCHEDULE cell (overall + rows atomically). */
    async correctSchedule(input: CorrectCellInput): Promise<CorrectionResult> {
        return this.correctCell(input, "SCHEDULE");
    }

    /** Ordinary source re-home while F_old keeps >= 1 other source. */
    async rehomeSource(input: RehomeSourceInput): Promise<CorrectionResult> {
        const op = "rehomeSource";
        if (input.target.mode === "new") {
            this.requireNewFindingAudit(input.actor, input.now, op);
            this.validateNewFindingDraft(input.target.finding, op);
        }
        // the PREPARATION gate runs first (initial-disposition ordering)
        if (input.source.kind === "response") {
            const pre = await this.readCellByRef(input.source.cell);
            this.assertVisitPreparation(pre, op);
        } else {
            const pre = await this.readObservation(input.source.observationId);
            this.assertObservationVisitPreparation(pre, op);
        }
        // fast-path Class-A convergence: the source already points at the
        // requested target (nothing to re-home; no write needed)
        const converged = await this.sourceRehomeDurable(input.source, input.target, null, input.actor ?? "");
        if (converged !== null) return converged;

        return this.runUnit(
            async () => {
                // in-window retry: the identical durable re-home target may
                // already exist (converge without any write)
                const windowed = await this.sourceRehomeDurable(input.source, input.target, null, input.actor ?? "");
                if (windowed !== null) return { kind: "converged" as const, result: windowed };
                const plan = await this.planRehomeInsideTx(input, { voidOld: false });
                const tId = await this.ensureTargetFinding(plan, input.actor ?? "", input.now ?? "");
                const guarded = await this.applyReassignment(input, plan, tId);
                if (guarded.changes !== 1) throw new ZeroRowGuard();
                return { kind: "applied" as const, tId, createdFindingId: plan.target.mode === "new" ? tId : null };
            },
            async () => {
                const durable = await this.sourceRehomeDurable(input.source, input.target, null, input.actor ?? "");
                if (durable !== null) return { kind: "converged" as const, result: durable };
                throw stateConflict(`${op}: durable source state does not match the identical re-home target`);
            },
        ).then((outcome) => {
            if (outcome.kind === "converged") return outcome.result;
            return this.assembleSourceResult(input.source, true, {
                voidedFindingId: null,
                createdFindingId: outcome.createdFindingId,
                followUpCount: 0,
            });
        });
    }

    // -- T6-VOID ------------------------------------------------------------

    /**
     * `voidOpenFindingByLastSourceCorrection` — the LAST source of OPEN F_old
     * ceases to be a source (terminal correction / retraction), then F_old is
     * VOIDED atomically. Never a generic status operation.
     */
    async voidOpenFindingByLastSourceCorrection(input: VoidLastSourceInput): Promise<CorrectionResult> {
        const event = this.validateFollowUpEvent(input.event, "voidOpenFindingByLastSourceCorrection");
        // existence pre-read (missing cell/observation is always an error) and
        // the source-visit PREPARATION gate (initial-disposition ordering)
        if (input.correction.kind === "response") {
            const sPre = await this.readCellByRef(input.correction.cell);
            this.assertVisitPreparation(sPre, "voidOpenFindingByLastSourceCorrection");
        } else {
            const oPre = await this.readObservation(input.correction.observationId);
            this.assertObservationVisitPreparation(oPre, "voidOpenFindingByLastSourceCorrection");
        }
        // fast-path Class-A convergence first: a retry after a committed VOID
        // sees the source already corrected/retracted AND F_old VOIDED with the
        // IDENTICAL VOID event/audit identity — the durable-dependent
        // preconditions no longer hold, so the identical durable target must be
        // recognized BEFORE any shape precondition that requires the
        // NON_COMPLIANT pre-state
        if (await this.lastSourceVoidConverges(input, event)) {
            return this.resultOfVoidConverged(input);
        }
        // F_old already VOIDED but the durable target/event does not match the
        // request: a CONFLICTING retry, never an identical one
        const fStatusRows = await this.db.query(
            `SELECT status FROM finding WHERE finding_id = ?`,
            [input.findingId],
        );
        if (fStatusRows.length > 0 && String(fStatusRows[0].status) === "VOIDED") {
            throw stateConflict(
                "voidOpenFindingByLastSourceCorrection: F_old is already VOIDED but the durable source state and/or " +
                    "the durable VOID event identity (event_datetime / actor / note / recorded_by / status_changed_at) does " +
                    "not match the requested retry — a conflicting retry never converges",
            );
        }
        // durable still NON_COMPLIANT -> request-shape validation now fires
        if (input.correction.kind === "response") {
            const sPre = await this.readCellByRef(input.correction.cell);
            if (durableClass(sPre) === "NON_COMPLIANT") {
                await this.validateVoidResponseShape(input.correction, sPre);
            }
        }

        return this.runUnit(
            async () => {
                // in-window retry: the identical durable VOID target may
                // already exist (converge without any write)
                if (await this.lastSourceVoidConverges(input, event)) {
                    return { kind: "converged" as const, result: await this.resultOfVoidConverged(input) };
                }
                const plan = await this.planVoidInsideTx(input, event);
                const guarded = await this.applyVoidSourceCorrection(input, plan);
                if (guarded.changes !== 1) throw new ZeroRowGuard();
                await this.verifyZeroSourcesThenVoid(plan.fOld.findingId, event, "voidOpenFindingByLastSourceCorrection");
                return { kind: "applied" as const, voidedFindingId: plan.fOld.findingId };
            },
            async () => {
                if (await this.lastSourceVoidConverges(input, event)) {
                    return { kind: "converged" as const, result: await this.resultOfVoidConverged(input) };
                }
                throw stateConflict(
                    "voidOpenFindingByLastSourceCorrection: durable state does not match the identical void target — " +
                        "the last-source retraction was not applied",
                );
            },
        ).then((outcome) => {
            if (outcome.kind === "converged") return outcome.result;
            return this.assembleVoidResult(input, true, outcome.voidedFindingId, null);
        });
    }

    // -- T6-REHOME ----------------------------------------------------------

    /**
     * `rehomeLastSourceAndVoidFinding` — the LAST source of OPEN F_old stays
     * valid (NON_COMPLIANT answer / valid observation) but its Finding
     * association was wrong: guarded re-assignment to an existing target (A)
     * or a NEW target (B, origin_visit_id = the SOURCE's Visit), then F_old is
     * VOIDED. Any failure rolls back everything including the NEW target.
     */
    async rehomeLastSourceAndVoidFinding(input: RehomeLastSourceInput): Promise<CorrectionResult> {
        const event = this.validateFollowUpEvent(input.event, "rehomeLastSourceAndVoidFinding");
        if (input.target.mode === "new") {
            this.validateNewFindingDraft(input.target.finding, "rehomeLastSourceAndVoidFinding");
        }
        // the source-visit PREPARATION gate runs first (initial-disposition
        // ordering); finding-state gates stay inside the transaction so an
        // identical retry (F_old already VOIDED) still converges
        if (input.source.kind === "response") {
            const pre = await this.readCellByRef(input.source.cell);
            this.assertVisitPreparation(pre, "rehomeLastSourceAndVoidFinding");
        } else {
            const pre = await this.readObservation(input.source.observationId);
            this.assertObservationVisitPreparation(pre, "rehomeLastSourceAndVoidFinding");
        }
        // fast-path Class-A convergence: source already points at the intended
        // target AND F_old is VOIDED with the IDENTICAL VOID event/audit
        // identity — no second target Finding, no duplicate FollowUp, no
        // repeated re-home (RECOVERY §5; TRANSACTION §12)
        const converged = await this.lastSourceRehomeConverges(input);
        if (converged !== null) return converged;
        // F_old already VOIDED but the durable target/event does not match the
        // request: a CONFLICTING retry, never an identical one
        const fStatusRows = await this.db.query(
            `SELECT status FROM finding WHERE finding_id = ?`,
            [input.findingId],
        );
        if (fStatusRows.length > 0 && String(fStatusRows[0].status) === "VOIDED") {
            throw stateConflict(
                "rehomeLastSourceAndVoidFinding: F_old is already VOIDED but the durable source/target state and/or " +
                    "the durable VOID event identity (event_datetime / actor / note / recorded_by / status_changed_at) does " +
                    "not match the requested retry — a conflicting retry never converges",
            );
        }

        return this.runUnit(
            async () => {
                // in-window retry: the identical durable re-home+VOID target
                // may already exist (converge without any write)
                const windowed = await this.lastSourceRehomeConverges(input);
                if (windowed !== null) return { kind: "converged" as const, result: windowed };
                const plan = await this.planRehomeInsideTx(input, { voidOld: true });
                const tId = await this.ensureTargetFinding(plan, event.recordedBy, event.now);
                const guarded = await this.applyReassignment(input, plan, tId);
                if (guarded.changes !== 1) throw new ZeroRowGuard();
                await this.verifyZeroSourcesThenVoid(plan.fOld.findingId, event, "rehomeLastSourceAndVoidFinding");
                return { kind: "applied" as const, tId, voidedFindingId: plan.fOld.findingId, createdFindingId: plan.target.mode === "new" ? tId : null };
            },
            async () => {
                const durable = await this.lastSourceRehomeConverges(input);
                if (durable !== null) return { kind: "converged" as const, result: durable };
                throw stateConflict(
                    "rehomeLastSourceAndVoidFinding: durable state does not match the identical re-home+VOID target — " +
                        "the re-assignment was not applied",
                );
            },
        ).then((outcome) => {
            if (outcome.kind === "converged") return outcome.result;
            return this.assembleSourceResult(input.source, true, {
                voidedFindingId: outcome.voidedFindingId,
                createdFindingId: outcome.createdFindingId,
                followUpCount: 1,
            });
        });
    }

    // -----------------------------------------------------------------------
    // correctCell engine
    // -----------------------------------------------------------------------

    private async correctCell(input: CorrectCellInput, model: "SINGLE_VALUE" | "SCHEDULE"): Promise<CorrectionResult> {
        const op = model === "SCHEDULE" ? "correctSchedule" : "correctSingle";
        const pre = await this.readCellByRef(input.cell);
        // the PREPARATION gate runs first (initial-disposition ordering): a
        // finalized Visit refuses every correction regardless of shape
        this.assertVisitPreparation(pre, op);
        if (pre.responseModel !== model) {
            throw config(
                `${op}: response ${pre.responseId} (${pre.itemCode}) pins response_model '${pre.responseModel}'; ` +
                    `${model} required (use the matching correction entry point)`,
            );
        }
        // request-shape resolution: allowed value from the PINNED definition,
        // note rule, row set shape, finding selection, HUMAN decision shapes
        const shape = await this.resolveCellCorrectionShape(pre, input, op);
        // durable retry-convergence (Class A): the cell already equals the
        // requested target, including its reconciliation row content set
        const preRows = model === "SCHEDULE" ? await this.readReconRows(pre.responseId) : [];
        if (await this.durableMatchesTarget(pre, preRows, input.request, shape)) {
            return this.resultOfCell(pre, false, { voidedFindingId: null, createdFindingId: null, followUpCount: 0, rowCount: preRows.length });
        }

        return this.runUnit(
            async () => {
                const outcome = await this.writeCellCorrection(pre, input, shape, model, op);
                return { kind: "applied" as const, result: outcome };
            },
            async () => {
                const durable = await this.readCellByRef(input.cell);
                const rows = model === "SCHEDULE" ? await this.readReconRows(durable.responseId) : [];
                if (await this.durableMatchesTarget(durable, rows, input.request, shape)) {
                    return { kind: "converged" as const, result: this.resultOfCell(durable, false, { voidedFindingId: null, createdFindingId: null, followUpCount: 0, rowCount: rows.length }) };
                }
                throw stateConflict(`${op}: durable cell state does not match the identical correction target — ` +
                    "conflicting retries never silently succeed");
            },
        ).then((outcome) => outcome.result);
    }

    /** request-shape validation + resolution against the pinned definition. */
    private async resolveCellCorrectionShape(
        s: CellSnapshot,
        input: CorrectCellInput,
        op: string,
    ): Promise<{ link: LinkExpectation; rows: readonly ReconRow[]; targetClass: SemanticClass }> {
        const request = input.request;
        const target = request.target;
        let link: LinkExpectation = { kind: "none" };
        let rows: readonly ReconRow[] = [];
        let targetClass: SemanticClass;

        if (target.kind === "answer") {
            const value = await this.resolveAllowedValue(s.itemDefinitionId, target.allowedValueId, op);
            targetClass = value.semanticClass;
            if (value.semanticClass === "COMPLIANT") {
                const sel = input.finding ?? { mode: "none" as const };
                if (sel.mode !== "none") {
                    throw config(`${op}: a COMPLIANT corrected answer of ${s.itemCode} must never be linked to a Finding`);
                }
            } else {
                if (normalizeText(request.note) === null) {
                    throw config(`${op}: NON_COMPLIANT corrected answer of ${s.itemCode} requires a meaningful note ` + "(APPLICATION-CORE §7)");
                }
                link = await this.resolveFindingExpectation(s, input.finding, input.actor, input.now, op);
            }
            if (s.responseModel === "SCHEDULE") {
                rows = this.validateReconciliationRows(request.rows ?? [], value.semanticClass, op);
            } else if ((request.rows ?? []).length > 0) {
                throw config(`${op}: reconciliation rows belong only to SCHEDULE-type responses (${s.itemCode} is SINGLE_VALUE)`);
            }
        } else if (target.kind === "notInspected") {
            targetClass = "COMPLIANT";
            if (normalizeText(target.reason) === null) {
                throw config(`${op}: a deliberate NOT_INSPECTED correction requires a meaningful (non-blank) reason`);
            }
            if (normalizeText(request.note) !== null) {
                throw config(`${op}: a deliberate NOT_INSPECTED correction carries no note (the reason is the recorded explanation)`);
            }
            if (s.responseModel === "SCHEDULE" && (request.rows ?? []).length > 0) {
                throw config(`${op}: a deliberate NOT_INSPECTED SCHEDULE correction carries zero reconciliation rows`);
            }
        } else {
            targetClass = "COMPLIANT"; // NA carries no answered value
            const rule = parseApplicabilityRule(s.applicabilityRule);
            if (rule.decisionKind !== "HUMAN_CONFIRMATION") {
                throw config(
                    `${op}: response ${s.responseId} (${s.itemCode}) pins decision_kind '${rule.decisionKind}'; an NA target is ` +
                        "reachable only on a HUMAN_CONFIRMATION cell through the explicit NOT_APPLICABLE decision — AUTO " +
                        "cells never use the HUMAN reversal path",
                );
            }
        }
        return { link, rows, targetClass };
    }

    /**
     * In-transaction correction of a dispositioned cell. Every mutable check
     * is re-run against the in-tx snapshot; the guarded UPDATE carries the
     * in-tx durable predicates (B5) so a stale/racing write affects zero rows
     * and rolls the whole unit back.
     */
    private async writeCellCorrection(
        pre: CellSnapshot,
        input: CorrectCellInput,
        shape: { link: LinkExpectation; rows: readonly ReconRow[]; targetClass: SemanticClass },
        model: "SINGLE_VALUE" | "SCHEDULE",
        op: string,
    ): Promise<CorrectionResult> {
        // re-read inside BEGIN IMMEDIATE: no writer can change the cell or its
        // finding between this admissibility read and the guarded write
        const s = await this.readCellByRef(input.cell);
        this.assertVisitPreparation(s, op);
        const durableRows = model === "SCHEDULE" ? await this.readReconRows(s.responseId) : [];
        if (await this.durableMatchesTarget(s, durableRows, input.request, shape)) {
            // identical durable target already present (retry in the window)
            return this.resultOfCell(s, false, { voidedFindingId: null, createdFindingId: null, followUpCount: 0, rowCount: durableRows.length });
        }
        this.assertTransitionLegal(s, input.request, op);
        this.assertHumanGates(s, input.request, op);

        // Finding-source discipline: does the cell currently source F_old, and
        // does the requested correction detach or re-point that link?
        const fOld = s.findingId;
        const request = input.request;
        let linkValue: number | null = null;
        let createdFindingId: number | null = null;
        if (request.target.kind === "answer" && shape.targetClass === "NON_COMPLIANT") {
            if (shape.link.kind === "new") {
                if (fOld !== null) {
                    await this.assertDetachOrRelinkAllowed(s, fOld, true, op);
                }
                const d = shape.link.draft;
                const fRes = await this.db.run(
                    `INSERT INTO finding(origin_visit_id, description, defect_type, defect_type_other, location,
                                         subject_id, urgency, impact, status, status_changed_at, created_at, created_by)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', NULL, ?, ?)`,
                    [
                        s.visitId,
                        d.description,
                        d.defectType,
                        d.defectTypeOther,
                        d.location,
                        s.subjectId,
                        d.urgency,
                        d.impact,
                        shape.link.createdAt,
                        shape.link.createdBy,
                    ] as readonly SqlValue[],
                );
                this.guardInsert(fRes, "finding");
                if (fRes.lastInsertRowid === null) throw stateConflict(`${op}: new finding insert returned no rowid`);
                createdFindingId = Number(fRes.lastInsertRowid);
                linkValue = createdFindingId;
            } else {
                // existing target
                if (shape.link.findingId !== fOld) {
                    if (fOld !== null) {
                        await this.assertDetachOrRelinkAllowed(s, fOld, true, op);
                    }
                    // target admissibility INSIDE the tx (Gate-5D correction B)
                    await this.validateExistingTarget(s, shape.link.findingId, op);
                } else {
                    // the cell stays with its current finding (value/note change)
                    await this.assertSourceFindingActive(s, fOld, op);
                }
                linkValue = shape.link.findingId;
            }
        } else {
            // COMPLIANT / NOT_INSPECTED / NA targets never carry a finding link
            if (fOld !== null) {
                await this.assertDetachOrRelinkAllowed(s, fOld, false, op);
            }
        }

        if (model === "SCHEDULE") {
            if (request.target.kind === "answer") {
                if (shape.targetClass === "COMPLIANT") {
                    // rows first: overall COMPLIANT may never coexist with a
                    // discrepancy row even transiently — delete the old set and
                    // insert the corrected (zero-discrepancy) set, then set the
                    // overall disposition (Gate-5E owner-authorized full row-set
                    // replacement; DELETE is legal while the Visit is PREPARATION)
                    await this.replaceReconRows(s.responseId, durableRows, shape.rows);
                    await this.updateResponseToTarget(s, request, null, op);
                } else {
                    // overall NON_COMPLIANT first, corrected rows follow
                    await this.updateResponseToTarget(s, request, linkValue, op);
                    await this.replaceReconRows(s.responseId, durableRows, shape.rows);
                }
            } else {
                // deliberate NOT_INSPECTED on a rowed SCHEDULE cell: the corrected
                // state has ZERO rows — delete the old rows first (legal during
                // PREPARATION), then set the overlay (an overlay may never
                // coexist with rows)
                await this.deleteReconRows(s.responseId, durableRows);
                await this.updateResponseToTarget(s, request, null, op);
            }
        } else {
            await this.updateResponseToTarget(s, request, linkValue, op);
        }

        // post-state result from the durable row inside the same transaction
        const post = await this.readCellByRef(input.cell);
        const rowCount = model === "SCHEDULE" ? (await this.readReconRows(post.responseId)).length : 0;
        return this.resultOfCell(post, true, { voidedFindingId: null, createdFindingId, followUpCount: 0, rowCount });
    }

    // -----------------------------------------------------------------------
    // guarded writes
    // -----------------------------------------------------------------------

    /**
     * The single guarded UPDATE of the response cell. The WHERE clause carries
     * the durable pre-state predicates (read inside this tx) + the PREPARATION
     * gate (B5: zero affected rows => ROLLBACK + durable re-read).
     */
    private async updateResponseToTarget(
        s: CellSnapshot,
        request: CellCorrectionRequest,
        linkValue: number | null,
        op: string,
    ): Promise<SqlResult> {
        const target = request.target;
        const pred = this.durablePredicates(s);
        const visitPrep =
            `AND (SELECT v.status FROM visit v WHERE v.visit_id = checklist_response.visit_id) = 'PREPARATION'` +
            ` AND (SELECT v.finalized_at FROM visit v WHERE v.visit_id = checklist_response.visit_id) IS NULL`;
        let sql: string;
        let params: SqlValue[];
        if (target.kind === "answer") {
            const note = normalizeText(request.note);
            sql =
                `UPDATE checklist_response
                    SET answered_value_id = ?, overlay_state = NULL, note = ?, not_inspected_reason = NULL, finding_id = ?
                  WHERE response_id = ? AND ${pred.overlay} AND ${pred.answered} AND ${pred.reason} AND ${pred.finding} ${visitPrep}`;
            params = [target.allowedValueId, note, linkValue, s.responseId];
        } else if (target.kind === "notInspected") {
            const reason = normalizeText(target.reason)!;
            sql =
                `UPDATE checklist_response
                    SET overlay_state = 'NOT_INSPECTED', not_inspected_reason = ?, answered_value_id = NULL,
                        note = NULL, finding_id = NULL
                  WHERE response_id = ? AND ${pred.overlay} AND ${pred.answered} AND ${pred.reason} AND ${pred.finding} ${visitPrep}`;
            params = [reason, s.responseId];
        } else {
            const note = normalizeText(request.note);
            sql =
                `UPDATE checklist_response
                    SET overlay_state = 'NA', answered_value_id = NULL, not_inspected_reason = NULL, note = ?,
                        finding_id = NULL
                  WHERE response_id = ? AND ${pred.overlay} AND ${pred.answered} AND ${pred.reason} AND ${pred.finding} ${visitPrep}`;
            params = [note, s.responseId];
        }
        const res = await this.db.run(sql, params);
        if (res.changes !== 1) throw new ZeroRowGuard();
        void op;
        return res;
    }

    /** durable pre-state predicates of the response row (values read in-tx). */
    private durablePredicates(s: CellSnapshot): { overlay: string; answered: string; reason: string; finding: string } {
        return {
            overlay: s.overlayState === null ? "overlay_state IS NULL" : `overlay_state = '${s.overlayState}'`,
            answered: s.answeredValueId === null ? "answered_value_id IS NULL" : `answered_value_id = ${s.answeredValueId}`,
            reason: s.notInspectedReason === null ? "not_inspected_reason IS NULL" : "not_inspected_reason IS NOT NULL",
            finding: s.findingId === null ? "finding_id IS NULL" : `finding_id = ${s.findingId}`,
        };
    }

    /**
     * Delete the durable reconciliation row set of a SCHEDULE response.
     * Physical rule (Gate-5E owner-authorized narrow schema correction): the
     * DELETE is allowed only while the owning response's Visit is PREPARATION
     * and not finalized — trg_recon_bd aborts the whole transaction otherwise.
     */
    private async deleteReconRows(responseId: number, durable: readonly ReconRow[]): Promise<void> {
        if (durable.length === 0) return;
        const res = await this.db.run(
            `DELETE FROM equipment_reconciliation_row WHERE response_id = ?`,
            [responseId],
        );
        if (res.changes !== durable.length) {
            throw stateConflict(
                `reconciliation row-set replacement: expected to delete ${durable.length} row(s) of response ` +
                    `${responseId}, affected ${res.changes} — durable state raced`,
            );
        }
    }

    /**
     * Replace the complete reconciliation row set of a SCHEDULE response inside
     * the correction transaction: DELETE the old rows, INSERT the complete
     * corrected set (any size: smaller / larger / same). Any failure rolls the
     * whole unit back, restoring both the old overall disposition and the old
     * row set.
     */
    private async replaceReconRows(responseId: number, durable: readonly ReconRow[], intended: readonly ReconRow[]): Promise<void> {
        await this.deleteReconRows(responseId, durable);
        for (let i = 0; i < intended.length; i += 1) {
            const res = await this.db.run(
                `INSERT INTO equipment_reconciliation_row
                    (response_id, category, declared_qty, observed_qty, difference, discrepancy_type, discrepancy_desc, sort_order)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    responseId,
                    intended[i].category,
                    intended[i].declaredQty,
                    intended[i].observedQty,
                    intended[i].difference,
                    intended[i].discrepancyType,
                    intended[i].discrepancyDesc,
                    i + 1,
                ] as readonly SqlValue[],
            );
            this.guardInsert(res, `reconciliation row ${i + 1}`);
        }
    }

    // -----------------------------------------------------------------------
    // finding-source discipline
    // -----------------------------------------------------------------------

    /** a linked Finding must not be VOIDED (a VOIDED finding can never hold a source). */
    private async assertSourceFindingActive(s: CellSnapshot, fOldId: number, op: string): Promise<void> {
        const f = await this.readFinding(fOldId);
        if (f.status === "VOIDED") {
            throw stateConflict(`${op}: finding ${fOldId} is VOIDED while a response still sources it — corrupt state`);
        }
        // IN_TREATMENT / RESOLVED findings may legitimately keep their sources;
        // keeping this cell's link on them is never a correction of the link.
        void s;
    }

    /** the correction is removing or moving this cell's link away from F_old. */
    private async assertDetachOrRelinkAllowed(s: CellSnapshot, fOldId: number, relink: boolean, op: string): Promise<void> {
        const fOld = await this.readFinding(fOldId);
        if (fOld.status === "VOIDED") {
            throw stateConflict(`${op}: finding ${fOldId} is VOIDED while a response still sources it — corrupt state`);
        }
        const otherSources = (await this.countSources(fOldId)) - 1; // the cell itself is one source
        if (otherSources === 0) {
            if (fOld.status !== "OPEN") {
                throw stateConflict(
                    `${op}: response ${s.responseId} is the LAST recorded source of finding ${fOldId} ` +
                        `(status '${fOld.status}'); removing/reassigning the last source of an IN_TREATMENT/RESOLVED finding ` +
                        "stays refused in v1 (TRANSACTION §7)",
                );
            }
            throw lastSource(
                `${op}: response ${s.responseId} is the LAST recorded source of OPEN finding ${fOldId}; an ordinary ` +
                    (relink
                        ? "re-home is forbidden here — use rehomeLastSourceAndVoidFinding (T6-REHOME)"
                        : "detach is forbidden here — use voidOpenFindingByLastSourceCorrection (T6-VOID)"),
            );
        }
    }

    /** existing-target admissibility (mirrors the initial-disposition rules). */
    private async validateExistingTarget(
        s: CellSnapshot | ObservationSnapshot,
        findingId: number,
        op: string,
        sourceSubjectOverride?: number | null,
    ): Promise<FindingSnapshot> {
        const t = await this.readFinding(findingId);
        if (t.status !== "OPEN" && t.status !== "IN_TREATMENT") {
            throw new DomainError(
                APP_ERR.FINDING_TARGET_INVALID,
                `${op}: finding ${findingId} has status '${t.status}'; only OPEN (or IN_TREATMENT at the inspector's ` +
                    "explicit choice) findings are re-home/correction targets — VOIDED/RESOLVED never regain a source",
            );
        }
        if (t.originInstitutionId !== s.visitInstitutionId) {
            throw new DomainError(
                APP_ERR.CONTEXT,
                `${op}: finding ${findingId} belongs to institution ${t.originInstitutionId} but the source visit belongs to ` +
                    `institution ${s.visitInstitutionId} (E_CONTEXT)`,
            );
        }
        const subject = sourceSubjectOverride === undefined ? s.subjectId : sourceSubjectOverride;
        if (subject !== null && t.subjectId !== subject) {
            const findingSubject = t.subjectId === null ? "the institution context (subject_id NULL)" : `subject ${t.subjectId}`;
            throw new DomainError(
                APP_ERR.CONTEXT,
                `${op}: finding ${findingId} is recorded for ${findingSubject} but the source carries subject ${subject}; ` +
                    "a target Finding must share the source's subject context when the source has one (E_CONTEXT)",
            );
        }
        // first-source/origin integrity: a Finding with no recorded source may
        // only receive its first source from its origin_visit_id
        const excludeRes = "responseId" in s ? s.responseId : -1;
        const excludeObs = "observationId" in s ? s.observationId : -1;
        const hasOther = await this.hasOtherSource(findingId, excludeRes, excludeObs);
        if (!hasOther && t.originVisitId !== s.visitId) {
            throw new DomainError(
                APP_ERR.FINDING_TARGET_INVALID,
                `${op}: finding ${findingId} has no recorded source yet; its first source must belong to its origin visit ` +
                    `${t.originVisitId} (the source lives in visit ${s.visitId}) — first-source integrity`,
            );
        }
        return t;
    }

    private async hasOtherSource(findingId: number, excludeResponseId: number, excludeObsId: number): Promise<boolean> {
        const rows = await this.db.query(
            `SELECT
                EXISTS (SELECT 1 FROM checklist_response cr WHERE cr.finding_id = ? AND cr.response_id <> ?) AS r,
                EXISTS (SELECT 1 FROM adhoc_observation o WHERE o.finding_id = ? AND o.observation_id <> ?) AS o`,
            [findingId, excludeResponseId, findingId, excludeObsId],
        );
        return Boolean(rows[0].r) || Boolean(rows[0].o);
    }

    // -----------------------------------------------------------------------
    // adopted cell transitions / HUMAN decision gates
    // -----------------------------------------------------------------------

    private assertTransitionLegal(s: CellSnapshot, request: CellCorrectionRequest, op: string): void {
        const targetKind = request.target.kind;
        if (isTruePending(s)) {
            throw config(
                `${op}: response ${s.responseId} (${s.itemCode}) is still in the true-pending state; ` +
                    "a correction applies only to a dispositioned cell (initial dispositions record the first answer)",
            );
        }
        const rule = parseApplicabilityRule(s.applicabilityRule);
        if (s.overlayState === "NA") {
            if (rule.decisionKind !== "HUMAN_CONFIRMATION") {
                throw config(
                    `${op}: response ${s.responseId} (${s.itemCode}) is AUTO-NA; the deterministic NOT_APPLICABLE outcome ` +
                        "has no correction transition while its rule/context/visit-type inputs are immutable (AUTO cells " +
                        "never use the HUMAN reversal path)",
                );
            }
            if (targetKind === "notApplicable") {
                throw config(
                    `${op}: response ${s.responseId} (${s.itemCode}) is already NA; NA -> NA is not a correction ` +
                        "(an identical NA converges as a retry; an NA cell only LEAVES NA through the explicit HUMAN reversal)",
                );
            }
            return; // HUMAN NA -> answered / reasoned is legal (APPLICABLE gate below)
        }
        if (s.overlayState === "NOT_INSPECTED" && s.notInspectedReason !== null && s.answeredValueId === null) {
            // reasoned NOT_INSPECTED pre-state
            if (targetKind === "notInspected") {
                throw config(
                    `${op}: response ${s.responseId} (${s.itemCode}) already carries a deliberate NOT_INSPECTED reason; ` +
                        "replacing one reason with another is not an adopted T6 transition (only an answer or a HUMAN " +
                        "NOT_APPLICABLE reversal leaves a reasoned cell)",
                );
            }
            return;
        }
        if (s.answeredValueId !== null) {
            return; // answered -> answered / reasoned / (HUMAN) NA are the adopted moves
        }
        throw config(`${op}: response ${s.responseId} (${s.itemCode}) is not in a correctionable dispositioned state`);
    }

    private assertHumanGates(s: CellSnapshot, request: CellCorrectionRequest, op: string): void {
        const rule = parseApplicabilityRule(s.applicabilityRule);
        const human = rule.decisionKind === "HUMAN_CONFIRMATION";
        const target = request.target;
        if (!human) {
            if (request.humanDecision !== undefined || request.decision !== undefined) {
                throw config(
                    `${op}: response ${s.responseId} (${s.itemCode}) pins decision_kind '${rule.decisionKind}'; HUMAN ` +
                        "decision parameters never apply to an AUTO cell",
                );
            }
            return;
        }
        if (target.kind === "notApplicable") {
            if (request.decision !== "NOT_APPLICABLE") {
                throw new DomainError(
                    APP_ERR.HUMAN_NEEDS_DECISION,
                    `${op}: response ${s.responseId} (${s.itemCode}) is a HUMAN_CONFIRMATION cell; correcting it to NA ` +
                        "requires the explicit decision='NOT_APPLICABLE' (never a blind overlay-state swap)",
                );
            }
            if (request.humanDecision !== undefined) {
                throw config(`${op}: decision='NOT_APPLICABLE' and humanDecision='APPLICABLE' are mutually exclusive`);
            }
            return;
        }
        if (s.overlayState === "NA") {
            if (request.humanDecision !== "APPLICABLE") {
                throw new DomainError(
                    APP_ERR.HUMAN_NEEDS_DECISION,
                    `${op}: response ${s.responseId} (${s.itemCode}) is HUMAN-decided NA; leaving NA towards an answer / ` +
                        "deliberate NOT_INSPECTED requires the explicit humanDecision='APPLICABLE' in the same correction",
                );
            }
            return;
        }
        if (request.decision !== undefined) {
            throw config(
                `${op}: decision='NOT_APPLICABLE' is only valid when the corrected cell actually enters NA ` +
                    `(durable state of ${s.itemCode} is not NA)`,
            );
        }
        // humanDecision='APPLICABLE' on a non-NA durable HUMAN cell is a
        // harmless redundant restatement (the cell is already APPLICABLE-resolved)
    }

    // -----------------------------------------------------------------------
    // T6-VOID internals
    // -----------------------------------------------------------------------

    /** request-shape validation of a void response correction (durable still NC). */
    private async validateVoidResponseShape(
        correction: Extract<VoidLastSourceInput["correction"], { kind: "response" }>,
        s: CellSnapshot,
    ): Promise<void> {
        const op = "voidOpenFindingByLastSourceCorrection";
        const request = correction.request;
        const target = request.target;
        if (target.kind === "answer") {
            const value = await this.resolveAllowedValue(s.itemDefinitionId, target.allowedValueId, op);
            if (value.semanticClass !== "COMPLIANT") {
                throw config(
                    `${op}: the terminal correction of the LAST source must leave the NON_COMPLIANT state (NC -> ` +
                        "COMPLIANT / HUMAN NA / deliberate NOT_INSPECTED); an NC target keeps the source valid — use " +
                        "rehomeLastSourceAndVoidFinding (T6-REHOME)",
                );
            }
            if (s.responseModel === "SCHEDULE") {
                this.validateReconciliationRows(request.rows ?? [], "COMPLIANT", op);
            } else if ((request.rows ?? []).length > 0) {
                throw config(`${op}: reconciliation rows belong only to SCHEDULE responses`);
            }
        } else if (target.kind === "notApplicable") {
            const rule = parseApplicabilityRule(s.applicabilityRule);
            if (rule.decisionKind !== "HUMAN_CONFIRMATION") {
                throw config(
                    `${op}: response ${s.responseId} (${s.itemCode}) pins decision_kind '${rule.decisionKind}'; an NA ` +
                        "terminal correction is valid only through the HUMAN NOT_APPLICABLE decision",
                );
            }
        } else {
            if (normalizeText(target.reason) === null) {
                throw config(`${op}: a deliberate NOT_INSPECTED terminal correction requires a meaningful reason`);
            }
            if (normalizeText(request.note) !== null) {
                throw config(`${op}: a deliberate NOT_INSPECTED terminal correction carries no note`);
            }
        }
    }

    /** in-tx revalidation of F_old + the source + the requested correction. */
    private async planVoidInsideTx(
        input: VoidLastSourceInput,
        event: ValidatedEvent,
    ): Promise<{ fOld: FindingSnapshot; responseSnap: CellSnapshot | null; obsSnap: ObservationSnapshot | null; voidRows: ReconRow[] }> {
        const op = "voidOpenFindingByLastSourceCorrection";
        const fOld = await this.readFinding(input.findingId);
        if (fOld.status !== "OPEN") {
            throw stateConflict(
                `${op}: F_old ${input.findingId} has status '${fOld.status}'; the last-source VOID applies only to an ` +
                    "OPEN finding (IN_TREATMENT/RESOLVED retraction stays refused in v1)",
            );
        }
        this.assertFindingOriginVisitOpen(fOld, op);
        const caCount = await this.countCorrectiveActions(input.findingId);
        if (caCount > 0) throw hasActions(input.findingId, caCount);

        if (input.correction.kind === "response") {
            const s = await this.readCellByRef(input.correction.cell);
            this.assertVisitPreparation(s, op);
            if (s.findingId !== input.findingId) {
                throw stateConflict(
                    `${op}: response ${s.responseId} (${s.itemCode}) is linked to finding ${s.findingId === null ? "NULL" : s.findingId}, ` +
                        `not to F_old ${input.findingId}`,
                );
            }
            if (durableClass(s) !== "NON_COMPLIANT") {
                throw stateConflict(
                    `${op}: response ${s.responseId} (${s.itemCode}) is not answered NON_COMPLIANT — only a NON_COMPLIANT ` +
                        "source can be corrected to a terminal non-source state",
                );
            }
            await this.validateVoidResponseShape(input.correction, s);
            this.assertTransitionLegal(s, input.correction.request, op);
            this.assertHumanGates(s, input.correction.request, op);
            // the corrected reconciliation set for a terminal COMPLIANT shape
            // (validated against the pinned SCHEDULE cell); overlay terminal
            // shapes carry zero target rows — the old rows are DELETED inside
            // the transaction (legal while the Visit is PREPARATION)
            let voidRows: ReconRow[] = [];
            if (s.responseModel === "SCHEDULE" && input.correction.request.target.kind === "answer") {
                voidRows = this.validateReconciliationRows(input.correction.request.rows ?? [], "COMPLIANT", op);
            }
            const total = await this.countSources(input.findingId);
            if (total !== 1) {
                throw lastSource(
                    `${op}: F_old ${input.findingId} has ${total} source(s); the VOID branch requires the corrected/retracted ` +
                        "source to be its LAST source — with other sources an ordinary correction/re-home applies (never void)",
                );
            }
            return { fOld, responseSnap: s, obsSnap: null, voidRows };
        }
        const o = await this.readObservation(input.correction.observationId);
        this.assertObservationVisitPreparation(o, op);
        if (o.findingId !== input.findingId) {
            throw stateConflict(
                `${op}: observation ${o.observationId} is linked to finding ${o.findingId === null ? "NULL" : o.findingId}, ` +
                    `not to F_old ${input.findingId}`,
            );
        }
        await this.validateObsRideAlong(o, input.correction, op);
        const total = await this.countSources(input.findingId);
        if (total !== 1) {
            throw lastSource(
                `${op}: F_old ${input.findingId} has ${total} source(s); the VOID branch requires the retracted observation ` +
                    "to be its LAST source — with other sources an ordinary correction/re-home applies (never void)",
            );
        }
        return { fOld, responseSnap: null, obsSnap: o, voidRows: [] };
    }

    /** apply the T6-VOID source correction (guarded single-row + SCHEDULE rows). */
    private async applyVoidSourceCorrection(
        input: VoidLastSourceInput,
        plan: { responseSnap: CellSnapshot | null; obsSnap: ObservationSnapshot | null; voidRows: ReconRow[] },
    ): Promise<SqlResult> {
        if (input.correction.kind === "response") {
            const s = plan.responseSnap!;
            const request = input.correction.request;
            const durableRows = s.responseModel === "SCHEDULE" ? await this.readReconRows(s.responseId) : [];
            if (request.target.kind === "answer") {
                // NC -> COMPLIANT terminal shape: replace the complete row set
                // BEFORE the overall disposition (a discrepancy row may never
                // coexist with COMPLIANT, even transiently)
                await this.replaceReconRows(s.responseId, durableRows, plan.voidRows);
                return this.updateResponseToTarget(s, request, null, "voidOpenFindingByLastSourceCorrection");
            }
            // overlay terminal shape (NA / NOT_INSPECTED): the corrected state
            // has ZERO rows — delete the old set first, then set the overlay
            await this.deleteReconRows(s.responseId, durableRows);
            return this.updateResponseToTarget(s, request, null, "voidOpenFindingByLastSourceCorrection");
        }
        const o = plan.obsSnap!;
        return this.updateObservationRetract(o, input.correction);
    }

    /** guarded obs retraction (finding_id -> NULL; optional explicit ride-along). */
    private async updateObservationRetract(
        o: ObservationSnapshot,
        correction: Extract<VoidLastSourceInput["correction"], { kind: "observation" }>,
    ): Promise<SqlResult> {
        const text = correction.correctedText !== undefined ? this.meaningfulText(correction.correctedText) : o.text;
        const subject = correction.correctedSubjectId !== undefined ? correction.correctedSubjectId : o.subjectId;
        if (subject !== null && subject !== o.subjectId) {
            await this.assertSubjectOfInstitution(subject, o.visitInstitutionId);
        }
        return this.db.run(
            `UPDATE adhoc_observation
                SET finding_id = NULL, text = ?, subject_id = ?
              WHERE observation_id = ? AND finding_id = ?`,
            [text, subject, o.observationId, o.findingId],
        );
    }

    private async validateObsRideAlong(
        o: ObservationSnapshot,
        correction:
            | Extract<VoidLastSourceInput["correction"], { kind: "observation" }>
            | Extract<CorrectionSource, { kind: "observation" }>,
        op: string,
    ): Promise<void> {
        if (correction.correctedText !== undefined && normalizeText(correction.correctedText) === null) {
            throw config(`${op}: an explicitly corrected observation text must be meaningful (non-blank)`);
        }
        if (correction.correctedSubjectId !== undefined && correction.correctedSubjectId !== null && correction.correctedSubjectId !== o.subjectId) {
            await this.assertSubjectOfInstitution(correction.correctedSubjectId, o.visitInstitutionId);
        }
    }

    private async assertSubjectOfInstitution(subjectId: number, institutionId: number): Promise<void> {
        const rows = await this.db.query(`SELECT institution_id FROM inspected_subject WHERE subject_id = ?`, [subjectId]);
        if (rows.length === 0) {
            throw config(`corrected subject ${subjectId} does not exist`);
        }
        if (Number(rows[0].institution_id) !== institutionId) {
            throw new DomainError(
                APP_ERR.CONTEXT,
                `corrected subject ${subjectId} belongs to another institution than the source visit (E_CONTEXT)`,
            );
        }
    }

    // -----------------------------------------------------------------------
    // re-home planning (ordinary + last-source)
    // -----------------------------------------------------------------------

    /** in-tx revalidation shared by rehomeSource and rehomeLastSourceAndVoidFinding. */
    private async planRehomeInsideTx(
        input: RehomeSourceInput | RehomeLastSourceInput,
        opts: { voidOld: boolean },
    ): Promise<{
        fOld: FindingSnapshot;
        responseSnap: CellSnapshot | null;
        obsSnap: ObservationSnapshot | null;
        target: RehomeFindingTarget;
        sourceVisitId: number;
        sourceSubjectId: number | null;
    }> {
        const op = opts.voidOld ? "rehomeLastSourceAndVoidFinding" : "rehomeSource";
        const source = input.source;
        let fOldId: number;
        let responseSnap: CellSnapshot | null = null;
        let obsSnap: ObservationSnapshot | null = null;
        let sourceSubjectId: number | null;
        let sourceVisitId: number;
        if (source.kind === "response") {
            responseSnap = await this.readCellByRef(source.cell);
            this.assertVisitPreparation(responseSnap, op);
            if (durableClass(responseSnap) !== "NON_COMPLIANT" || responseSnap.findingId === null) {
                throw stateConflict(
                    `${op}: response ${responseSnap.responseId} (${responseSnap.itemCode}) is not an answered NON_COMPLIANT ` +
                        "Finding source (a re-home moves an existing source only — it never changes the answered value)",
                );
            }
            fOldId = responseSnap.findingId;
            sourceSubjectId = responseSnap.subjectId;
            sourceVisitId = responseSnap.visitId;
        } else {
            obsSnap = await this.readObservation(source.observationId);
            this.assertObservationVisitPreparation(obsSnap, op);
            if (obsSnap.findingId === null) {
                throw stateConflict(`${op}: observation ${obsSnap.observationId} is not linked to any finding — nothing to re-home`);
            }
            fOldId = obsSnap.findingId;
            // an explicitly requested ride-along correction is validated before
            // it governs target compatibility / the guarded write
            await this.validateObsRideAlong(obsSnap, source, op);
            // a corrected subject (explicit ride-along) governs target compatibility
            sourceSubjectId = this.obsFinalSubject(obsSnap, source);
            sourceVisitId = obsSnap.visitId;
        }
        const fOld = await this.readFinding(fOldId);
        if (opts.voidOld) {
            if (fOld.status !== "OPEN") {
                throw stateConflict(
                    `${op}: F_old ${fOldId} has status '${fOld.status}'; the last-source re-home+VOID applies only to an ` +
                        "OPEN finding (IN_TREATMENT/RESOLVED last-source moves stay refused in v1)",
                );
            }
            this.assertFindingOriginVisitOpen(fOld, op);
            const caCount = await this.countCorrectiveActions(fOldId);
            if (caCount > 0) throw hasActions(fOldId, caCount);
        }
        // source-count discipline (both source tables)
        const total = await this.countSources(fOldId);
        if (opts.voidOld) {
            if (total !== 1) {
                throw lastSource(
                    `${op}: F_old ${fOldId} has ${total} source(s); the dedicated re-home+VOID branch requires this source ` +
                        "to be the LAST one — with other sources ordinary rehomeSource applies",
                );
            }
        } else {
            const otherSources = total - 1; // this source is currently linked
            if (otherSources === 0) {
                if (fOld.status !== "OPEN") {
                    throw stateConflict(
                        `${op}: the source is the LAST recorded source of finding ${fOldId} (status '${fOld.status}'); ` +
                            "moving the last source of an IN_TREATMENT/RESOLVED finding stays refused in v1",
                    );
                }
                throw lastSource(
                    `${op}: the source is the LAST recorded source of OPEN finding ${fOldId}; an ordinary re-home is ` +
                        "forbidden here — use rehomeLastSourceAndVoidFinding (T6-REHOME)",
                );
            }
        }
        // target validation (existing: full admissibility; new: explicit data only)
        const target = input.target;
        if (target.mode === "existing") {
            // runtime guard (defensive — the type already demands `true`): the
            // inspector's explicit covers-same-issue confirmation is never
            // replaced by an automatic semantic inference
            if (target.coversSameIssueConfirmed !== true) {
                throw new DomainError(
                    APP_ERR.FINDING_TARGET_INVALID,
                    `${op}: re-homing onto an existing Finding requires the inspector's explicit ` +
                        "covers-same-issue confirmation (never an automatic semantic inference)",
                );
            }
            if (target.findingId === fOldId) {
                throw new DomainError(
                    APP_ERR.FINDING_TARGET_INVALID,
                    `${op}: target finding ${target.findingId} IS the source's current finding F_old — a re-home needs a ` +
                        "different Finding (never a self-re-home)",
                );
            }
            const sourceSnap = responseSnap ?? obsSnap!;
            await this.validateExistingTarget(sourceSnap, target.findingId, op, sourceSubjectId);
        } else {
            this.validateNewFindingDraft(target.finding, op);
        }
        return { fOld, responseSnap, obsSnap, target, sourceVisitId, sourceSubjectId };
    }

    /** INSERT the NEW target when requested (nothing defaulted); else existing id. */
    private async ensureTargetFinding(plan: { target: RehomeFindingTarget; sourceVisitId: number; sourceSubjectId: number | null }, createdBy: string, createdAt: string): Promise<number> {
        if (plan.target.mode === "existing") return plan.target.findingId;
        const f = plan.target.finding;
        const draft = this.normalizeNewFinding(f);
        const res = await this.db.run(
            `INSERT INTO finding(origin_visit_id, description, defect_type, defect_type_other, location,
                                 subject_id, urgency, impact, status, status_changed_at, created_at, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', NULL, ?, ?)`,
            [
                plan.sourceVisitId,
                draft.description,
                draft.defectType,
                draft.defectTypeOther,
                draft.location,
                plan.sourceSubjectId,
                draft.urgency,
                draft.impact,
                createdAt,
                createdBy,
            ] as readonly SqlValue[],
        );
        this.guardInsert(res, "target finding");
        if (res.lastInsertRowid === null) throw stateConflict("re-home: new target finding insert returned no rowid");
        return Number(res.lastInsertRowid);
    }

    /** guarded source re-assignment (response: finding_id only; obs: optional ride-along). */
    private async applyReassignment(
        input: RehomeSourceInput | RehomeLastSourceInput,
        plan: { responseSnap: CellSnapshot | null; obsSnap: ObservationSnapshot | null; fOld: FindingSnapshot },
        targetFindingId: number,
    ): Promise<SqlResult> {
        if (plan.responseSnap !== null) {
            return this.db.run(
                `UPDATE checklist_response
                    SET finding_id = ?
                  WHERE response_id = ? AND finding_id = ?
                    AND (SELECT v.status FROM visit v WHERE v.visit_id = checklist_response.visit_id) = 'PREPARATION'
                    AND (SELECT v.finalized_at FROM visit v WHERE v.visit_id = checklist_response.visit_id) IS NULL`,
                [targetFindingId, plan.responseSnap.responseId, plan.fOld.findingId],
            );
        }
        const o = plan.obsSnap!;
        const obsSource = input.source.kind === "observation" ? input.source : null;
        const text = obsSource?.correctedText !== undefined ? this.meaningfulText(obsSource.correctedText) : o.text;
        const subject = obsSource?.correctedSubjectId !== undefined ? obsSource.correctedSubjectId : o.subjectId;
        if (subject !== null && subject !== o.subjectId) {
            await this.assertSubjectOfInstitution(subject, o.visitInstitutionId);
        }
        return this.db.run(
            `UPDATE adhoc_observation
                SET finding_id = ?, text = ?, subject_id = ?
              WHERE observation_id = ? AND finding_id = ?
                AND (SELECT v.status FROM visit v WHERE v.visit_id = adhoc_observation.visit_id) = 'PREPARATION'
                AND (SELECT v.finalized_at FROM visit v WHERE v.visit_id = adhoc_observation.visit_id) IS NULL`,
            [targetFindingId, text, subject, o.observationId, plan.fOld.findingId],
        );
    }

    // -----------------------------------------------------------------------
    // VOID tail (zero-source verification -> FollowUp -> OPEN -> VOIDED)
    // -----------------------------------------------------------------------

    private async verifyZeroSourcesThenVoid(findingId: number, event: ValidatedEvent, op: string): Promise<void> {
        const remaining = await this.countSources(findingId);
        if (remaining !== 0) {
            throw stateConflict(
                `${op}: F_old ${findingId} still has ${remaining} source(s) after the retraction/re-home — ` +
                    "internal guard violated",
            );
        }
        const fu = await this.db.run(
            `INSERT INTO follow_up(finding_id, status_target, status_after, event_datetime, actor_role,
                                   actor_role_other, actor_name, note, recorded_by)
             VALUES (?, 'FINDING', 'VOIDED', ?, ?, ?, ?, ?, ?)`,
            [
                findingId,
                event.now,
                event.actorRole,
                event.actorRoleOther,
                event.actorName,
                event.note,
                event.recordedBy,
            ] as readonly SqlValue[],
        );
        this.guardInsert(fu, "follow_up");
        const upd = await this.db.run(
            `UPDATE finding
                SET status = 'VOIDED', status_changed_at = ?
              WHERE finding_id = ? AND status = 'OPEN'`,
            [event.now, findingId],
        );
        if (upd.changes !== 1) throw new ZeroRowGuard();
    }

    // -----------------------------------------------------------------------
    // convergence helpers (identical durable target only)
    // -----------------------------------------------------------------------

    private async durableMatchesTarget(
        s: CellSnapshot,
        durableRows: readonly ReconRow[],
        request: CellCorrectionRequest,
        shape: { rows: readonly ReconRow[]; link: LinkExpectation },
    ): Promise<boolean> {
        const target = request.target;
        const link = shape.link;
        if (target.kind === "answer") {
            if (s.overlayState !== null || s.answeredValueId !== target.allowedValueId || s.notInspectedReason !== null) return false;
            if (normalizeText(s.note) !== normalizeText(request.note)) return false;
            if (link.kind === "none" && s.findingId !== null) return false;
            if (link.kind === "existing" && s.findingId !== link.findingId) return false;
            // NEW: a durable finding_id alone is NOT proof of an identical
            // retry — the linked Finding must match the requested creation
            // identity (Gate-5E correction E)
            if (link.kind === "new") {
                if (s.findingId === null) return false;
                if (!(await this.findingMatchesNewDraft(s, link))) return false;
            }
            if (durableRows.length !== shape.rows.length) return false;
            for (let i = 0; i < durableRows.length; i += 1) {
                const a = durableRows[i];
                const b = shape.rows[i];
                if (a.category !== b.category || a.declaredQty !== b.declaredQty || a.observedQty !== b.observedQty ||
                    a.difference !== b.difference || a.discrepancyType !== b.discrepancyType || a.discrepancyDesc !== b.discrepancyDesc) {
                    return false;
                }
            }
            return true;
        }
        if (target.kind === "notInspected") {
            if (s.overlayState !== "NOT_INSPECTED" || s.answeredValueId !== null || s.findingId !== null || s.note !== null) return false;
            if (normalizeText(s.notInspectedReason) !== normalizeText(target.reason)) return false;
            return durableRows.length === 0;
        }
        // notApplicable
        if (s.overlayState !== "NA" || s.answeredValueId !== null || s.notInspectedReason !== null || s.findingId !== null) return false;
        if (normalizeText(s.note) !== normalizeText(request.note)) return false;
        return durableRows.length === 0;
    }

    /**
     * Durable link equality against an existing/new re-home target (with
     * source context). For a NEW target a durable finding_id alone is NOT
     * proof of identity: the immutable semantic creation fields must match the
     * requested target, including created_by (the request-supplied actor) —
     * created_at is deliberately excluded (a retry generates a fresh clock)
     * and the CURRENT status is deliberately not required to be OPEN.
     */
    private async linkMatchesTarget(
        findingId: number,
        target: RehomeFindingTarget,
        sourceVisitId: number,
        sourceSubjectId: number | null,
        createdBy: string,
    ): Promise<boolean> {
        if (target.mode === "existing") return findingId === target.findingId;
        const rows = await this.db.query(
            `SELECT origin_visit_id, description, defect_type, defect_type_other, location, subject_id, urgency, impact, created_by
               FROM finding WHERE finding_id = ?`,
            [findingId],
        );
        if (rows.length === 0) return false;
        const f = rows[0];
        const d = this.normalizeNewFinding(target.finding);
        return (
            Number(f.origin_visit_id) === sourceVisitId &&
            (f.subject_id === null ? sourceSubjectId === null : sourceSubjectId !== null && Number(f.subject_id) === sourceSubjectId) &&
            String(f.description) === d.description &&
            (f.defect_type === null ? d.defectType === null : d.defectType !== null && String(f.defect_type) === d.defectType) &&
            (f.defect_type_other === null ? d.defectTypeOther === null : d.defectTypeOther !== null && String(f.defect_type_other) === d.defectTypeOther) &&
            (f.location === null ? d.location === null : d.location !== null && String(f.location) === d.location) &&
            String(f.urgency) === d.urgency &&
            String(f.impact) === d.impact &&
            String(f.created_by) === createdBy
        );
    }

    /**
     * Gate-5E correction E — durable Finding vs the requested NEW-Finding
     * creation identity (mirror of the Gate-5D rule). created_at and the
     * CURRENT status are deliberately excluded.
     */
    private async findingMatchesNewDraft(s: CellSnapshot, link: Extract<LinkExpectation, { kind: "new" }>): Promise<boolean> {
        if (s.findingId === null) return false;
        const rows = await this.db.query(
            `SELECT origin_visit_id, subject_id, description, defect_type, defect_type_other, location, urgency, impact, created_by
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

    /** durable source of a re-home request that already equals the requested target. */
    private async sourceRehomeDurable(
        source: CorrectionSource,
        target: RehomeFindingTarget,
        voidedFindingId: number | null,
        createdBy: string,
    ): Promise<CorrectionResult | null> {
        if (source.kind === "response") {
            const s = await this.readCellByRef(source.cell);
            if (s.findingId !== null && (await this.linkMatchesTarget(s.findingId, target, s.visitId, s.subjectId, createdBy))) {
                return this.resultOfCell(s, false, { voidedFindingId, createdFindingId: null, followUpCount: 0, rowCount: 0 });
            }
            return null;
        }
        const o = await this.readObservation(source.observationId);
        if (o.findingId === null) return null;
        if (!this.obsCorrectionEquals(o, source)) return null;
        if (await this.linkMatchesTarget(o.findingId, target, o.visitId, this.obsFinalSubject(o, source), createdBy)) {
            return this.resultOfObservation(o, false, { voidedFindingId, createdFindingId: null, followUpCount: 0 });
        }
        return null;
    }

    /**
     * Durable VOID-event identity (Gate-5E correction D): the already-applied
     * VOID FollowUp of F_old must match the requested event/audit identity —
     * status_target/status_after (FINDING/VOIDED), event_datetime, actor_role,
     * actor_role_other (null-safe), actor_name (null-safe), normalized note
     * and recorded_by. A source/F_old state match alone never converges.
     */
    private async voidEventMatches(findingId: number, event: ValidatedEvent): Promise<boolean> {
        const rows = await this.db.query(
            `SELECT event_datetime, actor_role, actor_role_other, actor_name, note, recorded_by
               FROM follow_up
              WHERE finding_id = ? AND status_target = 'FINDING' AND status_after = 'VOIDED'
              ORDER BY followup_id DESC LIMIT 1`,
            [findingId],
        );
        if (rows.length === 0) return false;
        const f = rows[0];
        return (
            String(f.event_datetime) === event.now &&
            String(f.actor_role) === event.actorRole &&
            (f.actor_role_other === null
                ? event.actorRoleOther === null
                : event.actorRoleOther !== null && String(f.actor_role_other) === event.actorRoleOther) &&
            (f.actor_name === null
                ? event.actorName === null
                : event.actorName !== null && String(f.actor_name) === event.actorName) &&
            String(f.note) === event.note &&
            String(f.recorded_by) === event.recordedBy
        );
    }

    /** F_old already VOIDED + status_changed_at == requested event_datetime? */
    private async voidedFindingStateMatches(findingId: number, event: ValidatedEvent): Promise<boolean> {
        const fRows = await this.db.query(`SELECT status, status_changed_at FROM finding WHERE finding_id = ?`, [findingId]);
        if (fRows.length === 0 || String(fRows[0].status) !== "VOIDED") return false;
        return String(fRows[0].status_changed_at) === event.now;
    }

    /** T6-VOID durable convergence: source corrected/retracted + F_old VOIDED + event identity. */
    private async lastSourceVoidConverges(input: VoidLastSourceInput, event: ValidatedEvent): Promise<boolean> {
        if (!(await this.voidedFindingStateMatches(input.findingId, event))) return false;
        if (!(await this.voidEventMatches(input.findingId, event))) return false;
        if (input.correction.kind === "observation") {
            const o = await this.readObservation(input.correction.observationId);
            if (o.findingId !== null) return false;
            return this.obsCorrectionEquals(o, input.correction);
        }
        const s = await this.readCellByRef(input.correction.cell);
        if (s.findingId !== null) return false;
        const request = input.correction.request;
        // structural compare only (no durable-state precondition is required to
        // recognize the identical durable target of a committed VOID)
        if (request.target.kind === "answer") {
            if (s.overlayState !== null || s.answeredValueId !== request.target.allowedValueId || s.notInspectedReason !== null) return false;
            if (normalizeText(s.note) !== normalizeText(request.note)) return false;
            const rows = s.responseModel === "SCHEDULE" ? await this.readReconRows(s.responseId) : [];
            const intended = this.normalizeIntendedRows(request.rows ?? []);
            if (rows.length !== intended.length) return false;
            for (let i = 0; i < rows.length; i += 1) {
                const a = rows[i];
                const b = intended[i];
                if (a.category !== b.category || a.declaredQty !== b.declaredQty || a.observedQty !== b.observedQty ||
                    a.difference !== b.difference || a.discrepancyType !== b.discrepancyType || a.discrepancyDesc !== b.discrepancyDesc) {
                    return false;
                }
            }
            return true;
        }
        if (request.target.kind === "notInspected") {
            if (s.overlayState !== "NOT_INSPECTED" || s.answeredValueId !== null || s.findingId !== null || s.note !== null) return false;
            return normalizeText(s.notInspectedReason) === normalizeText(request.target.reason);
        }
        // notApplicable
        if (s.overlayState !== "NA" || s.answeredValueId !== null || s.notInspectedReason !== null || s.findingId !== null) return false;
        return normalizeText(s.note) === normalizeText(request.note);
    }

    /** T6-REHOME durable convergence: source -> intended target + F_old VOIDED + event identity. */
    private async lastSourceRehomeConverges(input: RehomeLastSourceInput): Promise<CorrectionResult | null> {
        const event = this.validateFollowUpEvent(input.event, "rehomeLastSourceAndVoidFinding");
        if (!(await this.voidedFindingStateMatches(input.findingId, event))) return null;
        if (!(await this.voidEventMatches(input.findingId, event))) return null;
        return this.sourceRehomeDurable(input.source, input.target, input.findingId, event.recordedBy);
    }

    private obsFinalSubject(o: ObservationSnapshot, source: Extract<CorrectionSource, { kind: "observation" }>): number | null {
        return source.correctedSubjectId === undefined ? o.subjectId : source.correctedSubjectId;
    }

    private obsCorrectionEquals(o: ObservationSnapshot, source: Extract<CorrectionSource, { kind: "observation" }>): boolean {
        if (source.correctedText !== undefined) {
            const t = normalizeText(source.correctedText);
            if (t === null || o.text !== t) return false;
        }
        if (source.correctedSubjectId !== undefined && o.subjectId !== source.correctedSubjectId) return false;
        return true;
    }

    // -----------------------------------------------------------------------
    // result assembly (from durable state — never from hypothetical snapshots)
    // -----------------------------------------------------------------------

    private resultOfCell(
        s: CellSnapshot,
        applied: boolean,
        extra: { voidedFindingId: number | null; createdFindingId: number | null; followUpCount: number; rowCount: number },
    ): CorrectionResult {
        return {
            applied,
            sourceKind: "response",
            responseId: s.responseId,
            observationId: null,
            overlayState: s.overlayState,
            answeredValueId: s.answeredValueId,
            note: s.note,
            notInspectedReason: s.notInspectedReason,
            findingId: s.findingId,
            reconciliationRowCount: extra.rowCount,
            voidedFindingId: extra.voidedFindingId,
            createdFindingId: extra.createdFindingId,
            followUpCount: extra.followUpCount,
        };
    }

    private resultOfObservation(
        o: ObservationSnapshot,
        applied: boolean,
        extra: { voidedFindingId: number | null; createdFindingId: number | null; followUpCount: number },
    ): CorrectionResult {
        return {
            applied,
            sourceKind: "observation",
            responseId: null,
            observationId: o.observationId,
            overlayState: null,
            answeredValueId: null,
            note: null,
            notInspectedReason: null,
            findingId: o.findingId,
            reconciliationRowCount: 0,
            voidedFindingId: extra.voidedFindingId,
            createdFindingId: extra.createdFindingId,
            followUpCount: extra.followUpCount,
        };
    }

    private async resultOfVoidConverged(input: VoidLastSourceInput): Promise<CorrectionResult> {
        if (input.correction.kind === "response") {
            const s = await this.readCellByRef(input.correction.cell);
            const rows = s.responseModel === "SCHEDULE" ? await this.readReconRows(s.responseId) : [];
            return this.resultOfCell(s, false, { voidedFindingId: input.findingId, createdFindingId: null, followUpCount: 0, rowCount: rows.length });
        }
        const o = await this.readObservation(input.correction.observationId);
        return this.resultOfObservation(o, false, { voidedFindingId: input.findingId, createdFindingId: null, followUpCount: 0 });
    }

    /** post-commit result of an applied VOID (durable source state is authoritative). */
    private async assembleVoidResult(input: VoidLastSourceInput, applied: boolean, voidedFindingId: number, createdFindingId: number | null): Promise<CorrectionResult> {
        if (input.correction.kind === "response") {
            const s = await this.readCellByRef(input.correction.cell);
            const rows = s.responseModel === "SCHEDULE" ? await this.readReconRows(s.responseId) : [];
            return this.resultOfCell(s, applied, { voidedFindingId, createdFindingId, followUpCount: 1, rowCount: rows.length });
        }
        const o = await this.readObservation(input.correction.observationId);
        return this.resultOfObservation(o, applied, { voidedFindingId, createdFindingId, followUpCount: 1 });
    }

    /** post-commit result of an applied re-home (ordinary or T6-REHOME). */
    private async assembleSourceResult(
        source: CorrectionSource,
        applied: boolean,
        extra: { voidedFindingId: number | null; createdFindingId: number | null; followUpCount: number },
    ): Promise<CorrectionResult> {
        if (source.kind === "response") {
            const s = await this.readCellByRef(source.cell);
            return this.resultOfCell(s, applied, { ...extra, rowCount: 0 });
        }
        const o = await this.readObservation(source.observationId);
        return this.resultOfObservation(o, applied, extra);
    }

    // -----------------------------------------------------------------------
    // reads (pre-tx fast paths AND in-tx admissibility re-reads)
    // -----------------------------------------------------------------------

    private async readCellByRef(ref: ResponseCellRef): Promise<CellSnapshot> {
        const subjectWhere = ref.subjectId === null ? "cr.subject_id IS NULL" : "cr.subject_id = ?";
        const params: SqlValue[] =
            ref.subjectId === null ? [ref.visitId, ref.itemDefinitionId] : [ref.visitId, ref.itemDefinitionId, ref.subjectId];
        const rows = await this.db.query(
            `SELECT cr.response_id, cr.visit_id, cr.item_definition_id, cr.subject_id,
                    cr.overlay_state, cr.answered_value_id, cr.note, cr.not_inspected_reason, cr.finding_id,
                    cr.recorded_at, cr.recorded_by,
                    v.status AS visit_status, v.finalized_at AS visit_finalized_at,
                    v.institution_id AS visit_institution_id,
                    d.item_code, d.response_model, d.applicability_rule,
                    av.semantic_class AS answered_class
               FROM checklist_response cr
               JOIN visit v ON v.visit_id = cr.visit_id
               JOIN checklist_item_definition d ON d.item_definition_id = cr.item_definition_id
               LEFT JOIN checklist_allowed_value av ON av.allowed_value_id = cr.answered_value_id
              WHERE cr.visit_id = ? AND cr.item_definition_id = ? AND ${subjectWhere}`,
            params,
        );
        if (rows.length === 0) {
            throw new DomainError(
                APP_ERR.CELL_NOT_MATERIALIZED,
                `no materialized checklist_response cell for (visit ${ref.visitId}, item_definition ${ref.itemDefinitionId}, ` +
                    `subject ${ref.subjectId === null ? "NULL" : ref.subjectId}); corrections never INSERT a scope cell`,
            );
        }
        const r = rows[0];
        return {
            responseId: Number(r.response_id),
            visitId: Number(r.visit_id),
            itemDefinitionId: Number(r.item_definition_id),
            subjectId: r.subject_id === null ? null : Number(r.subject_id),
            overlayState: (r.overlay_state as "NA" | "NOT_INSPECTED" | null) ?? null,
            answeredValueId: r.answered_value_id === null ? null : Number(r.answered_value_id),
            answeredClass: r.answered_class === null ? null : (String(r.answered_class) as SemanticClass),
            note: r.note === null ? null : String(r.note),
            notInspectedReason: r.not_inspected_reason === null ? null : String(r.not_inspected_reason),
            findingId: r.finding_id === null ? null : Number(r.finding_id),
            recordedAt: String(r.recorded_at),
            recordedBy: String(r.recorded_by),
            visitStatus: String(r.visit_status),
            visitFinalizedAt: r.visit_finalized_at === null ? null : String(r.visit_finalized_at),
            visitInstitutionId: Number(r.visit_institution_id),
            itemCode: String(r.item_code),
            responseModel: String(r.response_model),
            applicabilityRule: String(r.applicability_rule),
        };
    }

    private async readObservation(observationId: number): Promise<ObservationSnapshot> {
        const rows = await this.db.query(
            `SELECT o.observation_id, o.visit_id, o.subject_id, o.text, o.finding_id, o.recorded_at, o.recorded_by,
                    v.status AS visit_status, v.finalized_at AS visit_finalized_at,
                    v.institution_id AS visit_institution_id
               FROM adhoc_observation o
               JOIN visit v ON v.visit_id = o.visit_id
              WHERE o.observation_id = ?`,
            [observationId],
        );
        if (rows.length === 0) {
            throw new DomainError(APP_ERR.CONFIG, `corrections: observation ${observationId} does not exist`);
        }
        const r = rows[0];
        return {
            observationId: Number(r.observation_id),
            visitId: Number(r.visit_id),
            subjectId: r.subject_id === null ? null : Number(r.subject_id),
            text: String(r.text),
            findingId: r.finding_id === null ? null : Number(r.finding_id),
            recordedAt: String(r.recorded_at),
            recordedBy: String(r.recorded_by),
            visitStatus: String(r.visit_status),
            visitFinalizedAt: r.visit_finalized_at === null ? null : String(r.visit_finalized_at),
            visitInstitutionId: Number(r.visit_institution_id),
        };
    }

    private async readFinding(findingId: number): Promise<FindingSnapshot> {
        const rows = await this.db.query(
            `SELECT f.finding_id, f.status, f.origin_visit_id, f.subject_id,
                    (SELECT v.institution_id FROM visit v WHERE v.visit_id = f.origin_visit_id) AS origin_institution_id,
                    (SELECT v.status FROM visit v WHERE v.visit_id = f.origin_visit_id) AS origin_visit_status,
                    (SELECT v.finalized_at FROM visit v WHERE v.visit_id = f.origin_visit_id) AS origin_visit_finalized_at
               FROM finding f
              WHERE f.finding_id = ?`,
            [findingId],
        );
        if (rows.length === 0) {
            throw new DomainError(APP_ERR.FINDING_NOT_FOUND, `corrections: finding ${findingId} does not exist`);
        }
        const r = rows[0];
        return {
            findingId: Number(r.finding_id),
            status: String(r.status),
            originVisitId: Number(r.origin_visit_id),
            subjectId: r.subject_id === null ? null : Number(r.subject_id),
            originInstitutionId: Number(r.origin_institution_id),
            originVisitStatus: String(r.origin_visit_status),
            originVisitFinalizedAt: r.origin_visit_finalized_at === null ? null : String(r.origin_visit_finalized_at),
        };
    }

    private async readReconRows(responseId: number): Promise<ReconRow[]> {
        const rows = await this.db.query(
            `SELECT row_id, category, declared_qty, observed_qty, difference, discrepancy_type, discrepancy_desc
               FROM equipment_reconciliation_row
              WHERE response_id = ?
              ORDER BY sort_order, row_id`,
            [responseId],
        );
        return rows.map((r) => ({
            rowId: Number(r.row_id),
            category: String(r.category),
            declaredQty: Number(r.declared_qty),
            observedQty: Number(r.observed_qty),
            difference: Number(r.difference),
            discrepancyType: r.discrepancy_type === null ? null : String(r.discrepancy_type),
            discrepancyDesc: r.discrepancy_desc === null ? null : String(r.discrepancy_desc),
        }));
    }

    private async countSources(findingId: number): Promise<number> {
        const rows = await this.db.query(
            `SELECT (SELECT count(*) FROM checklist_response WHERE finding_id = ?) +
                    (SELECT count(*) FROM adhoc_observation WHERE finding_id = ?) AS c`,
            [findingId, findingId],
        );
        return Number(rows[0].c);
    }

    private async countCorrectiveActions(findingId: number): Promise<number> {
        const rows = await this.db.query(`SELECT count(*) AS c FROM corrective_action WHERE finding_id = ?`, [findingId]);
        return Number(rows[0].c);
    }

    // -----------------------------------------------------------------------
    // validators
    // -----------------------------------------------------------------------

    private async resolveAllowedValue(itemDefinitionId: number, allowedValueId: number, op: string): Promise<AllowedValueSnapshot> {
        const rows = await this.db.query(
            `SELECT allowed_value_id, value_code, semantic_class
               FROM checklist_allowed_value
              WHERE allowed_value_id = ? AND item_definition_id = ?`,
            [allowedValueId, itemDefinitionId],
        );
        if (rows.length === 0) {
            throw config(
                `${op}: allowed_value_id ${allowedValueId} does not belong to the pinned item_definition_id ${itemDefinitionId} ` +
                    "(every corrected value must come from the pinned definition's allowed values)",
            );
        }
        return {
            allowedValueId: Number(rows[0].allowed_value_id),
            valueCode: String(rows[0].value_code),
            semanticClass: String(rows[0].semantic_class) as SemanticClass,
        };
    }

    private async resolveFindingExpectation(
        s: CellSnapshot,
        selection: FindingSelection | undefined,
        actor: string | undefined,
        now: string | undefined,
        op: string,
    ): Promise<LinkExpectation> {
        const sel = selection ?? { mode: "none" as const };
        if (sel.mode === "none") {
            throw config(
                `${op}: NON_COMPLIANT corrected answer of ${s.itemCode} requires Finding accountability — ` +
                    "supply finding.mode='new' or finding.mode='existing' (an NC answer never stands without a Finding)",
            );
        }
        if (sel.mode === "new") {
            this.validateNewFindingDraft(sel.finding, op);
            if (typeof actor !== "string" || actor.trim().length === 0 || typeof now !== "string" || now.trim().length === 0) {
                throw config(`${op}: a NEW Finding requires op-level actor and now (app-supplied creation audit)`);
            }
            return { kind: "new", draft: this.normalizeNewFinding(sel.finding), createdBy: actor, createdAt: now };
        }
        if (sel.coversSameIssueConfirmed !== true) {
            throw new DomainError(
                APP_ERR.FINDING_TARGET_INVALID,
                `${op}: linking NON_COMPLIANT ${s.itemCode} to an existing Finding requires the inspector's explicit ` +
                    "covers-same-issue confirmation (never an automatic semantic inference)",
            );
        }
        return { kind: "existing", findingId: sel.findingId };
    }

    private requireNewFindingAudit(actor: string | undefined, now: string | undefined, op: string): void {
        if (typeof actor !== "string" || actor.trim().length === 0 || typeof now !== "string" || now.trim().length === 0) {
            throw config(`${op}: a NEW target Finding requires op-level actor and now (app-supplied creation audit)`);
        }
    }

    private validateNewFindingDraft(f: NewFindingInput, op: string): void {
        if (normalizeText(f.description) === null) {
            throw config(`${op}: a NEW Finding requires a meaningful description`);
        }
        if (!(FINDING_URGENCIES as readonly string[]).includes(f.urgency)) {
            throw config(`${op}: finding urgency must be one of ${FINDING_URGENCIES.join(" | ")}`);
        }
        if (!(FINDING_IMPACTS as readonly string[]).includes(f.impact)) {
            throw config(`${op}: finding impact must be one of ${FINDING_IMPACTS.join(" | ")}`);
        }
        if (f.defectType !== undefined && f.defectType !== null && !(FINDING_DEFECT_TYPES as readonly string[]).includes(f.defectType)) {
            throw config(`${op}: finding defect_type must be one of ${FINDING_DEFECT_TYPES.join(" | ")}`);
        }
        if (f.defectType === "OTHER" && normalizeText(f.defectTypeOther) === null) {
            throw config(`${op}: defect_type=OTHER requires a meaningful defect_type_other`);
        }
    }

    /** NEW Finding fields are explicit; nothing is invented or defaulted. */
    private normalizeNewFinding(f: NewFindingInput): NewFindingDraft {
        let defectType: string | null = null;
        if (f.defectType !== undefined && f.defectType !== null) defectType = f.defectType;
        return {
            description: normalizeText(f.description)!,
            defectType,
            defectTypeOther: normalizeText(f.defectTypeOther ?? null),
            location: normalizeText(f.location ?? null),
            urgency: f.urgency,
            impact: f.impact,
        };
    }

    private validateReconciliationRows(input: readonly ReconciliationRowInput[], overall: SemanticClass, op: string): ReconRow[] {
        const rows: ReconRow[] = [];
        for (const [i, r] of input.entries()) {
            const category = normalizeText(r.category);
            if (category === null) throw config(`${op}: reconciliation row ${i + 1} requires a meaningful category`);
            if (!Number.isInteger(r.declaredQty) || r.declaredQty < 0) {
                throw config(`${op}: row ${i + 1} declared_qty must be a non-negative integer`);
            }
            if (!Number.isInteger(r.observedQty) || r.observedQty < 0) {
                throw config(`${op}: row ${i + 1} observed_qty must be a non-negative integer`);
            }
            const difference = r.observedQty - r.declaredQty;
            let type: string | null = null;
            if (r.discrepancyType !== undefined && r.discrepancyType !== null) {
                if (!(RECON_DISCREPANCY_TYPES as readonly string[]).includes(r.discrepancyType)) {
                    throw config(`${op}: row ${i + 1} discrepancy_type must be one of ${RECON_DISCREPANCY_TYPES.join(" | ")}`);
                }
                type = r.discrepancyType;
            }
            const desc = normalizeText(r.discrepancyDesc);
            if (type === "OTHER" && desc === null) {
                throw config(`${op}: row ${i + 1} discrepancy_type=OTHER requires a meaningful discrepancy_desc`);
            }
            if (overall === "COMPLIANT" && (difference !== 0 || type !== null)) {
                throw config(
                    `${op}: overall COMPLIANT may not carry a discrepancy row (row ${i + 1}: difference ${difference}, ` +
                        `type ${type ?? "NULL"})`,
                );
            }
            rows.push({ rowId: -1, category, declaredQty: r.declaredQty, observedQty: r.observedQty, difference, discrepancyType: type, discrepancyDesc: desc });
        }
        return rows;
    }

    /** structural row normalization used by durable-target comparisons (no throwing). */
    private normalizeIntendedRows(input: readonly ReconciliationRowInput[]): ReconRow[] {
        return input.map((r) => ({
            rowId: -1,
            category: normalizeText(r.category) ?? "",
            declaredQty: r.declaredQty,
            observedQty: r.observedQty,
            difference: r.observedQty - r.declaredQty,
            discrepancyType: r.discrepancyType === undefined || r.discrepancyType === null ? null : r.discrepancyType,
            discrepancyDesc: normalizeText(r.discrepancyDesc ?? null),
        }));
    }

    private assertVisitPreparation(s: CellSnapshot, op: string): void {
        if (s.visitStatus !== "PREPARATION" || s.visitFinalizedAt !== null) {
            throw new DomainError(
                APP_ERR.VISIT_NOT_PREPARATION,
                `${op}: visit ${s.visitId} is '${s.visitStatus}'${s.visitFinalizedAt !== null ? " (finalized)" : ""}; ` +
                    "corrections only apply while the source Visit is PREPARATION and not finalized",
            );
        }
    }

    private assertObservationVisitPreparation(o: ObservationSnapshot, op: string): void {
        if (o.visitStatus !== "PREPARATION" || o.visitFinalizedAt !== null) {
            throw new DomainError(
                APP_ERR.VISIT_NOT_PREPARATION,
                `${op}: visit ${o.visitId} of observation ${o.observationId} is '${o.visitStatus}'` +
                    `${o.visitFinalizedAt !== null ? " (finalized)" : ""}; corrections only apply while the source Visit is ` +
                    "PREPARATION and not finalized",
            );
        }
    }

    private assertFindingOriginVisitOpen(f: FindingSnapshot, op: string): void {
        if (f.originVisitStatus !== "PREPARATION" || f.originVisitFinalizedAt !== null) {
            throw new DomainError(
                APP_ERR.VISIT_NOT_PREPARATION,
                `${op}: origin visit ${f.originVisitId} of finding ${f.findingId} is '${f.originVisitStatus}'` +
                    `${f.originVisitFinalizedAt !== null ? " (finalized)" : ""}; the last-source VOID/re-home only applies ` +
                    "while the origin Visit is PREPARATION and not finalized",
            );
        }
    }

    private meaningfulText(v: string): string {
        const t = normalizeText(v);
        if (t === null) throw config("an explicitly corrected observation text must be meaningful (non-blank)");
        return t;
    }

    private validateFollowUpEvent(event: FollowUpEventInput, op: string): ValidatedEvent {
        const now = normalizeText(event.now);
        if (now === null) throw config(`${op}: event.now must be a meaningful ISO-8601 UTC instant`);
        if (!(FOLLOW_UP_ACTOR_ROLES as readonly string[]).includes(event.actorRole)) {
            throw config(`${op}: actor_role must be one of ${FOLLOW_UP_ACTOR_ROLES.join(" | ")}`);
        }
        const roleOther = normalizeText(event.actorRoleOther);
        if (event.actorRole === "OTHER" && roleOther === null) {
            throw config(`${op}: actor_role=OTHER requires a meaningful actor_role_other`);
        }
        const note = normalizeText(event.note);
        if (note === null) throw config(`${op}: a meaningful void/correction note is required (follow_up.note)`);
        const recordedBy = normalizeText(event.recordedBy);
        if (recordedBy === null) throw config(`${op}: recorded_by must be meaningful`);
        return {
            now,
            actorRole: event.actorRole,
            actorRoleOther: roleOther,
            actorName: normalizeText(event.actorName),
            note,
            recordedBy,
        };
    }

    /** one BEGIN IMMEDIATE … COMMIT unit; a ZeroRowGuard rolls back and converges. */
    private async runUnit<TApplied extends { kind: "applied" }, TConverged extends { kind: "converged"; result: CorrectionResult }>(
        work: () => Promise<TApplied | TConverged>,
        converge: () => Promise<TConverged>,
    ): Promise<TApplied | TConverged> {
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
            throw new DomainError(APP_ERR.STATE_CONFLICT, `corrections: ${what} insert expected one row, got ${res.changes}`);
        }
    }
}

/** semantic class of the durable answered value of a cell. */
function durableClass(s: CellSnapshot): SemanticClass | null {
    return s.answeredClass;
}
