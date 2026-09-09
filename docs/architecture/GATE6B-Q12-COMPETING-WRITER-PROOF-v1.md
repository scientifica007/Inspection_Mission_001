# Gate 6B — Q12 Genuine Competing Writer Proof v1

> **Gate:** 6B — already open
>
> **Status:** `DIAGNOSTIC_HARDENED_PENDING_PHYSICAL_RETEST`
>
> **Branch:** `implementation/gate6b-android-runtime-proof-v1`
>
> **Purpose:** qualify only `Q12_COMPETING_WRITE`. This diagnostic boundary is not a product adapter and is not Gate 6C.

## 1. Why a native diagnostic writer is required

The pinned candidate is `@capacitor-community/sqlite@8.1.1`, upstream release commit `3f3f71606c8f292a3d6d841937bcfc5b5c45aeb5`.

Its Android `CapacitorSQLite.createConnection()` normalizes the ordinary connection dictionary key to `RW_<database>` and rejects a second RW entry for the same database. Therefore a second JavaScript wrapper through the same plugin cannot establish a genuinely independent writer. Q12 cannot be satisfied by Promise timing or by another wrapper around the same native connection.

## 2. Same native engine

The exact v8.1.1 Android build declares `net.zetetic:sqlcipher-android:4.17.0@aar`. The plugin's `Database` class imports `net.zetetic.database.sqlcipher.SQLiteDatabase`; for `no-encryption`, password remains the empty string.

Q12 writer B compiles directly against the **same** `sqlcipher-android:4.17.0@aar`. No Android framework SQLite engine, alternative SQL library, adapter replacement, or second persistence stack is introduced.

SQLCipher `v4.17.0` resolves to signed tag object `0725b962ffb60b00460b0e315bc632a543b399e7` and release commit `ae57a61052d8c41ce35cd48319b2f6f20f4de6bf`.

The app also declares `compileOnly 'androidx.sqlite:sqlite:2.4.0'` because SQLCipher's public `SQLiteDatabase` type implements AndroidX `SupportSQLiteDatabase`. This is compile-time support only; CI requires the only resolved SQLCipher runtime coordinate to be `4.17.0`.

## 3. A and B boundaries

A remains the existing `@capacitor-community/sqlite` → `CapacitorSqliteAdapter`. No Q12-specific transaction implementation is added to A. It still acquires the lock through `CapacitorSqliteAdapter.beginImmediate()` → `connection.execute("BEGIN IMMEDIATE;", false)` and releases through existing `rollback()`.

B is `Gate6BCompetingWriterPlugin`, a custom Capacitor Android diagnostic plugin. It owns a separate `net.zetetic.database.sqlcipher.SQLiteDatabase` instance and remains open across preflight, lock attempt, and post-release retry.

B does not implement `SqlAdapter`, is never imported by `src/application/**` or `src/bootstrap/**`, and must not become product database architecture.

## 4. Exact same-file proof

A executes `PRAGMA database_list;` and supplies the absolute `main` path to B. The path is transport-only and is not emitted in proof JSON.

B rejects the target unless all are true:

1. basename is exactly `inspection_gate6b_adapter_probe_v1SQLite.db`;
2. canonical parent is exactly this app's private database directory;
3. canonical path equals `Context.getDatabasePath(expectedBasename)`;
4. the file already exists and is a regular file.

B opens with `SQLiteDatabase.openDatabase(..., OPEN_READWRITE, ...)` **without** `CREATE_IF_NECESSARY`, using the empty password compatible with Gate-6B `no-encryption` mode. After open, B independently executes its own `PRAGMA database_list`; canonical same-file comparison is a distinct diagnostic stage.

A post-open `samePhysicalFile=false` remains a semantic contradiction and therefore FAIL. A failed/rejected native open cannot establish same-file identity and remains BLOCKED.

## 5. B preflight proves real independent write capability

Before A owns any explicit transaction:

1. B verifies `__g6b_probe` is readable.
2. B inserts synthetic marker `g6b-q12-preflight`.
3. A queries that marker and requires count=1.
4. A deletes it and requires one-row cleanup.

A later during-lock failure cannot therefore be accepted merely because B was incapable of opening or writing the database. B also returns its own `sqlite_version()`; the classifier requires it to equal A's recorded version.

## 6. Bounded native lock behavior

B executes `PRAGMA busy_timeout = 0;` and reads the pragma back. Q12 PASS requires the effective value to be exactly zero milliseconds.

No JavaScript Promise timeout is used. No ExecutorService, background worker, delayed writer, or orphan thread exists. Each plugin method performs one synchronous native SQLite call and resolves only after that call returns.

## 7. Native BUSY/LOCKED classification

In SQLCipher Android `4.17.0` JNI exception mapping:

- `SQLITE_BUSY` → `android.database.sqlite.SQLiteDatabaseLockedException`;
- `SQLITE_LOCKED` → `android.database.sqlite.SQLiteTableLockedException`.

B classifies only those concrete outcomes as `BUSY`/`LOCKED`, recording result code 5/6 and the concrete exception class. Any other `SQLiteException` is `ERROR` and causes Q12 to remain BLOCKED rather than PASS.

## 8. Exact differential sequence

