// Gate 5F — T7 `createFindingWithObservationSource` (runtime-neutral
// TypeScript, no node:* imports).
//
// Implements the adopted ensure-accounted operation of
// TRANSACTION-CONTRACTS-v1.md §8 / APPLICATION-CORE-v1.md §4.7 for an
// EXISTING AdHocObservation:
//
//   * The durable operation identity is the observation_id: ensure this
//     durable Observation is accounted for by exactly one Finding. T7 is
//     NOT "INSERT a Finding then blindly assign observation.finding_id".
//     It is Class A (RECOVERY §5 / TRANSACTION §12) — a retry after
//     "COMMIT succeeded but ACK lost" never creates a second Finding and
//     never reassigns/orphans the first one.
//
//   * One explicit BEGIN IMMEDIATE … COMMIT/ROLLBACK unit:
//       pre-read the AdHocObservation (missing => E_OBSERVATION_NOT_FOUND)
//       -> already-linked convergence OR new-link eligibility
//       -> INSERT Finding OPEN (only when finding_id IS NULL)
//       -> guarded observation link (changes == 1, B5)
//       -> COMMIT.
//     Every failure rolls the whole unit back.
//
//   * Already-linked branch: NEVER INSERT another Finding, NEVER overwrite /
//     reassign finding_id. The already-linked durable Finding is recognized
//     as the identical historical target ONLY when its immutable semantic
//     creation identity matches the requested NEW-Finding draft (the
//     Gate-5D/5E retry-identity discipline applied consistently to T7):
//       origin_visit_id == observation.visit_id
//       subject_id == observation.subject_id (null-safe)
//       normalized description / defect_type / defect_type_other / location
//       urgency / impact
//       created_by == the request-supplied actor (Gate-5D/5E rule)
//     Deliberately NOT compared: created_at (a retry generates a fresh clock
//     and must not defeat otherwise identical historical convergence) and
//     the Finding's CURRENT status (it may legitimately have transitioned
//     later — recognizing the historical retry never re-authorizes a new
//     link and must not require the Visit to still be PREPARATION merely for
//     retry recognition). A differing semantic target is a typed conflict
//     (E_STATE_CONFLICT) — never silent success, never reassignment.
//
//   * New-relationship branch (observation.finding_id IS NULL): the Visit
//     must be status = PREPARATION AND finalized_at IS NULL — the mutable
//     authorization read happens INSIDE BEGIN IMMEDIATE (Gate-5D review
//     correction B: no TOCTOU window), else E_VISIT_NOT_PREPARATION. The new
//     Finding is INSERTed OPEN with origin_visit_id = observation.visit_id,
//     subject_id = observation.subject_id, explicit created_at/created_by
//     (app-supplied actor/now); urgency/impact are never defaulted. Then the
//     guarded link:
//         UPDATE adhoc_observation SET finding_id = ?
//          WHERE observation_id = ? AND finding_id IS NULL
//     changes != 1 => ROLLBACK immediately (the tentative Finding disappears
//     with the rollback), then re-read the durable Observation: linked and
//     matching the identical requested semantic target => converged
//     idempotent success; otherwise a typed state conflict. No source-less
//     OPEN Finding ever survives COMMIT.
//
//   * First-source / institution integrity holds by construction (the new
//     Finding's origin is the Observation's Visit) and is re-enforced by the
//     schema (trg_finding_bi subject-institution check; trg_obs_finding_bu
//     institution + first-source checks; trg_obs_bu "a VOIDED finding must
//     never regain a source"). T7 carries no reassignment path at all, so no
//     VOIDED target/reassignment is introduced.
//
//   * Out of scope: AdHocObservation creation (no adopted Gate-5A numbered
//     contract exists for it — contract gap), T6 retraction/re-home, T8+
//     transitions, finalization, evidence, UI.
//
// The finding subject equals the observation subject by construction, so
// finding.subject_id = observation.subject_id — including the NULL
// (institution-context) case.

