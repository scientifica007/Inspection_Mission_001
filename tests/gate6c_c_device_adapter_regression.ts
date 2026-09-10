import {
  cameraMediaToEvidenceSource,
  mapCameraError,
  nativeGenericResultToOutcome,
} from "../src/device/evidence-acquisition-mapping.ts";

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

await test("G6C-C-H01 camera permission error maps to PERMISSION_DENIED", () => {
  assert(mapCameraError({ code: "OS-PLUG-CAMR-0003", message: "camera denied" }).status === "PERMISSION_DENIED", "camera permission mapping");
});

await test("G6C-C-H02 gallery permission error maps to PERMISSION_DENIED", () => {
  assert(mapCameraError({ code: "OS-PLUG-CAMR-0005" }).status === "PERMISSION_DENIED", "gallery permission mapping");
});

await test("G6C-C-H03 camera cancellation is normal USER_CANCELLED", () => {
  assert(mapCameraError({ code: "OS-PLUG-CAMR-0006" }).status === "USER_CANCELLED", "camera cancel mapping");
});

await test("G6C-C-H04 gallery cancellation is normal USER_CANCELLED", () => {
  assert(mapCameraError({ code: "OS-PLUG-CAMR-0020" }).status === "USER_CANCELLED", "gallery cancel mapping");
});

await test("G6C-C-H05 no camera maps to SOURCE_UNAVAILABLE", () => {
  assert(mapCameraError({ code: "OS-PLUG-CAMR-0007" }).status === "SOURCE_UNAVAILABLE", "no camera mapping");
});

await test("G6C-C-H06 missing selected file maps to SOURCE_UNAVAILABLE", () => {
  assert(mapCameraError({ code: "OS-PLUG-CAMR-0027" }).status === "SOURCE_UNAVAILABLE", "missing file mapping");
});

await test("G6C-C-H07 invalid plugin argument maps to UNSUPPORTED_SOURCE", () => {
  assert(mapCameraError({ code: "OS-PLUG-CAMR-0031" }).status === "UNSUPPORTED_SOURCE", "unsupported mapping");
});

await test("G6C-C-H08 camera result exposes URI metadata only", () => {
  const outcome = cameraMediaToEvidenceSource("CAMERA_PHOTO", {
    uri: "content://synthetic.camera/photo/1",
    metadata: { size: 1234, format: "jpeg", creationDate: "2026-09-10T12:34:56+01:00" },
  });
  assert(outcome.status === "SUCCESS", "camera source expected");
  assert(outcome.source.kind === "CAMERA_PHOTO", "kind");
  assert(outcome.source.sourceRef === "content://synthetic.camera/photo/1", "opaque URI");
  assert(outcome.source.declaredMimeType === "image/jpeg", "MIME");
  assert(outcome.source.sizeHint === 1234, "size hint");
  assert(outcome.source.capturedAt === "2026-09-10T11:34:56.000Z", "UTC normalization");
  assert(!("thumbnail" in outcome.source), "no thumbnail/binary crosses Application Core seam");
});

await test("G6C-C-H09 gallery result remains one source", () => {
  const outcome = cameraMediaToEvidenceSource("GALLERY_MEDIA", {
    uri: "file:///synthetic/gallery/item.mp4",
    metadata: { size: 9876, format: "mp4" },
  });
  assert(outcome.status === "SUCCESS" && outcome.source.kind === "GALLERY_MEDIA", "gallery source expected");
  assert(outcome.source.declaredMimeType === "video/mp4", "video MIME");
});

await test("G6C-C-H10 camera result without URI fails closed", () => {
  assert(cameraMediaToEvidenceSource("CAMERA_PHOTO", { metadata: { format: "jpg" } }).status === "SOURCE_UNAVAILABLE", "missing URI must fail");
});

await test("G6C-C-H11 unsupported Camera URI scheme fails closed", () => {
  assert(cameraMediaToEvidenceSource("CAMERA_PHOTO", { uri: "https://example.invalid/photo.jpg" }).status === "UNSUPPORTED_SOURCE", "scheme guard");
});

await test("G6C-C-H12 generic content URI is transient sourceRef only", () => {
  const outcome = nativeGenericResultToOutcome({
    status: "SUCCESS",
    sourceRef: "content://synthetic.documents/document/42",
    displayName: "synthetic.pdf",
    declaredMimeType: "application/pdf",
    sizeHint: 42,
  });
  assert(outcome.status === "SUCCESS", "generic source expected");
  assert(outcome.source.kind === "GENERIC_FILE", "generic kind");
  assert(outcome.source.sourceRef.startsWith("content://"), "content source");
  assert(!outcome.source.sourceRef.startsWith("evidence/v1/objects/"), "source URI is not storage_ref");
});

await test("G6C-C-H13 generic cancellation remains USER_CANCELLED", () => {
  assert(nativeGenericResultToOutcome({ status: "USER_CANCELLED" }).status === "USER_CANCELLED", "generic cancel");
});

await test("G6C-C-H14 generic unsupported URI scheme fails closed", () => {
  assert(nativeGenericResultToOutcome({ status: "SUCCESS", sourceRef: "https://example.invalid/x" }).status === "UNSUPPORTED_SOURCE", "generic scheme guard");
});

console.log(`Gate 6C-C device adapter host regression: ${passed} passed, ${failed} failed`);
if (failed !== 0) process.exitCode = 1;
