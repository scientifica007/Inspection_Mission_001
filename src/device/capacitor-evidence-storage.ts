import { APP_ERR, DomainError } from "../application/errors.ts";
import {
  isCanonicalSha256,
  isCanonicalStagingRef,
  isCanonicalStorageRef,
  type EvidenceObjectAllocation,
  type EvidenceSource,
  type EvidenceStorage,
  type HashVerification,
  type ManagedEvidenceObject,
  type ResolvedEvidenceHandle,
  type StagedEvidenceObject,
  type StoredEvidenceObject,
  type StoredEvidenceStat,
} from "../application/evidence-contract.ts";
import { Gate6CEvidenceNative, type Gate6CEvidenceNativePlugin } from "./gate6c-evidence-native.ts";

interface NativePluginErrorLike { code?: unknown; message?: unknown }

function message(error: unknown): string {
  if (typeof error === "object" && error !== null && typeof (error as NativePluginErrorLike).message === "string") {
    return String((error as NativePluginErrorLike).message).replace(/[\r\n]+/g, " ").slice(0, 240);
  }
  return "native Gate 6C Evidence operation failed";
}

function code(error: unknown): string {
  return typeof error === "object" && error !== null && typeof (error as NativePluginErrorLike).code === "string"
    ? String((error as NativePluginErrorLike).code)
    : "";
}

function mapped(error: unknown): DomainError {
  const c = code(error);
  const m = message(error);
  if (c === "G6C_PERMISSION_DENIED") return new DomainError(APP_ERR.EVIDENCE_PERMISSION_DENIED, m);
  if (c === "G6C_SOURCE_UNAVAILABLE") return new DomainError(APP_ERR.EVIDENCE_SOURCE_UNAVAILABLE, m);
  if (c === "G6C_BROKEN_STORAGE_REFERENCE" || c === "G6C_BAD_REFERENCE") return new DomainError(APP_ERR.EVIDENCE_BROKEN_STORAGE_REFERENCE, m);
  return new DomainError(APP_ERR.EVIDENCE_STORAGE_WRITE_FAILED, m);
}

function requireCanonicalAllocation(value: EvidenceObjectAllocation): EvidenceObjectAllocation {
  if (!isCanonicalStorageRef(value.storageRef) || !isCanonicalStagingRef(value.stagingRef)) {
    throw new DomainError(APP_ERR.EVIDENCE_STORAGE_WRITE_FAILED, "Gate 6C native allocation returned non-canonical references");
  }
  return value;
}

export class CapacitorEvidenceStorage implements EvidenceStorage {
  private readonly native: Gate6CEvidenceNativePlugin;

  constructor(native: Gate6CEvidenceNativePlugin = Gate6CEvidenceNative) {
    this.native = native;
  }

  async allocate(source: EvidenceSource): Promise<EvidenceObjectAllocation> {
    try {
      return requireCanonicalAllocation(await this.native.allocate({
        sourceRef: source.sourceRef,
        ...(source.displayName === undefined ? {} : { displayName: source.displayName }),
        ...(source.declaredMimeType === undefined ? {} : { declaredMimeType: source.declaredMimeType }),
      }));
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw mapped(error);
    }
  }

  async stage(source: EvidenceSource, allocation: EvidenceObjectAllocation): Promise<StagedEvidenceObject> {
    requireCanonicalAllocation(allocation);
    try {
      const result = await this.native.stage({
        sourceRef: source.sourceRef,
        storageRef: allocation.storageRef,
        stagingRef: allocation.stagingRef,
        ...(source.displayName === undefined ? {} : { displayName: source.displayName }),
        ...(source.declaredMimeType === undefined ? {} : { declaredMimeType: source.declaredMimeType }),
        ...(source.capturedAt === undefined ? {} : { capturedAt: source.capturedAt }),
      });
      if (!isCanonicalStorageRef(result.storageRef) || !isCanonicalStagingRef(result.stagingRef)) {
        throw new DomainError(APP_ERR.EVIDENCE_STORAGE_WRITE_FAILED, "Gate 6C native stage returned non-canonical identity");
      }
      if (!Number.isSafeInteger(result.fileSize) || result.fileSize < 0) {
        throw new DomainError(APP_ERR.EVIDENCE_STORAGE_WRITE_FAILED, "Gate 6C native stage returned invalid byte count");
      }
      if (!isCanonicalSha256(result.contentHash)) {
        throw new DomainError(APP_ERR.EVIDENCE_HASH_FAILED, "Gate 6C native stage returned invalid SHA-256");
      }
      return {
        storageRef: result.storageRef,
        stagingRef: result.stagingRef,
        fileName: result.fileName,
        mimeType: result.mimeType,
        fileSize: result.fileSize,
        contentHash: result.contentHash,
        capturedAt: result.capturedAt ?? null,
        deviceNote: result.deviceNote ?? null,
      };
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw mapped(error);
    }
  }