import type { SqlAdapter, SqlResult, SqlValue } from "../bootstrap/adapter.ts";
import { APP_ERR, DomainError } from "./errors.ts";
import {
    FINDING_DEFECT_TYPES,
    FINDING_IMPACTS,
    FINDING_URGENCIES,
    type FindingDefectType,
    type FindingImpact,
    type FindingUrgency,
    type NewFindingInput,
} from "./initial-disposition.ts";

// ---------------------------------------------------------------------------
// public types
// ---------------------------------------------------------------------------

export interface CreateFindingWithObservationSourceInput {
    /** the durable key of the EXISTING AdHocObservation (never created here) */
    observationId: number;
    /** explicit NEW-Finding creation draft — nothing is defaulted */
    finding: NewFindingInput;
    /** app-supplied creation audit: created_by of the (possibly) new Finding */
    actor: string;
    /** app-supplied ISO-8601 UTC instant: created_at of the (possibly) new Finding */
    now: string;
}

export interface ObservationFindingResult {
    observationId: number;
    /** false when the call converged on the already-linked identical durable Finding */
    applied: boolean;
    /** the durable Finding that accounts for this observation */
    findingId: number;
    /** the Finding created by this call (null on a converged retry) */
    createdFindingId: number | null;
}

// ---------------------------------------------------------------------------
// internal model
// ---------------------------------------------------------------------------

/** durable row of the adhoc_observation (+ its Visit authorization context). */
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

/** validated NEW-Finding data (nothing defaulted; all fields normalized). */
interface NewFindingDraft {
    description: string;
    defectType: FindingDefectType | null;
    defectTypeOther: string | null;
    location: string | null;
    urgency: FindingUrgency;
    impact: FindingImpact;
}

/** thrown inside the write unit to force ROLLBACK + durable-state re-read (B5) */
class ZeroRowGuard extends Error {
    constructor() {
        super("guarded observation link affected zero rows (B5)");
        this.name = "ZeroRowGuard";
    }
}

// ---------------------------------------------------------------------------
// normalization / message helpers (Arabic never parsed; only text meaning is
// checked)
// ---------------------------------------------------------------------------

/** trim; blank/missing => null. */
function normalizeText(v: string | null | undefined): string | null {
    if (v === null || v === undefined) return null;
    const t = v.trim();
    return t.length === 0 ? null : t;
}

function config(what: string): DomainError {
    return new DomainError(APP_ERR.CONFIG, `createFindingWithObservationSource: ${what}`);
}

function stateConflict(what: string): DomainError {
    return new DomainError(APP_ERR.STATE_CONFLICT, `createFindingWithObservationSource: ${what}`);
}

// ---------------------------------------------------------------------------
// service
// ---------------------------------------------------------------------------

export class ObservationFindingService {
    private readonly db: SqlAdapter;

    constructor(db: SqlAdapter) {
        this.db = db;
    }

