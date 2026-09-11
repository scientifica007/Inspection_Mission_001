import { Capacitor } from "@capacitor/core";
import type { SqlAdapter, SqlRow } from "../bootstrap/adapter.ts";
import { BootstrapLoader } from "../bootstrap/loader.ts";
import { APP_ERR, DomainError, isDomainError } from "../application/errors.ts";
import { EvidenceApplicationContext, EvidenceService } from "../application/evidence.ts";
import {
  isCanonicalSha256,
  isCanonicalStorageRef,
  type AcquisitionOutcome,
  type EvidenceReconciliationReport,
  type EvidenceSource,
  type EvidenceSourceAcquisition,
  type EvidenceSourceKind,
} from "../application/evidence-contract.ts";
import { VisitScopeService } from "../application/visit-scope.ts";
import { CANONICAL_BOOTSTRAP, CANONICAL_SCHEMA_SQL } from "../gate6b/assets.ts";
import { CapacitorEvidenceSourceAcquisition } from "../device/capacitor-evidence-acquisition.ts";
import { CapacitorEvidenceStorage } from "../device/capacitor-evidence-storage.ts";
import {
  closeGate6BDatabase,
  deleteGate6BDatabase,
  openGate6BDatabase,
  type OpenGate6BDatabase,
} from "../device/gate6b-database.ts";
import {
  gate6cRestoredResultCoordinator,
  type PendingRestoredEvidenceSource,
} from "../device/evidence-restored-result.ts";
import {
  GATE6CD_SETUP_SCENARIO_ID,
  buildGate6CDQualificationResult,
  expectedFailureSatisfied,
  type Gate6CDPhysicalScenarioId,
  type Gate6CDQualificationResult,
  type Gate6CDReconciliationSummary,
  type Gate6CDRuntimeDescriptor,
  type Gate6CDScenarioId,
} from "./physical-qualification-model.ts";

export const GATE6CD_DATABASE = "inspection_gate6c_d_physical_qualification_v1";
const MISSION_NAME = "Gate 6C-D synthetic qualification mission";
const INSTITUTION_CODE = "G6CD-PHYSICAL-QUALIFICATION";
const INSTITUTION_NAME = "Gate 6C-D synthetic qualification institution";
const ACTOR = "gate6c-d-physical-qualification";
const TESTED_GIT_SHA = String(import.meta.env.VITE_GIT_COMMIT ?? "UNAVAILABLE");

interface PendingQualificationSource { pendingId: string; source: EvidenceSource }

export interface Gate6CDHarnessSnapshot {
  testedGitSha: string;
  database: string;
  ownerVisitId: number | null;
  runtimeReadiness: string;
  pendingSource: { pendingId: string; sourceKind: EvidenceSourceKind } | null;
  restoredPending: {
    pendingId: string;
    methodName: "takePhoto" | "chooseFromGallery";
    sourceKind: EvidenceSourceKind;
  } | null;
}

export interface Gate6CDCommittedEvidenceSummary {
  evidenceId: number;
  storageRef: string;
  contentHash: string | null;
  fileSize: number | null;
}

class CancelledAcquisition implements EvidenceSourceAcquisition {
  takeCameraPhoto(): Promise<AcquisitionOutcome> { return Promise.resolve({ status: "USER_CANCELLED" }); }
  chooseGalleryMedia(): Promise<AcquisitionOutcome> { return Promise.resolve({ status: "USER_CANCELLED" }); }
  chooseGenericFile(): Promise<AcquisitionOutcome> { return Promise.resolve({ status: "USER_CANCELLED" }); }
}

class OneShotSourceAcquisition implements EvidenceSourceAcquisition {
  private consumed = false;
  private readonly source: EvidenceSource;
  constructor(source: EvidenceSource) { this.source = { ...source }; }
  private consume(kind: EvidenceSourceKind): Promise<AcquisitionOutcome> {
    if (this.consumed || this.source.kind !== kind) return Promise.resolve({ status: "USER_CANCELLED" });
    this.consumed = true;
    return Promise.resolve({ status: "SUCCESS", source: { ...this.source } });
  }
  takeCameraPhoto(): Promise<AcquisitionOutcome> { return this.consume("CAMERA_PHOTO"); }
  chooseGalleryMedia(): Promise<AcquisitionOutcome> { return this.consume("GALLERY_MEDIA"); }
  chooseGenericFile(): Promise<AcquisitionOutcome> { return this.consume("GENERIC_FILE"); }
}

