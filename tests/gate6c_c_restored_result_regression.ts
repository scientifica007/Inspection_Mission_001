import type { EvidenceSourceAcquisition } from "../src/application/evidence-contract.ts";
import {
  EvidenceRestoredResultCoordinator,
  type RestoredListenerEventLike,
} from "../src/device/evidence-restored-result.ts";

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
  listener: ((event: RestoredListenerEventLike) => void) | null = null;
  removeCalls = 0;
  async addListener(_name: "appRestoredResult", listener: (event: RestoredListenerEventLike) => void) {
    this.listener = listener;
    return { remove: async () => { this.removeCalls += 1; this.listener = null; } };
  }
}

async function take(acquisition: EvidenceSourceAcquisition) {
  return acquisition.takeCameraPhoto();
}

await test("G6C-C-R01 unrelated restored plugin event is ignored", () => {
  const coordinator = new EvidenceRestoredResultCoordinator(new FakeApp());
  const result = coordinator.acceptRestoredEvent({ pluginId: "Filesystem", methodName: "readFile", success: true, data: {} });
  assert(result.status === "IGNORED", "unrelated plugin must be ignored");
  assert(coordinator.getPending() === null, "unrelated event cannot create pending source");
});

await test("G6C-C-R02 deprecated restored Camera method is ignored", () => {
  const coordinator = new EvidenceRestoredResultCoordinator(new FakeApp());
  const result = coordinator.acceptRestoredEvent({ pluginId: "Camera", methodName: "getPhoto", success: true, data: { uri: "content://legacy" } });
  assert(result.status === "IGNORED", "deprecated getPhoto restoration is outside Gate 6C-C");
});

await test("G6C-C-R03 restored takePhoto becomes pending without owner information", () => {
  const coordinator = new EvidenceRestoredResultCoordinator(new FakeApp());
  const result = coordinator.acceptRestoredEvent({
    pluginId: "Camera",
    methodName: "takePhoto",
    success: true,
    data: { uri: "content://synthetic.camera/restored/1", metadata: { size: 300, format: "jpg" } },
  });
  assert(result.status === "PENDING", "restored photo should become pending");
  assert(result.pending.source.kind === "CAMERA_PHOTO", "camera source kind");
  assert(!("ownerKind" in result.pending) && !("ownerRef" in result.pending), "pending source must carry no owner intent");
  assert(coordinator.getPending()?.pendingId === result.pending.pendingId, "volatile pending slot");
});

await test("G6C-C-R04 pending restored source never auto-consumes", async () => {
  const coordinator = new EvidenceRestoredResultCoordinator(new FakeApp());
  const result = coordinator.acceptRestoredEvent({
    pluginId: "Camera", methodName: "takePhoto", success: true,
    data: { uri: "content://synthetic.camera/restored/2", metadata: { format: "jpeg" } },
  });
  assert(result.status === "PENDING", "pending expected");
  assert(coordinator.getPending() !== null, "pending remains until explicit adoption/discard");
});

await test("G6C-C-R05 explicit adoption yields one-shot existing EvidenceSourceAcquisition seam", async () => {
  const coordinator = new EvidenceRestoredResultCoordinator(new FakeApp());
  const result = coordinator.acceptRestoredEvent({
    pluginId: "Camera", methodName: "takePhoto", success: true,
    data: { uri: "content://synthetic.camera/restored/3", metadata: { format: "jpg" } },
  });
  assert(result.status === "PENDING", "pending expected");
  const acquisition = coordinator.adoptPending(result.pending.pendingId);
  assert(acquisition !== null, "explicit adoption should return an acquisition adapter");
  assert(coordinator.getPending() === null, "adoption consumes pending slot");
  const first = await take(acquisition);
  assert(first.status === "SUCCESS" && first.source.sourceRef.includes("restored/3"), "same restored source enters standard acquisition seam");
  assert((await take(acquisition)).status === "USER_CANCELLED", "one-shot source cannot silently replace later camera requests");
});

await test("G6C-C-R06 wrong pending id cannot adopt or consume source", () => {
  const coordinator = new EvidenceRestoredResultCoordinator(new FakeApp());
  const result = coordinator.acceptRestoredEvent({
    pluginId: "Camera", methodName: "takePhoto", success: true,
    data: { uri: "content://synthetic.camera/restored/4" },
  });
  assert(result.status === "PENDING", "pending expected");
  assert(coordinator.adoptPending("restored-wrong") === null, "wrong id refused");
  assert(coordinator.getPending() !== null, "pending remains untouched");
});

await test("G6C-C-R07 restored gallery accepts exactly one item", () => {
  const coordinator = new EvidenceRestoredResultCoordinator(new FakeApp());
  const result = coordinator.acceptRestoredEvent({
    pluginId: "Camera", methodName: "chooseFromGallery", success: true,
    data: { results: [{ uri: "content://synthetic.gallery/restored/1", metadata: { format: "mp4", size: 500 } }] },
  });
  assert(result.status === "PENDING", "single restored gallery source should become pending");
  assert(result.pending.source.kind === "GALLERY_MEDIA", "gallery kind");
});

await test("G6C-C-R08 restored multi-gallery result refuses domain batch expansion", () => {
  const coordinator = new EvidenceRestoredResultCoordinator(new FakeApp());
  const result = coordinator.acceptRestoredEvent({
    pluginId: "Camera", methodName: "chooseFromGallery", success: true,
    data: { results: [{ uri: "content://a" }, { uri: "content://b" }] },
  });
  assert(result.status === "FAILED" && result.outcome.status === "UNSUPPORTED_SOURCE", "multi-restored selection is unsupported for one Evidence op");
  assert(coordinator.getPending() === null, "no pending batch created");
});

await test("G6C-C-R09 unsuccessful restored result is classified and not pending", () => {
  const coordinator = new EvidenceRestoredResultCoordinator(new FakeApp());
  const result = coordinator.acceptRestoredEvent({
    pluginId: "Camera", methodName: "takePhoto", success: false, data: null,
    error: { code: "OS-PLUG-CAMR-0003", message: "camera denied" },
  });
  assert(result.status === "FAILED" && result.outcome.status === "PERMISSION_DENIED", "restored denial mapping");
  assert(coordinator.getPending() === null, "failed restored call cannot attach");
});

await test("G6C-C-R10 listener starts early, captures relevant event, and can stop", async () => {
  const app = new FakeApp();
  const coordinator = new EvidenceRestoredResultCoordinator(app);
  await coordinator.start();
  assert(app.listener !== null, "listener registered");
  app.listener!({ pluginId: "Camera", methodName: "takePhoto", success: true, data: { uri: "file:///synthetic/restored.jpg" } });
  assert(coordinator.getPending() !== null, "listener populates only volatile pending state");
  await coordinator.stop();
  assert(app.removeCalls === 1 && app.listener === null, "listener removed cleanly");
});

await test("G6C-C-R11 explicit discard removes volatile pending source only", () => {
  const coordinator = new EvidenceRestoredResultCoordinator(new FakeApp());
  const result = coordinator.acceptRestoredEvent({ pluginId: "Camera", methodName: "takePhoto", success: true, data: { uri: "file:///synthetic/discard.jpg" } });
  assert(result.status === "PENDING", "pending expected");
  assert(coordinator.discardPending(result.pending.pendingId), "explicit discard succeeds");
  assert(coordinator.getPending() === null, "pending cleared");
});

console.log(`Gate 6C-C restored-result host regression: ${passed} passed, ${failed} failed`);
if (failed !== 0) process.exitCode = 1;
