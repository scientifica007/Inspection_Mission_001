import { App } from "@capacitor/app";
import type {
  AcquisitionOutcome,
  EvidenceSource,
  EvidenceSourceAcquisition,
  EvidenceSourceKind,
} from "../application/evidence-contract.ts";
import {
  cameraMediaToEvidenceSource,
  legacyCameraPhotoToEvidenceSource,
  mapCameraError,
} from "./evidence-acquisition-mapping.ts";

export interface RestoredListenerEventLike {
  pluginId: string;
  methodName: string;
  data: unknown;
  success: boolean;
  error?: { message?: string; code?: string } | null;
}

interface AppRestoredEventSource {
  addListener(
    eventName: "appRestoredResult",
    listener: (event: RestoredListenerEventLike) => void,
  ): Promise<{ remove(): Promise<void> }>;
}

type RestoredCameraMethodName = "getPhoto" | "takePhoto" | "chooseFromGallery";

export interface PendingRestoredEvidenceSource {
  pendingId: string;
  methodName: RestoredCameraMethodName;
  source: EvidenceSource;
}

export type RestoredEventDisposition =
  | { status: "IGNORED" }
  | { status: "PENDING"; pending: PendingRestoredEvidenceSource }
  | { status: "FAILED"; outcome: Exclude<AcquisitionOutcome, { status: "SUCCESS" }> };

function nextPendingId(): string {
  const bytes = new Uint32Array(2);
  crypto.getRandomValues(bytes);
  return `restored-${bytes[0].toString(16).padStart(8, "0")}${bytes[1].toString(16).padStart(8, "0")}`;
}

function dataToOutcome(methodName: RestoredCameraMethodName, data: unknown): AcquisitionOutcome {
  if (typeof data !== "object" || data === null) {
    return { status: "SOURCE_UNAVAILABLE", detail: "Restored Camera result did not contain media metadata" };
  }
  if (methodName === "getPhoto") {
    return legacyCameraPhotoToEvidenceSource(data);
  }
  if (methodName === "takePhoto") {
    return cameraMediaToEvidenceSource("CAMERA_PHOTO", data as { uri?: unknown; metadata?: { size?: unknown; format?: unknown; creationDate?: unknown } | null });
  }
  const results = (data as { results?: unknown }).results;
  if (!Array.isArray(results)) {
    return { status: "SOURCE_UNAVAILABLE", detail: "Restored gallery result did not contain a media result array" };
  }
  if (results.length === 0) return { status: "USER_CANCELLED" };
  if (results.length !== 1) {
    return { status: "UNSUPPORTED_SOURCE", detail: "Gate 6C v1 accepts exactly one restored gallery item per Evidence operation" };
  }
  return cameraMediaToEvidenceSource("GALLERY_MEDIA", results[0] as { uri?: unknown; metadata?: { size?: unknown; format?: unknown; creationDate?: unknown } | null });
}

class PendingSourceAcquisition implements EvidenceSourceAcquisition {
  private consumed = false;
  private readonly source: EvidenceSource;

  constructor(source: EvidenceSource) {
    this.source = source;
  }

  private consume(kind: EvidenceSourceKind): Promise<AcquisitionOutcome> {
    if (this.consumed || this.source.kind !== kind) return Promise.resolve({ status: "USER_CANCELLED" });
    this.consumed = true;
    return Promise.resolve({ status: "SUCCESS", source: this.source });
  }

  takeCameraPhoto(): Promise<AcquisitionOutcome> { return this.consume("CAMERA_PHOTO"); }
  chooseGalleryMedia(): Promise<AcquisitionOutcome> { return this.consume("GALLERY_MEDIA"); }
  chooseGenericFile(): Promise<AcquisitionOutcome> { return this.consume("GENERIC_FILE"); }
}

/**
 * Device/composition-layer restored Camera coordinator.
 * Pending sources are deliberately volatile and carry no owner information.
 * Explicit adoption only yields an EvidenceSourceAcquisition; the caller must then use the normal EvidenceService pipeline.
 */
export class EvidenceRestoredResultCoordinator {
  private pending: PendingRestoredEvidenceSource | null = null;
  private handle: { remove(): Promise<void> } | null = null;
  private readonly app: AppRestoredEventSource;

  constructor(app: AppRestoredEventSource = App as unknown as AppRestoredEventSource) {
    this.app = app;
  }

  async start(): Promise<void> {
    if (this.handle !== null) return;
    this.handle = await this.app.addListener("appRestoredResult", (event) => {
      this.acceptRestoredEvent(event);
    });
  }

  async stop(): Promise<void> {
    const active = this.handle;
    this.handle = null;
    if (active !== null) await active.remove();
  }

  acceptRestoredEvent(event: RestoredListenerEventLike): RestoredEventDisposition {
    if (event.pluginId !== "Camera") return { status: "IGNORED" };
    if (event.methodName !== "getPhoto" && event.methodName !== "takePhoto" && event.methodName !== "chooseFromGallery") return { status: "IGNORED" };

    if (!event.success) {
      const outcome = mapCameraError(event.error ?? { message: "Restored Camera call did not succeed" });
      return { status: "FAILED", outcome: outcome.status === "SUCCESS" ? { status: "SOURCE_UNAVAILABLE" } : outcome };
    }

    const outcome = dataToOutcome(event.methodName, event.data);
    if (outcome.status !== "SUCCESS") return { status: "FAILED", outcome };

    const pending: PendingRestoredEvidenceSource = {
      pendingId: nextPendingId(),
      methodName: event.methodName,
      source: outcome.source,
    };
    this.pending = pending;
    return { status: "PENDING", pending };
  }

  getPending(): PendingRestoredEvidenceSource | null {
    return this.pending === null ? null : { ...this.pending, source: { ...this.pending.source } };
  }

  discardPending(pendingId: string): boolean {
    if (this.pending?.pendingId !== pendingId) return false;
    this.pending = null;
    return true;
  }

  adoptPending(pendingId: string): EvidenceSourceAcquisition | null {
    if (this.pending?.pendingId !== pendingId) return null;
    const source = this.pending.source;
    this.pending = null;
    return new PendingSourceAcquisition(source);
  }
}

/** Registered during module startup, before React renders any diagnostic UI. */
export const gate6cRestoredResultCoordinator = new EvidenceRestoredResultCoordinator();