class RecordingAcquisition implements EvidenceSourceAcquisition {
  lastOutcome: AcquisitionOutcome | null = null;
  constructor(private readonly inner: EvidenceSourceAcquisition) {}
  private async record(work: Promise<AcquisitionOutcome>): Promise<AcquisitionOutcome> {
    const outcome = await work;
    this.lastOutcome = outcome;
    return outcome;
  }
  takeCameraPhoto(): Promise<AcquisitionOutcome> { return this.record(this.inner.takeCameraPhoto()); }
  chooseGalleryMedia(): Promise<AcquisitionOutcome> { return this.record(this.inner.chooseGalleryMedia()); }
  chooseGenericFile(): Promise<AcquisitionOutcome> { return this.record(this.inner.chooseGenericFile()); }
}

function nextPendingId(): string {
  const values = new Uint32Array(2);
  crypto.getRandomValues(values);
  return `physical-${values[0].toString(16).padStart(8, "0")}${values[1].toString(16).padStart(8, "0")}`;
}

function runtimeDescriptor(): Gate6CDRuntimeDescriptor {
  const platform = Capacitor.getPlatform();
  const native = Capacitor.isNativePlatform();
  return { platform, native, android: native && platform === "android" };
}

function reconciliationSummary(report: EvidenceReconciliationReport | null): Gate6CDReconciliationSummary[] {
  if (report === null) return [];
  return report.items.map((item) => {
    switch (item.kind) {
      case "VALID_REFERENCE": return { kind: item.kind, storageRef: item.storageRef, evidenceId: item.evidenceId };
      case "INCOMING_REMOVED": return { kind: item.kind, ref: item.ref };
      case "ORPHAN_REMOVED": return { kind: item.kind, storageRef: item.storageRef };
      case "BROKEN_STORAGE_REFERENCE": return { kind: item.kind, storageRef: item.storageRef, evidenceId: item.evidenceId };
      case "STORAGE_REF_CONFLICT": return { kind: item.kind, storageRef: item.storageRef, evidenceIds: [...item.evidenceIds] };
      case "HASH_MISMATCH": return { kind: item.kind, storageRef: item.storageRef, evidenceId: item.evidenceId };
      case "ORPHAN_CLEANUP_FAILED": return { kind: item.kind, ref: item.ref };
      case "STORAGE_DIAGNOSTIC_FAILED": return { kind: item.kind, ref: item.ref };
      case "UNKNOWN_MANAGED_OBJECT": return { kind: item.kind, ref: item.ref };
    }
  });
}

function errorCode(error: unknown): string {
  return isDomainError(error) ? error.code : "UNEXPECTED_ERROR";
}

function handleScheme(handleRef: string): string | null {
  const index = handleRef.indexOf(":");
  return index > 0 ? handleRef.slice(0, index).toLowerCase() : null;
}

async function acquireByKind(acquisition: EvidenceSourceAcquisition, kind: EvidenceSourceKind): Promise<AcquisitionOutcome> {
  if (kind === "CAMERA_PHOTO") return acquisition.takeCameraPhoto();
  if (kind === "GALLERY_MEDIA") return acquisition.chooseGalleryMedia();
  return acquisition.chooseGenericFile();
}

async function createSyntheticVisit(db: SqlAdapter): Promise<number> {
  const now = new Date().toISOString();
  const mission = await db.run(
    `INSERT INTO mission(name,description,status,created_at,created_by) VALUES (?,?,?,?,?)`,
    [MISSION_NAME, "synthetic Gate 6C-D physical qualification only", "PREPARATION", now, ACTOR],
  );
  const institution = await db.run(
    `INSERT INTO institution(name,official_code,kind_code,active,created_at,created_by) VALUES (?,?,?,?,?,?)`,
    [INSTITUTION_NAME, INSTITUTION_CODE, "CFPA", 1, now, ACTOR],
  );
  if (mission.lastInsertRowid === null || institution.lastInsertRowid === null) {
    throw new DomainError(APP_ERR.STATE_CONFLICT, "Gate 6C-D synthetic roots require row identities");
  }
  const visit = await new VisitScopeService(db).createVisit({
    missionId: mission.lastInsertRowid,
    institutionId: institution.lastInsertRowid,
    visitType: "PLANNED",
    visitDate: now.slice(0, 10),
    inspector: ACTOR,
    expectedP0ItemCodes: CANONICAL_BOOTSTRAP.manifest.expected_p0_item_codes,
    actor: ACTOR,
    now,
  });
  return visit.visitId;
}

async function reconstructSyntheticVisit(db: SqlAdapter): Promise<number> {
  const rows = await db.query(
    `SELECT v.visit_id FROM visit v JOIN mission m ON m.mission_id=v.mission_id JOIN institution i ON i.institution_id=v.institution_id WHERE m.name=? AND i.official_code=? ORDER BY v.visit_id`,
    [MISSION_NAME, INSTITUTION_CODE],
  );
  if (rows.length !== 1) throw new DomainError(APP_ERR.STATE_CONFLICT, `Gate 6C-D expected one synthetic Visit, found ${rows.length}`);
  const visitId = Number(rows[0].visit_id);
  if (!Number.isInteger(visitId) || visitId < 1) throw new DomainError(APP_ERR.STATE_CONFLICT, "Gate 6C-D synthetic Visit identity invalid");
  return visitId;
}

