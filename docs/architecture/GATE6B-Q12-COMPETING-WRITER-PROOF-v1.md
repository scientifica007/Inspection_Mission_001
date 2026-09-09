# Gate 6B — Q12 Genuine Competing Writer Proof v1

> **Gate:** 6B — already open
>
> **Status:** `IMPLEMENTED_PENDING_PHYSICAL_RETEST`
>
> **Branch:** `implementation/gate6b-android-runtime-proof-v1`
>
> **Purpose:** qualify only `Q12_COMPETING_WRITE`. This diagnostic boundary is not a product adapter and is not Gate 6C.

## 1. Why a native diagnostic writer is required

The pinned candidate is `@capacitor-community/sqlite@8.1.1`, upstream release commit `3f3f71606c8f292a3d6d841937bcfc5b5c45aeb5`.

Its Android `CapacitorSQLite.createConnection()` normalizes the ordinary connection dictionary key to `RW_<database>` and rejects a second RW entry for the same database. It constructs the normal file as `<normalized-database-name>SQLite.db`.

Therefore a second JavaScript wrapper through the same plugin cannot establish a genuinely independent writer. Q12 cannot be satisfied by Promise timing or by another wrapper around the same native connection.

## 2. Same native engine

The exact v8.1.1 Android build declares `net.zetetic:sqlcipher-android:4.17.0@aar`. The plugin's `Database` class imports `net.zetetic.database.sqlcipher.SQLiteDatabase`; for `no-encryption`, password remains the empty string.

Q12 writer B compiles directly against the **same** `sqlcipher-android:4.17.0@aar`. No Android framework SQLite engine, alternative SQL library, adapter replacement, or second persistence stack is introduced.

SQLCipher `v4.17.0` resolves to signed tag object `0725b962ffb60b00460b0e315bc632a543b399e7` and release commit `ae57a61052d8c41ce35cd48319b2f6f20f4de6bf`.

The plugin also keeps `androidx.sqlite:sqlite:2.4.0` behind its Gradle `implementation` boundary. Because SQLCipher's public `SQLiteDatabase` type implements AndroidX `SupportSQLiteDatabase`, the app's diagnostic Java source needs that interface on the **compile** classpath. Gate 6B therefore declares the same plugin version as `compileOnly 'androidx.sqlite:sqlite:2.4.0'`; this does not introduce another runtime engine or persistence stack and does not replace the plugin's runtime dependency.

CI inspects `debugRuntimeClasspath` and requires the only resolved `net.zetetic:sqlcipher-android` coordinate to be `4.17.0`.

## 3. A and B boundaries

A remains the existing `@capacitor-community/sqlite` → `CapacitorSqliteAdapter`. No Q12-specific transaction implementation is added to A. It still acquires the lock through `CapacitorSqliteAdapter.beginImmediate()` → `connection.execute("BEGIN IMMEDIATE;", false)` and releases deterministically through existing `rollback()`.

B is `Gate6BCompetingWriterPlugin`, a custom Capacitor Android plugin registered only in the Gate-6B proof shell. It owns a separate `net.zetetic.database.sqlcipher.SQLiteDatabase` instance and remains open across preflight, lock attempt, and post-release retry.

B does not implement `SqlAdapter`, is never imported by `src/application/**` or `src/bootstrap/**`, and must not become product database architecture.

## 4. Exact same-file proof

A first executes `PRAGMA database_list;` and supplies the absolute `main` path to B. The absolute path is transport-only and is not emitted in proof JSON.

B rejects the target unless all are true:

1. basename is exactly `inspection_gate6b_adapter_probe_v1SQLite.db`;
2. canonical parent is exactly this app's private database directory;
3. canonical path equals `Context.getDatabasePath(expectedBasename)`;
4. the file already exists and is a regular file.

