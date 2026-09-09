# Gate 6B — Q12 Genuine Competing Writer Proof v1

> **Gate:** 6B — `CLOSED / MERGED`
>
> **Q12 status:** `PHYSICAL_PASS_REVIEW_ACCEPTED`
>
> **Implementation branch:** `implementation/gate6b-android-runtime-proof-v1`
>
> **Reviewed branch head:** `04dcf001e5494c38258c7112619ea1d508af694c`
>
> **PR:** `#17`
>
> **Merge SHA:** `0905c6111269d62480e7ccadc31786bef29f3c51`
>
> **Purpose:** record the genuine `Q12_COMPETING_WRITE` qualification. This diagnostic boundary is not a product adapter and is not Gate 6C.

## 1. Why a native diagnostic writer was required

The pinned candidate is `@capacitor-community/sqlite@8.1.1`, upstream release commit `3f3f71606c8f292a3d6d841937bcfc5b5c45aeb5`.

Its Android connection dictionary normalizes an ordinary RW connection to `RW_<database>` and rejects a second RW entry for the same database. Therefore a second JavaScript wrapper through the same plugin could not establish a genuinely independent writer. Q12 could not be satisfied by Promise timing or another wrapper around the same native connection.

## 2. Same native engine

The exact v8.1.1 Android build declares `net.zetetic:sqlcipher-android:4.17.0@aar`, and the plugin database layer imports `net.zetetic.database.sqlcipher.SQLiteDatabase`.

Q12 writer B compiles directly against the **same** SQLCipher `4.17.0`. No Android framework SQLite engine, alternative SQL library, adapter replacement, or second persistence stack is introduced.

The app also declares `compileOnly 'androidx.sqlite:sqlite:2.4.0'` solely for compile-time `SupportSQLiteDatabase` type visibility. CI requires the only resolved SQLCipher runtime coordinate to remain `4.17.0`.

## 3. A and B boundaries

A remains the existing `@capacitor-community/sqlite` → `CapacitorSqliteAdapter`. It acquires the lock through `CapacitorSqliteAdapter.beginImmediate()` → `connection.execute("BEGIN IMMEDIATE;", false)` and releases through existing `rollback()`.

B is `Gate6BCompetingWriterPlugin`, a custom Capacitor Android diagnostic plugin. It owns a separate `net.zetetic.database.sqlcipher.SQLiteDatabase` instance and remains open across preflight, lock attempt, and post-release retry.

B does not implement `SqlAdapter`, is never imported by `src/application/**` or `src/bootstrap/**`, and is not product database architecture.

## 4. Exact same-file proof

A executes `PRAGMA database_list;` and supplies the absolute `main` path to B. The path is transport-only and is not emitted in proof JSON.

B rejects the target unless all are true:

1. basename is exactly `inspection_gate6b_adapter_probe_v1SQLite.db`;
2. canonical parent is exactly this app's private database directory;
3. canonical path equals `Context.getDatabasePath(expectedBasename)`;
4. the file already exists and is a regular file.

B opens with `SQLiteDatabase.openDatabase(..., OPEN_READWRITE, ...)` without `CREATE_IF_NECESSARY`, using the empty password compatible with Gate-6B no-encryption mode. After open, B independently executes its own `PRAGMA database_list` and verifies canonical same-file identity.

A post-open `samePhysicalFile=false` is FAIL. A failed/rejected native open cannot establish same-file identity and is BLOCKED.

## 5. B preflight proves independent write capability

Before A owns any explicit transaction:

1. B verifies `__g6b_probe` is readable.
2. B inserts synthetic marker `g6b-q12-preflight`.
3. A queries that marker and requires count=1.
4. A deletes it and requires one-row cleanup.

B also returns its own `sqlite_version()`; the classifier requires it to equal A's recorded version.

## 6. Bounded native lock behavior

B requires an effective native busy timeout of exactly zero milliseconds.

The setter is executed as a row-producing PRAGMA through `scalarLong()` → `rawQuery()` and the returned row is stepped/read. The setter-returned value must be `0`, and an independent `PRAGMA busy_timeout;` readback must also be `0`.

No JavaScript Promise timeout, ExecutorService, background worker, delayed writer, or orphan thread is used.

## 7. Native BUSY/LOCKED classification

In SQLCipher Android `4.17.0` JNI exception mapping:

- `SQLITE_BUSY` → `android.database.sqlite.SQLiteDatabaseLockedException`;
- `SQLITE_LOCKED` → `android.database.sqlite.SQLiteTableLockedException`.

B classifies only those concrete outcomes as `BUSY`/`LOCKED`, recording result code 5/6 and the concrete exception class. Any other `SQLiteException` is `ERROR` and cannot produce PASS.

## 8. Exact differential sequence

1. A and B point to the same validated physical probe DB.
2. B preflight write succeeds and A reads it.
3. A calls existing `beginImmediate()`.
4. While A still owns the transaction, B attempts INSERT of `g6b-q12-lock-marker`.
5. The native call must return concrete BUSY/LOCKED.
6. While A still owns the transaction, A requires marker count=0.
7. A releases using existing `rollback()`.
8. B retries the same marker INSERT.
9. It must succeed.
10. A requires marker count=1.
11. A deletes the marker.
12. B closes deterministically.

No step releases A merely to rescue B.

## 9. Verdict rules — unchanged

