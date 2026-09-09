import { classifyQ12, Q12_NATIVE_ENGINE, type Q12Observation, type Q12NativeWriteResult } from "../src/gate6b/q12-qualification.ts";

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void): void {
  try { fn(); passed += 1; console.log(`[PASS] ${name}`); }
  catch (error) { failed += 1; console.error(`[FAIL] ${name}: ${error instanceof Error ? error.message : String(error)}`); }
}
function eq(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
}
const success = (): Q12NativeWriteResult => ({ outcome: "SUCCESS", exceptionClass: null, sqliteResultCode: null });
const busy = (): Q12NativeWriteResult => ({ outcome: "BUSY", exceptionClass: "android.database.sqlite.SQLiteDatabaseLockedException", sqliteResultCode: 5 });
const locked = (): Q12NativeWriteResult => ({ outcome: "LOCKED", exceptionClass: "android.database.sqlite.SQLiteTableLockedException", sqliteResultCode: 6 });
const generic = (): Q12NativeWriteResult => ({ outcome: "ERROR", exceptionClass: "android.database.sqlite.SQLiteException", sqliteResultCode: null });
function baseline(): Q12Observation {
  return {
    samePhysicalFile: true,
    databaseBasename: "inspection_gate6b_adapter_probe_v1SQLite.db",
    nativeEngine: Q12_NATIVE_ENGINE,
    expectedNativeEngine: Q12_NATIVE_ENGINE,
    primarySqliteVersion: "3.53.3",
    competingSqliteVersion: "3.53.3",
    busyTimeoutMs: 0,
    preflightWrite: success(),
    preflightMarkerCountSeenByPrimary: 1,
    primaryBeginImmediate: true,
    duringPrimaryLock: busy(),
    lockedMarkerCount: 0,
    primaryRelease: true,
    postReleaseWrite: success(),
    postReleaseMarkerCount: 1,
    cleanupComplete: true,
    nativeClosed: true,
  };
}

test("G6B-Q12-01 complete differential proof can PASS", () => eq(classifyQ12(baseline()).status, "PASS", "status"));
test("G6B-Q12-02 generic native error remains BLOCKED", () => { const o=baseline(); o.duringPrimaryLock=generic(); eq(classifyQ12(o).status,"BLOCKED","status"); });
test("G6B-Q12-03 same-file mismatch is BLOCKED", () => { const o=baseline(); o.samePhysicalFile=false; eq(classifyQ12(o).status,"BLOCKED","status"); });
test("G6B-Q12-04 preflight write failure cannot PASS", () => { const o=baseline(); o.preflightWrite=generic(); eq(classifyQ12(o).status,"BLOCKED","status"); });
test("G6B-Q12-05 writer success during primary lock is FAIL", () => { const o=baseline(); o.duringPrimaryLock=success(); eq(classifyQ12(o).status,"FAIL","status"); });
test("G6B-Q12-06 locked marker appearing during A lock is FAIL", () => { const o=baseline(); o.lockedMarkerCount=1; eq(classifyQ12(o).status,"FAIL","status"); });
test("G6B-Q12-07 post-release write failure is FAIL", () => { const o=baseline(); o.postReleaseWrite=busy(); eq(classifyQ12(o).status,"FAIL","status"); });
test("G6B-Q12-08 post-release cardinality mismatch is FAIL", () => { const o=baseline(); o.postReleaseMarkerCount=0; eq(classifyQ12(o).status,"FAIL","status"); });
test("G6B-Q12-09 engine mismatch is BLOCKED", () => { const o=baseline(); o.nativeEngine="another-engine"; eq(classifyQ12(o).status,"BLOCKED","status"); });
test("G6B-Q12-10 unclosed native resource is BLOCKED", () => { const o=baseline(); o.nativeClosed=false; eq(classifyQ12(o).status,"BLOCKED","status"); });
test("G6B-Q12-11 SQLITE_LOCKED classification also qualifies", () => { const o=baseline(); o.duringPrimaryLock=locked(); eq(classifyQ12(o).status,"PASS","status"); });
test("G6B-Q12-12 nonzero busy timeout is BLOCKED", () => { const o=baseline(); o.busyTimeoutMs=50; eq(classifyQ12(o).status,"BLOCKED","status"); });
test("G6B-Q12-13 incomplete marker cleanup is BLOCKED", () => { const o=baseline(); o.cleanupComplete=false; eq(classifyQ12(o).status,"BLOCKED","status"); });

console.log(`\nTOTAL: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
else console.log("RESULT: SUCCESS (0 failures)");
