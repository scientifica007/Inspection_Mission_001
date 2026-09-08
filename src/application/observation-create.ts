// Gate 5G — OBS-1 `createAdHocObservation` (runtime-neutral TypeScript,
// no node:* imports).
//
// Implements the owner-approved Gate-5G application contract
// (TRANSACTION-CONTRACTS-v1.md §14 / APPLICATION-CORE-v1.md §4.12 /
// GATE5G-DECISIONS-v1.md). Traceability: PROJECT — PRJ-03 (observations/
// notes, P0); REQ-012 is supporting DIRECT evidence only. The exact OBS-1
// API/transaction contract is an owner-approved PROJECT decision, never
// claimed DIRECT/DERIVED from the official sources.
//
//   * Creates exactly ONE new durable AdHocObservation identity per
//     invocation, during an open field Visit — the Observation ONLY. It
//     never creates a Finding, never links to a Finding (finding_id = NULL
//     ALWAYS on creation), never creates a Subject, never attaches
//     Evidence, and never performs correction / T8+ / reporting / UI /
//     sync behavior.
//
//   * One explicit BEGIN IMMEDIATE … COMMIT unit, in this order:
//       read/validate Visit   (missing => E_VISIT_NOT_FOUND;
//        status <> 'PREPARATION' OR finalized_at IS NOT NULL =>
//        E_VISIT_NOT_PREPARATION — no backdated creation into a finalized
//        Visit; the authoritative read happens INSIDE the write
//        transaction, so there is no TOCTOU window)
//       -> read/validate optional Subject in the SAME transaction
//        (missing => E_SUBJECT_NOT_FOUND; institution mismatch => E_CONTEXT;
//        the Subject is never created or modified here; subjectId NULL =
//        a general Visit/institution-level observation)
//       -> normalize text / recorded_at / recorded_by (project conventions:
//        trim to meaningfulness; blank/whitespace-only => E_CONFIG;
//        recorded_at is app-supplied and never invented internally — it must
//        be a REAL ISO-8601 UTC instant (strict YYYY-MM-DDTHH:MM:SS[.fff]Z,
//        calendar-valid components, explicit 'Z'; no local / timezone-less /
//        offset forms) or E_CONFIG)
//       -> INSERT adhoc_observation(…, finding_id = NULL, …)
//       -> require changes == 1 (B5) and a present lastInsertRowid, else
//        ROLLBACK + E_STATE_CONFLICT
//       -> COMMIT.
//     Every failure rolls the whole unit back — no other row is created.
//
//   * DELIBERATELY Class B (identity-creating; RECOVERY §5): the project
//     has adopted NO durable request/idempotency key for observation
//     creation, so this service performs no dedupe and adds no UNIQUE /
//     hash / sidecar / client-token mechanism. Two intentional invocations
//     with identical payloads create two distinct observations. After
//     "COMMIT succeeded but ACK lost" the outcome is ambiguous to the
//     caller: the service never internally re-issues the INSERT and never
//     inspects text/time to claim an existing row "must be" the same
//     attempt; recovery reconstructs the durable Visit observations and
//     surfaces/reconciles them to the inspector instead of auto-resubmitting.
//
//   * OBS-1 / T7 boundary (Gate 5F): this service never accepts Finding
//     creation data and never links. If the inspector later decides the
//     Observation represents a Finding, the already-adopted T7 operation
//     (ObservationFindingService.createFindingWithObservationSource) handles
//     that separately — the two operations are never combined.
//
//   * Deferred (documented, not implemented): a general correction API for
//     an informational/unlinked Observation is NOT part of OBS-1. The data
//     model permits observation text/subject correction while the Visit is
//     PREPARATION, and Gate 5E supports such correction only when it rides
//     on the specific T6 source-correction operations. Concise boundary
//     note: GATE5G-DECISIONS-v1.md.

import type { SqlAdapter, SqlResult, SqlValue } from "../bootstrap/adapter.ts";
import { APP_ERR, DomainError } from "./errors.ts";

// ---------------------------------------------------------------------------
// public types
// ---------------------------------------------------------------------------

export interface CreateAdHocObservationInput {
    /** the durable key of the open field Visit (must exist and be PREPARATION) */
    visitId: number;
    /**
     * optional — NULL means a general Visit/institution-level observation.
     * When supplied, the Subject must exist and belong to the Visit's
     * institution; OBS-1 never creates a Subject.
     */
    subjectId?: number | null;
    /** meaningful observation text (normalized: trimmed; blank => E_CONFIG) */
    text: string;
    /**
     * app-supplied ISO-8601 UTC instant in strict form
     * `YYYY-MM-DDTHH:MM:SS[.fraction]Z` (explicit 'Z'; calendar-valid
     * components; no local / timezone-less / offset forms) — never invented
     * internally.
     */
    recordedAt: string;
    /** meaningful audit actor (normalized: trimmed; blank => E_CONFIG) */
    recordedBy: string;
}

