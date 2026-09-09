import { registerPlugin } from "@capacitor/core";
import type { Q12NativeWriteResult } from "../gate6b/q12-qualification.ts";

interface NativeOpenResult {
  samePhysicalFile: boolean;
  databaseBasename: string;
  nativeEngine: string;
  sqliteVersion: string;
  busyTimeoutMs: number;
  probeTableReadable: boolean;
}

interface NativeWriteResult {
  outcome: string;
  exceptionClass?: string;
  sqliteResultCode?: number;
}

interface Gate6BCompetingWriterNative {
  open(options: { databasePath: string }): Promise<NativeOpenResult>;
  insertMarker(options: { marker: string }): Promise<NativeWriteResult>;
  close(): Promise<{ closed: boolean }>;
}

const nativeWriter = registerPlugin<Gate6BCompetingWriterNative>("Gate6BCompetingWriter");

export interface CompetingWriterOpenResult {
  samePhysicalFile: boolean;
  databaseBasename: string;
  nativeEngine: string;
  sqliteVersion: string;
  busyTimeoutMs: number;
  probeTableReadable: boolean;
}

export async function openGate6BCompetingWriter(databasePath: string): Promise<CompetingWriterOpenResult> {
  return nativeWriter.open({ databasePath });
}

export async function insertGate6BCompetingMarker(marker: string): Promise<Q12NativeWriteResult> {
  const result = await nativeWriter.insertMarker({ marker });
  const outcome = result.outcome;
  if (outcome !== "SUCCESS" && outcome !== "BUSY" && outcome !== "LOCKED" && outcome !== "ERROR") {
    return { outcome: "ERROR", exceptionClass: "Gate6BInvalidNativeOutcome", sqliteResultCode: null };
  }
  return {
    outcome,
    exceptionClass: typeof result.exceptionClass === "string" ? result.exceptionClass : null,
    sqliteResultCode: typeof result.sqliteResultCode === "number" ? result.sqliteResultCode : null,
  };
}

export async function closeGate6BCompetingWriter(): Promise<boolean> {
  const result = await nativeWriter.close();
  return result.closed === true;
}
