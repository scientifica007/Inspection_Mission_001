// Gate 5I — T9 `createCorrectiveAction` (runtime-neutral TypeScript, no
// node:* imports).
//
// Implements the adopted identity-creating CorrectiveAction operation of
// TRANSACTION-CONTRACTS-v1.md §10 / APPLICATION-CORE-v1.md §4.13:
//
//   * Creates exactly ONE new durable CorrectiveAction identity under ONE
//     existing Finding. CorrectiveActions are optional (0..*) per Finding:
//     resolving a Finding never REQUIRES an action, multiple actions under
//     one Finding are valid, and there is no dedupe by description / type /
//     due date / responsible person (no duplicate prohibition exists).
//
//   * One explicit BEGIN IMMEDIATE … COMMIT/ROLLBACK unit (the mutable
//     parent-Finding authorization read happens INSIDE the transaction —
//     no TOCTOU window):
//       re-read parent Finding (missing => E_FINDING_NOT_FOUND)
//       -> parent status gate: OPEN | IN_TREATMENT proceed;
//          RESOLVED | VOIDED (or any other durable status) =>
//          E_STATE_CONFLICT (validated in-tx BEFORE the INSERT, so the
//          schema trigger trg_ca_bi never surfaces as a raw SQLite abort)
//       -> validate/normalize the creation payload (project conventions)
//       -> single identity-creating INSERT with status = 'OPEN' and
//          closure fields closed_at / verified_by / verification_note
//          explicitly NULL (never populated at creation)
//       -> require changes == 1 (B5) and a present lastInsertRowid, else
//          ROLLBACK + E_STATE_CONFLICT
//       -> COMMIT.
//     Every failure rolls the whole unit back — no other row is created,
//     nothing else is modified.
//
//   * NO Visit gate (intentionally different from the T6 source
//     corrections): the corrective-action lifecycle may continue after the
//     origin Visit has been finalized, as long as the Finding is still
//     OPEN or IN_TREATMENT. T9 never reopens or modifies the Visit.
//
//   * Creating a CorrectiveAction NEVER: alters the Finding status or
//     status_changed_at, alters Finding source links, alters the Visit,
//     creates a Finding, or resolves anything. T10 owns action status
//     transitions/closure later.
//
//   * Creation FollowUp boundary (audited Gate-5I decision): the only
//     authoritative T9 contract (TRANSACTION §10) is the action row
//     itself; RECOVERY §2 mentions an "(+ optional FollowUp event)" but NO
//     authoritative document defines when it is supplied, its
//     status_target/status_after semantics, its actor/audit payload,
//     whether creation counts as a transition event, or its retry/recovery
//     identity (DATA-MODEL rule 8 ties FollowUp events to status
//     TRANSITIONS — a row created OPEN is not a transition). T9 therefore
//     records the action row ONLY; no creation FollowUp is invented. The
//     optional-event contract is reported to the owner as an open
//     ambiguity, not silently broadened.
//
//   * DELIBERATELY Class B (identity-creating; RECOVERY §5 / TRANSACTION
//     §12): the project has adopted NO durable request/idempotency key for
//     corrective-action creation — no UNIQUE constraint, no dedupe by
//     description/type/due date/responsible person, no hash, no sidecar
//     idempotency table, no client request token. Two intentional
//     invocations with identical payloads create two distinct actions.
//     After "COMMIT succeeded but ACK lost" the outcome is ambiguous to
//     the caller: the service never internally re-issues the INSERT and
//     never inspects payload fields to claim an existing row "must be" the
//     same attempt; recovery reconstructs/surfaces the durable actions to
//     the inspector/caller instead of auto-resubmitting. Exactly-once is
//     never claimed.
//
//   * Field contract (schema CHECKs mirrored as typed validation; no
//     invented semantics):
//       actionType          closed set MAINTENANCE_WORK | TASYIR_UPDATE |
//                           PROCUREMENT_DISTRIBUTION | ADMIN_ORGANIZATIONAL
//                           | OTHER (else E_CONFIG);
//       actionTypeOther     required meaningful when actionType === OTHER;
//                           otherwise normalized like the adopted optional
//                           companion-text convention (trim; blank => NULL);
//       description         required meaningful normalized text;
//       responsibleRole     closed set DIRECTOR | CONCERNED_SERVICE |
//                           INSPECTOR | OTHER (else E_CONFIG);
//       responsibleRoleOther required meaningful when responsibleRole ===
//                           OTHER; otherwise normalized (trim; blank=>NULL);
//       responsibleName     optional; blank normalizes to NULL (adopted
//                           optional-text convention);
//       dueDate             optional NULL-able TEXT preserved verbatim —
//                           NO strict format is invented (the physical
//                           schema stores nullable TEXT and no
//                           authoritative doc mandates ISO date semantics;
//                           documented boundary, trimmed/blank=>NULL per
//                           the adopted normalization convention only);
//       createdAt           required app-supplied audit timestamp,
//                           validated as a REAL ISO-8601 UTC instant in the
//                           adopted strict form (Gate-5G convention shared
//                           by every audit timestamp), never invented
//                           internally;
//       createdBy           required meaningful normalized text.
//
// Out of scope (later gates): T8 behavior, T10 CorrectiveAction status
// transitions, T11 finalization, observation correction, evidence,
// external-system tracking, reports/UI/sync.

