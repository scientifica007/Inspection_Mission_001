// Gate 5J — T10 `transitionCorrectiveActionStatus` (runtime-neutral
// TypeScript, no node:* imports).
//
// Implements the adopted atomic CorrectiveAction status-transition operation
// of TRANSACTION-CONTRACTS-v1.md §10 / APPLICATION-CORE-v1.md §4.8:
//
//   * Adopted transition graph (Gate-4B aligned — CorrectiveAction has NO
//     VOIDED status in v1):
//       OPEN -> IN_TREATMENT
//       OPEN -> RESOLVED          (legal directly)
//       IN_TREATMENT -> RESOLVED
//     Everything else is refused: generic target OPEN (a recognized action
//     status, never a generic T10 target — E_STATE_CONFLICT),
//     IN_TREATMENT -> OPEN, RESOLVED -> anything (E_STATE_CONFLICT), and any
//     status outside the action value set — including VOIDED, which does not
//     exist for CorrectiveActions — (E_CONFIG).
//
//   * One explicit BEGIN IMMEDIATE … COMMIT/ROLLBACK unit (all mutable
//     authorization reads inside the transaction — no TOCTOU window):
//       re-read CorrectiveAction joined to its parent Finding (missing
//       action => E_ACTION_NOT_FOUND)
//       -> transition graph check
//       -> target-specific resolution payload (RESOLVED: mandatory
//          meaningful verified_by, optional verification_note; a
//          non-RESOLVED target refuses ANY supplied resolution payload)
//       -> optional context Visit check (exists + same institution as the
//          parent Finding's origin Visit; Visit finalization is irrelevant —
//          FollowUp context, never a PREPARATION gate)
//       -> INSERT exactly ONE append-only follow_up row
//          (status_target='CORRECTIVE_ACTION',
//          corrective_action_id=actionId, status_after=target,
//          visit_id=contextVisitId|null, event_datetime shared with
//          closed_at on RESOLVED)
//       -> guarded UPDATE corrective_action
//          IN_TREATMENT: SET status='IN_TREATMENT' (closure fields stay
//          NULL — they were NULL by construction and the schema CHECK
//          enforces it)
//          RESOLVED: SET status='RESOLVED', closed_at=event_datetime,
//          verified_by=normalized verifiedBy,
//          verification_note=normalized optional note — ONE statement,
//          status and closure are one atomic write
//          WHERE action_id = ? AND status = <previously-read status>
//          (changes == 1, B5)
//       -> COMMIT.
//     FollowUp INSERT failure => no status/closure change; status-update
//     failure => the inserted FollowUp rolls back with the whole unit. No
//     partial audit/closure state ever commits.
//
//   * T10 is NOT Visit-preparation-only (intentionally different from the
//     T6 source corrections): the corrective-action follow-up lifecycle may
//     continue after the origin Visit has been finalized, and a
//     contextVisitId is FollowUp context (same institution as the parent
//     Finding's origin Visit), never a PREPARATION gate. T10 never reopens
//     or modifies the Visit.
//
//   * closed_at interpretation (audited and settled in Gate 5J):
//     closed_at = the transition FollowUp's normalized event_datetime —
//     ENTITY-CATALOG-v1.md §2.12 defines closed_at as "the instant of
//     resolution/closure", TRANSACTION-CONTRACTS-v1.md §1.7 adopts "one
//     transaction reuses the same timestamp for related rows", and T10 is
//     ONE atomic transition/closure event. No authoritative document
//     defines a separate user-supplied closure time, so none is invented
//     (the resolution payload carries verified_by / verification_note
//     only).
//
//   * Class-A retry with REQUIRED durable event + closure identity
//     (Gate-5H lesson applied to T10): "already at target" alone NEVER
//     converges. An already-at-target request returns applied:false only
//     when the durable transition-event identity matches the requested
//     event exactly — the canonical FollowUp row (finding_id = parent
//     Finding / corrective_action_id = actionId /
//     status_target='CORRECTIVE_ACTION' / status_after=target / null-safe
//     visit_id == requested contextVisitId / event_datetime / actor_role /
//     null-safe actor_role_other / null-safe actor_name / normalized note /
//     normalized recorded_by) with exactly ONE matching row — PLUS the
//     target closure identity: IN_TREATMENT requires
//     closed_at/verified_by/verification_note still NULL; RESOLVED
//     additionally requires closed_at == event_datetime, verified_by ==
//     normalized requested verifiedBy and verification_note == normalized
//     requested verificationNote (null-safe). A different audit event, a
//     mismatching closure identity, duplicate matching rows, or a stale
//     retry to a target the action has already legitimately advanced
//     beyond => E_STATE_CONFLICT — never backwards, never silent success,
//     never a duplicate FollowUp.
//
//   * Parent Finding is NEVER modified here: T10 changes the
//     CorrectiveAction only — it does not move the Finding toward
//     IN_TREATMENT/RESOLVED, does not touch finding.status_changed_at, and
//     does not touch source links. Finding transitions remain T8 (which may
//     later resolve the Finding once all its actions are RESOLVED — a
//     separate explicit operation).
//
// Out of scope (later/existing gates): T8 behavior, T9 creation, the T9
// creation-FollowUp ambiguity (open — deliberately not settled here), T11,
// observation correction, evidence, external-system tracking, UI/sync.