    /**
     * T7 — ensure this durable AdHocObservation is accounted for by exactly
     * one Finding. The observation is the durable operation key: an identical
     * retry (same observationId + same NEW-Finding semantic creation target)
     * converges on the already-linked Finding without any write.
     */
    async createFindingWithObservationSource(
        input: CreateFindingWithObservationSourceInput,
    ): Promise<ObservationFindingResult> {
        const op = "createFindingWithObservationSource";
        // pure request-shape validation only (nothing mutable is read here);
        // every authorization read happens inside the transaction below
        const draft = this.validateNewFinding(input.finding, op);
        const createdBy = this.requireAudit(input.actor, input.now, op);

        return this.runUnit(
            async () => {
                // 1) pre-read the AdHocObservation INSIDE BEGIN IMMEDIATE
                const o = await this.readObservation(input.observationId);

                if (o.findingId !== null) {
                    // 2) already durably linked: NEVER INSERT another Finding,
                    //    NEVER overwrite/reassign finding_id.
                    if (await this.findingMatchesDraft(o.findingId, o, draft, createdBy)) {
                        // identical historical retry — read-only convergence;
                        // the Visit need not still be PREPARATION merely for
                        // retry recognition (no new relationship is created)
                        return { kind: "converged" as const, result: this.resultOf(o, o.findingId, false, null) };
                    }
                    throw stateConflict(
                        `${op}: observation ${o.observationId} is already durably linked to finding ${o.findingId}, whose ` +
                            "immutable semantic creation identity does not match the requested NEW-Finding draft — a " +
                            "conflicting retry never converges and the existing link is never overwritten or reassigned",
                    );
                }

                // 3) new-relationship eligibility: the mutable Visit
                //    authorization read happens inside the transaction (no
                //    TOCTOU window between validation and the guarded link)
                this.assertObservationVisitPreparation(o, op);

                // 4) INSERT the Finding OPEN (origin = the Observation's Visit;
                //    subject context = the Observation's subject context;
                //    created_at/created_by explicit; urgency/impact explicit)
                const fRes = await this.db.run(
                    `INSERT INTO finding(origin_visit_id, description, defect_type, defect_type_other, location,
                                         subject_id, urgency, impact, status, status_changed_at, created_at, created_by)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', NULL, ?, ?)`,
                    [
                        o.visitId,
                        draft.description,
                        draft.defectType,
                        draft.defectTypeOther,
                        draft.location,
                        o.subjectId,
                        draft.urgency,
                        draft.impact,
                        input.now,
                        createdBy,
                    ] as readonly SqlValue[],
                );
                this.guardInsert(fRes, "finding");
                if (fRes.lastInsertRowid === null) {
                    throw stateConflict(`${op}: finding insert returned no rowid`);
                }
                const findingId = Number(fRes.lastInsertRowid);

                // 5) guarded source link (never blindly overwrites an
                //    existing link)
                const link = await this.db.run(
                    `UPDATE adhoc_observation
                        SET finding_id = ?
                      WHERE observation_id = ? AND finding_id IS NULL`,
                    [findingId, o.observationId] as readonly SqlValue[],
                );
                if (link.changes !== 1) throw new ZeroRowGuard();

                return { kind: "applied" as const, result: this.resultOf(o, findingId, true, findingId) };
            },
            async () => {
                // B5: the guarded link changed != 1 rows => the whole unit was
                // rolled back (the tentative Finding disappeared with it);
                // re-read the durable Observation and converge ONLY on the
                // identical durable semantic target
                const durable = await this.readObservation(input.observationId);
                if (
                    durable.findingId !== null &&
                    (await this.findingMatchesDraft(durable.findingId, durable, draft, createdBy))
                ) {
                    return { kind: "converged" as const, result: this.resultOf(durable, durable.findingId, false, null) };
                }
                throw stateConflict(
                    `${op}: the guarded observation link affected zero rows and the durable state does not match ` +
                        "the identical requested target — never blindly overwrite observation.finding_id",
                );
            },
        ).then((outcome) => outcome.result);
    }

    // -- reads / authorization ----------------------------------------------

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
            throw new DomainError(
                APP_ERR.OBSERVATION_NOT_FOUND,
                `createFindingWithObservationSource: observation ${observationId} does not exist (T7 only ensures an ` +
                    "EXISTING AdHocObservation is accounted for; it never creates one)",
            );
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

    /** a NEW source relationship may only be created while the Visit is open. */
    private assertObservationVisitPreparation(o: ObservationSnapshot, op: string): void {
        if (o.visitStatus !== "PREPARATION" || o.visitFinalizedAt !== null) {
            throw new DomainError(
                APP_ERR.VISIT_NOT_PREPARATION,
                `${op}: visit ${o.visitId} of observation ${o.observationId} is '${o.visitStatus}'` +
                    `${o.visitFinalizedAt !== null ? " (finalized)" : ""}; a new Finding source relationship may only ` +
                    "be created while the Visit is PREPARATION and not finalized",
            );
        }
    }

