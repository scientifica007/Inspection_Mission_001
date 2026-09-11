import { readFileSync } from "node:fs";
import {
  nativeGalleryResultToOutcome,
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

const acquisitionSource = readFileSync(new URL("../src/device/capacitor-evidence-acquisition.ts", import.meta.url), "utf8");
const nativeSeamSource = readFileSync(new URL("../src/device/gate6c-evidence-native.ts", import.meta.url), "utf8");
const nativeJavaSource = readFileSync(new URL("../android/app/src/main/java/com/scientifica/inspection/gate6bproof/Gate6CEvidencePlugin.java", import.meta.url), "utf8");
const manifestSource = readFileSync(new URL("../android/app/src/main/AndroidManifest.xml", import.meta.url), "utf8");

function methodSlice(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert(from >= 0, `missing method marker: ${start}`);
  assert(to > from, `missing end marker: ${end}`);
  return source.slice(from, to);
}

await test("G01 native Gallery SUCCESS content URI maps to GALLERY_MEDIA", () => {
  const outcome = nativeGalleryResultToOutcome({
    status: "SUCCESS",
    sourceRef: "content://synthetic.gallery/item/1",
  });
  assert(outcome.status === "SUCCESS", "content URI must map successfully");
  assert(outcome.source.kind === "GALLERY_MEDIA", "kind must be GALLERY_MEDIA");
  assert(outcome.source.sourceRef === "content://synthetic.gallery/item/1", "native URI must be retained");
});

await test("G02 native Gallery preserves safe descriptive metadata without invented capturedAt", () => {
  const outcome = nativeGalleryResultToOutcome({
    status: "SUCCESS",
    sourceRef: "file:///synthetic/gallery/video.mp4",
    displayName: "qualification-video.mp4",
    declaredMimeType: "video/mp4",
    sizeHint: 123456,
  });
  assert(outcome.status === "SUCCESS", "file URI must map successfully");
  assert(outcome.source.displayName === "qualification-video.mp4", "displayName preserved");
  assert(outcome.source.declaredMimeType === "video/mp4", "MIME preserved");
  assert(outcome.source.sizeHint === 123456, "sizeHint preserved");
  assert(!("capturedAt" in outcome.source), "native Gallery mapping must not invent capturedAt");
});

await test("G03 missing or blank native Gallery sourceRef fails SOURCE_UNAVAILABLE", () => {
  assert(nativeGalleryResultToOutcome({ status: "SUCCESS" }).status === "SOURCE_UNAVAILABLE", "missing sourceRef must fail closed");
  assert(nativeGalleryResultToOutcome({ status: "SUCCESS", sourceRef: "   " }).status === "SOURCE_UNAVAILABLE", "blank sourceRef must fail closed");
});

await test("G04 unsupported native Gallery URI scheme fails UNSUPPORTED_SOURCE", () => {
  const outcome = nativeGalleryResultToOutcome({ status: "SUCCESS", sourceRef: "https://example.invalid/gallery.jpg" });
  assert(outcome.status === "UNSUPPORTED_SOURCE", "unsupported scheme must fail closed");
});

await test("G05 native Gallery USER_CANCELLED is preserved", () => {
  assert(nativeGalleryResultToOutcome({ status: "USER_CANCELLED" }).status === "USER_CANCELLED", "cancel status must remain cancel");
});

await test("G06 native Gallery PERMISSION_DENIED is preserved", () => {
  assert(nativeGalleryResultToOutcome({ status: "PERMISSION_DENIED", detail: "denied" }).status === "PERMISSION_DENIED", "permission denial must remain permission denial");
});

await test("G07 production chooseGalleryMedia routes through project-owned native seam", () => {
  const galleryMethod = methodSlice(acquisitionSource, "async chooseGalleryMedia", "async chooseGenericFile");
  assert(galleryMethod.includes("this.native.chooseGalleryMedia()"), "production Gallery must invoke native chooseGalleryMedia");
  assert(galleryMethod.includes("nativeGalleryResultToOutcome"), "production Gallery must use native Gallery mapping");
  assert(nativeSeamSource.includes("chooseGalleryMedia(): Promise<NativePickerAcquisitionResult>"), "native seam must expose chooseGalleryMedia");
});

await test("G08 production Gallery route contains no Camera gallery API Base64 or webPath", () => {
  const galleryMethod = methodSlice(acquisitionSource, "async chooseGalleryMedia", "async chooseGenericFile");
  assert(!galleryMethod.includes("Camera.chooseFromGallery"), "IonCamera chooseFromGallery must not be used");
  assert(!galleryMethod.includes("Camera.pickImages"), "Camera pickImages must not be used");
  assert(!galleryMethod.includes("Base64"), "Gallery must not use Base64");
  assert(!galleryMethod.includes("webPath"), "Gallery must not use webPath");
});

await test("G09 Android Gallery intent is ACTION_OPEN_DOCUMENT openable single media read-only", () => {
  const intentMethod = methodSlice(nativeJavaSource, "static Intent buildGalleryMediaIntent()", "static Intent buildGenericFileIntent()");
  assert(intentMethod.includes("Intent.ACTION_OPEN_DOCUMENT"), "ACTION_OPEN_DOCUMENT required");
  assert(intentMethod.includes("Intent.CATEGORY_OPENABLE"), "CATEGORY_OPENABLE required");
  assert(intentMethod.includes("Intent.EXTRA_ALLOW_MULTIPLE, false"), "single selection required");
  assert(intentMethod.includes('new String[]{ "image/*", "video/*" }'), "image/video MIME filters required");
  assert(intentMethod.includes("Intent.FLAG_GRANT_READ_URI_PERMISSION"), "read URI grant required");
  assert(!intentMethod.includes("FLAG_GRANT_WRITE_URI_PERMISSION"), "write URI grant forbidden");
  assert(!intentMethod.includes("FLAG_GRANT_PERSISTABLE_URI_PERMISSION"), "persistable grant not required");
});

await test("G10 native Gallery callback uses ContentResolver URI access and no raw DATA path", () => {
  const pickerResult = methodSlice(nativeJavaSource, "private void resolvePickerResult", "@PluginMethod\n    public void allocate");
  assert(pickerResult.includes("resolver.openInputStream(uri)"), "selected URI must be opened through ContentResolver");
  assert(pickerResult.includes("ContentResolver.SCHEME_CONTENT"), "content scheme must be accepted");
  assert(pickerResult.includes("ContentResolver.SCHEME_FILE"), "file scheme must be accepted");
  assert(!/MediaStore\.MediaColumns\.DATA|MediaStore\.Images\.Media\.DATA|[\"']_data[\"']/.test(nativeJavaSource), "raw DATA column must not be queried");
  assert(!nativeJavaSource.includes("ExifInterface"), "native Gallery picker must not EXIF-process an external raw path");
});

await test("G11 manifest has no broad external-storage permissions", () => {
  assert(!manifestSource.includes("android.permission.READ_EXTERNAL_STORAGE"), "READ_EXTERNAL_STORAGE must not be added");
  assert(!manifestSource.includes("android.permission.WRITE_EXTERNAL_STORAGE"), "WRITE_EXTERNAL_STORAGE must not be added");
  assert(!manifestSource.includes("android.permission.MANAGE_EXTERNAL_STORAGE"), "MANAGE_EXTERNAL_STORAGE must not be added");
});

await test("G12 Camera acquisition remains exact legacy getPhoto URI correction", () => {
  const cameraMethod = methodSlice(acquisitionSource, "async takeCameraPhoto", "async chooseGalleryMedia");
  for (const expected of [
    "Camera.getPhoto({",
    "source: CameraSource.Camera",
    "resultType: CameraResultType.Uri",
    "quality: 100",
    "saveToGallery: false",
    "allowEditing: false",
    "correctOrientation: true",
  ]) assert(cameraMethod.includes(expected), `Camera correction missing ${expected}`);
  assert(!cameraMethod.includes("Camera.takePhoto("), "takePhoto must remain absent from corrected Camera capture");
});

await test("G13 Generic picker semantics remain project-owned ACTION_OPEN_DOCUMENT", () => {
  const outcome = nativeGenericResultToOutcome({
    status: "SUCCESS",
    sourceRef: "content://synthetic.documents/generic/1",
    displayName: "generic.bin",
    declaredMimeType: "application/octet-stream",
    sizeHint: 99,
  });
  assert(outcome.status === "SUCCESS" && outcome.source.kind === "GENERIC_FILE", "generic mapping must remain GENERIC_FILE");
  const genericMethod = methodSlice(acquisitionSource, "async chooseGenericFile", "\n}");
  assert(genericMethod.includes("this.native.chooseGenericFile()"), "generic picker must remain on native seam");
  const genericIntent = nativeJavaSource.slice(nativeJavaSource.indexOf("static Intent buildGenericFileIntent()"));
  assert(genericIntent.includes("Intent.ACTION_OPEN_DOCUMENT"), "generic ACTION_OPEN_DOCUMENT must remain");
  assert(genericIntent.includes('intent.setType("*/*")'), "generic all-file MIME behavior must remain");
});

await test("G14 native Gallery picker does not write Evidence SQL or create Evidence directly", () => {
  const galleryArea = nativeJavaSource.slice(nativeJavaSource.indexOf("public void chooseGalleryMedia"), nativeJavaSource.indexOf("public void allocate"));
  assert(!/INSERT\s+INTO\s+evidence/i.test(galleryArea), "native picker must not insert Evidence SQL");
  assert(!galleryArea.includes("EvidenceService"), "native picker must not instantiate EvidenceService");
  assert(!galleryArea.includes("Gate6CEvidenceStore"), "native picker must not publish Evidence directly");
});

await test("G15 native Gallery picker proves readability without whole-object buffering", () => {
  const pickerResult = methodSlice(nativeJavaSource, "private void resolvePickerResult", "@PluginMethod\n    public void allocate");
  assert(pickerResult.includes("try (InputStream input = resolver.openInputStream(uri))"), "readability probe must use stream lifetime");
  assert(!pickerResult.includes("readAllBytes"), "whole-object readAllBytes forbidden");
  assert(!pickerResult.includes("ByteArrayOutputStream"), "whole-object ByteArrayOutputStream forbidden");
  assert(!pickerResult.includes("byte[]"), "picker callback must not allocate binary byte arrays");
  assert(!pickerResult.includes("input.read("), "picker callback should not consume selected binary beyond opening the stream");
});

console.log(`Gate 6C-D Gallery native picker correction regression: ${passed} passed, ${failed} failed`);
if (failed !== 0) process.exitCode = 1;
