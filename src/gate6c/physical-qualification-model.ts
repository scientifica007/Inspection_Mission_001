export const GATE6CD_PHYSICAL_SCENARIO_IDS = [
  "G6CD-Q01-CAMERA-COMMIT",
  "G6CD-Q02-GALLERY-COMMIT",
  "G6CD-Q03-GENERIC-FILE-COMMIT",
  "G6CD-Q04-CANCEL",
  "G6CD-Q05-PERMISSION-DENIED",
  "G6CD-Q06-SOURCE-LOSS",
  "G6CD-Q07-RESTORED-CAMERA",
  "G6CD-Q08-RESTART-RECONCILIATION",
  "G6CD-Q09-ORPHAN-CLEANUP",
  "G6CD-Q10-MISSING-FILE",
  "G6CD-Q11-LARGE-FILE",
  "G6CD-Q12-WRITE-FAILURE",
  "G6CD-Q13-RETRIEVAL-AFTER-RESTART",
] as const;

export const GATE6CD_SETUP_SCENARIO_ID = "G6CD-SETUP-SYNTHETIC-OWNER" as const;

export type Gate6CDPhysicalScenarioId = (typeof GATE6CD_PHYSICAL_SCENARIO_IDS)[number];
export type Gate6CDScenarioId = Gate6CDPhysicalScenarioId | typeof GATE6CD_SETUP_SCENARIO_ID;
export type Gate6CDQualificationStatus = "PASS" | "FAIL" | "BLOCKED";
export type Gate6CDHashVerificationResult = "MATCH" | "MISMATCH" | "HISTORICAL_HASH_ABSENT" | "FAILED" | "NOT_RUN";
export type Gate6CDResolveStatus = "RESOLVED" | "FAILED" | "NOT_RUN";
export type Gate6CDJsonPrimitive = string | number | boolean | null;

export interface Gate6CDRuntimeDescriptor {
  platform: string;
  native: boolean;
  android: boolean;
}

export interface Gate6CDReconciliationSummary {
  kind: string;
  storageRef?: string;
  evidenceId?: number;
  ref?: string;
  evidenceIds?: readonly number[];
}

export interface Gate6CDQualificationResult {
  schemaVersion: "gate6c-d-physical-evidence-qualification-v1";
  scenarioId: Gate6CDScenarioId;
  testedGitSha: string;
  runtime: Gate6CDRuntimeDescriptor;
  timestamp: string;
  acquisitionOutcome: string;
  sourceKind: "CAMERA_PHOTO" | "GALLERY_MEDIA" | "GENERIC_FILE" | null;
  evidenceId: number | null;
  storageRef: string | null;
  canonicalStorageRef: boolean | null;
  fileSize: number | null;
  contentHash: string | null;
  canonicalContentHash: boolean | null;
  reconciliationResult: readonly Gate6CDReconciliationSummary[];
  resolveResult: {
    status: Gate6CDResolveStatus;
    handleScheme: string | null;
  };
  hashVerificationResult: Gate6CDHashVerificationResult;
  sqliteRowCount: number;
  status: Gate6CDQualificationStatus;
  failureStage: string | null;
  failureCode: string | null;
  details: Readonly<Record<string, Gate6CDJsonPrimitive>>;
}

export interface Gate6CDResultInput {
  scenarioId: Gate6CDScenarioId;
  testedGitSha: string;
  runtime: Gate6CDRuntimeDescriptor;
  status: Gate6CDQualificationStatus;
  timestamp?: string;
  acquisitionOutcome?: string;
  sourceKind?: Gate6CDQualificationResult["sourceKind"];
  evidenceId?: number | null;
  storageRef?: string | null;
  canonicalStorageRef?: boolean | null;
  fileSize?: number | null;
  contentHash?: string | null;
  canonicalContentHash?: boolean | null;
  reconciliationResult?: readonly Gate6CDReconciliationSummary[];
  resolveResult?: Gate6CDQualificationResult["resolveResult"];
  hashVerificationResult?: Gate6CDHashVerificationResult;
  sqliteRowCount?: number;
  failureStage?: string | null;
  failureCode?: string | null;
  details?: Readonly<Record<string, Gate6CDJsonPrimitive>>;
}

export function buildGate6CDQualificationResult(input: Gate6CDResultInput): Gate6CDQualificationResult {
  return {
    schemaVersion: "gate6c-d-physical-evidence-qualification-v1",
    scenarioId: input.scenarioId,
    testedGitSha: input.testedGitSha,
    runtime: { ...input.runtime },
    timestamp: input.timestamp ?? new Date().toISOString(),
    acquisitionOutcome: input.acquisitionOutcome ?? "NOT_RUN",
    sourceKind: input.sourceKind ?? null,
    evidenceId: input.evidenceId ?? null,
    storageRef: input.storageRef ?? null,
    canonicalStorageRef: input.canonicalStorageRef ?? null,
    fileSize: input.fileSize ?? null,
    contentHash: input.contentHash ?? null,
    canonicalContentHash: input.canonicalContentHash ?? null,
    reconciliationResult: [...(input.reconciliationResult ?? [])],
    resolveResult: input.resolveResult ?? { status: "NOT_RUN", handleScheme: null },
    hashVerificationResult: input.hashVerificationResult ?? "NOT_RUN",
    sqliteRowCount: input.sqliteRowCount ?? 0,
    status: input.status,
    failureStage: input.failureStage ?? null,
    failureCode: input.failureCode ?? null,
    details: { ...(input.details ?? {}) },
  };
}

export function expectedFailureSatisfied(
  expectedCode: string,
  actualCode: string | null,
  rowsBefore: number,
  rowsAfter: number,
): boolean {
  return actualCode === expectedCode && rowsAfter === rowsBefore;
}

export function canonicalGate6CDQualificationJson(result: Gate6CDQualificationResult): string {
  assertSafeEvidencePayload(result, "$");
  return JSON.stringify(sortValue(result), null, 2);
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function assertSafeEvidencePayload(value: unknown, path: string): void {
  if (typeof value === "string") {
    if (/^(?:content|file):\/\//i.test(value)) {
      throw new Error(`Gate 6C-D qualification JSON refuses raw source/handle URI at ${path}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeEvidencePayload(item, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/^(?:sourceRef|sourceUri|deviceSerial|serialNumber)$/i.test(key)) {
      throw new Error(`Gate 6C-D qualification JSON refuses sensitive field '${key}' at ${path}`);
    }
    assertSafeEvidencePayload(child, `${path}.${key}`);
  }
}
