// Gate 5C + Gate 5D + Gate 5E — application-core error taxonomy
// (runtime-neutral TypeScript, no node:* imports).
//
// The Gate-5C executable slice (evaluateApplicability / createVisit T0 /
// addSubjectToScope T1) surfaces every abnormal condition as a typed
// DomainError whose `code` follows the Gate-5A contract vocabulary where one
// exists:
//   * E_CONFIG              — malformed/unknown applicability payload (APPLICATION-CORE §5.4);
//                             reused by Gate 5D for a request that does not fit the pinned
//                             cell/definition contract (wrong response_model for the op,
//                             allowed value outside the pinned definition, a NON_COMPLIANT
//                             answer without finding data, an AUTO cell through T5, ...)
//   * E_MISSION_CLOSED      — createVisit on a mission not PREPARATION/ACTIVE (§4.1, T0)
//   * E_VISIT_NOT_PREPARATION — addSubjectToScope / initial disposition on a Visit not in
//                             PREPARATION (§4.2, §4.5, §4.6, §4.4)
//   * E_CONTEXT             — subject/finding of another institution (§5.4)
//   * E_SCOPE_GAP           — partial/mismatched grid (never silently repaired) (§4.2, T1)
// plus the Gate-5B manifest codes reused by T0 (the executable Gate-5B check
// raises BootstrapError; createVisit maps it to the same code in this type):
//   * E_NO_ACTIVE_DEFINITION / E_BOOTSTRAP_DRIFT / E_BOOTSTRAP_CONFLICT / E_CONFIG
// and the application-local codes required by clean executable contracts
// (not in the Gate-5A prose; documented here like bootstrap's loader-local
// codes):
//   * E_MISSION_NOT_FOUND   — mission_id has no row (T0 re-read)
//   * E_VISIT_NOT_FOUND     — visit_id has no row (T1 re-read)
//   * E_SUBJECT_NOT_FOUND   — subjectId has no row (T1 existing-subject path)
//   * E_CELL_NOT_MATERIALIZED / E_ALREADY_DISPOSITIONED / E_HUMAN_NEEDS_DECISION
//                           — Gate-5A §5.4 names adopted as typed codes by the
//                             Gate-5D initial-disposition slice (T2/T3/T4/T5)
//   * E_FINDING_NOT_FOUND   — chosen existing Finding has no row (T2/T3 re-read)
//   * E_FINDING_TARGET_INVALID — existing-Finding target violates the Gate-5A
//                             selectable-status / source-origin / explicit
//                             covers-same-issue contract (§4.7, T2(c)/T3B)
//   * E_STATE_CONFLICT      — affected-row cardinality failure (B5) or an
//                             impossible duplicate-ACTIVE resolution state;
//                             "conflict/domain error" of TRANSACTION §1.5/§12
// and the two Gate-5E correction codes required by the adopted T6 contract
// (TRANSACTION-CONTRACTS §7 — T6-VOID / T6-REHOME):
//   * E_VOID_HAS_ACTIONS    — the Finding carries >=1 CorrectiveAction, so its
//                             last-source VOID / re-home+VOID stays refused in
//                             v1 (Gate 4B + TRANSACTION §7)
//   * E_LAST_SOURCE         — the source in question is (or is not) the Finding's
//                             last source in the wrong operation: an ordinary
//                             detach/re-home on F_old's LAST source is refused
//                             (the dedicated T6-VOID / T6-REHOME branch is
//                             required), and the dedicated VOID/re-home ops
//                             refuse a source that is NOT the last one (ordinary
//                             correction applies — never void)
// and the Gate-5F code required by the adopted T7 contract
// (TRANSACTION-CONTRACTS §8 — createFindingWithObservationSource):
//   * E_OBSERVATION_NOT_FOUND — the observation_id of the T7 ensure-accounted
//                             operation has no adhoc_observation row (T7 only
//                             ensures an EXISTING observation; it never creates
//                             one)
// and the Gate-5J code required by the adopted T10 contract
// (TRANSACTION-CONTRACTS §10 — transitionCorrectiveActionStatus):
//   * E_ACTION_NOT_FOUND     — the actionId of the T10 status-transition
//                             operation has no corrective_action row. The
//                             taxonomy gives every entity lookup its own narrow
//                             not-found code (mission/visit/subject/finding/
//                             observation), so a missing ACTION gets its own —
//                             E_FINDING_NOT_FOUND is never used for it.
// and the Gate-5K finalization-blocker codes adopted by the authoritative
// finalization contract (APPLICATION-CORE-v1.md §8 / TRANSACTION §11 — T11):
// these codes are part of the adopted contract; adding them to the taxonomy
// is implementation alignment, not a new domain decision.
//   * E_UNRESOLVED_PENDING   — a reason-less pending cell survives into
//                             finalization: overlay_state='NOT_INSPECTED',
//                             answered_value_id NULL, not_inspected_reason
//                             NULL (includes unresolved HUMAN_CONFIRMATION
//                             cells — no pending cell may survive)
//   * E_UNINSPECTED_NEEDS_REASON — a deliberate NOT_INSPECTED cell carries no
//                             meaningful (non-blank) reason
//   * E_NC_UNACCOUNTED       — a NON_COMPLIANT answered cell has no finding
//                             link (finding_id IS NULL)
//   * E_NC_NEEDS_NOTE        — a NON_COMPLIANT answered cell has no
//                             meaningful (non-blank) note
//   * E_CHK012               — a SCHEDULE reconciliation state of the Visit
//                             violates the adopted physical/domain invariants
//                             (rows only under SCHEDULE responses; no overlay
//                             with rows; no COMPLIANT with a discrepancy row;
//                             difference/type/OTHER-desc/category invariants)
//   * E_ORPHAN_FINDING       — a Finding with origin_visit_id = this Visit is
//                             OPEN with zero recorded sources across
//                             checklist_response AND adhoc_observation.
//                             VOIDED findings are EXPECTED source-less and are
//                             never orphan blockers (Gate 4B).
// T11 throws ONE DomainError whose `blockers` payload carries the complete
// deterministic list (every blocker of every check — the authoritative
// contract says run ALL finalization checks before rolling back). The
// error's top-level `code` is the first blocker's code in the deterministic
// §8 order; no wrapper code (e.g. E_FINALIZATION_BLOCKED) is invented.
//
// Gate 6C-B extends this same typed DomainError/APP_ERR convention narrowly
// for runtime-neutral Evidence orchestration. USER_CANCELLED remains an
// expected acquisition result (not corruption); E_EVIDENCE_FILE_TOO_LARGE is
// reserved only because no numeric Gate-6C file-size limit has been adopted.