export class Gate6CDPhysicalQualificationHarness {
  private opened: OpenGate6BDatabase | null = null;
  private context: EvidenceApplicationContext | null = null;
  private ownerVisitId: number | null = null;
  private pendingSource: PendingQualificationSource | null = null;
  private lastReconciliation: EvidenceReconciliationReport | null = null;
  private readonly acquisition = new CapacitorEvidenceSourceAcquisition();
  private readonly storage = new CapacitorEvidenceStorage();

  getSnapshot(): Gate6CDHarnessSnapshot {
    const restored = gate6cRestoredResultCoordinator.getPending();
    return {
      testedGitSha: TESTED_GIT_SHA,
      database: GATE6CD_DATABASE,
      ownerVisitId: this.ownerVisitId,
      runtimeReadiness: this.context?.readiness ?? "NOT_OPEN",
      pendingSource: this.pendingSource === null ? null : { pendingId: this.pendingSource.pendingId, sourceKind: this.pendingSource.source.kind },
      restoredPending: restored === null ? null : restoredSummary(restored),
    };
  }

  async initializeReset(): Promise<Gate6CDQualificationResult> {
    try {
      this.pendingSource = null;
      await this.closeRuntime();
      await deleteGate6BDatabase(GATE6CD_DATABASE).catch(() => undefined);
      const opened = await openGate6BDatabase(GATE6CD_DATABASE);
      await opened.connection.execute(CANONICAL_SCHEMA_SQL, false);
      await new BootstrapLoader(opened.adapter, CANONICAL_BOOTSTRAP).load();
      const visitId = await createSyntheticVisit(opened.adapter);
      const context = new EvidenceApplicationContext();
      const service = new EvidenceService(opened.adapter, new CancelledAcquisition(), this.storage, context);
      const report = await service.reconcileEvidence({ verifyHashes: true });
      this.opened = opened;
      this.context = context;
      this.ownerVisitId = visitId;
      this.lastReconciliation = report;
      return this.result(GATE6CD_SETUP_SCENARIO_ID, "PASS", {
        sqliteRowCount: await this.totalEvidenceRows(),
        reconciliationResult: reconciliationSummary(report),
        details: { syntheticVisitId: visitId, readiness: context.readiness, syntheticOnly: true },
      });
    } catch (error) {
      await this.closeRuntime().catch(() => undefined);
      return this.failure(GATE6CD_SETUP_SCENARIO_ID, "setup", error);
    }
  }

  async reconstructOwnerAndReconcile(
    scenarioId: Extract<Gate6CDPhysicalScenarioId, "G6CD-Q08-RESTART-RECONCILIATION" | "G6CD-Q09-ORPHAN-CLEANUP"> = "G6CD-Q08-RESTART-RECONCILIATION",
  ): Promise<Gate6CDQualificationResult> {
    try {
      const { report, context } = await this.reopenExisting();
      const summaries = reconciliationSummary(report);
      const rowCount = await this.totalEvidenceRows();
      if (scenarioId === "G6CD-Q09-ORPHAN-CLEANUP") {
        const removed = report.items.filter((item) => item.kind === "ORPHAN_REMOVED");
        let zeroRows = true;
        for (const item of removed) {
          if (item.kind === "ORPHAN_REMOVED" && await this.rowsForStorageRef(item.storageRef) !== 0) zeroRows = false;
        }
        const pass = removed.length > 0 && zeroRows && context.readiness === "READY";
        return this.result(scenarioId, pass ? "PASS" : "BLOCKED", {
          sqliteRowCount: rowCount,
          reconciliationResult: summaries,
          details: { orphanRemovedCount: removed.length, zeroRowsForRemovedOrphans: zeroRows, readiness: context.readiness },
        });
      }
      const fatal = report.items.some((item) =>
        item.kind === "ORPHAN_CLEANUP_FAILED" || item.kind === "STORAGE_DIAGNOSTIC_FAILED" ||
        item.kind === "STORAGE_REF_CONFLICT" || item.kind === "HASH_MISMATCH" || item.kind === "BROKEN_STORAGE_REFERENCE"
      );
      return this.result(scenarioId, !fatal && context.readiness === "READY" ? "PASS" : "FAIL", {
        sqliteRowCount: rowCount,
        reconciliationResult: summaries,
        details: { readiness: context.readiness, fatalClassificationPresent: fatal },
      });
    } catch (error) {
      return this.failure(scenarioId, "restart_reconciliation", error);
    }
  }