Q12 = PASS only when the whole differential sequence is proven, including same file, same engine, preflight, concrete native lock classification, absence under lock, successful post-release retry, cleanup, and native close.

Q12 = FAIL for a semantic contradiction, including a post-open same-physical-file mismatch, B writing while A owns `BEGIN IMMEDIATE`, locked marker visibility, primary transaction acquisition/release contradiction, or inability to write after release after a valid preflight.

Q12 = BLOCKED for qualification limitations, including inability to validate/open B before same-file observation is established, native preflight failure, engine mismatch, generic/unclassifiable native exception, unexpected busy policy, or incomplete cleanup/close.

## 10. Historical physical result on `c3cc890...`

A physical run on `c3cc890b35d7f9612214559f83d8091f98e96a68` kept Q1→Q11 PASS but Q12 BLOCKED at `native_open`. The instrumentation then available collapsed rejection detail, so the root cause for that historical run remained unknown. This result remains historical and is not reclassified.

## 11. Historical physical result on `7ebe780...`

A real Android Adapter Qualification on `7ebe780b1caffeb1a9240ff4010e5483e1c70b7b` returned Q12=`BLOCKED` at `native_open/set_busy_timeout` while Q1→Q11 remained PASS.

Exact evidence included `android.database.sqlite.SQLiteException` with message `Queries can be performed using SQLiteDatabase query or rawQuery methods only.` The differential lock test was not reached and `samePhysicalFile=false` was only the unestablished default.

The proven cause was the Q12 diagnostic writer transporting the row-producing `PRAGMA busy_timeout = 0;` through `execSQL`; this was a diagnostic transport defect, not evidence of SQLCipher incompatibility, primary adapter failure, same-file failure, `BEGIN IMMEDIATE` failure, or lock-semantics failure.

## 12. Narrow busy_timeout transport correction

Only the setter transport was corrected. `PRAGMA busy_timeout = 0;` runs through `scalarLong()` → `db.rawQuery(sql, null)` and the returned row is read. The setter-returned value and independent readback both must equal `0`.

The diagnostic stages remain:

- `validate_target`;
- `load_sqlcipher`;
- `open_database`;
- `set_busy_timeout`;
- `read_busy_timeout`;
- `read_sqlite_version`;
- `database_list`;
- `same_file_check`;
- `probe_table_read`.

No Q12 classifier or lock semantics were changed.

## 13. Host regression

`tests/gate6b_q12_regression.ts` baseline: **20 / 0**.

It proves fail-closed Q12 classification, diagnostic preservation, BUSY/LOCKED-only acceptance, source staging, `LinkageError` handling without `catch(Throwable)`, and query/rawQuery-backed zero busy-timeout setter/readback.

The host suite does not itself establish Android lock semantics.

## 14. Accepted physical PASS on `87135cfe...`

A real Android Adapter Qualification executed on:

`87135cfe80ae3de79a34e941828249fc6889139c`

was independently reviewed and accepted with `overallResult=PASS`.

External accepted evidence folder:

`https://drive.google.com/drive/folders/18siSZGeoUtmFsfz5H4ozKsrp3tbpVwkS?usp=drive_link`

Q12 exact evidence:

```text
samePhysicalFile=true
databaseBasename=inspection_gate6b_adapter_probe_v1SQLite.db
nativeEngine=sqlcipher-android-4.17.0
preflightWrite=SUCCESS
preflightMarkerCount=1
primaryBeginImmediate=true
duringPrimaryLock=BUSY/android.database.sqlite.SQLiteDatabaseLockedException/code=5
busyTimeoutMs=0
lockedMarkerCount=0
primaryRelease=true
postReleaseWrite=SUCCESS
postReleaseMarkerCount=1
cleanupComplete=true
nativeClosed=true
```

This satisfies the unchanged Q12 verdict rules and physically proves the genuine differential native locking requirement.

Q1→Q11 also PASS. Q8 remains 15 tables / 44 triggers / 1 view / 24 indexes / `integrity_check=ok`. Q9 remains 24 definitions / second bootstrap 24 no-ops / P0=20 / P1=4 / allowed_values=48.

## 15. Existing Application-Core/restart evidence reuse

The independent review accepted reuse of Application-Core and final real Force Stop/Restart evidence from `89d405d6254108ce735125638ccdb2fb2e67c568`.

This is based on demonstrated non-drift through `87135cfe...` of:

- `src/application/**`;
- `src/bootstrap/**`;
- `src/device/capacitor-sqlite-adapter.ts`;
- `docs/schema/schema.sql`;
- `bootstrap/v1/checklist-v1.json`.

It is not a claim that the `89d` and `871` APKs are the same binary: **`same_binary=false`**.

## 16. Gate closure provenance

Q12: **`PHYSICAL_PASS_REVIEW_ACCEPTED`**.

Gate 6B: **`CLOSED / MERGED`**.

`@capacitor-community/sqlite@8.1.1`: **`ADOPTED_BY_CLOSED_GATE6B`**.

PR: `#17`.

Reviewed branch head: `04dcf001e5494c38258c7112619ea1d508af694c`.

Merge SHA: `0905c6111269d62480e7ccadc31786bef29f3c51`.

`closure_authorized=true`.

Gate 6C is **`NEXT / NOT_STARTED`**; this record does not start Gate 6C implementation or request any additional physical retest.
