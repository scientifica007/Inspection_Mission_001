import type { SqlRow } from "../bootstrap/adapter.ts";

export type EvidenceSourceKind = "CAMERA_PHOTO" | "GALLERY_MEDIA" | "GENERIC_FILE";
export type EvidenceOwnerKind =
    | "VISIT" | "CHECKLIST_RESPONSE" | "ADHOC_OBSERVATION"
    | "FINDING" | "CORRECTIVE_ACTION" | "FOLLOW_UP";

export interface EvidenceSource {
    kind: EvidenceSourceKind;
    /** Opaque acquisition-only reference. Never persisted as Evidence.storage_ref. */
    sourceRef: string;
    displayName?: string;
    declaredMimeType?: string;
    sizeHint?: number;
    capturedAt?: string;
}

export type AcquisitionOutcome =
    | { status: "SUCCESS"; source: EvidenceSource }
    | { status: "USER_CANCELLED" }
    | { status: "PERMISSION_DENIED"; detail?: string }
    | { status: "SOURCE_UNAVAILABLE"; detail?: string }
    | { status: "UNSUPPORTED_SOURCE"; detail?: string };

export interface EvidenceSourceAcquisition {
    takeCameraPhoto(): Promise<AcquisitionOutcome>;
    chooseGalleryMedia(): Promise<AcquisitionOutcome>;
    chooseGenericFile(): Promise<AcquisitionOutcome>;
}

export interface EvidenceObjectAllocation { storageRef: string; stagingRef: string }
export interface StagedEvidenceObject {
    storageRef: string;
    stagingRef: string;
    fileName: string;
    mimeType: string;
    fileSize: number;
    contentHash: string;
    capturedAt?: string | null;
    deviceNote?: string | null;
}
export interface StoredEvidenceObject { storageRef: string }
export interface StoredEvidenceStat { storageRef: string; fileSize: number }
export interface ResolvedEvidenceHandle { storageRef: string; handleRef: string }
export type ManagedEvidenceObjectKind = "INCOMING" | "FINAL" | "UNKNOWN";
export interface ManagedEvidenceObject { kind: ManagedEvidenceObjectKind; ref: string }
export interface HashVerification { matches: boolean; actualHash?: string }

export interface EvidenceStorage {
    /** UUID generation/physical identity allocation stays behind this runtime-neutral seam. */
    allocate(source: EvidenceSource): Promise<EvidenceObjectAllocation>;
    /** Copy/hash bytes behind the storage seam; no whole binary enters Application Core. */
    stage(source: EvidenceSource, allocation: EvidenceObjectAllocation): Promise<StagedEvidenceObject>;
    finalExists(storageRef: string): Promise<boolean>;
    /** Must fail closed instead of replacing an existing final destination. */
    publish(staged: StagedEvidenceObject): Promise<StoredEvidenceObject>;
    stat(storageRef: string): Promise<StoredEvidenceStat>;
    resolve(storageRef: string): Promise<ResolvedEvidenceHandle>;
    listManagedObjects(): Promise<ManagedEvidenceObject[]>;
    removeIncoming(stagingRef: string): Promise<void>;
    removeConfirmedOrphan(storageRef: string): Promise<void>;
    verifyHash(storageRef: string, expectedHash: string): Promise<HashVerification>;
}

export interface CreateEvidenceInput {
    ownerKind: EvidenceOwnerKind;
    ownerRef: number;
    sourceKind: EvidenceSourceKind;
    recordedAt: string;
    recordedBy: string;
    note?: string | null;
}

export interface EvidenceState {
    evidenceId: number;
    ownerKind: EvidenceOwnerKind;
    ownerRef: number;
    storageRef: string;
    contentHash: string;
    fileName: string;
    mimeType: string;
    fileSize: number;
    capturedAt: string | null;
    deviceNote: string | null;
    note: string | null;
    recordedAt: string;
    recordedBy: string;
}

export type CreateEvidenceResult =
    | { status: "CREATED"; evidence: EvidenceState }
    | { status: "USER_CANCELLED" };

export type EvidenceReconciliationItem =
    | { kind: "VALID_REFERENCE"; storageRef: string; evidenceId: number }
    | { kind: "INCOMING_REMOVED"; ref: string }
    | { kind: "ORPHAN_REMOVED"; storageRef: string }
    | { kind: "BROKEN_STORAGE_REFERENCE"; storageRef: string; evidenceId: number }
    | { kind: "STORAGE_REF_CONFLICT"; storageRef: string; evidenceIds: readonly number[] }
    | { kind: "HASH_MISMATCH"; storageRef: string; evidenceId: number }
    | { kind: "ORPHAN_CLEANUP_FAILED"; ref: string }
    | { kind: "STORAGE_DIAGNOSTIC_FAILED"; ref: string }
    | { kind: "UNKNOWN_MANAGED_OBJECT"; ref: string };

export interface EvidenceReconciliationReport { items: readonly EvidenceReconciliationItem[] }
export type EvidenceHashDiagnostic =
    | { status: "MATCH"; evidenceId: number; storageRef: string }
    | { status: "HISTORICAL_HASH_ABSENT"; evidenceId: number; storageRef: string };