B opens with `SQLiteDatabase.openDatabase(..., OPEN_READWRITE, ...)` **without** `CREATE_IF_NECESSARY`, using the empty password compatible with Gate-6B `no-encryption` mode. After open, B independently executes its own `PRAGMA database_list` and requires its `main` canonical file to equal the validated target.

Machine evidence exposes only `samePhysicalFile=true/false` and the basename.

## 5. B preflight proves real independent write capability

Before A owns any explicit transaction:

1. B verifies `__g6b_probe` is readable.
2. B inserts synthetic marker `g6b-q12-preflight`.
3. A queries that marker and requires count=1.
4. A deletes it and requires one-row cleanup.

A later during-lock failure cannot therefore be accepted merely because B was incapable of opening or writing the database. B also returns its own `sqlite_version()`; the classifier requires it to equal A's recorded version.

## 6. Bounded native lock behavior

B executes `PRAGMA busy_timeout = 0;` and immediately reads the pragma back. Q12 PASS requires the effective value to be exactly zero milliseconds.

No JavaScript Promise timeout is used. No ExecutorService, background worker, delayed writer, or orphan thread exists. Each Capacitor plugin method performs one synchronous native SQLite call and resolves only after that call returns.

## 7. Native BUSY/LOCKED classification

In SQLCipher Android `4.17.0` JNI exception mapping:

- `SQLITE_BUSY` → `android.database.sqlite.SQLiteDatabaseLockedException`;
- `SQLITE_LOCKED` → `android.database.sqlite.SQLiteTableLockedException`.

B classifies only those concrete outcomes as `BUSY`/`LOCKED`, recording the mapped result code 5/6 and concrete exception class. Any other `SQLiteException` is `ERROR` and causes Q12 to remain BLOCKED rather than PASS.

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

No step releases A merely to rescue B; B's zero busy timeout makes the native lock attempt finite by construction.

## 9. Verdict rules

Q12 = PASS only when the whole differential sequence is proven, including same file, same engine, preflight, concrete native lock classification, absence under lock, successful post-release retry, cleanup, and native close.

Q12 = FAIL for a semantic contradiction, including a post-open same-physical-file mismatch, B writing while A owns `BEGIN IMMEDIATE`, locked marker visibility, primary transaction acquisition/release contradiction, or inability to write after release after a valid preflight.

Q12 = BLOCKED for qualification limitations, including inability to open/validate B before a same-file observation can be established, native preflight failure, engine mismatch, generic/unclassifiable native exception, unexpected busy policy, or incomplete cleanup/close.

## 10. Host regression

`tests/gate6b_q12_regression.ts` adversarially tests the pure classifier. Current baseline: **13 / 0**. This host suite cannot establish Android lock semantics; Android compilation proves only that the native bridge compiles against the pinned API.

## 11. Existing physical evidence and remaining action

All physical evidence on corrected SHA `89d405d6254108ce735125638ccdb2fb2e67c568` remains preserved: Q1-Q11 PASS, Application-Core PASS, and clean real Force Stop restart A→B PASS. Q12 on that build was BLOCKED because the genuine B path did not exist yet.

After this implementation and green CI, the first and only requested physical action is **Run Adapter Qualification** on the new APK.

Only that new physical run may establish Q12 PASS/FAIL/BLOCKED. CI must not mark Q12 PASS. Gate 6B remains **IN_PROGRESS** and closure remains unauthorized.

## 12. Self-review / disproved hypotheses

- Second plugin RW connection: disproved by the plugin dictionary constraint; not used.
- Second JS wrapper: not independent; not used.
- Promise timeout: not native lock evidence; not used.
- Android framework SQLite: different engine; not used.
- `openOrCreateDatabase` for B: could conceal wrong path; not used.
- Generic `SQLiteException`: insufficient lock classification; never accepted as PASS.
- Background writer thread: unnecessary and creates stale-write risk; not used.
- Primary adapter modification: unnecessary; not performed.

Remaining limitation is intentionally explicit: Q12 physical verdict is pending a real Android execution of the new APK.
