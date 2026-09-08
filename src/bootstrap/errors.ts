// Gate 5B — runtime-neutral bootstrap error taxonomy (no node:* imports).
//
// The loader / manifest-verifier never invent silent repairs: every abnormal
// condition is surfaced as a typed BootstrapError whose `code` matches the
// Gate-5A contract vocabulary where one exists:
//   E_NO_ACTIVE_DEFINITION / E_BOOTSTRAP_DRIFT  (APPLICATION-CORE §3.5, T0)
// plus two Gate-5B loader-local codes:
//   E_BOOTSTRAP_CONFLICT  (an ACTIVE definition of another version exists)
//   E_CONFIG              (malformed bootstrap artifact / unusable data)

export const ERR = {
    CONFIG: "E_CONFIG",
    NO_ACTIVE_DEFINITION: "E_NO_ACTIVE_DEFINITION",
    BOOTSTRAP_DRIFT: "E_BOOTSTRAP_DRIFT",
    BOOTSTRAP_CONFLICT: "E_BOOTSTRAP_CONFLICT",
} as const;

export type BootstrapErrorCode = (typeof ERR)[keyof typeof ERR];

export class BootstrapError extends Error {
    readonly code: BootstrapErrorCode;

    constructor(code: BootstrapErrorCode, message: string) {
        super(message);
        this.name = "BootstrapError";
        this.code = code;
    }
}

export function isBootstrapError(e: unknown): e is BootstrapError {
    return e instanceof BootstrapError;
}
