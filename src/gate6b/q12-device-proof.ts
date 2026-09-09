import type { OpenGate6BDatabase } from "../device/gate6b-database.ts";
import {
  closeGate6BCompetingWriter,
  insertGate6BCompetingMarker,
  openGate6BCompetingWriter,
} from "../device/gate6b-competing-writer.ts";
import {
  classifyQ12,
  Q12_NATIVE_ENGINE,
  type Q12NativeWriteResult,
  type Q12Observation,
} from "./q12-qualification.ts";
import {
  diagnoseQ12Error,
  q12FatalQualificationCase,
  type Q12FatalDiagnostic,
} from "./q12-diagnostics.ts";
import type { QualificationCase } from "./proof-types.ts";

const PREFLIGHT_MARKER = "g6b-q12-preflight";
const LOCK_MARKER = "g6b-q12-lock-marker";

const notAttempted = (): Q12NativeWriteResult => ({
  outcome: "ERROR",
  exceptionClass: "Gate6BNotAttempted",
  sqliteResultCode: null,
});

async function markerCount(opened: OpenGate6BDatabase, marker: string): Promise<number> {
  const rows = await opened.adapter.query("SELECT count(*) AS c FROM __g6b_probe WHERE text_value=?", [marker]);
  return Number(rows[0]?.c ?? -1);
}

function fatalFromError(status: "FAIL" | "BLOCKED", stage: string, error: unknown): Q12FatalDiagnostic {
  const diagnostic = diagnoseQ12Error(error);
  const exactStage = stage === "native_open" && diagnostic.nativeStage
    ? `${stage}/${diagnostic.nativeStage}`
    : stage;
  return { status, stage: exactStage, detail: diagnostic.detail };
}

export async function runQ12CompetingWriterProof(opened: OpenGate6BDatabase): Promise<QualificationCase> {
  const observation: Q12Observation = {
    samePhysicalFile: false,
    databaseBasename: "unknown",
    nativeEngine: "unknown",
    expectedNativeEngine: Q12_NATIVE_ENGINE,
    primarySqliteVersion: opened.sqliteVersion,
    competingSqliteVersion: "unknown",
    busyTimeoutMs: -1,
    preflightWrite: notAttempted(),
    preflightMarkerCountSeenByPrimary: -1,
    primaryBeginImmediate: false,
    duringPrimaryLock: notAttempted(),
    lockedMarkerCount: -1,
    primaryRelease: false,
    postReleaseWrite: notAttempted(),
    postReleaseMarkerCount: -1,
    cleanupComplete: false,
    nativeClosed: false,
  };

  let nativeOpen = false;
  let primaryLocked = false;
  let fatal: Q12FatalDiagnostic | null = null;
  let preflightClean = false;
  let finalMarkerClean = false;

  try {
    await closeGate6BCompetingWriter().catch(() => false);
    const databaseList = await opened.adapter.query("PRAGMA database_list;");
    const main = databaseList.find((row) => String(row.name ?? "") === "main");
    const mainPath = typeof main?.file === "string" ? main.file : "";
    if (!mainPath) {
      fatal = { status: "BLOCKED", stage: "primary_database_list", detail: "main path unavailable" };
    }

    if (!fatal) {
      try {
        const native = await openGate6BCompetingWriter(mainPath);
        nativeOpen = true;
        observation.samePhysicalFile = native.samePhysicalFile;
        observation.databaseBasename = native.databaseBasename;
        observation.nativeEngine = native.nativeEngine;
        observation.competingSqliteVersion = native.sqliteVersion;
        observation.busyTimeoutMs = native.busyTimeoutMs;
        if (!native.probeTableReadable) fatal = { status: "BLOCKED", stage: "native_open/probe_table_read", detail: "probe table not readable" };
      } catch (error) {
        fatal = fatalFromError("BLOCKED", "native_open", error);
      }
    }

    if (!fatal) {
      try {
        observation.preflightWrite = await insertGate6BCompetingMarker(PREFLIGHT_MARKER);
        observation.preflightMarkerCountSeenByPrimary = await markerCount(opened, PREFLIGHT_MARKER);
        const cleanup = await opened.adapter.run("DELETE FROM __g6b_probe WHERE text_value=?", [PREFLIGHT_MARKER]);
        preflightClean = cleanup.changes === 1;
      } catch (error) {
        fatal = fatalFromError("BLOCKED", "preflight", error);
      }
    }

    if (!fatal && (observation.preflightWrite.outcome !== "SUCCESS" || observation.preflightMarkerCountSeenByPrimary !== 1 || !preflightClean)) {
      fatal = { status: "BLOCKED", stage: "preflight", detail: "independent write/readback/cleanup not proven" };
    }

    if (!fatal) {
      try {
        await opened.adapter.beginImmediate();
        observation.primaryBeginImmediate = true;
        primaryLocked = true;
      } catch (error) {
        fatal = fatalFromError("FAIL", "primary_begin_immediate", error);
      }
    }

    if (!fatal && primaryLocked) {
      try {
        observation.duringPrimaryLock = await insertGate6BCompetingMarker(LOCK_MARKER);
      } catch (error) {
        observation.duringPrimaryLock = {
          outcome: "ERROR",
          exceptionClass: `BridgeRejected:${diagnoseQ12Error(error).detail}`,
          sqliteResultCode: null,
        };
      }
      try {
        observation.lockedMarkerCount = await markerCount(opened, LOCK_MARKER);
      } catch (error) {
        fatal = fatalFromError("FAIL", "primary_locked_readback", error);
      }
    }

    if (primaryLocked) {
      try {
        await opened.adapter.rollback();
        observation.primaryRelease = true;
      } catch (error) {
        fatal = fatal ?? fatalFromError("FAIL", "primary_release", error);
      } finally {
        primaryLocked = false;
      }
    }

    if (!fatal && observation.primaryRelease) {
      try {
        observation.postReleaseWrite = await insertGate6BCompetingMarker(LOCK_MARKER);
        observation.postReleaseMarkerCount = await markerCount(opened, LOCK_MARKER);
      } catch (error) {
        fatal = fatalFromError("FAIL", "post_release_write", error);
      }
    }
  } catch (error) {
    fatal = fatal ?? fatalFromError("BLOCKED", "orchestration", error);
  } finally {
    if (primaryLocked) {
      try {
        await opened.adapter.rollback();
        observation.primaryRelease = true;
      } catch {
        observation.primaryRelease = false;
      }
      primaryLocked = false;
    }

    try {
      const cleanup = await opened.adapter.run("DELETE FROM __g6b_probe WHERE text_value=?", [LOCK_MARKER]);
      finalMarkerClean = cleanup.changes === Math.max(observation.postReleaseMarkerCount, 0);
    } catch {
      finalMarkerClean = observation.postReleaseMarkerCount === 0;
    }
    observation.cleanupComplete = preflightClean && finalMarkerClean;

    if (nativeOpen) {
      try {
        observation.nativeClosed = await closeGate6BCompetingWriter();
      } catch {
        observation.nativeClosed = false;
      }
    } else {
      observation.nativeClosed = true;
    }
  }

  if (fatal) {
    return q12FatalQualificationCase(fatal, {
      samePhysicalFile: observation.samePhysicalFile,
      databaseBasename: observation.databaseBasename,
      nativeClosed: observation.nativeClosed,
    });
  }

  const decision = classifyQ12(observation);
  return { id: "Q12_COMPETING_WRITE", status: decision.status, evidence: decision.evidence };
}