  async commitProductionSource(
    scenarioId: Extract<Gate6CDPhysicalScenarioId, "G6CD-Q01-CAMERA-COMMIT" | "G6CD-Q02-GALLERY-COMMIT" | "G6CD-Q03-GENERIC-FILE-COMMIT">,
    sourceKind: EvidenceSourceKind,
  ): Promise<Gate6CDQualificationResult> {
    const recording = new RecordingAcquisition(this.acquisition);
    try {
      const { service, ownerVisitId } = this.service(recording);
      const before = await this.totalEvidenceRows();
      const created = await service.createEvidence(this.createInput(ownerVisitId, sourceKind));
      if (created.status === "USER_CANCELLED") {
        return this.result(scenarioId, "BLOCKED", {
          acquisitionOutcome: recording.lastOutcome?.status ?? "USER_CANCELLED",
          sourceKind,
          sqliteRowCount: await this.totalEvidenceRows(),
          failureStage: "acquisition",
          failureCode: "USER_CANCELLED",
          details: { rowsBefore: before, physicalSuccessNotProduced: true },
        });
      }
      return this.proveEvidence(scenarioId, created.evidence.evidenceId, "SUCCESS", sourceKind);
    } catch (error) {
      const outcome = recording.lastOutcome?.status ?? "NOT_REACHED";
      return this.failure(scenarioId, outcome === "SUCCESS" ? "evidence_create" : "acquisition", error, { acquisitionOutcome: outcome, sourceKind });
    }
  }

  async runAcquisitionExpectation(
    scenarioId: Extract<Gate6CDPhysicalScenarioId, "G6CD-Q04-CANCEL" | "G6CD-Q05-PERMISSION-DENIED">,
    sourceKind: EvidenceSourceKind,
    expected: "USER_CANCELLED" | "PERMISSION_DENIED",
  ): Promise<Gate6CDQualificationResult> {
    try {
      this.requireRuntime();
      const before = await this.totalEvidenceRows();
      const outcome = await acquireByKind(this.acquisition, sourceKind);
      if (outcome.status === "SUCCESS") this.pendingSource = { pendingId: nextPendingId(), source: { ...outcome.source } };
      const after = await this.totalEvidenceRows();
      return this.result(scenarioId, outcome.status === expected && before === after ? "PASS" : "BLOCKED", {
        acquisitionOutcome: outcome.status,
        sourceKind,
        sqliteRowCount: after,
        details: { expectedOutcome: expected, rowsBefore: before, rowsAfter: after, pendingSourceCreated: outcome.status === "SUCCESS" },
      });
    } catch (error) {
      return this.failure(scenarioId, "acquisition", error, { sourceKind });
    }
  }

  async acquireOnly(
    scenarioId: Extract<Gate6CDPhysicalScenarioId,
      "G6CD-Q06-SOURCE-LOSS" | "G6CD-Q07-RESTORED-CAMERA" | "G6CD-Q09-ORPHAN-CLEANUP" | "G6CD-Q11-LARGE-FILE" | "G6CD-Q12-WRITE-FAILURE">,
    sourceKind: EvidenceSourceKind,
  ): Promise<Gate6CDQualificationResult> {
    try {
      this.requireRuntime();
      const before = await this.totalEvidenceRows();
      const outcome = await acquireByKind(this.acquisition, sourceKind);
      if (outcome.status !== "SUCCESS") {
        return this.result(scenarioId, "BLOCKED", {
          acquisitionOutcome: outcome.status,
          sourceKind,
          sqliteRowCount: await this.totalEvidenceRows(),
          failureStage: "acquisition",
          failureCode: outcome.status,
          details: { rowsBefore: before, pendingSourceCreated: false },
        });
      }
      const pendingId = nextPendingId();
      this.pendingSource = { pendingId, source: { ...outcome.source } };
      const after = await this.totalEvidenceRows();
      return this.result(scenarioId, "BLOCKED", {
        acquisitionOutcome: "SUCCESS",
        sourceKind,
        sqliteRowCount: after,
        details: { rowsBefore: before, rowsAfter: after, pendingSourceCreated: true, pendingId, nextStepRequired: true },
      });
    } catch (error) {
      return this.failure(scenarioId, "acquisition_only", error, { sourceKind });
    }
  }

  discardPendingSource(): boolean {
    if (this.pendingSource === null) return false;
    this.pendingSource = null;
    return true;
  }

