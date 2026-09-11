import type {
  AcquisitionOutcome,
  EvidenceSource,
  EvidenceSourceKind,
} from "../application/evidence-contract.ts";

export interface CameraErrorLike {
  code?: unknown;
  message?: unknown;
}

export interface CameraMediaLike {
  uri?: unknown;
  metadata?: {
    size?: unknown;
    format?: unknown;
    creationDate?: unknown;
  } | null;
}

export interface LegacyCameraPhotoLike {
  path?: unknown;
  format?: unknown;
  webPath?: unknown;
}

const CAMERA_PERMISSION_CODES = new Set(["OS-PLUG-CAMR-0003", "OS-PLUG-CAMR-0005"]);
const CAMERA_CANCEL_CODES = new Set(["OS-PLUG-CAMR-0006", "OS-PLUG-CAMR-0020"]);
const CAMERA_UNAVAILABLE_CODES = new Set([
  "OS-PLUG-CAMR-0007",
  "OS-PLUG-CAMR-0010",
  "OS-PLUG-CAMR-0012",
  "OS-PLUG-CAMR-0018",
  "OS-PLUG-CAMR-0021",
  "OS-PLUG-CAMR-0027",
  "OS-PLUG-CAMR-0028",
  "OS-PLUG-CAMR-0033",
]);
const CAMERA_UNSUPPORTED_CODES = new Set(["OS-PLUG-CAMR-0031"]);

function detail(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const message = (error as CameraErrorLike).message;
  if (typeof message !== "string") return undefined;
  const normalized = message.replace(/[\r\n]+/g, " ").trim();
  return normalized.length === 0 ? undefined : normalized.slice(0, 240);
}

export function mapCameraError(error: unknown): AcquisitionOutcome {
  const code = typeof error === "object" && error !== null && typeof (error as CameraErrorLike).code === "string"
    ? String((error as CameraErrorLike).code)
    : "";
  const d = detail(error);
  if (CAMERA_PERMISSION_CODES.has(code)) return d ? { status: "PERMISSION_DENIED", detail: d } : { status: "PERMISSION_DENIED" };
  if (CAMERA_CANCEL_CODES.has(code)) return { status: "USER_CANCELLED" };
  if (CAMERA_UNSUPPORTED_CODES.has(code)) return d ? { status: "UNSUPPORTED_SOURCE", detail: d } : { status: "UNSUPPORTED_SOURCE" };
  if (CAMERA_UNAVAILABLE_CODES.has(code)) return d ? { status: "SOURCE_UNAVAILABLE", detail: d } : { status: "SOURCE_UNAVAILABLE" };
  return d ? { status: "SOURCE_UNAVAILABLE", detail: d } : { status: "SOURCE_UNAVAILABLE" };
}

function normalizedFormat(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim().toLowerCase();
  if (!/^[a-z0-9]+$/.test(v)) return undefined;
  return v;
}

function mimeFromFormat(format: string | undefined): string | undefined {
  switch (format) {
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "png": return "image/png";
    case "webp": return "image/webp";
    case "heic": return "image/heic";
    case "heif": return "image/heif";
    case "gif": return "image/gif";
    case "mp4": return "video/mp4";
    case "webm": return "video/webm";
    default: return undefined;
  }
}

function utcTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return undefined;
  return d.toISOString();
}

function sizeHint(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return undefined;
  return value;
}

