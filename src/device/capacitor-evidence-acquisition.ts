import {
  Camera,
  CameraResultType,
  CameraSource,
  MediaTypeSelection,
} from "@capacitor/camera";
import type { AcquisitionOutcome, EvidenceSourceAcquisition } from "../application/evidence-contract.ts";
import {
  cameraMediaToEvidenceSource,
  legacyCameraPhotoToEvidenceSource,
  mapCameraError,
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
      const { results } = await Camera.chooseFromGallery({
        mediaType: MediaTypeSelection.All,
        allowMultipleSelection: false,
        includeMetadata: true,
        editable: "no",
        quality: 100,
      });
      if (results.length === 0) return { status: "USER_CANCELLED" };
      if (results.length !== 1) {
        return { status: "UNSUPPORTED_SOURCE", detail: "Gate 6C v1 accepts exactly one gallery item per Evidence operation" };
      }
      return cameraMediaToEvidenceSource("GALLERY_MEDIA", results[0]);
    } catch (error) {
      return mapCameraError(error);
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
