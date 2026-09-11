import {
  Camera,
  CameraResultType,
  CameraSource,
} from "@capacitor/camera";
import type { AcquisitionOutcome, EvidenceSourceAcquisition } from "../application/evidence-contract.ts";
import {
  legacyCameraPhotoToEvidenceSource,
  mapCameraError,
  nativeGalleryResultToOutcome,
  nativeGenericResultToOutcome,
} from "./evidence-acquisition-mapping.ts";
import { Gate6CEvidenceNative, type Gate6CEvidenceNativePlugin } from "./gate6c-evidence-native.ts";

export class CapacitorEvidenceSourceAcquisition implements EvidenceSourceAcquisition {
  private readonly native: Gate6CEvidenceNativePlugin;

  constructor(native: Gate6CEvidenceNativePlugin = Gate6CEvidenceNative) {
    this.native = native;
  }

  async takeCameraPhoto(): Promise<AcquisitionOutcome> {
    try {
      const photo = await Camera.getPhoto({
        source: CameraSource.Camera,
        resultType: CameraResultType.Uri,
        quality: 100,
        saveToGallery: false,
        allowEditing: false,
        correctOrientation: true,
      });
      return legacyCameraPhotoToEvidenceSource(photo);
    } catch (error) {
      return mapCameraError(error);
    }
  }

  async chooseGalleryMedia(): Promise<AcquisitionOutcome> {
    try {
      return nativeGalleryResultToOutcome(await this.native.chooseGalleryMedia());
    } catch (error) {
      if (typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string") {
        const code = String((error as { code: string }).code);
        if (code === "G6C_PERMISSION_DENIED") return { status: "PERMISSION_DENIED" };
        if (code === "G6C_UNSUPPORTED_SOURCE") return { status: "UNSUPPORTED_SOURCE" };
      }
      return { status: "SOURCE_UNAVAILABLE", detail: "Native Android gallery picker failed" };
    }
  }

  async chooseGenericFile(): Promise<AcquisitionOutcome> {
    try {
      return nativeGenericResultToOutcome(await this.native.chooseGenericFile());
    } catch (error) {
      if (typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string") {
        const code = String((error as { code: string }).code);
        if (code === "G6C_PERMISSION_DENIED") return { status: "PERMISSION_DENIED" };
        if (code === "G6C_UNSUPPORTED_SOURCE") return { status: "UNSUPPORTED_SOURCE" };
      }
      return { status: "SOURCE_UNAVAILABLE", detail: "Generic Android file picker failed" };
    }
  }
}
