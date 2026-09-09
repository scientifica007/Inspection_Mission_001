// Gate 5H — T8 `transitionFindingStatus` (runtime-neutral TypeScript, no
// node:* imports).
//
// Implements the adopted atomic Finding status-transition operation of
// TRANSACTION-CONTRACTS-v1.md §9 / APPLICATION-CORE-v1.md §4.8:
//
//   * Adopted transition graph (Gate-4B aligned):
//       OPEN -> IN_TREATMENT
//       OPEN -> RESOLVED          (legal directly)
//       IN_TREATMENT -> RESOLVED
//     Everything else is refused: generic target OPEN, generic target
//     VOIDED, IN_TREATMENT -> OPEN, RESOLVED/VOIDED -> anything, backwards
//     moves. VOIDED is owned exclusively by the dedicated T6-VOID /
//     T6-REHOME correction operations — never by this generic op.
//
//   * One explicit BEGIN IMMEDIATE … COMMIT/ROLLBACK unit (all mutable
//     authorization reads inside the transaction — no TOCTOU window):
//       re-read Finding (missing => E_FINDING_NOT_FOUND)
//       -> transition graph check
//       -> leaving-OPEN source-count check (>= 1 durable source across
//          checklist_response + adhoc_observation)
//       -> RESOLVED target: zero CorrectiveActions OPEN/IN_TREATMENT
//          (a CorrectiveAction is never REQUIRED to exist)
//       -> optional context Visit check (exists + same institution as the
//          origin Visit; finalization is irrelevant — FollowUp context,
//          not source-correction authorization)
//       -> INSERT exactly ONE append-only follow_up row
//          (status_target='FINDING', corrective_action_id=NULL,
//          status_after=target, visit_id=contextVisitId|null,
//          event_datetime shared with status_changed_at)
//       -> guarded UPDATE finding SET status = target,
//          status_changed_at = event_datetime
//          WHERE finding_id = ? AND status = <previously-read status>
//          (changes == 1, B5)
//       -> COMMIT.
//     FollowUp INSERT failure => no status change; status-update failure =>
//     the inserted FollowUp rolls back with the whole unit. No partial
//     audit/status state ever commits.
//
//   * T8 is NOT Visit-preparation-only (intentionally different from the T6
//     source corrections): the Finding follow-up lifecycle may continue
//     after the origin Visit has been finalized, and a contextVisitId is
//     FollowUp context (same-institution), never a PREPARATION gate.
//
//   * Class-A retry with REQUIRED durable event identity (Gate-5H owner
//     clarification of "identical duplicates converge"): "already at
//     target" alone NEVER converges. An already-at-target request returns
//     applied:false only when the durable transition-event identity matches
//     the requested event exactly — the canonical FollowUp row (finding_id /
//     corrective_action_id IS NULL / status_target='FINDING' /
//     status_after=target / null-safe visit_id == requested contextVisitId /
//     event_datetime / actor_role / null-safe actor_role_other / null-safe
//     actor_name / normalized note / normalized recorded_by) PLUS
//     finding.status_changed_at == requested event_datetime, with exactly
//     ONE matching row. A different audit event, a mismatching
//     status_changed_at, duplicate matching rows, or a stale retry to a
//     target the Finding has already advanced beyond => E_STATE_CONFLICT.
//
//   * FollowUp event validation follows the adopted Gate-5E FollowUp-event
//     semantics (actorRole closed set, OTHER requires meaningful
//     actorRoleOther, meaningful normalized note/recordedBy, optional
//     normalized actorName) with the strict Gate-5G ISO-8601 UTC convention
//     for eventDatetime: app-supplied, strict `YYYY-MM-DDTHH:MM:SS[.fraction]Z`
//     (explicit 'Z', calendar-valid components), never invented internally,
//     stored as the normalized trimmed value.
//
// Out of scope (later gates): T6 behavior, T9/T10, T11, observation
// correction, currentVisitState, evidence, UI/report/sync. CorrectiveAction
// rows are never created here.

import type { SqlAdapter, SqlResult, SqlValue } from "../bootstrap/adapter.ts";
import { APP_ERR, DomainError } from "./errors.ts";
import { FOLLOW_UP_ACTOR_ROLES, type FollowUpActorRole } from "./corrections.ts";