/** the created durable Observation state (exactly what was committed). */
export interface AdHocObservationState {
    observationId: number;
    visitId: number;
    subjectId: number | null;
    text: string;
    /** ALWAYS null on creation (OBS-1 never links; T7 is the separate path) */
    findingId: null;
    recordedAt: string;
    recordedBy: string;
}

// ---------------------------------------------------------------------------
// internal model
// ---------------------------------------------------------------------------

interface VisitSnapshot {
    visitId: number;
    status: string;
    finalizedAt: string | null;
    institutionId: number;
}

interface SubjectSnapshot {
    subjectId: number;
    institutionId: number;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function config(what: string): DomainError {
    return new DomainError(APP_ERR.CONFIG, `createAdHocObservation: ${what}`);
}

function stateConflict(what: string): DomainError {
    return new DomainError(APP_ERR.STATE_CONFLICT, `createAdHocObservation: ${what}`);
}

/**
 * Focused OBS-1 ISO-8601 UTC validator (runtime-neutral / WebView-compatible;
 * no node:* and NO permissive `Date.parse` — Date.parse normalizes impossible
 * components like 2026-02-30, month 13, or hour 25, which this contract
 * rejects).
 *
 * Accepts exactly (after trimming): `YYYY-MM-DDTHH:MM:SS[.fraction]Z`
 *   - 4-digit year, real calendar month 01-12;
 *   - day valid for that month/year (leap years honored);
 *   - hour 00-23, minute 00-59, second 00-59;
 *   - optional dot-only fractional seconds (one or more digits);
 *   - the explicit UTC designator 'Z' is REQUIRED — a local/timezone-less
 *     datetime (`…T08:00:00`) or a numeric offset (`…+01:00`) is NOT UTC.
 * Returns the validated text, or null when the shape/components are invalid.
 */
function validateStrictUtcTimestamp(v: string): string | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/.exec(v);
    if (m === null) return null;
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    const hour = Number(m[4]);
    const minute = Number(m[5]);
    const second = Number(m[6]);
    if (month < 1 || month > 12) return null;
    if (hour > 23 || minute > 59 || second > 59) return null;
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (day < 1 || day > daysInMonth[month - 1]) return null;
    return v;
}

// ---------------------------------------------------------------------------
// service
// ---------------------------------------------------------------------------

export class ObservationCreateService {
    private readonly db: SqlAdapter;

    constructor(db: SqlAdapter) {
        this.db = db;
    }

    /**
     * OBS-1 — create exactly one durable AdHocObservation during an open
     * field Visit. Identity-creating Class-B operation: no dedupe, no
     * idempotency key, no auto-retry (GATE5G-DECISIONS-v1.md).
     */
    async createAdHocObservation(input: CreateAdHocObservationInput): Promise<AdHocObservationState> {
        const op = "createAdHocObservation";
        return this.runUnit(async () => {
            // 1) authoritative Visit read INSIDE BEGIN IMMEDIATE (no TOCTOU)
            const visit = await this.readVisit(input.visitId, op);
            this.assertPreparation(visit, op);

            // 2) optional Subject validation in the SAME transaction
            let subjectId: number | null = null;
            if (input.subjectId !== undefined && input.subjectId !== null) {
                const subject = await this.readSubject(input.subjectId, op);
                if (subject.institutionId !== visit.institutionId) {
                    throw new DomainError(
                        APP_ERR.CONTEXT,
                        `${op}: subject ${subject.subjectId} belongs to institution ${subject.institutionId}, ` +
                            `but visit ${visit.visitId} belongs to institution ${visit.institutionId} — an observation ` +
                            "may only reference a Subject of the Visit's institution (OBS-1 never creates or moves a Subject)",
                    );
                }
                subjectId = subject.subjectId;
            }

            // 3) normalized meaningful text / audit (project conventions;
            //    recorded_at is validated as a real ISO-8601 UTC instant)
            const text = this.requireMeaningful(input.text, `${op}: observation text`);
            const recordedAt = this.requireUtcTimestamp(input.recordedAt, `${op}: recorded_at`);
            const recordedBy = this.requireMeaningful(input.recordedBy, `${op}: recorded_by`);

            // 4) the single identity-creating INSERT — finding_id NULL ALWAYS
            const res = await this.db.run(
                `INSERT INTO adhoc_observation(visit_id, subject_id, text, finding_id, recorded_at, recorded_by)
                 VALUES (?, ?, ?, NULL, ?, ?)`,
                [visit.visitId, subjectId, text, recordedAt, recordedBy] as readonly SqlValue[],
            );
            this.guardInsert(res, op);
            if (res.lastInsertRowid === null) {
                throw stateConflict(`${op}: observation insert returned no rowid`);
            }
            const observationId = Number(res.lastInsertRowid);

            // 5) the created durable identity/state (COMMIT happens in runUnit)
            return {
                observationId,
                visitId: visit.visitId,
                subjectId,
                text,
                findingId: null,
                recordedAt,
                recordedBy,
            };
        });
    }

