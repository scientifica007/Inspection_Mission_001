import type { SqlAdapter, SqlResult, SqlRow, SqlValue } from "../bootstrap/adapter.ts";
import { BootstrapLoader } from "../bootstrap/loader.ts";
import { EvidenceApplicationContext, EvidenceService } from "../application/evidence.ts";
import {
  isCanonicalSha256,
  isCanonicalStorageRef,
  type AcquisitionOutcome,
  type EvidenceObjectAllocation,
  type EvidenceSource,
  type EvidenceSourceAcquisition,
  type EvidenceStorage,
  type HashVerification,
  type ManagedEvidenceObject,
  type ResolvedEvidenceHandle,
  type StagedEvidenceObject,
  type StoredEvidenceObject,
  type StoredEvidenceStat,
} from "../application/evidence-contract.ts";
import { VisitScopeService } from "../application/visit-scope.ts";
import { CANONICAL_BOOTSTRAP, CANONICAL_SCHEMA_SQL } from "../gate6b/assets.ts";
import {
  closeGate6BDatabase,
  deleteGate6BDatabase,
  openGate6BDatabase,
} from "../device/gate6b-database.ts";
import { CapacitorEvidenceStorage } from "../device/capacitor-evidence-storage.ts";

const DATABASE = "inspection_gate6c_android_integration_v1";
const FIXED_NOW = "2026-09-10T16:30:00.000Z";
const FIXED_VISIT_DATE = "2026-09-10";
const ACTOR = "gate6c-c-integration";

function requireTrue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

class RecordingSqlAdapter implements SqlAdapter {
  private readonly inner: SqlAdapter;
  private readonly events: string[];

  constructor(inner: SqlAdapter, events: string[]) {
    this.inner = inner;
    this.events = events;
  }

  async beginImmediate(): Promise<void> {
    this.events.push("db.beginImmediate.start");
    await this.inner.beginImmediate();
    this.events.push("db.beginImmediate.complete");
  }

  async commit(): Promise<void> {
    this.events.push("db.commit.start");
    await this.inner.commit();
    this.events.push("db.commit.complete");
  }

  async rollback(): Promise<void> {
    this.events.push("db.rollback.start");
    await this.inner.rollback();
    this.events.push("db.rollback.complete");
  }

  async run(sql: string, params: readonly SqlValue[] = []): Promise<SqlResult> {
    const evidenceInsert = /^\s*INSERT\s+INTO\s+evidence\b/i.test(sql);
    if (evidenceInsert) this.events.push("db.evidenceInsert.start");
    const result = await this.inner.run(sql, params);
    if (evidenceInsert) this.events.push("db.evidenceInsert.complete");
    return result;
  }

  query(sql: string, params: readonly SqlValue[] = []): Promise<SqlRow[]> {
    return this.inner.query(sql, params);
  }
}

class RecordingEvidenceStorage implements EvidenceStorage {
  private readonly inner: EvidenceStorage;
  private readonly events: string[];

  constructor(inner: EvidenceStorage, events: string[]) {
    this.inner = inner;
    this.events = events;
  }

  allocate(source: EvidenceSource): Promise<EvidenceObjectAllocation> { return this.inner.allocate(source); }
  stage(source: EvidenceSource, allocation: EvidenceObjectAllocation): Promise<StagedEvidenceObject> { return this.inner.stage(source, allocation); }
  finalExists(storageRef: string): Promise<boolean> { return this.inner.finalExists(storageRef); }

  async publish(staged: StagedEvidenceObject): Promise<StoredEvidenceObject> {
    this.events.push("storage.publish.start");
    const result = await this.inner.publish(staged);
    this.events.push("storage.publish.complete");
    return result;
  }

  stat(storageRef: string): Promise<StoredEvidenceStat> { return this.inner.stat(storageRef); }
  resolve(storageRef: string): Promise<ResolvedEvidenceHandle> { return this.inner.resolve(storageRef); }
  listManagedObjects(): Promise<ManagedEvidenceObject[]> { return this.inner.listManagedObjects(); }
  removeIncoming(stagingRef: string): Promise<void> { return this.inner.removeIncoming(stagingRef); }
  removeConfirmedOrphan(storageRef: string): Promise<void> { return this.inner.removeConfirmedOrphan(storageRef); }
  verifyHash(storageRef: string, expectedHash: string): Promise<HashVerification> { return this.inner.verifyHash(storageRef, expectedHash); }
}

class OneShotGenericSource implements EvidenceSourceAcquisition {
  private consumed = false;
  private readonly sourceRef: string;