    // -- request-shape validation (pure; nothing mutable is read) -----------

    /** NEW Finding fields are explicit; nothing is invented or defaulted. */
    private validateNewFinding(f: NewFindingInput, op: string): NewFindingDraft {
        const description = normalizeText(f.description);
        if (description === null) {
            throw config(`${op}: a NEW Finding requires a meaningful description`);
        }
        if (!(FINDING_URGENCIES as readonly string[]).includes(f.urgency)) {
            throw config(`${op}: finding urgency must be one of ${FINDING_URGENCIES.join(" | ")} (never defaulted)`);
        }
        if (!(FINDING_IMPACTS as readonly string[]).includes(f.impact)) {
            throw config(`${op}: finding impact must be one of ${FINDING_IMPACTS.join(" | ")} (never defaulted)`);
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

    private requireAudit(actor: string, now: string, op: string): string {
        if (typeof actor !== "string" || actor.trim().length === 0 || typeof now !== "string" || now.trim().length === 0) {
            throw config(`${op}: a NEW Finding requires op-level actor and now (app-supplied creation audit)`);
        }
        return actor;
    }

    // -- retry identity -------------------------------------------------------

    /**
     * Gate-5D/5E retry-identity discipline applied to T7: the already-linked
     * durable Finding is the identical historical target of a NEW-Finding
     * request only when its immutable semantic creation identity matches the
     * requested draft — origin_visit_id / subject_id (null-safe) / normalized
     * description / defect_type / defect_type_other / normalized location /
     * urgency / impact / created_by == request actor. Deliberately NOT
     * compared: created_at (a retry generates a fresh clock) and the Finding's
     * CURRENT status (a later legitimate transition never defeats historical
     * retry recognition).
     */
    private async findingMatchesDraft(
        findingId: number,
        o: ObservationSnapshot,
        draft: NewFindingDraft,
        createdBy: string,
    ): Promise<boolean> {
        const rows = await this.db.query(
            `SELECT origin_visit_id, subject_id, description, defect_type, defect_type_other, location, urgency, impact, created_by
               FROM finding WHERE finding_id = ?`,
            [findingId],
        );
        if (rows.length === 0) return false;
        const f = rows[0];
        return (
            Number(f.origin_visit_id) === o.visitId &&
            (f.subject_id === null ? o.subjectId === null : o.subjectId !== null && Number(f.subject_id) === o.subjectId) &&
            String(f.description) === draft.description &&
            (f.defect_type === null ? draft.defectType === null : draft.defectType !== null && String(f.defect_type) === draft.defectType) &&
            (f.defect_type_other === null
                ? draft.defectTypeOther === null
                : draft.defectTypeOther !== null && String(f.defect_type_other) === draft.defectTypeOther) &&
            (f.location === null ? draft.location === null : draft.location !== null && String(f.location) === draft.location) &&
            String(f.urgency) === draft.urgency &&
            String(f.impact) === draft.impact &&
            String(f.created_by) === createdBy
        );
    }

    // -- transaction unit / guards --------------------------------------------

    /** one BEGIN IMMEDIATE … COMMIT unit; a ZeroRowGuard rolls back and converges. */
    private async runUnit<TApplied extends { kind: "applied" }, TConverged extends { kind: "converged" }>(
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
            throw new DomainError(
                APP_ERR.STATE_CONFLICT,
                `createFindingWithObservationSource: ${what} insert expected one row, got ${res.changes}`,
            );
        }
    }

    // -- result assembly -------------------------------------------------------

    private resultOf(
        o: ObservationSnapshot,
        findingId: number,
        applied: boolean,
        createdFindingId: number | null,
    ): ObservationFindingResult {
        return { observationId: o.observationId, applied, findingId, createdFindingId };
    }
}