  async commitPendingScenario(
    scenarioId: Extract<Gate6CDPhysicalScenarioId, "G6CD-Q06-SOURCE-LOSS" | "G6CD-Q11-LARGE-FILE" | "G6CD-Q12-WRITE-FAILURE">,
  ): Promise<Gate6CDQualificationResult> {
    const pending = this.pendingSource;
    if (pending === null) return this.result(scenarioId, "BLOCKED", {
      failureStage: "precondition", failureCode: "NO_VOLATILE_PENDING_SOURCE", details: { pendingSourceRequired: true },
    });
    this.pendingSource = null;
    const expectedCode = scenarioId === "G6CD-Q06-SOURCE-LOSS"
      ? APP_ERR.EVIDENCE_SOURCE_UNAVAILABLE
      : scenarioId === "G6CD-Q12-WRITE-FAILURE" ? APP_ERR.EVIDENCE_STORAGE_WRITE_FAILED : null;
    const rowsBefore = await this.safeTotalEvidenceRows();
    try {
      const { service, ownerVisitId } = this.service(new OneShotSourceAcquisition(pending.source));
      const created = await service.createEvidence(this.createInput(ownerVisitId, pending.source.kind));
      if (created.status !== "CREATED") return this.result(scenarioId, "FAIL", {
        acquisitionOutcome: created.status, sourceKind: pending.source.kind, sqliteRowCount: await this.totalEvidenceRows(),
        failureStage: "evidence_create", failureCode: created.status,
      });
      const proof = await this.proveEvidence(scenarioId, created.evidence.evidenceId, "SUCCESS", pending.source.kind);
      if (expectedCode !== null) {
        return { ...proof, status: "FAIL", details: { ...proof.details, expectedFailureCode: expectedCode,
          expectedFailureNotObserved: true,
          ...(scenarioId === "G6CD-Q12-WRITE-FAILURE" ? { enospcProven: false, writeFailureVariant: "REAL_DEVICE_WRITE_FAILURE" } : {}) } };
      }
      return proof;
    } catch (error) {
      const rowsAfter = await this.safeTotalEvidenceRows();
      const code = errorCode(error);
      const pass = expectedCode !== null && expectedFailureSatisfied(expectedCode, code, rowsBefore, rowsAfter);
      return this.result(scenarioId, pass ? "PASS" : "FAIL", {
        acquisitionOutcome: "SUCCESS", sourceKind: pending.source.kind, sqliteRowCount: rowsAfter,
        failureStage: "evidence_create", failureCode: code,
        details: { expectedFailureCode: expectedCode, rowsBefore, rowsAfter, zeroEvidenceRowDelta: rowsBefore === rowsAfter,
          ...(scenarioId === "G6CD-Q12-WRITE-FAILURE" ? { enospcProven: false, writeFailureVariant: "REAL_DEVICE_WRITE_FAILURE" } : {}) },
      });
    }
  }

  async publishPendingAsZeroRowOrphan(): Promise<Gate6CDQualificationResult> {
    const scenarioId = "G6CD-Q09-ORPHAN-CLEANUP" as const;
    const pending = this.pendingSource;
    if (pending === null) return this.result(scenarioId, "BLOCKED", {
      failureStage: "precondition", failureCode: "NO_VOLATILE_PENDING_SOURCE", details: { pendingSourceRequired: true },
    });
    this.pendingSource = null;
    let stagingRef: string | null = null;
    try {
      this.requireRuntime();
      const allocation = await this.storage.allocate(pending.source);
      stagingRef = allocation.stagingRef;
      const staged = await this.storage.stage(pending.source, allocation);
      const published = await this.storage.publish(staged);
      stagingRef = null;
      const rows = await this.rowsForStorageRef(published.storageRef);
      const exists = await this.storage.finalExists(published.storageRef);
      return this.result(scenarioId, rows === 0 && exists ? "BLOCKED" : "FAIL", {
        acquisitionOutcome: "SUCCESS", sourceKind: pending.source.kind,
        storageRef: published.storageRef, canonicalStorageRef: isCanonicalStorageRef(published.storageRef),
        fileSize: published.fileSize, contentHash: published.contentHash,
        canonicalContentHash: isCanonicalSha256(published.contentHash), sqliteRowCount: rows,
        details: { zeroRowOrphanPublished: rows === 0 && exists, finalExists: exists, nextStepRequired: true },
      });
    } catch (error) {
      if (stagingRef !== null) await this.storage.removeIncoming(stagingRef).catch(() => undefined);
      return this.failure(scenarioId, "diagnostic_orphan_publish", error, { acquisitionOutcome: "SUCCESS", sourceKind: pending.source.kind });
    }
  }