  constructor(sourceRef: string) { this.sourceRef = sourceRef; }
  takeCameraPhoto(): Promise<AcquisitionOutcome> { return Promise.resolve({ status: "USER_CANCELLED" }); }
  chooseGalleryMedia(): Promise<AcquisitionOutcome> { return Promise.resolve({ status: "USER_CANCELLED" }); }
  chooseGenericFile(): Promise<AcquisitionOutcome> {
    if (this.consumed) return Promise.resolve({ status: "USER_CANCELLED" });
    this.consumed = true;
    return Promise.resolve({
      status: "SUCCESS",
      source: {
        kind: "GENERIC_FILE",
        sourceRef: this.sourceRef,
        displayName: "synthetic-gate6c-integration.bin",
        declaredMimeType: "application/octet-stream",
        sizeHint: 1,
      },
    });
  }
}

class CancelledAcquisition implements EvidenceSourceAcquisition {
  takeCameraPhoto(): Promise<AcquisitionOutcome> { return Promise.resolve({ status: "USER_CANCELLED" }); }
  chooseGalleryMedia(): Promise<AcquisitionOutcome> { return Promise.resolve({ status: "USER_CANCELLED" }); }
  chooseGenericFile(): Promise<AcquisitionOutcome> { return Promise.resolve({ status: "USER_CANCELLED" }); }
}

async function createSyntheticVisit(db: SqlAdapter): Promise<number> {
  const mission = await db.run(
    `INSERT INTO mission(name,description,status,created_at,created_by)
     VALUES ('G6C-C synthetic integration mission','synthetic only','PREPARATION',?,?)`,
    [FIXED_NOW, ACTOR],
  );
  const institution = await db.run(
    `INSERT INTO institution(name,official_code,kind_code,active,created_at,created_by)
     VALUES ('G6C-C synthetic integration institution','G6C-C-INTEGRATION','CFPA',1,?,?)`,
    [FIXED_NOW, ACTOR],
  );
  requireTrue(mission.lastInsertRowid !== null && institution.lastInsertRowid !== null, "synthetic roots require row identities");
  const visit = await new VisitScopeService(db).createVisit({
    missionId: mission.lastInsertRowid,
    institutionId: institution.lastInsertRowid,
    visitType: "PLANNED",
    visitDate: FIXED_VISIT_DATE,
    inspector: ACTOR,
    expectedP0ItemCodes: CANONICAL_BOOTSTRAP.manifest.expected_p0_item_codes,
    actor: ACTOR,
    now: FIXED_NOW,
  });
  return visit.visitId;
}

function eventBefore(events: readonly string[], first: string, second: string): boolean {
  const a = events.indexOf(first);
  const b = events.indexOf(second);
  return a >= 0 && b >= 0 && a < b;
}

export interface Gate6CDeviceIntegrationProofResult {
  status: "PASS";
  testedGitCommitSha: string;
  sourceIsContentUri: boolean;
  canonicalStorageRef: boolean;
  canonicalHash: boolean;
  expectedSize: number;
  persistedSize: number;
  expectedHash: string;
  persistedHash: string;
  sizeHintIgnored: boolean;
  publishCompletedBeforeDbBegin: boolean;
  publishCompletedBeforeEvidenceInsert: boolean;
  transactionCommitted: boolean;
  events: readonly string[];
  reconciliationValidAfterReopen: boolean;
  hashStatusAfterReopen: string;
  reopenedMetadataMatches: boolean;
  resolvedHandle: string;
  evidenceId: number;
  storageRef: string;
}

