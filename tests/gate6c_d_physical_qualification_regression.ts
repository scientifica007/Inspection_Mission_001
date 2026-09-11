import assert from "node:assert/strict";
import {
  GATE6CD_PHYSICAL_SCENARIO_IDS,
  buildGate6CDQualificationResult,
  canonicalGate6CDQualificationJson,
  expectedFailureSatisfied,
  type Gate6CDQualificationResult,
} from "../src/gate6c/physical-qualification-model.ts";

let passed = 0;
let failed = 0;

async function test(name: string, work: () => void | Promise<void>) {
  try {
    await work();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}`);
    console.error(error);
  }
}

const runtime = { platform: "android", native: true, android: true } as const;
const sha = "0123456789abcdef0123456789abcdef01234567";

await test("Q01-Q13 scenario identifiers are stable and unique", () => {
  assert.deepEqual(GATE6CD_PHYSICAL_SCENARIO_IDS, [
    "G6CD-Q01-CAMERA-COMMIT",
    "G6CD-Q02-GALLERY-COMMIT",
    "G6CD-Q03-GENERIC-FILE-COMMIT",
    "G6CD-Q04-CANCEL",
    "G6CD-Q05-PERMISSION-DENIED",
    "G6CD-Q06-SOURCE-LOSS",
    "G6CD-Q07-RESTORED-CAMERA",
    "G6CD-Q08-RESTART-RECONCILIATION",
    "G6CD-Q09-ORPHAN-CLEANUP",
    "G6CD-Q10-MISSING-FILE",
    "G6CD-Q11-LARGE-FILE",
    "G6CD-Q12-WRITE-FAILURE",
    "G6CD-Q13-RETRIEVAL-AFTER-RESTART",
  ]);
  assert.equal(new Set(GATE6CD_PHYSICAL_SCENARIO_IDS).size, 13);
});

await test("result builder emits required machine-readable defaults", () => {
  const result = buildGate6CDQualificationResult({
    scenarioId: "G6CD-Q01-CAMERA-COMMIT",
    testedGitSha: sha,
    runtime,
    status: "PASS",
  });
  assert.equal(result.schemaVersion, "gate6c-d-physical-evidence-qualification-v1");
  assert.equal(result.testedGitSha, sha);
  assert.equal(result.sqliteRowCount, 0);
  assert.equal(result.resolveResult.status, "NOT_RUN");
  assert.equal(result.hashVerificationResult, "NOT_RUN");
});

await test("canonical JSON sorts keys deterministically", () => {
  const result = buildGate6CDQualificationResult({
    scenarioId: "G6CD-Q03-GENERIC-FILE-COMMIT",
    testedGitSha: sha,
    runtime,
    status: "PASS",
    details: { zebra: 1, alpha: true },
  });
  const first = canonicalGate6CDQualificationJson(result);
  const second = canonicalGate6CDQualificationJson(result);
  assert.equal(first, second);
  assert.ok(first.indexOf('"alpha"') < first.indexOf('"zebra"'));
});

await test("canonical JSON refuses raw content URI", () => {
  const result = buildGate6CDQualificationResult({
    scenarioId: "G6CD-Q02-GALLERY-COMMIT",
    testedGitSha: sha,
    runtime,
    status: "BLOCKED",
    details: { leaked: "content://provider/private/item/7" },
  });
  assert.throws(() => canonicalGate6CDQualificationJson(result), /raw source\/handle URI/);
});

await test("canonical JSON refuses sourceRef field even when value is opaque", () => {
  const result = buildGate6CDQualificationResult({
    scenarioId: "G6CD-Q06-SOURCE-LOSS",
    testedGitSha: sha,
    runtime,
    status: "BLOCKED",
  }) as Gate6CDQualificationResult & { sourceRef?: string };
  result.sourceRef = "opaque-provider-token";
  assert.throws(() => canonicalGate6CDQualificationJson(result), /sensitive field 'sourceRef'/);
});

await test("expected source-loss failure requires exact code and zero row delta", () => {
  assert.equal(expectedFailureSatisfied("E_EVIDENCE_SOURCE_UNAVAILABLE", "E_EVIDENCE_SOURCE_UNAVAILABLE", 3, 3), true);
  assert.equal(expectedFailureSatisfied("E_EVIDENCE_SOURCE_UNAVAILABLE", "E_EVIDENCE_STORAGE_WRITE_FAILED", 3, 3), false);
  assert.equal(expectedFailureSatisfied("E_EVIDENCE_SOURCE_UNAVAILABLE", "E_EVIDENCE_SOURCE_UNAVAILABLE", 3, 4), false);
});

await test("write-failure qualification cannot pass with an Evidence row delta", () => {
  assert.equal(expectedFailureSatisfied("E_EVIDENCE_STORAGE_WRITE_FAILED", "E_EVIDENCE_STORAGE_WRITE_FAILED", 0, 0), true);
  assert.equal(expectedFailureSatisfied("E_EVIDENCE_STORAGE_WRITE_FAILED", "E_EVIDENCE_STORAGE_WRITE_FAILED", 0, 1), false);
});

await test("result can distinguish write failure from literal ENOSPC", () => {
  const result = buildGate6CDQualificationResult({
    scenarioId: "G6CD-Q12-WRITE-FAILURE",
    testedGitSha: sha,
    runtime,
    status: "PASS",
    failureStage: "evidence_create",
    failureCode: "E_EVIDENCE_STORAGE_WRITE_FAILED",
    details: { writeFailureVariant: "REAL_DEVICE_WRITE_FAILURE", enospcProven: false },
  });
  const json = canonicalGate6CDQualificationJson(result);
  assert.match(json, /REAL_DEVICE_WRITE_FAILURE/);
  assert.match(json, /"enospcProven": false/);
});

await test("result records only resolve scheme rather than raw handle", () => {
  const result = buildGate6CDQualificationResult({
    scenarioId: "G6CD-Q13-RETRIEVAL-AFTER-RESTART",
    testedGitSha: sha,
    runtime,
    status: "PASS",
    resolveResult: { status: "RESOLVED", handleScheme: "content" },
  });
  const json = canonicalGate6CDQualificationJson(result);
  assert.match(json, /"handleScheme": "content"/);
  assert.doesNotMatch(json, /content:\/\//);
});

console.log(`Gate 6C-D physical qualification model regression: ${passed} passed, ${failed} failed`);
if (failed !== 0) process.exitCode = 1;