1. A and B point to the same validated physical probe DB.
2. B preflight write succeeds and A reads it.
3. A calls existing `beginImmediate()`.
4. While A still owns the transaction, B attempts INSERT of `g6b-q12-lock-marker`.
5. The native call must return concrete BUSY/LOCKED.
6. While A still owns the transaction, A requires marker count=0.
7. A releases using existing `rollback()`.
8. B retries the **same marker INSERT**.
9. It must succeed.
10. A requires marker count=1.
11. A deletes the marker.
12. B closes deterministically.

No step releases A merely to rescue B. B's zero busy timeout makes the native lock attempt finite by construction.

## 9. Verdict rules — unchanged

Q12 = PASS only when the whole differential sequence is proven, including same file, same engine, preflight, concrete native lock classification, absence under lock, successful post-release retry, cleanup, and native close.

Q12 = FAIL for a semantic contradiction, including a **post-open** same-physical-file mismatch, B writing while A owns `BEGIN IMMEDIATE`, locked marker visibility, primary transaction acquisition/release contradiction, or inability to write after release after a valid preflight.

Q12 = BLOCKED for qualification limitations, including inability to validate/open B before same-file observation is established, native preflight failure, engine mismatch, generic/unclassifiable native exception, unexpected busy policy, or incomplete cleanup/close.

## 10. Physical result on `c3cc890...`

A real Android **Run Adapter Qualification** was executed on:

`c3cc890b35d7f9612214559f83d8091f98e96a68`

Overall result: `BLOCKED`. Q1→Q11 remained PASS. Q8 remained exact canonical PASS: 15 tables / 44 triggers / 1 view / 24 indexes / `integrity_check=ok`. Q9 remained PASS: 24 definitions, second bootstrap 24 no-ops, P0=20, P1=4, allowed_values=48.

Q12 physical evidence was:

```text
stage=native_open
detail=Error
samePhysicalFile=false
databaseBasename=unknown
nativeClosed=true
```

This does **not** establish a lock failure or adapter-locking contradiction. B did not reach the real differential lock test. `samePhysicalFile=false` was the unestablished/default observation because native `open()` rejected; it was not a successful native-open same-file comparison.

The root cause is **NOT YET KNOWN**. The previous TypeScript path reduced JavaScript `Error` to `error.name`, and the native `open()` wrapped multiple operations in one catch. Therefore the physical run cannot distinguish validation, native-library linkage, database open, pragma setup/readback, version readback, database-list, same-file comparison, or probe-table readability failure.

No SQLCipher defect, path defect, locking defect, or primary-adapter defect is claimed from this evidence.

## 11. Diagnostic hardening after the blocked run

The correction is instrumentation-only.

### TypeScript rejection preservation

`src/gate6b/q12-diagnostics.ts` preserves at minimum:

- JavaScript Error `name`;
- JavaScript Error `message`;
- Capacitor `code` when present;
- `data.stage`, `data.exceptionClass`, and `data.exceptionMessage` when present and type-safe.

For native-open rejection it also derives the stage from the stage-specific Capacitor error code if `data` is unavailable. Q12 evidence therefore no longer collapses to `detail=Error`.

### Native open stages

`Gate6BCompetingWriterPlugin.open()` now reports one stable stage before each operation:

- `validate_target`;
- `load_sqlcipher`;
- `open_database`;
- `set_busy_timeout`;
- `read_busy_timeout`;
- `read_sqlite_version`;
- `database_list`;
- `same_file_check`;
- `probe_table_read`.

A native-open rejection exposes deterministic stage, exception class, and sanitized exception message. The supplied app-private DB path is redacted from exception text before it is returned.

### Linkage failures

`LinkageError` is handled explicitly so failures such as `UnsatisfiedLinkError` are diagnosable. There is no broad `catch(Throwable)`.

A linkage/open/validation failure remains BLOCKED. It cannot produce Q12 PASS.

## 12. Host regression

`tests/gate6b_q12_regression.ts` baseline after diagnostic hardening: **19 / 0**.

In addition to the original classifier attacks, it proves:

- generic `Error` retains its message;
- Capacitor native-open rejection retains stage/class/message/code;
- native-open failure remains BLOCKED;
- PASS criteria are unchanged;
- post-open same-file contradiction remains FAIL;
- BUSY and LOCKED are the only accepted during-lock outcomes;
- all nine native-open stages exist in the Java source;
- `LinkageError` is caught explicitly and `catch(Throwable)` is absent.

This host suite cannot establish Android lock semantics.

## 13. Existing physical evidence retained

Physical evidence on corrected SHA `89d405d6254108ce735125638ccdb2fb2e67c568` remains preserved: Q1-Q11 PASS, Application-Core PASS, and clean real Force Stop restart A→B PASS. The historical pre-correction Q8 failure and restart negative control also remain preserved.

The `c3cc890...` Q12 BLOCKED result is retained as evidence of an **undiagnosed native-open blocker**, not reclassified after the fact.

## 14. Next action

After green CI and APK generation for this diagnostic hardening, the only requested physical action is:

**Run Adapter Qualification**

on the new APK.

Do not request Application-Core Proof or Restart Phase A/B in this step.

Gate 6B remains **IN_PROGRESS**, `closure_authorized=false`. Gate 6C remains **NOT_STARTED**.