export interface ReconcileEvidenceOptions { verifyHashes?: boolean }

export interface EvidenceDbRow {
    evidenceId: number;
    ownerKind: string;
    ownerRef: number;
    storageRef: string;
    contentHash: string | null;
    fileName: string;
    mimeType: string;
    fileSize: number | null;
    capturedAt: string | null;
    deviceNote: string | null;
    note: string | null;
    recordedAt: string;
    recordedBy: string;
}

export interface EvidenceAttempt {
    ownerKind: EvidenceOwnerKind;
    ownerRef: number;
    storageRef: string;
    contentHash: string;
    fileName: string;
    mimeType: string;
    fileSize: number;
    capturedAt: string | null;
    deviceNote: string | null;
    note: string | null;
    recordedAt: string;
    recordedBy: string;
}

export const OWNER_TABLES: Record<EvidenceOwnerKind, { table: string; pk: string }> = {
    VISIT: { table: "visit", pk: "visit_id" },
    CHECKLIST_RESPONSE: { table: "checklist_response", pk: "response_id" },
    ADHOC_OBSERVATION: { table: "adhoc_observation", pk: "observation_id" },
    FINDING: { table: "finding", pk: "finding_id" },
    CORRECTIVE_ACTION: { table: "corrective_action", pk: "action_id" },
    FOLLOW_UP: { table: "follow_up", pk: "followup_id" },
};

const UUID_V4 = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const FINAL_REF_RE = new RegExp(`^evidence/v1/objects/(${UUID_V4})\\.([a-z0-9]+)$`);
const STAGING_REF_RE = new RegExp(`^evidence/v1/\\.incoming/(${UUID_V4})\\.part$`);
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;

export function isCanonicalStorageRef(v: string): boolean { return FINAL_REF_RE.test(v) }
export function isCanonicalStagingRef(v: string): boolean { return STAGING_REF_RE.test(v) }
export function isCanonicalSha256(v: string): boolean { return SHA256_RE.test(v) }
export function canonicalAllocationUsesSameUuid(a: EvidenceObjectAllocation): boolean {
    const f = FINAL_REF_RE.exec(a.storageRef);
    const s = STAGING_REF_RE.exec(a.stagingRef);
    return f !== null && s !== null && f[1] === s[1];
}

export function parseEvidenceRow(row: SqlRow): EvidenceDbRow {
    return {
        evidenceId: Number(row.evidence_id), ownerKind: String(row.owner_kind), ownerRef: Number(row.owner_ref),
        storageRef: String(row.storage_ref), contentHash: row.content_hash === null ? null : String(row.content_hash),
        fileName: String(row.file_name), mimeType: String(row.mime_type),
        fileSize: row.file_size === null ? null : Number(row.file_size),
        capturedAt: row.captured_at === null ? null : String(row.captured_at),
        deviceNote: row.device_note === null ? null : String(row.device_note),
        note: row.note === null ? null : String(row.note), recordedAt: String(row.recorded_at), recordedBy: String(row.recorded_by),
    };
}

export function normalizeOptionalText(v: string | null | undefined): string | null {
    if (v === undefined || v === null) return null;
    const t = v.trim(); return t.length === 0 ? null : t;
}
export function isStrictUtcTimestamp(v: string): boolean {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/.exec(v);
    if (m === null) return false;
    const y=Number(m[1]), mo=Number(m[2]), d=Number(m[3]), h=Number(m[4]), mi=Number(m[5]), s=Number(m[6]);
    if (mo<1 || mo>12 || h>23 || mi>59 || s>59) return false;
    const leap=y%4===0 && (y%100!==0 || y%400===0);
    const days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
    return d>=1 && d<=days[mo-1];
}
export function errorText(e: unknown): string { return e instanceof Error ? e.message : String(e) }
export function attemptMatchesCommittedRow(a: EvidenceAttempt, r: EvidenceDbRow): boolean {
    // note is mutable; Gate-6C-A uncertain-COMMIT identity also excludes device_note.
    return r.ownerKind===a.ownerKind && r.ownerRef===a.ownerRef && r.storageRef===a.storageRef &&
        r.contentHash===a.contentHash && r.fileName===a.fileName && r.mimeType===a.mimeType &&
        r.fileSize===a.fileSize && r.capturedAt===a.capturedAt && r.recordedAt===a.recordedAt && r.recordedBy===a.recordedBy;
}
export function toEvidenceState(id: number, a: EvidenceAttempt): EvidenceState {
    return { evidenceId:id, ownerKind:a.ownerKind, ownerRef:a.ownerRef, storageRef:a.storageRef,
        contentHash:a.contentHash, fileName:a.fileName, mimeType:a.mimeType, fileSize:a.fileSize,
        capturedAt:a.capturedAt, deviceNote:a.deviceNote, note:a.note, recordedAt:a.recordedAt, recordedBy:a.recordedBy };
}