export async function runGate6CDeviceIntegrationProof(
  sourceRef: string,
  expectedSize: number,
  expectedHash: string,
): Promise<Gate6CDeviceIntegrationProofResult> {
  requireTrue(sourceRef.startsWith("content://"), "integration proof requires a synthetic content:// source");
  requireTrue(Number.isSafeInteger(expectedSize) && expectedSize > 1, "expectedSize must exceed deliberately false sizeHint");
  requireTrue(isCanonicalSha256(expectedHash), "expectedHash must be canonical SHA-256");

  await deleteGate6BDatabase(DATABASE).catch(() => undefined);
  const events: string[] = [];
  let storageRef = "";
  let evidenceId = 0;

  try {
    const opened = await openGate6BDatabase(DATABASE);
    await opened.connection.execute(CANONICAL_SCHEMA_SQL, false);
    await new BootstrapLoader(opened.adapter, CANONICAL_BOOTSTRAP).load();
    const visitId = await createSyntheticVisit(opened.adapter);

    const context = new EvidenceApplicationContext();
    const service = new EvidenceService(
      new RecordingSqlAdapter(opened.adapter, events),
      new OneShotGenericSource(sourceRef),
      new RecordingEvidenceStorage(new CapacitorEvidenceStorage(), events),
      context,
    );
    const startup = await service.reconcileEvidence({ verifyHashes: true });
    requireTrue(context.readiness === "READY", "startup reconciliation must establish Evidence readiness");
    requireTrue(startup.items.length === 0, "fresh synthetic store must reconcile cleanly");
    events.length = 0;

    const created = await service.createEvidence({
      ownerKind: "VISIT",
      ownerRef: visitId,
      sourceKind: "GENERIC_FILE",
      recordedAt: FIXED_NOW,
      recordedBy: ACTOR,
      note: "synthetic Gate 6C-C Android integration proof",
    });
    requireTrue(created.status === "CREATED", "synthetic Evidence create must commit");
    storageRef = created.evidence.storageRef;
    evidenceId = created.evidence.evidenceId;

    const rows = await opened.adapter.query(
      `SELECT evidence_id,storage_ref,content_hash,file_size FROM evidence WHERE evidence_id = ?`,
      [evidenceId],
    );
    requireTrue(rows.length === 1, "committed Evidence row must exist exactly once");
    const persistedSize = Number(rows[0].file_size);
    const persistedHash = String(rows[0].content_hash);
    requireTrue(String(rows[0].storage_ref) === storageRef, "committed storage_ref must equal created state");
    requireTrue(persistedSize === expectedSize, "file_size must equal copied bytes, not sizeHint");
    requireTrue(persistedHash === expectedHash, "content_hash must equal independent source digest");
    requireTrue(created.evidence.fileSize === expectedSize && created.evidence.contentHash === expectedHash, "created Evidence state must carry final native metadata");

    const publishBeforeBegin = eventBefore(events, "storage.publish.complete", "db.beginImmediate.start");
    const publishBeforeInsert = eventBefore(events, "storage.publish.complete", "db.evidenceInsert.start");
    const committed = events.includes("db.commit.complete");
    requireTrue(publishBeforeBegin && publishBeforeInsert && committed, `unexpected cross-store event order: ${events.join(",")}`);
    await closeGate6BDatabase(DATABASE);

    const reopened = await openGate6BDatabase(DATABASE);
    const reopenedContext = new EvidenceApplicationContext();
    const reopenedService = new EvidenceService(reopened.adapter, new CancelledAcquisition(), new CapacitorEvidenceStorage(), reopenedContext);
    const reconciliation = await reopenedService.reconcileEvidence({ verifyHashes: true });
    requireTrue(reopenedContext.readiness === "READY", "reopened runtime must re-establish Evidence readiness");
    const valid = reconciliation.items.some((item) => item.kind === "VALID_REFERENCE" && item.storageRef === storageRef && item.evidenceId === evidenceId);
    requireTrue(valid, "reopened reconciliation must classify committed Evidence as valid");
    const hash = await reopenedService.verifyEvidenceHash(evidenceId);
    requireTrue(hash.status === "MATCH", "reopened hash verification must match");
    const resolved = await reopenedService.resolveEvidence(evidenceId);
    requireTrue(resolved.storageRef === storageRef && resolved.handleRef.startsWith("content://"), "reopened Evidence must resolve inside managed store");
    const reopenedRows = await reopened.adapter.query(`SELECT storage_ref,content_hash,file_size FROM evidence WHERE evidence_id = ?`, [evidenceId]);
    requireTrue(reopenedRows.length === 1, "reopened SQLite authority must retain Evidence row");
    const reopenedMatch = String(reopenedRows[0].storage_ref) === storageRef
      && String(reopenedRows[0].content_hash) === expectedHash
      && Number(reopenedRows[0].file_size) === expectedSize;
    requireTrue(reopenedMatch, "reopened Evidence metadata must match committed durable state");
    await closeGate6BDatabase(DATABASE);

    return {
      status: "PASS",
      testedGitCommitSha: String(import.meta.env.VITE_GIT_COMMIT ?? "UNAVAILABLE"),
      sourceIsContentUri: true,
      canonicalStorageRef: isCanonicalStorageRef(storageRef),
      canonicalHash: isCanonicalSha256(persistedHash),
      expectedSize,
      persistedSize,
      expectedHash,
      persistedHash,
      sizeHintIgnored: expectedSize !== 1 && persistedSize === expectedSize,
      publishCompletedBeforeDbBegin: publishBeforeBegin,
      publishCompletedBeforeEvidenceInsert: publishBeforeInsert,
      transactionCommitted: committed,
      events: [...events],
      reconciliationValidAfterReopen: valid,
      hashStatusAfterReopen: hash.status,
      reopenedMetadataMatches: reopenedMatch,
      resolvedHandle: resolved.handleRef,
      evidenceId,
      storageRef,
    };
  } finally {
    await closeGate6BDatabase(DATABASE).catch(() => undefined);
    await deleteGate6BDatabase(DATABASE).catch(() => undefined);
  }
}

declare global {
  interface Window {
    __gate6cRunIntegrationProof?: typeof runGate6CDeviceIntegrationProof;
  }
}

if (typeof window !== "undefined") window.__gate6cRunIntegrationProof = runGate6CDeviceIntegrationProof;
