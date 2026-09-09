# Gate 6B — Android Runtime Proof v1

> **Status:** `IN_PROGRESS / PARTIAL_PASS_Q12_PENDING`
>
> **Governing base:** `main@608314ae62721af44d8ed4f50c1c618ac469fc66`
>
> **Implementation branch:** `implementation/gate6b-android-runtime-proof-v1`
>
> **SQLite candidate:** `@capacitor-community/sqlite@8.1.1`
>
> **Candidate status:** `PROVISIONAL_CANDIDATE_PENDING_DEVICE_PROOF`
>
> **Physical Android execution:** EXECUTED. Q1-Q11, Application-Core and clean Force Stop restart evidence PASS on corrected SHA `89d405d...`; Q12 implementation now awaits a new physical Adapter Qualification.

## 1. Scope and acceptance boundary

Gate 6B proves the Android shell + provisional native SQLite adapter against the already adopted `SqlAdapter` and Application Core. It contains only diagnostic/synthetic proof capability. It does not implement Gate 6C EvidenceStorage, Gate 6D field UI, reports, sync, server or authentication.

CI/build evidence cannot close Gate 6B. Closure remains a separate reviewed/authorized decision after physical evidence, and currently `closure_authorized=false`.

## 2. Exact versions

| Package/tool | Version |
|---|---:|
| `@capacitor/core` | `8.5.1` |
| `@capacitor/android` | `8.5.1` |
| `@capacitor/cli` | `8.5.1` |
| `@capacitor-community/sqlite` | `8.1.1` |
| SQLCipher Android native dependency | `4.17.0` |
| React / React DOM | `19.2.8` |
| Vite | `8.2.2` |
| TypeScript | `5.9.3` |

The actual physical Android SQLite engine reported by the corrected device proof was `3.53.3`.

## 3. Primary `SqlAdapter` mapping — unchanged

Implementation: `src/device/capacitor-sqlite-adapter.ts`.

| Existing seam | Gate-6B mapping |
|---|---|
| `beginImmediate()` | `connection.execute("BEGIN IMMEDIATE;", false)` |
| `commit()` | `connection.execute("COMMIT;", false)` |
| `rollback()` | `connection.execute("ROLLBACK;", false)` |
| `run(sql, params)` | `connection.run(sql, params, false, "no")` |
| `query(sql, params)` | `connection.query(sql, params)` |

The explicit `false` prevents plugin-owned statement transactions inside existing Application-Core transaction boundaries. Q12 does not alter this primary adapter.

`lastInsertRowid` normalization remains the adopted Gate-5B contract: real changing INSERT may expose a numeric rowid; UPDATE/DELETE/zero-change/no-op INSERT return `null`.

## 4. Database names and canonical assets

Persistent proof DB: `inspection_gate6b_runtime_proof_v1`. Focused adapter probe DB: `inspection_gate6b_adapter_probe_v1`. Android package: `com.scientifica.inspection.gate6bproof`.

Canonical schema authority is still exactly `docs/schema/schema.sql`, bundled via `?raw`; canonical bootstrap authority is still exactly `bootstrap/v1/checklist-v1.json`. No second authority exists.

Canonical SHA-256 values observed both by CI and physical corrected device proof:

- schema: `c9c8682ec721b5c24ef3950c49f5a5c402f053d99aa88c617dfd7fe8a7c19ba7`;
- bootstrap: `d43fe2b928116c71ab9b53653d71f832086e8cb01ba817ecac0a17562d3404fd`.

The canonical-schema transport correction is documented separately in `GATE6B-ANDROID-SCHEMA-EXECUTION-CORRECTION-v1.md`.

## 5. Qualification matrix — current physical state

| ID | Requirement | Physical state on `89d405d...` before new Q12 implementation |
|---|---|---|
| Q1 | Parameter binding | PASS |
| Q2 | Affected rows | PASS |
| Q3 | `lastInsertRowid` | PASS |
| Q4 | literal BEGIN IMMEDIATE / COMMIT | PASS |
| Q5 | Rollback | PASS |
| Q6 | Foreign keys | PASS |
| Q7 | Usability after rejection | PASS |
| Q8 | Exact canonical schema | PASS |
| Q9 | Exact canonical bootstrap | PASS |
| Q10 | Persistence | PASS |
| Q11 | no Node dependency | PASS |
| Q12 | genuine independent competing writer | BLOCKED on `89d405d...`; now IMPLEMENTED_PENDING_PHYSICAL_RETEST |

Corrected Adapter Qualification overall was `BLOCKED` solely because Q12 was BLOCKED.

Q8 physical evidence: 15 tables / 44 triggers / 1 view / 24 explicit indexes / exact object-name sets / `integrity_check=ok`.

Q9 physical evidence: first canonical load 24 definitions; second canonical load 24 already present/zero new; P0=20; P1=4; allowed_values=48.

## 6. Pre-correction physical evidence is retained

A real Android phone previously executed Adapter Qualification against SHA `5a642ac73ddaac1df5a49840e2ea4c4c49aae6dc`.

Results: Q1-Q7/Q10/Q11 PASS, Q12 BLOCKED, Q8 FAIL, Q9 not reached, overall FAIL. Exact Q8 error:

```text
Execute: not an error (code 0)
```

That failure led to the canonical-schema transport correction. It remains historical physical evidence for the defective build and is not replaced by later success.

## 7. Corrected physical Adapter Qualification