/** One structured finalization blocker (deterministic, machine-readable). */
export interface FinalizationBlocker {
    /** the authoritative blocker code */
    code: AppErrorCode;
    /** machine-readable violation discriminator (stable for tests/UI) */
    kind: string;
    /** durable identifiers/context needed to locate the problem */
    visitId?: number;
    responseId?: number | null;
    itemDefinitionId?: number | null;
    subjectId?: number | null;
    itemCode?: string | null;
    findingId?: number | null;
    /** equipment_reconciliation_row.row_id for E_CHK012 row-level blockers */
    rowId?: number | null;
}

export const APP_ERR = {
    CONFIG: "E_CONFIG",
    MISSION_CLOSED: "E_MISSION_CLOSED",
    MISSION_NOT_FOUND: "E_MISSION_NOT_FOUND",
    VISIT_NOT_FOUND: "E_VISIT_NOT_FOUND",
    VISIT_NOT_PREPARATION: "E_VISIT_NOT_PREPARATION",
    SUBJECT_NOT_FOUND: "E_SUBJECT_NOT_FOUND",
    CONTEXT: "E_CONTEXT",
    SCOPE_GAP: "E_SCOPE_GAP",
    NO_ACTIVE_DEFINITION: "E_NO_ACTIVE_DEFINITION",
    BOOTSTRAP_DRIFT: "E_BOOTSTRAP_DRIFT",
    BOOTSTRAP_CONFLICT: "E_BOOTSTRAP_CONFLICT",
    CELL_NOT_MATERIALIZED: "E_CELL_NOT_MATERIALIZED",
    ALREADY_DISPOSITIONED: "E_ALREADY_DISPOSITIONED",
    HUMAN_NEEDS_DECISION: "E_HUMAN_NEEDS_DECISION",
    FINDING_NOT_FOUND: "E_FINDING_NOT_FOUND",
    FINDING_TARGET_INVALID: "E_FINDING_TARGET_INVALID",
    STATE_CONFLICT: "E_STATE_CONFLICT",
    VOID_HAS_ACTIONS: "E_VOID_HAS_ACTIONS",
    LAST_SOURCE: "E_LAST_SOURCE",
    OBSERVATION_NOT_FOUND: "E_OBSERVATION_NOT_FOUND",
    ACTION_NOT_FOUND: "E_ACTION_NOT_FOUND",
    UNRESOLVED_PENDING: "E_UNRESOLVED_PENDING",
    UNINSPECTED_NEEDS_REASON: "E_UNINSPECTED_NEEDS_REASON",
    NC_UNACCOUNTED: "E_NC_UNACCOUNTED",
    NC_NEEDS_NOTE: "E_NC_NEEDS_NOTE",
    CHK012: "E_CHK012",
    ORPHAN_FINDING: "E_ORPHAN_FINDING",
    EVIDENCE_PERMISSION_DENIED: "E_EVIDENCE_PERMISSION_DENIED",
    EVIDENCE_SOURCE_UNAVAILABLE: "E_EVIDENCE_SOURCE_UNAVAILABLE",
    EVIDENCE_UNSUPPORTED_SOURCE: "E_EVIDENCE_UNSUPPORTED_SOURCE",
    EVIDENCE_STORAGE_WRITE_FAILED: "E_EVIDENCE_STORAGE_WRITE_FAILED",
    EVIDENCE_HASH_FAILED: "E_EVIDENCE_HASH_FAILED",
    EVIDENCE_OWNER_NOT_FOUND: "E_EVIDENCE_OWNER_NOT_FOUND",
    EVIDENCE_OWNER_INVALID: "E_EVIDENCE_OWNER_INVALID",
    EVIDENCE_SQLITE_FAILED: "E_EVIDENCE_SQLITE_FAILED",
    EVIDENCE_STORAGE_REF_CONFLICT: "E_EVIDENCE_STORAGE_REF_CONFLICT",
    EVIDENCE_BROKEN_STORAGE_REFERENCE: "E_EVIDENCE_BROKEN_STORAGE_REFERENCE",
    EVIDENCE_HASH_MISMATCH: "E_EVIDENCE_HASH_MISMATCH",
    EVIDENCE_ORPHAN_CLEANUP_FAILED: "E_EVIDENCE_ORPHAN_CLEANUP_FAILED",
    EVIDENCE_FILE_TOO_LARGE: "E_EVIDENCE_FILE_TOO_LARGE",
    EVIDENCE_NOT_FOUND: "E_EVIDENCE_NOT_FOUND",
    EVIDENCE_RECONCILIATION_REQUIRED: "E_EVIDENCE_RECONCILIATION_REQUIRED",
} as const;

export type AppErrorCode = (typeof APP_ERR)[keyof typeof APP_ERR];

export class DomainError extends Error {
    readonly code: AppErrorCode;
    /** T11 only: the complete deterministic structured blocker list. */
    readonly blockers: readonly FinalizationBlocker[] | undefined;

    constructor(code: AppErrorCode, message: string, blockers?: readonly FinalizationBlocker[]) {
        super(message);
        this.name = "DomainError";
        this.code = code;
        if (blockers !== undefined && blockers.length > 0) {
            this.blockers = blockers;
        }
    }
}

export function isDomainError(e: unknown): e is DomainError {
    return e instanceof DomainError;
}