  async adoptRestoredCamera(): Promise<Gate6CDQualificationResult> {
    const scenarioId = "G6CD-Q07-RESTORED-CAMERA" as const;
    const pending = gate6cRestoredResultCoordinator.getPending();
    if (pending === null) return this.result(scenarioId, "BLOCKED", {
      failureStage: "restored_result", failureCode: "NO_RESTORED_SOURCE", details: { explicitAdoptionRequired: true },
    });
    try {
      const runtime = this.requireRuntime();
      const before = await this.totalEvidenceRows();
      const acquisition = gate6cRestoredResultCoordinator.adoptPending(pending.pendingId);
      if (acquisition === null) return this.result(scenarioId, "BLOCKED", {
        sourceKind: pending.source.kind, failureStage: "restored_result", failureCode: "RESTORED_SOURCE_CHANGED",
      });
      const service = new EvidenceService(runtime.opened.adapter, acquisition, this.storage, runtime.context);
      const created = await service.createEvidence(this.createInput(runtime.ownerVisitId, pending.source.kind));
      if (created.status !== "CREATED") return this.result(scenarioId, "FAIL", {
        acquisitionOutcome: created.status, sourceKind: pending.source.kind, sqliteRowCount: await this.totalEvidenceRows(),
        failureStage: "restored_adoption", failureCode: created.status,
      });
      const proof = await this.proveEvidence(scenarioId, created.evidence.evidenceId, "RESTORED_SUCCESS", pending.source.kind);
      return { ...proof, details: { ...proof.details, restoredMethodName: pending.methodName,
        rowsBeforeAdopt: before, rowsAfterAdopt: await this.totalEvidenceRows(), explicitOwnerReconstruction: true } };
    } catch (error) {
      return this.failure(scenarioId, "restored_adoption", error, { acquisitionOutcome: "RESTORED_PENDING", sourceKind: pending.source.kind });
    }
  }

  discardRestoredCamera(): boolean {
    const pending = gate6cRestoredResultCoordinator.getPending();
    return pending !== null && gate6cRestoredResultCoordinator.discardPending(pending.pendingId);
  }

  async diagnoseMissingFile(evidenceId: number): Promise<Gate6CDQualificationResult> {
    const scenarioId = "G6CD-Q10-MISSING-FILE" as const;
    try {
      const { report, service } = await this.reopenExisting();
      const rows = await this.evidenceRow(evidenceId);
      const row = rows[0];
      const broken = report.items.some((item) => item.kind === "BROKEN_STORAGE_REFERENCE" && item.evidenceId === evidenceId);
      const storageRef = row === undefined ? null : String(row.storage_ref);
      const exists = storageRef === null ? false : await this.storage.finalExists(storageRef).catch(() => false);
      let resolveCode: string | null = null;
      try { await service.resolveEvidence(evidenceId); } catch (error) { resolveCode = errorCode(error); }
      const pass = rows.length === 1 && broken && !exists && resolveCode === APP_ERR.EVIDENCE_BROKEN_STORAGE_REFERENCE;
      return this.result(scenarioId, pass ? "PASS" : "FAIL", {
        evidenceId, storageRef, canonicalStorageRef: storageRef === null ? null : isCanonicalStorageRef(storageRef),
        fileSize: nullableNumber(row, "file_size"), contentHash: nullableString(row, "content_hash"),
        canonicalContentHash: canonicalNullableHash(row), reconciliationResult: reconciliationSummary(report),
        resolveResult: { status: "FAILED", handleScheme: null }, hashVerificationResult: "FAILED", sqliteRowCount: rows.length,
        failureStage: pass ? null : "missing_file_diagnosis", failureCode: pass ? null : resolveCode,
        details: { sqliteRowRetained: rows.length === 1, brokenStorageReferenceReported: broken,
          finalObjectMissing: !exists, resolveFailureCode: resolveCode, silentRepairObserved: false },
      });
    } catch (error) {
      return this.failure(scenarioId, "missing_file_diagnosis", error, { evidenceId });
    }
  }

  async retrieveAfterRestart(evidenceId: number): Promise<Gate6CDQualificationResult> {
    const scenarioId = "G6CD-Q13-RETRIEVAL-AFTER-RESTART" as const;
    try {
      const { report, service } = await this.reopenExisting();
      const rows = await this.evidenceRow(evidenceId);
      if (rows.length !== 1) return this.result(scenarioId, "FAIL", {
        evidenceId, sqliteRowCount: rows.length, reconciliationResult: reconciliationSummary(report),
        failureStage: "sqlite_reopen", failureCode: "EVIDENCE_ROW_CARDINALITY",
      });
      const row = rows[0];
      const storageRef = String(row.storage_ref);
      const contentHash = nullableString(row, "content_hash");
      const stat = await this.storage.stat(storageRef);
      const hash = await service.verifyEvidenceHash(evidenceId);
      const resolved = await service.resolveEvidence(evidenceId);
      const valid = report.items.some((item) => item.kind === "VALID_REFERENCE" && item.evidenceId === evidenceId);
      const pass = valid && hash.status === "MATCH" && resolved.storageRef === storageRef;
      return this.result(scenarioId, pass ? "PASS" : "FAIL", {
        evidenceId, storageRef, canonicalStorageRef: isCanonicalStorageRef(storageRef), fileSize: stat.fileSize,
        contentHash, canonicalContentHash: contentHash === null ? null : isCanonicalSha256(contentHash),
        reconciliationResult: reconciliationSummary(report),
        resolveResult: { status: "RESOLVED", handleScheme: handleScheme(resolved.handleRef) },
        hashVerificationResult: hash.status, sqliteRowCount: 1,
        details: { validReferenceAfterRestart: valid, metadataSurvivedRestart: nullableNumber(row, "file_size") === stat.fileSize,
          readiness: this.context?.readiness ?? "NOT_OPEN" },
      });
    } catch (error) {
      return this.failure(scenarioId, "retrieval_after_restart", error, { evidenceId });
    }
  }