  async finalExists(storageRef: string): Promise<boolean> {
    if (!isCanonicalStorageRef(storageRef)) throw new DomainError(APP_ERR.EVIDENCE_BROKEN_STORAGE_REFERENCE, "Malformed Gate 6C storage_ref");
    try { return (await this.native.finalExists({ storageRef })).exists; }
    catch (error) { throw mapped(error); }
  }

  async publish(staged: StagedEvidenceObject): Promise<StoredEvidenceObject> {
    if (!isCanonicalStorageRef(staged.storageRef) || !isCanonicalStagingRef(staged.stagingRef)) {
      throw new DomainError(APP_ERR.EVIDENCE_BROKEN_STORAGE_REFERENCE, "Malformed Gate 6C publish references");
    }
    try {
      const result = await this.native.publish({ storageRef: staged.storageRef, stagingRef: staged.stagingRef });
      if (!isCanonicalStorageRef(result.storageRef) || !Number.isSafeInteger(result.fileSize) || result.fileSize < 0) {
        throw new DomainError(APP_ERR.EVIDENCE_STORAGE_WRITE_FAILED, "Gate 6C native publish returned invalid final metadata");
      }
      if (!isCanonicalSha256(result.contentHash)) throw new DomainError(APP_ERR.EVIDENCE_HASH_FAILED, "Gate 6C native publish returned invalid SHA-256");
      return result;
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw mapped(error);
    }
  }

  async stat(storageRef: string): Promise<StoredEvidenceStat> {
    if (!isCanonicalStorageRef(storageRef)) throw new DomainError(APP_ERR.EVIDENCE_BROKEN_STORAGE_REFERENCE, "Malformed Gate 6C storage_ref");
    try {
      const result = await this.native.stat({ storageRef });
      if (result.storageRef !== storageRef || !Number.isSafeInteger(result.fileSize) || result.fileSize < 0) {
        throw new DomainError(APP_ERR.EVIDENCE_BROKEN_STORAGE_REFERENCE, "Native Evidence stat returned invalid metadata");
      }
      return result;
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw mapped(error);
    }
  }

  async resolve(storageRef: string): Promise<ResolvedEvidenceHandle> {
    if (!isCanonicalStorageRef(storageRef)) throw new DomainError(APP_ERR.EVIDENCE_BROKEN_STORAGE_REFERENCE, "Malformed Gate 6C storage_ref");
    try {
      const result = await this.native.resolve({ storageRef });
      if (result.storageRef !== storageRef || typeof result.handleRef !== "string" || result.handleRef.length === 0) {
        throw new DomainError(APP_ERR.EVIDENCE_BROKEN_STORAGE_REFERENCE, "Native Evidence resolve returned invalid handle");
      }
      return result;
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw mapped(error);
    }
  }

  async listManagedObjects(): Promise<ManagedEvidenceObject[]> {
    try {
      const { objects } = await this.native.listManagedObjects();
      return objects.map((item) => ({ kind: item.kind, ref: item.ref }));
    } catch (error) {
      throw mapped(error);
    }
  }

  async removeIncoming(stagingRef: string): Promise<void> {
    if (!isCanonicalStagingRef(stagingRef)) throw new DomainError(APP_ERR.EVIDENCE_BROKEN_STORAGE_REFERENCE, "Malformed Gate 6C staging_ref");
    try { await this.native.removeIncoming({ stagingRef }); }
    catch (error) { throw mapped(error); }
  }

  async removeConfirmedOrphan(storageRef: string): Promise<void> {
    if (!isCanonicalStorageRef(storageRef)) throw new DomainError(APP_ERR.EVIDENCE_BROKEN_STORAGE_REFERENCE, "Malformed Gate 6C storage_ref");
    try { await this.native.removeConfirmedOrphan({ storageRef }); }
    catch (error) { throw mapped(error); }
  }

  async verifyHash(storageRef: string, expectedHash: string): Promise<HashVerification> {
    if (!isCanonicalStorageRef(storageRef)) throw new DomainError(APP_ERR.EVIDENCE_BROKEN_STORAGE_REFERENCE, "Malformed Gate 6C storage_ref");
    if (!isCanonicalSha256(expectedHash)) throw new DomainError(APP_ERR.EVIDENCE_HASH_FAILED, "Expected Gate 6C hash is not canonical SHA-256");
    try { return await this.native.verifyHash({ storageRef, expectedHash }); }
    catch (error) { throw mapped(error); }
  }
}