// ---------------------------------------------------------------------------
// public types
// ---------------------------------------------------------------------------

/** Every Finding status value known to the schema (finding.status CHECK). */
export const FINDING_STATUSES = ["OPEN", "IN_TREATMENT", "RESOLVED", "VOIDED"] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

/** Statuses reachable through T8 — `to` of a legal generic transition. */
export const FINDING_TRANSITION_TARGETS = ["IN_TREATMENT", "RESOLVED"] as const;
export type FindingTransitionTarget = (typeof FINDING_TRANSITION_TARGETS)[number];

/** The append-only FollowUp event of a T8 Finding status transition. */
export interface FindingTransitionEventInput {
    /**
     * App-supplied strict ISO-8601 UTC instant
     * (`YYYY-MM-DDTHH:MM:SS[.fraction]Z`); shared verbatim by
     * follow_up.event_datetime and finding.status_changed_at.
     */
    eventDatetime: string;
    actorRole: FollowUpActorRole;
    /** required meaningful when actorRole === "OTHER" */
    actorRoleOther?: string | null;
    actorName?: string | null;
    /** meaningful transition note (follow_up.note) */
    note: string;
    recordedBy: string;
}

export interface TransitionFindingStatusInput {
    findingId: number;
    /**
     * Requested target status. Only IN_TREATMENT/RESOLVED are legal T8
     * targets; OPEN and VOIDED are recognized Finding statuses but never
     * generic T8 targets (E_STATE_CONFLICT), and anything else is a
     * malformed request (E_CONFIG).
     */
    to: FindingStatus;
    event: FindingTransitionEventInput;
    /** optional same-institution FollowUp context (never a PREPARATION gate) */
    contextVisitId?: number | null;
}

export interface TransitionFindingStatusResult {
    /** false when the call converged on the already-applied identical durable transition event */
    applied: boolean;
    findingId: number;
    /** durable Finding status after the operation */
    status: FindingStatus;
    statusChangedAt: string | null;
}

// ---------------------------------------------------------------------------
// internal model
// ---------------------------------------------------------------------------

interface FindingSnapshot {
    findingId: number;
    originVisitId: number;
    status: FindingStatus;
    statusChangedAt: string | null;
}

interface ValidatedEvent {
    eventDatetime: string;
    actorRole: FollowUpActorRole;
    actorRoleOther: string | null;
    actorName: string | null;
    note: string;
    recordedBy: string;
}

