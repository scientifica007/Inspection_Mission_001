// Gate 5C — application-core error taxonomy (runtime-neutral TypeScript, no node:* imports).
//
// The Gate-5C executable slice (evaluateApplicability / createVisit T0 /
// addSubjectToScope T1) surfaces every abnormal condition as a typed
// DomainError whose `code` follows the Gate-5A contract vocabulary where one
// exists:
//   * E_CONFIG              — malformed/unknown applicability payload (APPLICATION-CORE §5.4)
//   * E_MISSION_CLOSED      — createVisit on a mission not PREPARATION/ACTIVE (§4.1, T0)
//   * E_VISIT_NOT_PREPARATION — addSubjectToScope on a Visit not in PREPARATION (§4.2)
//   * E_CONTEXT             — subject of another institution (§5.4)
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
//   * E_STATE_CONFLICT      — affected-row cardinality failure (B5) or an
//                             impossible duplicate-ACTIVE resolution state;
//                             "conflict/domain error" of TRANSACTION §1.5/§12

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
    STATE_CONFLICT: "E_STATE_CONFLICT",
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