export function cameraMediaToEvidenceSource(kind: Exclude<EvidenceSourceKind, "GENERIC_FILE">, media: CameraMediaLike): AcquisitionOutcome {
  if (typeof media.uri !== "string" || media.uri.trim().length === 0) {
    return { status: "SOURCE_UNAVAILABLE", detail: "Camera result did not contain a native media URI" };
  }
  const sourceRef = media.uri.trim();
  if (!/^(content|file):\/\//i.test(sourceRef)) {
    return { status: "UNSUPPORTED_SOURCE", detail: "Camera result URI uses an unsupported scheme" };
  }
  const format = normalizedFormat(media.metadata?.format);
  const displayStem = kind === "CAMERA_PHOTO" ? "camera-evidence" : "gallery-evidence";
  const source: EvidenceSource = {
    kind,
    sourceRef,
    displayName: `${displayStem}.${format ?? "bin"}`,
  };
  const declaredMimeType = mimeFromFormat(format);
  if (declaredMimeType !== undefined) source.declaredMimeType = declaredMimeType;
  const size = sizeHint(media.metadata?.size);
  if (size !== undefined) source.sizeHint = size;
  const capturedAt = utcTimestamp(media.metadata?.creationDate);
  if (capturedAt !== undefined) source.capturedAt = capturedAt;
  return { status: "SUCCESS", source };
}

export function legacyCameraPhotoToEvidenceSource(photo: unknown): AcquisitionOutcome {
  const record = typeof photo === "object" && photo !== null ? photo as LegacyCameraPhotoLike : null;
  if (record === null || typeof record.path !== "string" || record.path.trim().length === 0) {
    return { status: "SOURCE_UNAVAILABLE", detail: "Legacy Camera result did not contain a native photo path" };
  }
  const sourceRef = record.path.trim();
  if (!/^(content|file):\/\//i.test(sourceRef)) {
    return { status: "UNSUPPORTED_SOURCE", detail: "Legacy Camera photo path uses an unsupported scheme" };
  }
  const format = normalizedFormat(record.format);
  const source: EvidenceSource = {
    kind: "CAMERA_PHOTO",
    sourceRef,
    displayName: `camera-evidence.${format ?? "bin"}`,
  };
  const declaredMimeType = mimeFromFormat(format);
  if (declaredMimeType !== undefined) source.declaredMimeType = declaredMimeType;
  return { status: "SUCCESS", source };
}

export interface NativeGenericAcquisitionResult {
  status: "SUCCESS" | "USER_CANCELLED" | "PERMISSION_DENIED" | "SOURCE_UNAVAILABLE" | "UNSUPPORTED_SOURCE";
  sourceRef?: string;
  displayName?: string;
  declaredMimeType?: string;
  sizeHint?: number;
  detail?: string;
}

export function nativeGenericResultToOutcome(result: NativeGenericAcquisitionResult): AcquisitionOutcome {
  if (result.status === "USER_CANCELLED") return { status: "USER_CANCELLED" };
  if (result.status === "PERMISSION_DENIED") return result.detail ? { status: "PERMISSION_DENIED", detail: result.detail } : { status: "PERMISSION_DENIED" };
  if (result.status === "SOURCE_UNAVAILABLE") return result.detail ? { status: "SOURCE_UNAVAILABLE", detail: result.detail } : { status: "SOURCE_UNAVAILABLE" };
  if (result.status === "UNSUPPORTED_SOURCE") return result.detail ? { status: "UNSUPPORTED_SOURCE", detail: result.detail } : { status: "UNSUPPORTED_SOURCE" };
  if (typeof result.sourceRef !== "string" || result.sourceRef.trim().length === 0) {
    return { status: "SOURCE_UNAVAILABLE", detail: "Generic picker returned no source URI" };
  }
  if (!/^(content|file):\/\//i.test(result.sourceRef.trim())) {
    return { status: "UNSUPPORTED_SOURCE", detail: "Generic picker returned an unsupported URI scheme" };
  }
  const source: EvidenceSource = { kind: "GENERIC_FILE", sourceRef: result.sourceRef.trim() };
  if (typeof result.displayName === "string" && result.displayName.trim().length > 0) source.displayName = result.displayName.trim();
  if (typeof result.declaredMimeType === "string" && result.declaredMimeType.trim().length > 0) source.declaredMimeType = result.declaredMimeType.trim();
  if (typeof result.sizeHint === "number" && Number.isSafeInteger(result.sizeHint) && result.sizeHint >= 0) source.sizeHint = result.sizeHint;
  return { status: "SUCCESS", source };
}