/** thrown inside the write unit to force ROLLBACK + durable-state re-read (B5) */
class ZeroRowGuard extends Error {
    constructor() {
        super("guarded finding status update affected zero rows (B5)");
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
    return new DomainError(APP_ERR.CONFIG, `transitionFindingStatus: ${what}`);
}

function stateConflict(what: string): DomainError {
    return new DomainError(APP_ERR.STATE_CONFLICT, `transitionFindingStatus: ${what}`);
}

/**
 * Strict ISO-8601 UTC validator — the exact Gate-5G semantic convention
 * (OBS-1 recordedAt; src/application/observation-create.ts): runtime-neutral,
 * no permissive Date.parse (Date.parse would normalize impossible components
 * like 2026-02-30 or hour 25, which this contract rejects).
 *
 * Accepts exactly (after trimming): `YYYY-MM-DDTHH:MM:SS[.fraction]Z`
 *   - 4-digit year, real calendar month 01-12;
 *   - day valid for that month/year (leap years honored);
 *   - hour 00-23, minute 00-59, second 00-59;
 *   - optional dot-only fractional seconds (one or more digits);
 *   - the explicit UTC designator 'Z' is REQUIRED — a local/timezone-less
 *     datetime (`…T08:00:00`) or a numeric offset (`…+01:00`) is NOT UTC.
 * Returns the validated (trimmed) text, or null when invalid.
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

export class FindingTransitionService {
    private readonly db: SqlAdapter;

    constructor(db: SqlAdapter) {
        this.db = db;
    }

    /**
     * T8 — one atomic Finding status transition: append-only FollowUp event +
     * guarded status update, changes == 1, one transaction. Class A: an
     * already-at-target request converges (applied:false, no second FollowUp)
     * ONLY on the exact durable transition-event identity; everything else is
     * a typed conflict.
     */
    async transitionFindingStatus(input: TransitionFindingStatusInput): Promise<TransitionFindingStatusResult> {
        const op = "transitionFindingStatus";

        // pure request-shape validation only (nothing mutable is read here);
        // every authorization read happens inside the transaction below
        if (!(FINDING_STATUSES as readonly string[]).includes(input.to)) {
            throw config(`${op}: 'to' must be one of ${FINDING_STATUSES.join(" | ")}`);
        }
        const event = this.validateEvent(input.event, op);
        const to = input.to;
        const contextVisitId = input.contextVisitId ?? null;

        return this.runUnit(
            async () => {
                // 1) authoritative Finding read INSIDE BEGIN IMMEDIATE
                const f = await this.readFinding(input.findingId);
                const from = f.status;

                // 2) generic targets OPEN / VOIDED are never T8 requests
                //    (VOIDED is owned exclusively by T6-VOID / T6-REHOME)
                if (to === "OPEN" || to === "VOIDED") {
                    throw stateConflict(
                        `${op}: target '${to}' is not a T8 transition target — Finding VOID is reachable only ` +
                            "through the dedicated T6-VOID / T6-REHOME correction operations, and no generic " +
                            "OPEN target exists",
                    );
                }

                // 3) already at the requested target: Class-A convergence ONLY
                //    on the exact durable transition-event identity (§9 retry
                //    rule); a bare status match is a DIFFERENT event
                if (from === to) {
                    const match = await this.durableEventMatchCount(input.findingId, to, contextVisitId, event);
                    if (match === 1 && String(f.statusChangedAt) === event.eventDatetime) {
                        return {
                            kind: "converged" as const,
                            result: this.resultOf(input.findingId, to, f.statusChangedAt, false),
                        };
                    }
                    throw stateConflict(
                        match > 1
                            ? `${op}: finding ${input.findingId} is already '${to}' but ${match} identical ` +
                                "canonical FollowUp rows exist — duplicate audit rows are an integrity conflict, " +
                                "never silent convergence"
                            : `${op}: finding ${input.findingId} is already '${to}' but the durable transition-event ` +
                                "identity does not match the requested event (canonical FollowUp row and/or " +
                                "status_changed_at differ) — an already-at-target status alone never converges",
                    );
                }

                // 4) adopted transition graph
                const legal =
                    (from === "OPEN" && to === "IN_TREATMENT") ||
                    (from === "OPEN" && to === "RESOLVED") ||
                    (from === "IN_TREATMENT" && to === "RESOLVED");
                if (!legal) {
                    throw stateConflict(
                        `${op}: transition ${from} -> ${to} is not in the adopted T8 graph ` +
                            "(OPEN -> IN_TREATMENT, OPEN -> RESOLVED, IN_TREATMENT -> RESOLVED)",
                    );
                }

                // 5) source-count: a Finding needs >= 1 durable source before
                //    entering IN_TREATMENT/RESOLVED (Gate §D.3 for leaving
                //    OPEN; mirrored for IN_TREATMENT -> RESOLVED so the schema
                //    guard trg_finding_bu surfaces as a typed conflict, never
                //    a raw trigger abort)
                const sources = await this.countSources(input.findingId);
                if (sources < 1) {
                    throw stateConflict(
                        `${op}: finding ${input.findingId} has no durable source (checklist_response + ` +
                            "adhoc_observation) and must not progress to " +
                            `${to} — a source-less OPEN finding is blocked by the adopted integrity rules`,
                    );
                }

                // 6) RESOLVED target: zero CorrectiveActions OPEN/IN_TREATMENT
                //    (a CorrectiveAction is never required to exist)
                if (to === "RESOLVED") {
                    const active = await this.countActiveActions(input.findingId);
                    if (active > 0) {
                        throw stateConflict(
                            `${op}: finding ${input.findingId} cannot become RESOLVED while ${active} ` +
                                "corrective action(s) are OPEN or IN_TREATMENT",
                        );
                    }
                }

                // 7) optional context Visit — FollowUp context, never a
                //    source-correction authorization (no PREPARATION gate)
                if (contextVisitId !== null) {
                    await this.validateContextVisit(f, contextVisitId, op);
                }

                // 8) INSERT exactly ONE append-only follow_up row
                const fu = await this.db.run(
                    `INSERT INTO follow_up(finding_id, corrective_action_id, visit_id, status_target, status_after,
                                           event_datetime, actor_role, actor_role_other, actor_name, note, recorded_by)
                     VALUES (?, NULL, ?, 'FINDING', ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        input.findingId,
                        contextVisitId,
                        to,
                        event.eventDatetime,
                        event.actorRole,
                        event.actorRoleOther,
                        event.actorName,
                        event.note,
                        event.recordedBy,
                    ] as readonly SqlValue[],
                );
                this.guardInsert(fu, "follow_up");

                // 9) guarded status update — same event_datetime, optimistic
                //    guard on the status read inside this transaction
                const upd = await this.db.run(
                    `UPDATE finding
                        SET status = ?, status_changed_at = ?
                      WHERE finding_id = ? AND status = ?`,
                    [to, event.eventDatetime, input.findingId, from] as readonly SqlValue[],
                );
                if (upd.changes !== 1) throw new ZeroRowGuard();

                return {
                    kind: "applied" as const,
                    result: this.resultOf(input.findingId, to, event.eventDatetime, true),
                };
            },
            async () => {
                // B5: the guarded status update changed != 1 rows => the whole
                // unit was rolled back (the tentative FollowUp disappeared
                // with it); re-read durable state and converge ONLY on the
                // identical durable transition event
                const durable = await this.readFindingIfPresent(input.findingId);
                if (
                    durable !== null &&
                    durable.status === to &&
                    String(durable.statusChangedAt) === event.eventDatetime &&
                    (await this.durableEventMatchCount(input.findingId, to, contextVisitId, event)) === 1
                ) {
                    return {
                        kind: "converged" as const,
                        result: this.resultOf(input.findingId, to, durable.statusChangedAt, false),
                    };
                }
                throw stateConflict(
                    `${op}: the guarded status update affected zero rows and the durable state does not ` +
                        "match the identical requested transition event (status / status_changed_at / canonical " +
                        "FollowUp identity) — a FollowUp row is never committed without its status transition",
                );
            },
        ).then((outcome) => outcome.result);
    }

    // -- reads / authorization ----------------------------------------------

    private async readFinding(findingId: number): Promise<FindingSnapshot> {
        const f = await this.readFindingIfPresent(findingId);
        if (f === null) {
            throw new DomainError(
                APP_ERR.FINDING_NOT_FOUND,
                `transitionFindingStatus: finding ${findingId} does not exist`,
            );
        }
        return f;
    }

    private async readFindingIfPresent(findingId: number): Promise<FindingSnapshot | null> {
        const rows = await this.db.query(
            `SELECT finding_id, origin_visit_id, status, status_changed_at
               FROM finding WHERE finding_id = ?`,
            [findingId],
        );
        if (rows.length === 0) return null;
        const r = rows[0];
        return {
            findingId: Number(r.finding_id),
            originVisitId: Number(r.origin_visit_id),
            status: String(r.status) as FindingStatus,
            statusChangedAt: r.status_changed_at === null ? null : String(r.status_changed_at),
        };
    }

    /** total durable sources (both source tables) of a finding. */
    private async countSources(findingId: number): Promise<number> {
        const rows = await this.db.query(
            `SELECT (SELECT count(*) FROM checklist_response cr WHERE cr.finding_id = ?) +
                    (SELECT count(*) FROM adhoc_observation o WHERE o.finding_id = ?) AS c`,
            [findingId, findingId],
        );
        return Number(rows[0].c);
    }

    /** CorrectiveActions of the finding still OPEN or IN_TREATMENT. */
    private async countActiveActions(findingId: number): Promise<number> {
        const rows = await this.db.query(
            `SELECT count(*) AS c FROM corrective_action
              WHERE finding_id = ? AND status IN ('OPEN','IN_TREATMENT')`,
            [findingId],
        );
        return Number(rows[0].c);
    }

    /** context Visit must exist and belong to the origin Visit's institution. */
    private async validateContextVisit(f: FindingSnapshot, contextVisitId: number, op: string): Promise<void> {
        const rows = await this.db.query(`SELECT institution_id FROM visit WHERE visit_id = ?`, [contextVisitId]);
        if (rows.length === 0) {
            throw new DomainError(
                APP_ERR.VISIT_NOT_FOUND,
                `${op}: context visit ${contextVisitId} does not exist`,
            );
        }
        const originRows = await this.db.query(
            `SELECT institution_id FROM visit WHERE visit_id = ?`,
            [f.originVisitId],
        );
        const originInstitution = Number(originRows[0].institution_id);
        if (Number(rows[0].institution_id) !== originInstitution) {
            throw new DomainError(
                APP_ERR.CONTEXT,
                `${op}: context visit ${contextVisitId} belongs to institution ${rows[0].institution_id} but ` +
                    `finding ${f.findingId} originates from visit ${f.originVisitId} of institution ` +
                    `${originInstitution} — FollowUp context must stay inside the finding's institution`,
            );
        }
    }

    // -- request-shape validation (pure; nothing mutable is read) -----------

    /** FollowUp event semantics (Gate 5E) + strict Gate-5G UTC eventDatetime. */
    private validateEvent(event: FindingTransitionEventInput, op: string): ValidatedEvent {
        const eventDatetime = normalizeText(event.eventDatetime);
        if (eventDatetime === null) {
            throw config(`${op}: event.eventDatetime must be an app-supplied ISO-8601 UTC instant`);
        }
        if (validateStrictUtcTimestamp(eventDatetime) === null) {
            throw config(
                `${op}: event.eventDatetime must be a real ISO-8601 UTC instant in strict form ` +
                    "YYYY-MM-DDTHH:MM:SS[.fraction]Z (explicit 'Z'; no local / timezone-less / offset forms; " +
                    "calendar-valid components)",
            );
        }
        if (!(FOLLOW_UP_ACTOR_ROLES as readonly string[]).includes(event.actorRole)) {
            throw config(`${op}: event.actorRole must be one of ${FOLLOW_UP_ACTOR_ROLES.join(" | ")}`);
        }
        const actorRoleOther = normalizeText(event.actorRoleOther);
        if (event.actorRole === "OTHER" && actorRoleOther === null) {
            throw config(`${op}: event.actorRole=OTHER requires a meaningful event.actorRoleOther`);
        }
        const note = normalizeText(event.note);
        if (note === null) throw config(`${op}: a meaningful event note is required (follow_up.note)`);
        const recordedBy = normalizeText(event.recordedBy);
        if (recordedBy === null) throw config(`${op}: event.recordedBy must be meaningful`);
        return {
            eventDatetime,
            actorRole: event.actorRole,
            actorRoleOther,
            actorName: normalizeText(event.actorName),
            note,
            recordedBy,
        };
    }

    // -- retry identity -------------------------------------------------------

    /**
     * Counts the canonical durable FollowUp rows of the requested transition
     * event (Gate §G): finding_id / corrective_action_id IS NULL /
     * status_target='FINDING' / status_after = target / null-safe visit_id ==
     * requested contextVisitId / event_datetime / actor_role / null-safe
     * actor_role_other / null-safe actor_name / normalized note /
     * normalized recorded_by. Convergence requires EXACTLY one such row;
     * zero => no durable event, more than one => integrity conflict.
     */
    private async durableEventMatchCount(
        findingId: number,
        to: string,
        contextVisitId: number | null,
        event: ValidatedEvent,
    ): Promise<number> {
        const rows = await this.db.query(
            `SELECT followup_id
               FROM follow_up
              WHERE finding_id = ?
                AND corrective_action_id IS NULL
                AND status_target = 'FINDING'
                AND status_after = ?
                AND visit_id IS ?
                AND event_datetime = ?
                AND actor_role = ?
                AND actor_role_other IS ?
                AND actor_name IS ?
                AND note = ?
                AND recorded_by = ?`,
            [
                findingId,
                to,
                contextVisitId,
                event.eventDatetime,
                event.actorRole,
                event.actorRoleOther,
                event.actorName,
                event.note,
                event.recordedBy,
            ] as readonly SqlValue[],
        );
        return rows.length;
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
                `transitionFindingStatus: ${what} insert expected one row, got ${res.changes}`,
            );
        }
    }

    // -- result assembly -------------------------------------------------------

    private resultOf(
        findingId: number,
        status: FindingStatus,
        statusChangedAt: string | null,
        applied: boolean,
    ): TransitionFindingStatusResult {
        return { applied, findingId, status, statusChangedAt };
    }
}