  async listCommittedEvidence(): Promise<Gate6CDCommittedEvidenceSummary[]> {
    if (this.opened === null) return [];
    const rows = await this.opened.adapter.query(`SELECT evidence_id,storage_ref,content_hash,file_size FROM evidence ORDER BY evidence_id`);
    return rows.map((row) => ({ evidenceId: Number(row.evidence_id), storageRef: String(row.storage_ref),
      contentHash: nullableString(row, "content_hash"), fileSize: nullableNumber(row, "file_size") }));
  }

  private async proveEvidence(scenarioId: Gate6CDPhysicalScenarioId, evidenceId: number, acquisitionOutcome: string, sourceKind: EvidenceSourceKind): Promise<Gate6CDQualificationResult> {
    const runtime = this.requireRuntime();
    const rows = await this.evidenceRow(evidenceId);
    if (rows.length !== 1) throw new DomainError(APP_ERR.STATE_CONFLICT, `Gate 6C-D Evidence row cardinality=${rows.length}`);
    const row = rows[0];
    const storageRef = String(row.storage_ref);
    const contentHash = nullableString(row, "content_hash");
    const stat = await this.storage.stat(storageRef);
    const hash = await runtime.service.verifyEvidenceHash(evidenceId);
    const resolved = await runtime.service.resolveEvidence(evidenceId);
    const pass = isCanonicalStorageRef(storageRef) && contentHash !== null && isCanonicalSha256(contentHash) &&
      hash.status === "MATCH" && resolved.storageRef === storageRef && nullableNumber(row, "file_size") === stat.fileSize;
    return this.result(scenarioId, pass ? "PASS" : "FAIL", {
      acquisitionOutcome, sourceKind, evidenceId, storageRef, canonicalStorageRef: isCanonicalStorageRef(storageRef),
      fileSize: stat.fileSize, contentHash, canonicalContentHash: contentHash === null ? null : isCanonicalSha256(contentHash),
      reconciliationResult: reconciliationSummary(this.lastReconciliation),
      resolveResult: { status: "RESOLVED", handleScheme: handleScheme(resolved.handleRef) },
      hashVerificationResult: hash.status, sqliteRowCount: 1,
      details: { ownerKind: "VISIT", ownerRef: runtime.ownerVisitId, readiness: runtime.context.readiness },
    });
  }

  private async reopenExisting(): Promise<{ report: EvidenceReconciliationReport; service: EvidenceService; context: EvidenceApplicationContext }> {
    await this.closeRuntime();
    const opened = await openGate6BDatabase(GATE6CD_DATABASE);
    try {
      const schema = await opened.adapter.query(`SELECT name FROM sqlite_master WHERE type='table' AND name='visit'`);
      if (schema.length !== 1) throw new DomainError(APP_ERR.CONFIG, "Gate 6C-D qualification database is not initialized");
      const visitId = await reconstructSyntheticVisit(opened.adapter);
      const context = new EvidenceApplicationContext();
      const service = new EvidenceService(opened.adapter, new CancelledAcquisition(), this.storage, context);
      const report = await service.reconcileEvidence({ verifyHashes: true });
      this.opened = opened;
      this.context = context;
      this.ownerVisitId = visitId;
      this.lastReconciliation = report;
      return { report, service, context };
    } catch (error) {
      await closeGate6BDatabase(GATE6CD_DATABASE).catch(() => undefined);
      throw error;
    }
  }

  private service(acquisition: EvidenceSourceAcquisition): { service: EvidenceService; ownerVisitId: number } {
    const runtime = this.requireRuntime();
    return { service: new EvidenceService(runtime.opened.adapter, acquisition, this.storage, runtime.context), ownerVisitId: runtime.ownerVisitId };
  }

  private requireRuntime(): { opened: OpenGate6BDatabase; context: EvidenceApplicationContext; ownerVisitId: number; service: EvidenceService } {
    if (this.opened === null || this.context === null || this.ownerVisitId === null) {
      throw new DomainError(APP_ERR.CONFIG, "Gate 6C-D requires Initialize/Reset or explicit synthetic owner reconstruction first");
    }
    if (this.context.readiness !== "READY") throw new DomainError(APP_ERR.EVIDENCE_RECONCILIATION_REQUIRED, "Gate 6C-D Evidence runtime is not READY");
    return { opened: this.opened, context: this.context, ownerVisitId: this.ownerVisitId,
      service: new EvidenceService(this.opened.adapter, new CancelledAcquisition(), this.storage, this.context) };
  }