import type { SqlAdapter, SqlResult, SqlValue } from "../bootstrap/adapter.ts";
import { APP_ERR, DomainError } from "./errors.ts";

// ---------------------------------------------------------------------------
// public types
// ---------------------------------------------------------------------------

/** Every CorrectiveAction action_type value known to the schema CHECK. */
export const CORRECTIVE_ACTION_TYPES = [
    "MAINTENANCE_WORK",
    "TASYIR_UPDATE",
    "PROCUREMENT_DISTRIBUTION",
    "ADMIN_ORGANIZATIONAL",
    "OTHER",
] as const;
export type CorrectiveActionType = (typeof CORRECTIVE_ACTION_TYPES)[number];

/** Every CorrectiveAction responsible_role value known to the schema CHECK. */
export const CORRECTIVE_ACTION_RESPONSIBLE_ROLES = [
    "DIRECTOR",
    "CONCERNED_SERVICE",
    "INSPECTOR",
    "OTHER",
] as const;
export type CorrectiveActionResponsibleRole = (typeof CORRECTIVE_ACTION_RESPONSIBLE_ROLES)[number];

export interface CreateCorrectiveActionInput {
    /** the durable key of the parent Finding (must exist and be OPEN | IN_TREATMENT) */
    findingId: number;
    actionType: CorrectiveActionType;
    /** required meaningful when actionType === "OTHER"; optional otherwise */
    actionTypeOther?: string | null;
    /** meaningful action description (normalized: trimmed; blank => E_CONFIG) */
    description: string;
    responsibleRole: CorrectiveActionResponsibleRole;
    /** required meaningful when responsibleRole === "OTHER"; optional otherwise */
    responsibleRoleOther?: string | null;
    /** optional executor name; blank normalizes to NULL (adopted convention) */
    responsibleName?: string | null;
    /**
     * optional NULL-able due date text — stored as supplied (trimmed; blank
     * normalizes to NULL). No strict format is invented: the adopted
     * contract stores nullable TEXT and mandates no ISO date semantics.
     */
    dueDate?: string | null;
    /**
     * app-supplied audit timestamp in the adopted strict ISO-8601 UTC form
     * `YYYY-MM-DDTHH:MM:SS[.fraction]Z` (explicit 'Z'; calendar-valid
     * components) — never invented internally.
     */
    createdAt: string;
    /** meaningful audit actor (normalized: trimmed; blank => E_CONFIG) */
    createdBy: string;
}