import type { SqlAdapter, SqlResult, SqlValue } from "../bootstrap/adapter.ts";
import { APP_ERR, DomainError } from "./errors.ts";
import { FOLLOW_UP_ACTOR_ROLES, type FollowUpActorRole } from "./corrections.ts";

// ---------------------------------------------------------------------------
// public types
// ---------------------------------------------------------------------------

/** Every CorrectiveAction status value known to the schema CHECK (no VOIDED). */
export const CORRECTIVE_ACTION_STATUSES = ["OPEN", "IN_TREATMENT", "RESOLVED"] as const;
export type CorrectiveActionStatus = (typeof CORRECTIVE_ACTION_STATUSES)[number];

/** Statuses reachable through T10 — `to` of a legal generic transition. */
export const CORRECTIVE_ACTION_TRANSITION_TARGETS = ["IN_TREATMENT", "RESOLVED"] as const;
export type CorrectiveActionTransitionTarget = (typeof CORRECTIVE_ACTION_TRANSITION_TARGETS)[number];

/** The append-only FollowUp event of a T10 CorrectiveAction status transition. */
export interface CorrectiveActionTransitionEventInput {
    /**
     * App-supplied strict ISO-8601 UTC instant
     * (`YYYY-MM-DDTHH:MM:SS[.fraction]Z`); shared verbatim by
     * follow_up.event_datetime and (on RESOLVED) corrective_action.closed_at.
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

/**
 * The closure payload of a RESOLVED transition. Carries verification data
 * ONLY — closed_at is the transition event's instant (never a separate
 * user-supplied value).
 */
export interface CorrectiveActionResolutionInput {
    /** who verified the resolution — mandatory, meaningful (corrective_action.verified_by) */
    verifiedBy: string;
    /** optional verification note; blank normalizes to NULL */
    verificationNote?: string | null;
}

export interface TransitionCorrectiveActionStatusInput {
    /** the durable key of the CorrectiveAction (must exist) */
    actionId: number;
    /**
     * Requested target status. IN_TREATMENT/RESOLVED are the legal T10
     * targets; OPEN is a recognized action status but never a generic T10
     * target (E_STATE_CONFLICT), and anything outside the action value set
     * (including VOIDED — no VOIDED action exists in v1) is a malformed
     * request (E_CONFIG).
     */
    to: CorrectiveActionStatus;
    event: CorrectiveActionTransitionEventInput;
    /** optional same-institution FollowUp context (never a PREPARATION gate) */
    contextVisitId?: number | null;
    /**
     * closure payload — REQUIRED for a RESOLVED target; MUST NOT be supplied
     * for any non-RESOLVED target (E_CONFIG rather than silently storing or
     * ignoring closure values).
     */
    resolution?: CorrectiveActionResolutionInput | null;
}

export interface TransitionCorrectiveActionStatusResult {
    /** false when the call converged on the already-applied identical durable transition event */
    applied: boolean;
    actionId: number;
    /** the action's parent Finding */
    findingId: number;
    /** durable CorrectiveAction status after the operation */
    status: CorrectiveActionStatus;
    /** durable closure state after the operation */
    closedAt: string | null;
    verifiedBy: string | null;
    verificationNote: string | null;
}

// ---------------------------------------------------------------------------
// internal model
// ---------------------------------------------------------------------------

interface ActionSnapshot {
    actionId: number;
    findingId: number;
    originVisitId: number;
    status: CorrectiveActionStatus;
    closedAt: string | null;
    verifiedBy: string | null;
    verificationNote: string | null;
}

interface ValidatedEvent {
    eventDatetime: string;
    actorRole: FollowUpActorRole;
    actorRoleOther: string | null;
    actorName: string | null;
    note: string;
    recordedBy: string;
}

interface ValidatedResolution {
    verifiedBy: string;
    verificationNote: string | null;
}

/** thrown inside the write unit to force ROLLBACK + durable-state re-read (B5) */
class ZeroRowGuard extends Error {
    constructor() {
        super("guarded corrective-action status update affected zero rows (B5)");
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
    return new DomainError(APP_ERR.CONFIG, `transitionCorrectiveActionStatus: ${what}`);
}

function stateConflict(what: string): DomainError {
    return new DomainError(APP_ERR.STATE_CONFLICT, `transitionCorrectiveActionStatus: ${what}`);
}

/**
 * Strict ISO-8601 UTC validator — the exact Gate-5G semantic convention
 * (OBS-1 recordedAt; src/application/observation-create.ts): runtime-neutral,
 * no permissive Date.parse (Date.parse would normalize impossible components
 * like 2026-02-30, month 13, or hour 25, which this contract rejects).
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

export class CorrectiveActionStatusService {
    private readonly db: SqlAdapter;

    constructor(db: SqlAdapter) {
        this.db = db;
    }

    /**
     * T10 — one atomic CorrectiveAction status transition: append-only
     * FollowUp event + guarded status update (+ closure fields for RESOLVED),
     * changes == 1, one transaction. Class A: an already-at-target request
     * converges (applied:false, no second FollowUp) ONLY on the exact
     * durable transition-event AND closure identity; everything else is a
     * typed conflict.
     */
    async transitionCorrectiveActionStatus(
        input: TransitionCorrectiveActionStatusInput,
    ): Promise<TransitionCorrectiveActionStatusResult> {
        const op = "transitionCorrectiveActionStatus";

        // pure request-shape validation only (nothing mutable is read here);
        // every authorization read happens inside the transaction below
        if (!(CORRECTIVE_ACTION_STATUSES as readonly string[]).includes(input.to)) {
            throw config(
                `${op}: 'to' must be one of ${CORRECTIVE_ACTION_STATUSES.join(" | ")} — CorrectiveAction ` +
                    "has no VOIDED status in v1",
            );
        }
        const event = this.validateEvent(input.event, op);
        const to = input.to;
        const contextVisitId = input.contextVisitId ?? null;
        // RESOLVED => validated closure payload; non-RESOLVED => null, and
        // any supplied resolution payload was refused above (pure shape rule)
        const resolution = this.validateResolution(input, to, op);

        return this.runUnit(
            async () => {
                // 1) authoritative action + parent Finding read INSIDE
                //    BEGIN IMMEDIATE (the action row is joined to its parent
                //    Finding for finding_id / origin context; a missing
                //    action is a typed E_ACTION_NOT_FOUND, never
                //    E_FINDING_NOT_FOUND)
                const a = await this.readAction(input.actionId, op);
                const from = a.status;

                // 2) generic target OPEN is never a T10 request (a recognized
                //    action status, but no generic backwards target exists)
                if (to === "OPEN") {
                    throw stateConflict(
                        `${op}: target 'OPEN' is not a T10 transition target — CorrectiveActions never move ` +
                            "backwards through the generic transition operation",
                    );
                }

                // 3) already at the requested target: Class-A convergence
                //    ONLY on the exact durable transition-event + closure
                //    identity; a bare status match is a DIFFERENT event
                if (from === to) {
                    const matches = await this.durableEventMatchCount(a, to, contextVisitId, event);
                    const closureOk = this.closureIdentityMatches(a, to, event, resolution);
                    if (matches === 1 && closureOk) {
                        return {
                            kind: "converged" as const,
                            result: this.resultOfDurable(a, to, false),
                        };
                    }
                    throw stateConflict(
                        matches > 1
                            ? `${op}: action ${input.actionId} is already '${to}' but ${matches} identical ` +
                                "canonical FollowUp rows exist — duplicate audit rows are an integrity conflict, " +
                                "never silent convergence"
                            : `${op}: action ${input.actionId} is already '${to}' but the durable transition ` +
                                "identity does not match the requested event (canonical FollowUp row and/or " +
                                "closure identity differ) — an already-at-target status alone never converges",
                    );
                }

                // 4) adopted transition graph
                const legal =
                    (from === "OPEN" && to === "IN_TREATMENT") ||
                    (from === "OPEN" && to === "RESOLVED") ||
                    (from === "IN_TREATMENT" && to === "RESOLVED");
                if (!legal) {
                    throw stateConflict(
                        `${op}: transition ${from} -> ${to} is not in the adopted T10 graph ` +
                            "(OPEN -> IN_TREATMENT, OPEN -> RESOLVED, IN_TREATMENT -> RESOLVED)",
                    );
                }

                // 5) optional context Visit — FollowUp context, never a
                //    source-correction authorization (no PREPARATION gate)
                if (contextVisitId !== null) {
                    await this.validateContextVisit(a, contextVisitId, op);
                }

                // 6) INSERT exactly ONE append-only follow_up row
                const fu = await this.db.run(
                    `INSERT INTO follow_up(finding_id, corrective_action_id, visit_id, status_target, status_after,
                                           event_datetime, actor_role, actor_role_other, actor_name, note, recorded_by)
                     VALUES (?, ?, ?, 'CORRECTIVE_ACTION', ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        a.findingId,
                        input.actionId,
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
                this.guardInsert(fu, op);

                // 7) guarded status update — one statement; for RESOLVED the
                //    closure fields are written in the SAME statement
                //    (status + closed_at + verified_by + verification_note
                //    are one atomic write; closed_at == event_datetime, the
                //    instant of the transition/closure event)
                if (to === "RESOLVED") {
                    const r = resolution as ValidatedResolution; // guaranteed by validateResolution
                    const upd = await this.db.run(
                        `UPDATE corrective_action
                            SET status = 'RESOLVED', closed_at = ?, verified_by = ?, verification_note = ?
                          WHERE action_id = ? AND status = ?`,
                        [event.eventDatetime, r.verifiedBy, r.verificationNote, input.actionId, from] as readonly SqlValue[],
                    );
                    if (upd.changes !== 1) throw new ZeroRowGuard();
                    return {
                        kind: "applied" as const,
                        result: {
                            applied: true,
                            actionId: input.actionId,
                            findingId: a.findingId,
                            status: to,
                            closedAt: event.eventDatetime,
                            verifiedBy: r.verifiedBy,
                            verificationNote: r.verificationNote,
                        },
                    };
                }

                const upd = await this.db.run(
                    `UPDATE corrective_action
                        SET status = 'IN_TREATMENT'
                      WHERE action_id = ? AND status = ?`,
                    [input.actionId, from] as readonly SqlValue[],
                );
                if (upd.changes !== 1) throw new ZeroRowGuard();
                return {
                    kind: "applied" as const,
                    result: {
                        applied: true,
                        actionId: input.actionId,
                        findingId: a.findingId,
                        status: to,
                        closedAt: null,
                        verifiedBy: null,
                        verificationNote: null,
                    },
                };
            },
            async () => {
                // B5: the guarded status update changed != 1 rows => the whole
                // unit was rolled back (the tentative FollowUp disappeared
                // with it); re-read durable state and converge ONLY on the
                // identical durable transition event + closure identity
                const durable = await this.readActionIfPresent(input.actionId);
                if (
                    durable !== null &&
                    durable.status === to &&
                    (await this.durableEventMatchCount(durable, to, contextVisitId, event)) === 1 &&
                    this.closureIdentityMatches(durable, to, event, resolution)
                ) {
                    return {
                        kind: "converged" as const,
                        result: this.resultOfDurable(durable, to, false),
                    };
                }
                throw stateConflict(
                    `${op}: the guarded status update affected zero rows and the durable state does not ` +
                        "match the identical requested transition event (status / canonical FollowUp / closure " +
                        "identity) — a FollowUp row is never committed without its status transition",
                );
            },
        ).then((outcome) => outcome.result);
    }

    // -- reads / authorization ----------------------------------------------

    private async readAction(actionId: number, op: string): Promise<ActionSnapshot> {
        const a = await this.readActionIfPresent(actionId);
        if (a === null) {
            throw new DomainError(
                APP_ERR.ACTION_NOT_FOUND,
                `${op}: corrective action ${actionId} does not exist`,
            );
        }
        return a;
    }

    /**
     * CorrectiveAction joined to its parent Finding (the parent gives the
     * FollowUp its finding_id and the context-Visit its institution source).
     */
    private async readActionIfPresent(actionId: number): Promise<ActionSnapshot | null> {
        const rows = await this.db.query(
            `SELECT ca.action_id, ca.finding_id, ca.status, ca.closed_at, ca.verified_by, ca.verification_note,
                    f.origin_visit_id
               FROM corrective_action ca
               JOIN finding f ON f.finding_id = ca.finding_id
              WHERE ca.action_id = ?`,
            [actionId],
        );
        if (rows.length === 0) return null;
        const r = rows[0];
        return {
            actionId: Number(r.action_id),
            findingId: Number(r.finding_id),
            originVisitId: Number(r.origin_visit_id),
            status: String(r.status) as CorrectiveActionStatus,
            closedAt: r.closed_at === null ? null : String(r.closed_at),
            verifiedBy: r.verified_by === null ? null : String(r.verified_by),
            verificationNote: r.verification_note === null ? null : String(r.verification_note),
        };
    }

    /** context Visit must exist and belong to the parent Finding's institution. */
    private async validateContextVisit(a: ActionSnapshot, contextVisitId: number, op: string): Promise<void> {
        const rows = await this.db.query(`SELECT institution_id FROM visit WHERE visit_id = ?`, [contextVisitId]);
        if (rows.length === 0) {
            throw new DomainError(
                APP_ERR.VISIT_NOT_FOUND,
                `${op}: context visit ${contextVisitId} does not exist`,
            );
        }
        const originRows = await this.db.query(
            `SELECT institution_id FROM visit WHERE visit_id = ?`,
            [a.originVisitId],
        );
        const originInstitution = Number(originRows[0].institution_id);
        if (Number(rows[0].institution_id) !== originInstitution) {
            throw new DomainError(
                APP_ERR.CONTEXT,
                `${op}: context visit ${contextVisitId} belongs to institution ${rows[0].institution_id} but ` +
                    `the action's parent finding originates from visit ${a.originVisitId} of institution ` +
                    `${originInstitution} — FollowUp context must stay inside the finding's institution`,
            );
        }
    }

    // -- request-shape validation (pure; nothing mutable is read) -----------

    /** FollowUp event semantics (Gate 5E) + strict Gate-5G UTC eventDatetime. */
    private validateEvent(event: CorrectiveActionTransitionEventInput, op: string): ValidatedEvent {
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

    /**
     * RESOLVED: the resolution payload is required and normalized (verifiedBy
     * meaningful — mandatory; verificationNote optional — blank => NULL).
     * Any other target: a supplied resolution payload is REFUSED (E_CONFIG)
     * — closure values are never silently stored or ignored.
     */
    private validateResolution(
        input: TransitionCorrectiveActionStatusInput,
        to: CorrectiveActionStatus,
        op: string,
    ): ValidatedResolution | null {
        if (to !== "RESOLVED") {
            if (input.resolution !== undefined && input.resolution !== null) {
                throw config(
                    `${op}: resolution must not be supplied for a non-RESOLVED target ('${to}') — closure ` +
                        "fields are written only by the RESOLVED transition",
                );
            }
            return null;
        }
        const resolution = input.resolution;
        if (resolution === undefined || resolution === null) {
            throw config(`${op}: target RESOLVED requires a resolution payload with a meaningful verifiedBy`);
        }
        const verifiedBy = normalizeText(resolution.verifiedBy);
        if (verifiedBy === null) {
            throw config(`${op}: resolution.verifiedBy must be meaningful (corrective_action.verified_by)`);
        }
        return { verifiedBy, verificationNote: normalizeText(resolution.verificationNote) };
    }

    // -- retry identity -------------------------------------------------------

    /**
     * Counts the canonical durable FollowUp rows of the requested transition
     * event (Gate §J): finding_id = parent Finding / corrective_action_id =
     * actionId / status_target='CORRECTIVE_ACTION' / status_after = target /
     * null-safe visit_id == requested contextVisitId / event_datetime /
     * actor_role / null-safe actor_role_other / null-safe actor_name /
     * normalized note / normalized recorded_by. Convergence requires EXACTLY
     * one such row; zero => no durable event, more than one => integrity
     * conflict.
     */
    private async durableEventMatchCount(
        a: ActionSnapshot,
        to: string,
        contextVisitId: number | null,
        event: ValidatedEvent,
    ): Promise<number> {
        const rows = await this.db.query(
            `SELECT followup_id
               FROM follow_up
              WHERE finding_id = ?
                AND corrective_action_id = ?
                AND status_target = 'CORRECTIVE_ACTION'
                AND status_after = ?
                AND visit_id IS ?
                AND event_datetime = ?
                AND actor_role = ?
                AND actor_role_other IS ?
                AND actor_name IS ?
                AND note = ?
                AND recorded_by = ?`,
            [
                a.findingId,
                a.actionId,
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

    /**
     * Target closure identity (Gate §J): IN_TREATMENT requires the closure
     * fields to remain NULL; RESOLVED additionally requires closed_at ==
     * event_datetime (the adopted closure timestamp), verified_by == the
     * normalized requested verifiedBy and verification_note == the
     * normalized requested verificationNote (null-safe).
     */
    private closureIdentityMatches(
        a: ActionSnapshot,
        to: string,
        event: ValidatedEvent,
        resolution: ValidatedResolution | null,
    ): boolean {
        if (to === "IN_TREATMENT") {
            return a.closedAt === null && a.verifiedBy === null && a.verificationNote === null;
        }
        if (resolution === null) return false; // unreachable: RESOLVED requires resolution
        return (
            a.closedAt === event.eventDatetime &&
            a.verifiedBy === resolution.verifiedBy &&
            a.verificationNote === resolution.verificationNote
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

    private guardInsert(res: SqlResult, op: string): void {
        if (res.changes !== 1) {
            throw new DomainError(
                APP_ERR.STATE_CONFLICT,
                `${op}: follow_up insert expected one row, got ${res.changes}`,
            );
        }
    }

    // -- result assembly -------------------------------------------------------

    /** converged result — reflects the DURABLE state, never the request. */
    private resultOfDurable(
        a: ActionSnapshot,
        status: CorrectiveActionStatus,
        applied: boolean,
    ): TransitionCorrectiveActionStatusResult {
        return {
            applied,
            actionId: a.actionId,
            findingId: a.findingId,
            status,
            closedAt: a.closedAt,
            verifiedBy: a.verifiedBy,
            verificationNote: a.verificationNote,
        };
    }
}