  private createInput(ownerVisitId: number, sourceKind: EvidenceSourceKind) {
    return { ownerKind: "VISIT" as const, ownerRef: ownerVisitId, sourceKind, recordedAt: new Date().toISOString(),
      recordedBy: ACTOR, note: "synthetic Gate 6C-D physical Evidence qualification" };
  }

  private async totalEvidenceRows(): Promise<number> {
    if (this.opened === null) return 0;
    const rows = await this.opened.adapter.query(`SELECT COUNT(*) AS count FROM evidence`);
    return Number(rows[0]?.count ?? 0);
  }

  private async safeTotalEvidenceRows(): Promise<number> { try { return await this.totalEvidenceRows(); } catch { return 0; } }

  private async rowsForStorageRef(storageRef: string): Promise<number> {
    if (this.opened === null) return 0;
    const rows = await this.opened.adapter.query(`SELECT COUNT(*) AS count FROM evidence WHERE storage_ref=?`, [storageRef]);
    return Number(rows[0]?.count ?? 0);
  }

  private async evidenceRow(evidenceId: number): Promise<SqlRow[]> {
    if (!Number.isInteger(evidenceId) || evidenceId < 1) throw new DomainError(APP_ERR.CONFIG, "Gate 6C-D evidenceId must be positive integer");
    if (this.opened === null) return [];
    return this.opened.adapter.query(`SELECT evidence_id,storage_ref,content_hash,file_size FROM evidence WHERE evidence_id=?`, [evidenceId]);
  }

  private result(
    scenarioId: Gate6CDScenarioId,
    status: "PASS" | "FAIL" | "BLOCKED",
    overrides: Partial<Omit<Gate6CDQualificationResult, "schemaVersion" | "scenarioId" | "testedGitSha" | "runtime" | "timestamp" | "status">> = {},
  ): Gate6CDQualificationResult {
    return buildGate6CDQualificationResult({ scenarioId, testedGitSha: TESTED_GIT_SHA, runtime: runtimeDescriptor(), status,
      acquisitionOutcome: overrides.acquisitionOutcome, sourceKind: overrides.sourceKind, evidenceId: overrides.evidenceId,
      storageRef: overrides.storageRef, canonicalStorageRef: overrides.canonicalStorageRef, fileSize: overrides.fileSize,
      contentHash: overrides.contentHash, canonicalContentHash: overrides.canonicalContentHash,
      reconciliationResult: overrides.reconciliationResult, resolveResult: overrides.resolveResult,
      hashVerificationResult: overrides.hashVerificationResult, sqliteRowCount: overrides.sqliteRowCount,
      failureStage: overrides.failureStage, failureCode: overrides.failureCode, details: overrides.details });
  }

  private async failure(
    scenarioId: Gate6CDScenarioId,
    stage: string,
    error: unknown,
    extras: { acquisitionOutcome?: string; sourceKind?: EvidenceSourceKind; evidenceId?: number } = {},
  ): Promise<Gate6CDQualificationResult> {
    return this.result(scenarioId, "FAIL", {
      acquisitionOutcome: extras.acquisitionOutcome ?? "NOT_RUN", sourceKind: extras.sourceKind ?? null,
      evidenceId: extras.evidenceId ?? null, reconciliationResult: reconciliationSummary(this.lastReconciliation),
      sqliteRowCount: await this.safeTotalEvidenceRows(), failureStage: stage, failureCode: errorCode(error),
    });
  }

  private async closeRuntime(): Promise<void> {
    this.opened = null;
    this.context = null;
    this.ownerVisitId = null;
    this.lastReconciliation = null;
    await closeGate6BDatabase(GATE6CD_DATABASE).catch(() => undefined);
  }
}

function nullableString(row: SqlRow | undefined, key: string): string | null {
  if (row === undefined || row[key] === null || row[key] === undefined) return null;
  return String(row[key]);
}
function nullableNumber(row: SqlRow | undefined, key: string): number | null {
  if (row === undefined || row[key] === null || row[key] === undefined) return null;
  return Number(row[key]);
}
function canonicalNullableHash(row: SqlRow | undefined): boolean | null {
  const value = nullableString(row, "content_hash");
  return value === null ? null : isCanonicalSha256(value);
}
function restoredSummary(pending: PendingRestoredEvidenceSource) {
  return { pendingId: pending.pendingId, methodName: pending.methodName, sourceKind: pending.source.kind };
}

export const gate6cdPhysicalQualificationHarness = new Gate6CDPhysicalQualificationHarness();
