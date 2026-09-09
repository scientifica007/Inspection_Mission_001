import type { ProofStatus } from "./proof-types.ts";

export const Q12_NATIVE_ENGINE = "sqlcipher-android-4.17.0" as const;

export type Q12NativeWriteOutcome = "SUCCESS" | "BUSY" | "LOCKED" | "ERROR";

export interface Q12NativeWriteResult {
  outcome: Q12NativeWriteOutcome;
  exceptionClass: string | null;
  sqliteResultCode: number | null;
}

export interface Q12Observation {
  samePhysicalFile: boolean;
  databaseBasename: string;
  nativeEngine: string;
  expectedNativeEngine: string;
  primarySqliteVersion: string;
  competingSqliteVersion: string;
  busyTimeoutMs: number;
  preflightWrite: Q12NativeWriteResult;
  preflightMarkerCountSeenByPrimary: number;
  primaryBeginImmediate: boolean;
  duringPrimaryLock: Q12NativeWriteResult;
  lockedMarkerCount: number;
  primaryRelease: boolean;
  postReleaseWrite: Q12NativeWriteResult;
  postReleaseMarkerCount: number;
  cleanupComplete: boolean;
  nativeClosed: boolean;
}

export interface Q12Decision {
  status: ProofStatus;
  evidence: string;
}

function compact(o: Q12Observation): string {
  const during = o.duringPrimaryLock.exceptionClass
    ? `${o.duringPrimaryLock.outcome}/${o.duringPrimaryLock.exceptionClass}/code=${String(o.duringPrimaryLock.sqliteResultCode)}`
    : o.duringPrimaryLock.outcome;
  return [
    `samePhysicalFile=${o.samePhysicalFile}`,
    `databaseBasename=${o.databaseBasename || "unknown"}`,
    `nativeEngine=${o.nativeEngine || "unknown"}`,
    `preflightWrite=${o.preflightWrite.outcome}`,
    `preflightMarkerCount=${o.preflightMarkerCountSeenByPrimary}`,
    `primaryBeginImmediate=${o.primaryBeginImmediate}`,
    `duringPrimaryLock=${during}`,
    `busyTimeoutMs=${o.busyTimeoutMs}`,
    `lockedMarkerCount=${o.lockedMarkerCount}`,
    `primaryRelease=${o.primaryRelease}`,
    `postReleaseWrite=${o.postReleaseWrite.outcome}`,
    `postReleaseMarkerCount=${o.postReleaseMarkerCount}`,
    `cleanupComplete=${o.cleanupComplete}`,
    `nativeClosed=${o.nativeClosed}`,
  ].join("; ");
}

export function classifyQ12(o: Q12Observation): Q12Decision {
  const evidence = compact(o);
  if (!o.samePhysicalFile) return { status: "FAIL", evidence: `same-file proof contradicted after native open; ${evidence}` };
  if (o.nativeEngine !== o.expectedNativeEngine) return { status: "BLOCKED", evidence: `native engine/version mismatch; ${evidence}` };
  if (!o.primarySqliteVersion || o.primarySqliteVersion !== o.competingSqliteVersion) {
    return { status: "BLOCKED", evidence: `primary/competing sqlite_version mismatch; ${evidence}` };
  }
  if (o.busyTimeoutMs !== 0) return { status: "BLOCKED", evidence: `native busy policy was not the required bounded zero-wait policy; ${evidence}` };
  if (o.preflightWrite.outcome !== "SUCCESS" || o.preflightMarkerCountSeenByPrimary !== 1) {
    return { status: "BLOCKED", evidence: `independent writer preflight was not proven; ${evidence}` };
  }
  if (!o.primaryBeginImmediate) return { status: "FAIL", evidence: `primary adapter did not acquire BEGIN IMMEDIATE; ${evidence}` };
  if (o.duringPrimaryLock.outcome === "SUCCESS") return { status: "FAIL", evidence: `independent writer wrote while primary BEGIN IMMEDIATE was held; ${evidence}` };
  if (o.duringPrimaryLock.outcome === "ERROR") return { status: "BLOCKED", evidence: `during-lock native failure was not classifiable as SQLITE_BUSY/SQLITE_LOCKED; ${evidence}` };
  if (o.lockedMarkerCount !== 0) return { status: "FAIL", evidence: `locked marker became visible while primary transaction owned the write lock; ${evidence}` };
  if (!o.primaryRelease) return { status: "FAIL", evidence: `primary transaction did not release normally; ${evidence}` };
  if (o.postReleaseWrite.outcome !== "SUCCESS") return { status: "FAIL", evidence: `same independent write did not succeed after primary release; ${evidence}` };
  if (o.postReleaseMarkerCount !== 1) return { status: "FAIL", evidence: `post-release marker cardinality was not exactly one; ${evidence}` };
  if (!o.cleanupComplete) return { status: "BLOCKED", evidence: `synthetic Q12 marker cleanup did not complete; ${evidence}` };
  if (!o.nativeClosed) return { status: "BLOCKED", evidence: `native competing writer did not close cleanly; ${evidence}` };
  return { status: "PASS", evidence };
}
