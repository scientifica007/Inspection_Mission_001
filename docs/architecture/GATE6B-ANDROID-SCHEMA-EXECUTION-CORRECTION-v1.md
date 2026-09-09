# Gate 6B — Android Canonical Schema Execution Correction v1

> **Gate status:** `IN_PROGRESS / DEVICE_PROOF_PENDING`
>
> **Branch:** `implementation/gate6b-android-runtime-proof-v1`
>
> **Physical failing build SHA:** `5a642ac73ddaac1df5a49840e2ea4c4c49aae6dc`
>
> **Classification:** device-found correction inside the already-open Gate 6B. This is not a new Gate and not a closed-Gate reopen.

## 1. Physical Android evidence that triggered this correction

A real Android device ran **Run Adapter Qualification** against build SHA `5a642ac73ddaac1df5a49840e2ea4c4c49aae6dc` with:

- package: `com.scientifica.inspection.gate6bproof`;
- Capacitor: `8.5.1`;
- `@capacitor-community/sqlite`: `8.1.1`;
- actual device SQLite engine: `3.53.3`;
- canonical schema SHA-256: `c9c8682ec721b5c24ef3950c49f5a5c402f053d99aa88c617dfd7fe8a7c19ba7`;
- canonical bootstrap SHA-256: `d43fe2b928116c71ab9b53653d71f832086e8cb01ba817ecac0a17562d3404fd`.

Physical results:

| Case | Result |
|---|---|
| Q1 parameter binding | PASS |
| Q2 affected rows | PASS |
| Q3 `lastInsertRowid` | PASS |
| Q4 transaction commit | PASS |
| Q5 rollback | PASS |
| Q6 foreign keys | PASS |
| Q7 connection after rejected statement | PASS |
| Q8 canonical schema | **FAIL** |
| Q9 canonical bootstrap | NOT REACHED because Q8 failed |
| Q10 persistence | PASS |
| Q11 no Node dependency | PASS |
| Q12 competing write | BLOCKED, already expected |

Exact Q8 device error:

```text
Execute: not an error (code 0)
```

Overall physical result: **FAIL**. This evidence is retained as a real device result; it is not reclassified as a host failure.

## 2. Confirmed root cause in the pinned Android plugin

The pinned `@capacitor-community/sqlite@8.1.1` Android implementation processes `SQLiteDBConnection.execute()` input through `UtilsSQLite.getStatementsArray()` before native execution.

The relevant v8.1.1 behavior is:

1. normalize literal lowercase `end;` to `END;`;
2. split the complete input on the literal delimiter `;\n`;
3. run a limited trigger repair that only recognizes an array element exactly equal to `END` and joins it to the immediately preceding fragment;
4. pass the resulting commands to `Database.execute()`;
5. `Database.execute()` calls native `_db.execSQL(...)` for each command.

This splitter is insufficient for the adopted canonical schema. A trigger with one internal statement can sometimes be reconstructed because the lone body fragment immediately precedes `END`. A trigger with multiple internal statements cannot be reconstructed: each internal `SELECT ...;\n` is split into a separate command, and the final `END` can repair only the immediately preceding fragment.

`trg_mission_bu` is a deterministic example: it contains three independent `SELECT RAISE(...)` body statements. Under the v8.1.1 splitter, the first fragment begins `CREATE TRIGGER trg_mission_bu ... BEGIN ...` but lacks the outer `END`; later body arms become separate commands. The same incompatibility affects other multi-statement triggers including `trg_subject_bu`, `trg_visit_bu`, `trg_def_bi`, and additional canonical triggers.

A dedicated host regression now reproduces this exact plugin algorithm against the exact `docs/schema/schema.sql` and proves that the plugin-split command stream is not executable as the canonical schema.

## 3. Why `run()` / `executeSet()` are not used for DDL

The investigation also checked the alternative plugin paths rather than assuming they were safe.

On Android v8.1.1, `run()` / `executeSet()` route into `prepareSQL()`, compile the statement, and use `executeInsert()` for INSERT or `executeUpdateDelete()` for non-INSERT statements. That is not the plugin path intended for CREATE TABLE/INDEX/VIEW/TRIGGER DDL.

The correction therefore retains `execute()` so the final native primitive remains `execSQL`; it only prevents the plugin's insufficient **batch** splitter from deciding canonical statement boundaries.

## 4. Correction technique

The canonical authority remains exactly:

`docs/schema/schema.sql`

No schema copy is introduced and no canonical SQL byte is edited in the repository.

Gate 6B adds a narrowly scoped canonical-schema execution layer which:

1. consumes the exact bundled canonical schema string;
2. lexically segments it into complete SQLite statements;
3. treats ordinary statements as semicolon-terminated statements outside strings/comments;
4. treats `CREATE TRIGGER ... BEGIN ... END;` as one statement, including multiple internal statements;
5. tracks `CASE ... END` inside trigger bodies so expression `END` tokens do not terminate the trigger;
6. transports each already-complete statement separately through `execute(..., false)`;
7. neutralizes the v8.1.1 literal `;\n` batch delimiter only at normal SQL boundaries, without changing quoted text or line-comment boundaries;
8. preserves `transaction=false` and therefore does not introduce a plugin-owned transaction.

Only an `execute()` call whose input is byte-for-byte the exact canonical schema asset is intercepted. Existing `BEGIN IMMEDIATE`, `COMMIT`, `ROLLBACK`, PRAGMA, adapter `run()`, and query paths are unchanged.

## 5. Host regression added

`tests/gate6b_schema_execution_regression.ts` is independent from the existing 16/0 adapter-mapping suite. It verifies:

- the installed pinned v8.1.1 Android source still contains the diagnosed splitter/execSQL paths;
- exact canonical schema SHA-256 is unchanged;
- a test replica of the plugin splitter breaks the exact canonical multi-statement trigger stream;
- all 44 canonical triggers are segmented as complete statements;
- `trg_mission_bu`, `trg_subject_bu`, `trg_visit_bu`, and `trg_def_bi` retain their body arms;
- corrected one-statement transport is an identity operation to the plugin splitter;
- an independent Python `sqlite3` runtime executes both the exact canonical control script and the corrected per-statement stream;
- both executions yield the same exact object-name sets: 15 tables, 44 triggers, 1 view, 24 explicit indexes;
- all stored trigger definitions match the canonical control after whitespace normalization;
- Q8 execution errors include stage, canonical statement index, object/trigger name when known, and underlying plugin error text.

The regression does not use the production inventory parser as its execution oracle.

## 6. Device diagnostics after the correction

A future Q8 execution failure is emitted compactly in this shape:

```text
stage=execute_statement; statement_index=<n>; object=<name-or-kind>; plugin_error=<native/plugin text>
```

The proof JSON does not include the full schema.

## 7. Required next physical action

CI and an Android debug build can prove compilation, host regression, canonical hashes, historical baselines, and APK construction. They **cannot** convert the prior Q8 device failure into a PASS.

A new APK built from the corrected branch must be installed and **Run Adapter Qualification must be executed first**. The new physical result must show Q8 PASS and must reach Q9 before Application-Core proof or restart Phase A/B are treated as current evidence.

The previous `5a642ac...` physical result remains historical evidence for the defective build and must not be overwritten or relabeled.

Gate 6B remains `IN_PROGRESS / DEVICE_PROOF_PENDING`. Q12 remains separately BLOCKED until a genuine independent competing-writer procedure is available or otherwise reviewed.
