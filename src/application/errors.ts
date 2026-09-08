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
} as const;

export type AppErrorCode = (typeof APP_ERR)[keyof typeof APP_ERR];

export class DomainError extends Error {
    readonly code: AppErrorCode;

    constructor(code: AppErrorCode, message: string) {
        super(message);
        this.name = "DomainError";
        this.code = code;
    }
}

export function isDomainError(e: unknown): e is DomainError {
    return e instanceof DomainError;
}
