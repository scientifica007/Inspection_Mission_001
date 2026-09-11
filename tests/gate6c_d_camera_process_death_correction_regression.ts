import { readFileSync } from "node:fs";
import {
  legacyCameraPhotoToEvidenceSource,
  nativeGalleryResultToOutcome,
  nativeGenericResultToOutcome,
} from "../src/device/evidence-acquisition-mapping.ts";
import { EvidenceRestoredResultCoordinator } from "../src/device/evidence-restored-result.ts";

let passed = 0;
let failed = 0;

async function test(name: string, body: () => void | Promise<void>): Promise<void> {
  try {
    await body();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

class FakeApp {
  async addListener() {
    return { remove: async () => undefined };
  }
}

await test("G6CD-CAM-C01 legacy content URI maps to CAMERA_PHOTO", () => {
  const outcome = legacyCameraPhotoToEvidenceSource({
    path: "content://synthetic.camera/legacy/1",
    format: "jpeg",
    webPath: "capacitor://ignored-web-path",
  });
  assert(outcome.status === "SUCCESS", "legacy Camera content URI must succeed");
  assert(outcome.source.kind === "CAMERA_PHOTO", "kind must be CAMERA_PHOTO");
  assert(outcome.source.sourceRef === "content://synthetic.camera/legacy/1", "native path must be sourceRef");
  assert(outcome.source.displayName === "camera-evidence.jpeg", "format should inform displayName");
  assert(outcome.source.declaredMimeType === "image/jpeg", "format should inform MIME");
  assert(!("sizeHint" in outcome.source), "legacy result must not invent file size");
  assert(!("capturedAt" in outcome.source), "legacy result must not invent capturedAt");
});

await test("G6CD-CAM-C02 legacy file URI maps without webPath substitution", () => {
  const outcome = legacyCameraPhotoToEvidenceSource({
    path: "file:///data/user/0/example/cache/camera.jpg",
    format: "jpg",
    webPath: "https://localhost/_capacitor_file_/camera.jpg",
  });
  assert(outcome.status === "SUCCESS", "legacy Camera file URI must succeed");
  assert(outcome.source.sourceRef.startsWith("file://"), "native file URI must be retained");
  assert(!outcome.source.sourceRef.includes("localhost"), "webPath must not replace native path");
});

await test("G6CD-CAM-C03 missing legacy path fails SOURCE_UNAVAILABLE", () => {
  assert(legacyCameraPhotoToEvidenceSource({ format: "jpeg" }).status === "SOURCE_UNAVAILABLE", "missing path must fail closed");
  assert(legacyCameraPhotoToEvidenceSource({ path: "   ", format: "jpeg" }).status === "SOURCE_UNAVAILABLE", "blank path must fail closed");
});

await test("G6CD-CAM-C04 unsupported legacy path scheme fails UNSUPPORTED_SOURCE", () => {
  assert(legacyCameraPhotoToEvidenceSource({ path: "https://example.invalid/photo.jpg", format: "jpeg" }).status === "UNSUPPORTED_SOURCE", "unsupported scheme must fail closed");
});

await test("G6CD-CAM-C05 production Camera capture uses exact legacy URI compatibility options", () => {
  const source = readFileSync(new URL("../src/device/capacitor-evidence-acquisition.ts", import.meta.url), "utf8");
  assert(source.includes("Camera.getPhoto({"), "camera capture must use getPhoto");
  assert(source.includes("source: CameraSource.Camera"), "CameraSource.Camera required");
  assert(source.includes("resultType: CameraResultType.Uri"), "CameraResultType.Uri required");
  assert(source.includes("quality: 100"), "quality 100 required");
  assert(source.includes("saveToGallery: false"), "saveToGallery false required");
  assert(source.includes("allowEditing: false"), "allowEditing false required");
  assert(source.includes("correctOrientation: true"), "correctOrientation true required");
  const cameraMethod = source.slice(source.indexOf("async takeCameraPhoto"), source.indexOf("async chooseGalleryMedia"));
  assert(!cameraMethod.includes("Camera.takePhoto("), "corrected camera method must not call takePhoto");
  assert(!cameraMethod.includes("Base64"), "camera method must not use Base64");
});

await test("G6CD-CAM-C06 restored getPhoto becomes volatile pending with no owner", () => {
  const coordinator = new EvidenceRestoredResultCoordinator(new FakeApp());
  const result = coordinator.acceptRestoredEvent({
    pluginId: "Camera",
    methodName: "getPhoto",
    success: true,
    data: { path: "content://synthetic.camera/restored/getPhoto", format: "jpeg" },
  });
  assert(result.status === "PENDING", "restored getPhoto should become pending");
  assert(result.pending.methodName === "getPhoto", "method identity must be preserved");
  assert(result.pending.source.kind === "CAMERA_PHOTO", "restored source kind");
  assert(!("ownerKind" in result.pending) && !("ownerRef" in result.pending), "restored side-channel must carry no owner");
});

await test("G6CD-CAM-C07 restored getPhoto adoption is explicit and one-shot", async () => {
  const coordinator = new EvidenceRestoredResultCoordinator(new FakeApp());
  const result = coordinator.acceptRestoredEvent({
    pluginId: "Camera",
    methodName: "getPhoto",
    success: true,
    data: { path: "file:///synthetic/restored-getPhoto.jpg", format: "jpeg" },
  });
  assert(result.status === "PENDING", "restored getPhoto pending required");
  assert(coordinator.getPending() !== null, "no auto-consume/commit");
  const acquisition = coordinator.adoptPending(result.pending.pendingId);
  assert(acquisition !== null, "explicit adoption must yield EvidenceSourceAcquisition");
  assert(coordinator.getPending() === null, "adoption consumes volatile pending slot");
  const first = await acquisition.takeCameraPhoto();
  assert(first.status === "SUCCESS" && first.source.sourceRef === "file:///synthetic/restored-getPhoto.jpg", "adopted source enters normal acquisition seam");
  assert((await acquisition.takeCameraPhoto()).status === "USER_CANCELLED", "adopted source must be one-shot");
});

await test("G6CD-CAM-C08 gallery now uses project-owned native URI picker without changing Camera correction", () => {
  const outcome = nativeGalleryResultToOutcome({
    status: "SUCCESS",
    sourceRef: "content://synthetic.gallery/native/1",
    displayName: "gallery.png",
    declaredMimeType: "image/png",
    sizeHint: 44,
  });
  assert(outcome.status === "SUCCESS" && outcome.source.kind === "GALLERY_MEDIA", "native gallery mapping must remain successful");
  assert(outcome.source.sizeHint === 44 && outcome.source.declaredMimeType === "image/png", "native gallery metadata remains mapped");
  const source = readFileSync(new URL("../src/device/capacitor-evidence-acquisition.ts", import.meta.url), "utf8");
  const galleryMethod = source.slice(source.indexOf("async chooseGalleryMedia"), source.indexOf("async chooseGenericFile"));
  assert(galleryMethod.includes("this.native.chooseGalleryMedia()"), "gallery must use project-owned native picker");
  assert(!galleryMethod.includes("Camera.chooseFromGallery"), "obsolete IonCamera gallery route must not return");
  assert(source.includes("Camera.getPhoto({"), "Camera getPhoto correction remains intact");
});

await test("G6CD-CAM-C09 generic file mapping is unchanged", () => {
  const outcome = nativeGenericResultToOutcome({
    status: "SUCCESS",
    sourceRef: "content://synthetic.documents/unchanged/1",
    displayName: "unchanged.bin",
    declaredMimeType: "application/octet-stream",
    sizeHint: 99,
  });
  assert(outcome.status === "SUCCESS" && outcome.source.kind === "GENERIC_FILE", "generic mapping remains successful");
  assert(outcome.source.sourceRef === "content://synthetic.documents/unchanged/1", "generic URI unchanged");
});

await test("G6CD-CAM-C10 corrected restored path never commits directly", () => {
  const source = readFileSync(new URL("../src/device/evidence-restored-result.ts", import.meta.url), "utf8");
  assert(!/INSERT\s+INTO\s+evidence/i.test(source), "restored coordinator must not write Evidence SQL");
  assert(!source.includes("new EvidenceService"), "restored coordinator must not instantiate commit service");
  assert(source.includes("adoptPending"), "explicit adoption seam must remain");
});

console.log(`Gate 6C-D Camera process-death correction regression: ${passed} passed, ${failed} failed`);
if (failed !== 0) process.exitCode = 1;
