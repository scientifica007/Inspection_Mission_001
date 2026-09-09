import { readFileSync } from "node:fs";
import { diagnoseQ12Error, q12FatalQualificationCase } from "../src/gate6b/q12-diagnostics.ts";
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
function contains(text: string, fragment: string, label: string): void {
  if (!text.includes(fragment)) throw new Error(`${label}: missing ${fragment}`);
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
test("G6B-Q12-03 same-file mismatch is FAIL", () => { const o=baseline(); o.samePhysicalFile=false; eq(classifyQ12(o).status,"FAIL","status"); });
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

test("G6B-Q12-14 generic Error preserves its diagnostic message", () => {
  const diagnostic = diagnoseQ12Error(new Error("native rejection detail must survive"));
  contains(diagnostic.detail, '"name":"Error"', "error name");
  contains(diagnostic.detail, '"message":"native rejection detail must survive"', "error message");
  if (diagnostic.detail === "Error" || diagnostic.detail === '{"name":"Error"}') throw new Error("diagnostic collapsed to Error only");
});

test("G6B-Q12-15 Capacitor native-open rejection preserves stage/class/message/code", () => {
  const error = new Error("Gate6B Q12 native open failed; stage=open_database; exceptionClass=java.lang.UnsatisfiedLinkError; exceptionMessage=dlopen failed");
  Object.defineProperty(error, "code", { value: "G6B_Q12_NATIVE_OPEN_OPEN_DATABASE", enumerable: true });
  Object.defineProperty(error, "data", {
    value: {
      stage: "open_database",
      exceptionClass: "java.lang.UnsatisfiedLinkError",
      exceptionMessage: "dlopen failed",
    },
    enumerable: true,
  });
  const diagnostic = diagnoseQ12Error(error);
  eq(diagnostic.code, "G6B_Q12_NATIVE_OPEN_OPEN_DATABASE", "code");
  eq(diagnostic.nativeStage, "open_database", "native stage");
  eq(diagnostic.exceptionClass, "java.lang.UnsatisfiedLinkError", "exception class");
  eq(diagnostic.exceptionMessage, "dlopen failed", "exception message");
  contains(diagnostic.detail, '"message":"Gate6B Q12 native open failed; stage=open_database', "rejection message");
});

test("G6B-Q12-16 native-open diagnostic failure remains BLOCKED", () => {
  const decision = q12FatalQualificationCase(
    {
      status: "BLOCKED",
      stage: "native_open/open_database",
      detail: '{"name":"Error","message":"open failed","nativeStage":"open_database","exceptionClass":"java.lang.UnsatisfiedLinkError"}',
    },
    { samePhysicalFile: false, databaseBasename: "unknown", nativeClosed: true },
  );
  eq(decision.status, "BLOCKED", "status");
  contains(decision.evidence, "stage=native_open/open_database", "stage evidence");
  contains(decision.evidence, "java.lang.UnsatisfiedLinkError", "class evidence");
});

test("G6B-Q12-17 only BUSY or LOCKED qualify during the held lock", () => {
  const busyCase = baseline();
  busyCase.duringPrimaryLock = busy();
  eq(classifyQ12(busyCase).status, "PASS", "BUSY status");
  const lockedCase = baseline();
  lockedCase.duringPrimaryLock = locked();
  eq(classifyQ12(lockedCase).status, "PASS", "LOCKED status");
  const genericCase = baseline();
  genericCase.duringPrimaryLock = generic();
  eq(classifyQ12(genericCase).status, "BLOCKED", "ERROR status");
  const successCase = baseline();
  successCase.duringPrimaryLock = success();
  eq(classifyQ12(successCase).status, "FAIL", "SUCCESS-under-lock status");
});

const javaSource = readFileSync(
  new URL("../android/app/src/main/java/com/scientifica/inspection/gate6bproof/Gate6BCompetingWriterPlugin.java", import.meta.url),
  "utf8",
);

test("G6B-Q12-18 native open source exposes every required diagnostic stage", () => {
  for (const stage of [
    "validate_target",
    "load_sqlcipher",
    "open_database",
    "set_busy_timeout",
    "read_busy_timeout",
    "read_sqlite_version",
    "database_list",
    "same_file_check",
    "probe_table_read",
  ]) {
    contains(javaSource, `"${stage}"`, `stage ${stage}`);
  }
});

test("G6B-Q12-19 linkage failures are handled narrowly without catch(Throwable)", () => {
  contains(javaSource, "catch (LinkageError error)", "LinkageError catch");
  if (javaSource.includes("catch (Throwable")) throw new Error("broad Throwable catch is forbidden");
});

test("G6B-Q12-20 busy_timeout setter uses rawQuery transport and fails closed on nonzero values", () => {
  if (javaSource.includes('execSQL("PRAGMA busy_timeout = 0;")')) {
    throw new Error("busy_timeout setter must not use execSQL");
  }
  contains(javaSource, 'final long configuredBusyTimeout = scalarLong(opened, "PRAGMA busy_timeout = 0;");', "query-backed busy_timeout setter");
  contains(javaSource, 'if (configuredBusyTimeout != 0L)', "setter zero check");
  contains(javaSource, 'final long busyTimeout = scalarLong(opened, "PRAGMA busy_timeout;");', "independent busy_timeout readback");
  contains(javaSource, 'if (busyTimeout != 0L)', "readback zero check");
  contains(javaSource, 'db.rawQuery(sql, null)', "scalarLong rawQuery transport");
});

console.log(`\nTOTAL: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
else console.log("RESULT: SUCCESS (0 failures)");
