import { registerPlugin } from "@capacitor/core";
import type { ManagedEvidenceObjectKind } from "../application/evidence-contract.ts";
import type { NativePickerAcquisitionResult } from "./evidence-acquisition-mapping.ts";

export interface NativeAllocationResult {
  storageRef: string;
  stagingRef: string;
}

export interface NativeStageResult {
  storageRef: string;
  stagingRef: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  contentHash: string;
  capturedAt?: string | null;
  deviceNote?: string | null;
}

export interface NativePublishResult {
  storageRef: string;
  fileSize: number;
  contentHash: string;
}

export interface NativeManagedObject {
  kind: ManagedEvidenceObjectKind;
  ref: string;
}

export interface Gate6CEvidenceNativePlugin {
  chooseGalleryMedia(): Promise<NativePickerAcquisitionResult>;
  chooseGenericFile(): Promise<NativePickerAcquisitionResult>;
  allocate(options: {
    sourceRef: string;
    displayName?: string;
    declaredMimeType?: string;
  }): Promise<NativeAllocationResult>;
  stage(options: {
    sourceRef: string;
    storageRef: string;
    stagingRef: string;
    displayName?: string;
    declaredMimeType?: string;
    capturedAt?: string;
  }): Promise<NativeStageResult>;
  finalExists(options: { storageRef: string }): Promise<{ exists: boolean }>;
  publish(options: { storageRef: string; stagingRef: string }): Promise<NativePublishResult>;
  stat(options: { storageRef: string }): Promise<{ storageRef: string; fileSize: number }>;
  resolve(options: { storageRef: string }): Promise<{ storageRef: string; handleRef: string }>;
  listManagedObjects(): Promise<{ objects: NativeManagedObject[] }>;
  removeIncoming(options: { stagingRef: string }): Promise<void>;
  removeConfirmedOrphan(options: { storageRef: string }): Promise<void>;
  verifyHash(options: { storageRef: string; expectedHash: string }): Promise<{ matches: boolean; actualHash?: string }>;
}

export const Gate6CEvidenceNative = registerPlugin<Gate6CEvidenceNativePlugin>("Gate6CEvidence");