A real Android phone then executed the replacement build at `89d405d6254108ce735125638ccdb2fb2e67c568` with Capacitor `8.5.1`, plugin `8.1.1`, actual Android SQLite `3.53.3`, and the canonical hashes listed above.

Q1-Q11 all PASS. Q12 alone remained BLOCKED because the plugin dictionary exposes only one ordinary `RW_<database>` connection and no genuine independent writer was then available. Overall result: `BLOCKED`.

## 8. Physical Application-Core proof

Same tested SHA `89d405d...`: overall PASS.

Evidence includes exact Q8/Q9 PASS and use of existing `BootstrapLoader`, T0, T1, T2, OBS-1, T7, T9, and `currentVisitState` services. Synthetic visit=1.

`currentVisitState`: before=121 / after=121 / delta=0.

T11 finalization PASS. A post-finalization field-truth mutation was rejected by the existing Application-Core gate.

State hash: `9d7ab85b68ded94d02fc63e55d765f40f25f1d041e42a506ed7cb3b6cd52f405`.

## 9. Final clean physical Force Stop restart evidence

The owner executed exactly: Reset Synthetic Proof DB → Run Restart Phase A → preserve JSON → Android Settings/App Info → real Force Stop → reopen app → Run Restart Phase B → preserve JSON.

There was **no** Reset, uninstall, or clear-data between FINAL A and FINAL B.

FINAL Phase A: timestamp `2026-09-09T20:38:14.309Z`, overall `DEVICE_PROOF_READY`, visit=1, Q8/Q9/CORE_FLOW PASS, currentVisitState 121→121 delta=0, hash `9d7ab85b68ded94d02fc63e55d765f40f25f1d041e42a506ed7cb3b6cd52f405`.

FINAL Phase B: timestamp `2026-09-09T20:41:35.702Z`, phase `RESTART_PHASE_B_AFTER_FORCE_STOP`, overall PASS, Q8_SCHEMA_REOPEN PASS, visit=1 rediscovered from SQLite markers only, currentVisitState 0→0 delta=0, identical state hash.

The owner retained external screenshots of Android App Info / Force Stop. They are intentionally not committed to GitHub.

An earlier Phase B deliberately preceded by `Reset Synthetic Proof DB` failed because DB/schema/Visit no longer existed. This remains negative evidence, not a product defect.

## 10. Q12 genuine competing-writer implementation

The normal plugin API cannot make a second independent RW connection because v8.1.1 keys ordinary writable connections as `RW_<database>` and rejects duplicate entries.

Gate 6B therefore adds a diagnostic-only Android Capacitor plugin B while keeping A as the existing `CapacitorSqliteAdapter`.

B compiles against the same `net.zetetic:sqlcipher-android:4.17.0@aar`; receives the actual `main` path queried by A via `PRAGMA database_list`; accepts only the exact existing app-private Gate-6B probe file; opens with SQLCipher `OPEN_READWRITE` without create-if-necessary and empty password matching `no-encryption`; verifies its own `PRAGMA database_list`, `sqlite_version()`, and probe-table readability; uses `PRAGMA busy_timeout=0`; has no background writer thread; reports concrete SQLCipher BUSY/LOCKED exception classification; and closes deterministically.

The exact differential sequence and verdict rules are in `GATE6B-Q12-COMPETING-WRITER-PROOF-v1.md`.

## 11. Q12 native lock classification

Pinned SQLCipher `v4.17.0` release commit `ae57a61052d8c41ce35cd48319b2f6f20f4de6bf` maps `SQLITE_BUSY` to `android.database.sqlite.SQLiteDatabaseLockedException` and `SQLITE_LOCKED` to `android.database.sqlite.SQLiteTableLockedException`.

A generic `SQLiteException` is not accepted as lock evidence and leaves Q12 BLOCKED.

## 12. Machine-readable Q12 evidence

The existing proof format remains version 1. Q12 remains one `QualificationCase`; compact evidence includes samePhysicalFile, database basename, native engine, preflight write, primaryBeginImmediate, concrete BUSY/LOCKED classification/code, busyTimeoutMs, lockedMarkerCount, primaryRelease, postReleaseWrite/count, cleanupComplete and nativeClosed.

No absolute private filesystem path, device serial, secrets or operational inspection data are emitted.

## 13. Diagnostic UI

The existing single **Run Adapter Qualification** action remains the first physical workflow and now includes real Q12. No product-like Q12 screen was added. The shell remains `GATE 6B DEVICE PROOF — NOT FIELD UI`.

## 14. Host/CI regression expectations

- Gate 6B adapter mapping: 16/0;
- Gate 6B canonical-schema execution: 8/0;
- Gate 6B Q12 classifier: 13/0;
- Gate 5B adapter normalization: 6/0;
- Gate 5B bootstrap: 32/0;
- Gates 5C→5L: adopted baselines unchanged;
- schema: 100/0;
- Gate-6B runtime typecheck, Vite build, Capacitor sync, resolved SQLCipher dependency assertion=4.17.0, Android assembleDebug, diff/no-drift/runtime-neutral checks, debug APK upload.

CI cannot claim Q12 device PASS.

## 15. Remaining step

After implementation and green CI, install the new APK and run **Run Adapter Qualification only**. Preserve its synthetic JSON for independent review.

The Reviewing/Planning AI will decide later whether the earlier `89d405d...` Application-Core/restart evidence remains admissible for closure or whether another A/B run on the new SHA is required.

Gate 6B remains `IN_PROGRESS`. Gate 6C is `NOT_STARTED`. No PR/merge/closure is implied by this document.
