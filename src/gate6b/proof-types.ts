export type ProofStatus = "PASS" | "FAIL" | "BLOCKED";

export interface QualificationCase {
  id: string;
  status: ProofStatus;
  evidence: string;
}

export interface Gate6BProofOutput {
  gate: "6B";
  proofFormatVersion: 1;
  testedGitCommitSha: string;
  androidAppPackageId: string;
  capacitorVersion: string;
  sqlitePlugin: { package: "@capacitor-community/sqlite"; version: string; status: "PROVISIONAL_CANDIDATE_PENDING_DEVICE_PROOF" };
  sqliteEngineVersion: string;
  schemaAssetSha256: string;
  bootstrapAssetSha256: string;
  phase: string;
  timestamp: string;
  qualification: QualificationCase[];
  visitIdentifierRecoveredFromSqlite: number | null;
  currentVisitStateZeroWrite: { measured: boolean; before: number | null; after: number | null; delta: number | null };
  stateHashSha256?: string;
  overallResult: "PASS" | "FAIL" | "BLOCKED" | "DEVICE_PROOF_READY";
}

export function overallOf(cases: readonly QualificationCase[], ready = false): Gate6BProofOutput["overallResult"] {
  if (cases.some((c) => c.status === "FAIL")) return "FAIL";
  if (cases.some((c) => c.status === "BLOCKED")) return ready ? "DEVICE_PROOF_READY" : "BLOCKED";
  return ready ? "DEVICE_PROOF_READY" : "PASS";
}
