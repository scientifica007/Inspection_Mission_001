import type { QualificationCase } from "./proof-types.ts";

export interface Q12FatalDiagnostic {
  status: "FAIL" | "BLOCKED";
  stage: string;
  detail: string;
}

export interface Q12FatalEvidenceContext {
  samePhysicalFile: boolean;
  databaseBasename: string;
  nativeClosed: boolean;
}

export interface Q12ErrorDiagnostic {
  detail: string;
  code: string | null;
  nativeStage: string | null;
  exceptionClass: string | null;
  exceptionMessage: string | null;
}

const NATIVE_OPEN_CODE_PREFIX = "G6B_Q12_NATIVE_OPEN_";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function codeField(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function stageFromCode(code: string | null): string | null {
  if (!code?.startsWith(NATIVE_OPEN_CODE_PREFIX)) return null;
  const suffix = code.slice(NATIVE_OPEN_CODE_PREFIX.length);
  return suffix.length > 0 ? suffix.toLowerCase() : null;
}

export function diagnoseQ12Error(error: unknown): Q12ErrorDiagnostic {
  const record = isRecord(error) ? error : null;
  const data = record && isRecord(record.data) ? record.data : null;
  const code = codeField(record?.code);
  const nativeStage = stringField(data?.stage) ?? stageFromCode(code);
  const exceptionClass = stringField(data?.exceptionClass);
  const exceptionMessage = stringField(data?.exceptionMessage);

  const name = error instanceof Error
    ? (error.name || "Error")
    : (stringField(record?.name) ?? (typeof error === "string" ? "StringError" : "UnknownError"));
  const message = error instanceof Error
    ? error.message
    : (stringField(record?.message) ?? (typeof error === "string" ? error : "unknown error"));

  const payload: Record<string, string> = { name, message };
  if (code !== null) payload.code = code;
  if (nativeStage !== null) payload.nativeStage = nativeStage;
  if (exceptionClass !== null) payload.exceptionClass = exceptionClass;
  if (exceptionMessage !== null) payload.exceptionMessage = exceptionMessage;

  return {
    detail: JSON.stringify(payload),
    code,
    nativeStage,
    exceptionClass,
    exceptionMessage,
  };
}

export function q12FatalQualificationCase(
  fatal: Q12FatalDiagnostic,
  context: Q12FatalEvidenceContext,
): QualificationCase {
  return {
    id: "Q12_COMPETING_WRITE",
    status: fatal.status,
    evidence: `stage=${fatal.stage}; detail=${fatal.detail}; samePhysicalFile=${context.samePhysicalFile}; databaseBasename=${context.databaseBasename}; nativeClosed=${context.nativeClosed}`,
  };
}