    // -- reads / authorization (all INSIDE the write transaction) ------------

    private async readVisit(visitId: number, op: string): Promise<VisitSnapshot> {
        const rows = await this.db.query(
            `SELECT visit_id, status, finalized_at, institution_id
               FROM visit WHERE visit_id = ?`,
            [visitId],
        );
        if (rows.length === 0) {
            throw new DomainError(APP_ERR.VISIT_NOT_FOUND, `${op}: visit ${visitId} does not exist`);
        }
        const r = rows[0];
        return {
            visitId: Number(r.visit_id),
            status: String(r.status),
            finalizedAt: r.finalized_at === null ? null : String(r.finalized_at),
            institutionId: Number(r.institution_id),
        };
    }

    private assertPreparation(v: VisitSnapshot, op: string): void {
        if (v.status !== "PREPARATION" || v.finalizedAt !== null) {
            throw new DomainError(
                APP_ERR.VISIT_NOT_PREPARATION,
                `${op}: visit ${v.visitId} is '${v.status}'${v.finalizedAt !== null ? " (finalized)" : ""}; ` +
                    "an AdHocObservation may only be created while the Visit is PREPARATION and not finalized " +
                    "(no backdated creation into a finalized Visit)",
            );
        }
    }

    private async readSubject(subjectId: number, op: string): Promise<SubjectSnapshot> {
        const rows = await this.db.query(
            `SELECT subject_id, institution_id FROM inspected_subject WHERE subject_id = ?`,
            [subjectId],
        );
        if (rows.length === 0) {
            throw new DomainError(
                APP_ERR.SUBJECT_NOT_FOUND,
                `${op}: subject ${subjectId} does not exist (OBS-1 never creates a Subject)`,
            );
        }
        return { subjectId: Number(rows[0].subject_id), institutionId: Number(rows[0].institution_id) };
    }

    // -- request-shape validation ---------------------------------------------

    /** project convention: trim to meaningfulness; blank/whitespace-only => E_CONFIG. */
    private requireMeaningful(v: string, what: string): string {
        if (typeof v !== "string") {
            throw config(`${what} must be a non-blank string`);
        }
        const t = v.trim();
        if (t.length === 0) {
            throw config(`${what} must be meaningful (non-blank)`);
        }
        return t;
    }

    /**
     * OBS-1 recorded_at: a REAL ISO-8601 UTC timestamp. Trimmed, strictly
     * validated (no permissive Date.parse — it would normalize impossible
     * calendar components), stored as the trimmed text; never invented.
     */
    private requireUtcTimestamp(v: string, what: string): string {
        if (typeof v !== "string") {
            throw config(`${what} must be an app-supplied ISO-8601 UTC timestamp string`);
        }
        const t = v.trim();
        if (validateStrictUtcTimestamp(t) === null) {
            throw config(
                `${what} must be a real ISO-8601 UTC instant in strict form YYYY-MM-DDTHH:MM:SS[.fraction]Z ` +
                    "(explicit 'Z'; no local / timezone-less / offset forms; calendar-valid components; " +
                    "the time is never invented internally)",
            );
        }
        return t;
    }

    // -- transaction unit / guards ---------------------------------------------

    /**
     * one explicit BEGIN IMMEDIATE … COMMIT unit. Class B: any failure rolls
     * the whole unit back and is surfaced as-is — there is no convergence
     * branch and no internal re-INSERT (RECOVERY §5).
     */
    private async runUnit<T>(work: () => Promise<T>): Promise<T> {
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
            throw e;
        }
    }

    private guardInsert(res: SqlResult, op: string): void {
        if (res.changes !== 1) {
            throw stateConflict(`${op}: observation insert expected exactly one row, got ${res.changes}`);
        }
    }
}