/** the created durable CorrectiveAction state (exactly what was committed). */
export interface CorrectiveActionState {
    actionId: number;
    findingId: number;
    actionType: CorrectiveActionType;
    actionTypeOther: string | null;
    description: string;
    responsibleRole: CorrectiveActionResponsibleRole;
    responsibleRoleOther: string | null;
    responsibleName: string | null;
    dueDate: string | null;
    /** ALWAYS exactly "OPEN" on creation (trg_ca_bi: actions are born OPEN) */
    status: "OPEN";
    /** closure fields are ALWAYS NULL at creation (T10 owns them later) */
    closedAt: null;
    verifiedBy: null;
    verificationNote: null;
    createdAt: string;
    createdBy: string;
}

// ---------------------------------------------------------------------------
// internal model
// ---------------------------------------------------------------------------

interface FindingSnapshot {
    findingId: number;
    status: string;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function config(what: string): DomainError {
    return new DomainError(APP_ERR.CONFIG, `createCorrectiveAction: ${what}`);
}

function stateConflict(what: string): DomainError {
    return new DomainError(APP_ERR.STATE_CONFLICT, `createCorrectiveAction: ${what}`);
}

/** trim; blank/missing => null (the adopted optional-text convention). */
function normalizeText(v: string | null | undefined): string | null {
    if (v === null || v === undefined) return null;
    const t = v.trim();
    return t.length === 0 ? null : t;
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

export class CorrectiveActionCreateService {
    private readonly db: SqlAdapter;

    constructor(db: SqlAdapter) {
        this.db = db;
    }

    /**
     * T9 — create exactly one durable CorrectiveAction identity under one
     * existing Finding. Identity-creating Class-B operation: no dedupe, no
     * idempotency key, no auto-retry (TRANSACTION §12 / RECOVERY §5).
     */
    async createCorrectiveAction(input: CreateCorrectiveActionInput): Promise<CorrectiveActionState> {
        const op = "createCorrectiveAction";
        return this.runUnit(async () => {
            // 1) authoritative parent-Finding read INSIDE BEGIN IMMEDIATE
            //    (no TOCTOU window for the mutable status authorization)
            const finding = await this.readFinding(input.findingId, op);

            // 2) parent status gate: OPEN | IN_TREATMENT proceed;
            //    RESOLVED | VOIDED (or any other durable status) refused
            //    with the adopted typed state-conflict vocabulary — the
            //    trg_ca_bi precondition is validated in-tx so the raw
            //    trigger abort is never leaked
            if (finding.status !== "OPEN" && finding.status !== "IN_TREATMENT") {
                throw stateConflict(
                    `${op}: finding ${finding.findingId} is '${finding.status}' — a CorrectiveAction may only be ` +
                        "created under an OPEN or IN_TREATMENT finding (RESOLVED and VOIDED findings refuse new " +
                        "actions, matching the trg_ca_bi precondition)",
                );
            }

            // 3) validate/normalize the creation payload (project conventions;
            //    no invented semantics — see the module header)
            const payload = this.validatePayload(input, op);

            // 4) the single identity-creating INSERT — born OPEN with every
            //    closure field explicitly NULL (nothing else is created)
            const res = await this.db.run(
                `INSERT INTO corrective_action(finding_id, action_type, action_type_other, description,
                                               responsible_role, responsible_role_other, responsible_name,
                                               due_date, status, closed_at, verified_by, verification_note,
                                               created_at, created_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', NULL, NULL, NULL, ?, ?)`,
                [
                    finding.findingId,
                    payload.actionType,
                    payload.actionTypeOther,
                    payload.description,
                    payload.responsibleRole,
                    payload.responsibleRoleOther,
                    payload.responsibleName,
                    payload.dueDate,
                    payload.createdAt,
                    payload.createdBy,
                ] as readonly SqlValue[],
            );
            this.guardInsert(res, op);
            if (res.lastInsertRowid === null) {
                throw stateConflict(`${op}: corrective action insert returned no rowid`);
            }
            const actionId = Number(res.lastInsertRowid);

            // 5) the created durable identity/state (COMMIT happens in runUnit)
            return {
                actionId,
                findingId: finding.findingId,
                actionType: payload.actionType,
                actionTypeOther: payload.actionTypeOther,
                description: payload.description,
                responsibleRole: payload.responsibleRole,
                responsibleRoleOther: payload.responsibleRoleOther,
                responsibleName: payload.responsibleName,
                dueDate: payload.dueDate,
                status: "OPEN",
                closedAt: null,
                verifiedBy: null,
                verificationNote: null,
                createdAt: payload.createdAt,
                createdBy: payload.createdBy,
            };
        });
    }

    // -- reads / authorization (all INSIDE the write transaction) ------------

    private async readFinding(findingId: number, op: string): Promise<FindingSnapshot> {
        const rows = await this.db.query(
            `SELECT finding_id, status FROM finding WHERE finding_id = ?`,
            [findingId],
        );
        if (rows.length === 0) {
            throw new DomainError(APP_ERR.FINDING_NOT_FOUND, `${op}: finding ${findingId} does not exist`);
        }
        return { findingId: Number(rows[0].finding_id), status: String(rows[0].status) };
    }

    // -- request-shape validation (pure; nothing mutable is read) ------------

    private validatePayload(
        input: CreateCorrectiveActionInput,
        op: string,
    ): {
        actionType: CorrectiveActionType;
        actionTypeOther: string | null;
        description: string;
        responsibleRole: CorrectiveActionResponsibleRole;
        responsibleRoleOther: string | null;
        responsibleName: string | null;
        dueDate: string | null;
        createdAt: string;
        createdBy: string;
    } {
        if (!(CORRECTIVE_ACTION_TYPES as readonly string[]).includes(input.actionType)) {
            throw config(`${op}: actionType must be one of ${CORRECTIVE_ACTION_TYPES.join(" | ")}`);
        }
        const actionTypeOther = normalizeText(input.actionTypeOther);
        if (input.actionType === "OTHER" && actionTypeOther === null) {
            throw config(`${op}: actionType=OTHER requires a meaningful actionTypeOther`);
        }
        const description = normalizeText(input.description);
        if (description === null) {
            throw config(`${op}: a meaningful description is required (corrective_action.description)`);
        }
        if (!(CORRECTIVE_ACTION_RESPONSIBLE_ROLES as readonly string[]).includes(input.responsibleRole)) {
            throw config(
                `${op}: responsibleRole must be one of ${CORRECTIVE_ACTION_RESPONSIBLE_ROLES.join(" | ")}`,
            );
        }
        const responsibleRoleOther = normalizeText(input.responsibleRoleOther);
        if (input.responsibleRole === "OTHER" && responsibleRoleOther === null) {
            throw config(`${op}: responsibleRole=OTHER requires a meaningful responsibleRoleOther`);
        }
        const responsibleName = normalizeText(input.responsibleName);
        // due_date: optional NULL-able TEXT preserved as supplied — no strict
        // format is invented (adopted contract stores nullable TEXT with no
        // ISO-date mandate); only the adopted trim/blank=>NULL normalization
        // convention applies.
        const dueDate = normalizeText(input.dueDate);
        const createdAt = normalizeText(input.createdAt);
        if (createdAt === null) {
            throw config(`${op}: createdAt must be an app-supplied ISO-8601 UTC timestamp`);
        }
        if (validateStrictUtcTimestamp(createdAt) === null) {
            throw config(
                `${op}: createdAt must be a real ISO-8601 UTC instant in strict form ` +
                    "YYYY-MM-DDTHH:MM:SS[.fraction]Z (explicit 'Z'; no local / timezone-less / offset forms; " +
                    "calendar-valid components; the time is never invented internally)",
            );
        }
        const createdBy = normalizeText(input.createdBy);
        if (createdBy === null) {
            throw config(`${op}: createdBy must be meaningful (corrective_action.created_by)`);
        }
        return {
            actionType: input.actionType,
            actionTypeOther,
            description,
            responsibleRole: input.responsibleRole,
            responsibleRoleOther,
            responsibleName,
            dueDate,
            createdAt,
            createdBy,
        };
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
            throw stateConflict(`${op}: corrective action insert expected exactly one row, got ${res.changes}`);
        }
    }
}
