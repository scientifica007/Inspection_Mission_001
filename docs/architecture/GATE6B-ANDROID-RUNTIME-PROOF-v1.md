# Gate 6B — Android Runtime Proof v1

> **Status:** `CLOSED / MERGED`
>
> **Original governing base:** `main@608314ae62721af44d8ed4f50c1c618ac469fc66`
>
> **Implementation branch:** `implementation/gate6b-android-runtime-proof-v1`
>
> **Reviewed branch head:** `04dcf001e5494c38258c7112619ea1d508af694c`
>
> **PR:** `#17`
>
> **Merge SHA:** `0905c6111269d62480e7ccadc31786bef29f3c51`
>
> **SQLite candidate:** `@capacitor-community/sqlite@8.1.1`
>
> **Candidate status:** `ADOPTED_BY_CLOSED_GATE6B`
>
> **Physical qualification target:** `87135cfe80ae3de79a34e941828249fc6889139c`
>
> **Physical Android execution:** Q1→Q12 PASS. Application-Core and final real Force Stop/Restart evidence from `89d405d...` remain accepted by independent non-drift evidence reuse with `same_binary=false`.

## 1. Scope and closure boundary

Gate 6B proved the Android shell + candidate native SQLite adapter against the already adopted `SqlAdapter` and Application Core. It contains diagnostic/synthetic proof capability only and does not implement Gate 6C EvidenceStorage, Gate 6D field UI, reports, sync, server or authentication.

Gate 6B is now formally **CLOSED / MERGED** after independent review, project-owner merge approval, PR #17 merge, and Fresh Read of `main@0905c6111269d62480e7ccadc31786bef29f3c51`.

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

The accepted physical Adapter Qualification reported Android SQLite engine `3.53.3`.

## 3. Primary `SqlAdapter` mapping — unchanged

Implementation: `src/device/capacitor-sqlite-adapter.ts`.

| Existing seam | Gate-6B mapping |
|---|---|
| `beginImmediate()` | `connection.execute("BEGIN IMMEDIATE;", false)` |
| `commit()` | `connection.execute("COMMIT;", false)` |
| `rollback()` | `connection.execute("ROLLBACK;", false)` |
| `run(sql, params)` | `connection.run(sql, params, false, "no")` |
| `query(sql, params)` | `connection.query(sql, params)` |

The explicit `false` prevents plugin-owned statement transactions inside existing Application-Core transaction boundaries. Q12 did not alter this primary adapter.

`lastInsertRowid` normalization remains the adopted Gate-5B contract.

## 4. Database names and canonical assets

Persistent proof DB: `inspection_gate6b_runtime_proof_v1`. Focused adapter probe DB: `inspection_gate6b_adapter_probe_v1`. Android package: `com.scientifica.inspection.gate6bproof`.

Canonical schema authority remains exactly `docs/schema/schema.sql`; canonical bootstrap authority remains exactly `bootstrap/v1/checklist-v1.json`.

Canonical SHA-256 values:

- schema: `c9c8682ec721b5c24ef3950c49f5a5c402f053d99aa88c617dfd7fe8a7c19ba7`;
- bootstrap: `d43fe2b928116c71ab9b53653d71f832086e8cb01ba817ecac0a17562d3404fd`.

The canonical-schema transport correction is documented in `GATE6B-ANDROID-SCHEMA-EXECUTION-CORRECTION-v1.md`.

## 5. Qualification matrix — accepted physical state

Accepted physical target:

`87135cfe80ae3de79a34e941828249fc6889139c`

| ID | Requirement | Physical state |
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
| Q12 | genuine independent competing writer | PASS |

Overall Adapter Qualification: **PASS**.

Q8: 15 tables / 44 triggers / 1 view / 24 explicit indexes / `integrity_check=ok`.

Q9: first canonical load 24 definitions; second bootstrap 24 no-ops; P0=20; P1=4; allowed_values=48.

External accepted evidence:

`https://drive.google.com/drive/folders/18siSZGeoUtmFsfz5H4ozKsrp3tbpVwkS?usp=drive_link`

## 6. Q12 accepted physical evidence

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

This is the genuine differential native lock proof: independent B writes before the lock, A obtains literal `BEGIN IMMEDIATE`, B receives genuine SQLCipher BUSY while A owns the lock, the locked marker remains absent, then B succeeds after A releases and cleanup/close complete.

## 7. Historical pre-correction evidence retained

A real Android phone previously executed Adapter Qualification against SHA `5a642ac73ddaac1df5a49840e2ea4c4c49aae6dc`.

Results: Q1-Q7/Q10/Q11 PASS, Q12 BLOCKED, Q8 FAIL, Q9 not reached, overall FAIL. Exact Q8 error:

```text
Execute: not an error (code 0)
```

That failure led to the canonical-schema transport correction. It remains historical physical evidence for the defective build.

## 8. Historical corrected Adapter Qualification on `89d405d...`

A real Android phone executed the replacement build at `89d405d6254108ce735125638ccdb2fb2e67c568` with Capacitor `8.5.1`, plugin `8.1.1`, Android SQLite `3.53.3`, and canonical hashes listed above.

Q1-Q11 all PASS. Q12 remained BLOCKED because a genuine independent writer B had not yet been introduced. Overall result: `BLOCKED`.

This historical result is not rewritten as PASS.

## 9. Accepted Physical Application-Core proof from `89d405d...`

Application-Core overall: PASS.

Evidence:

- synthetic visit=1;
- `currentVisitState`: before=121 / after=121 / delta=0;
- T11 finalization: PASS;
- state hash: `9d7ab85b68ded94d02fc63e55d765f40f25f1d041e42a506ed7cb3b6cd52f405`.

## 10. Accepted final real Force Stop restart evidence from `89d405d...`

FINAL Phase A: timestamp `2026-09-09T20:38:14.309Z`, overall `DEVICE_PROOF_READY`, visit=1, Q8/Q9/CORE_FLOW PASS, currentVisitState 121→121 delta=0, hash `9d7ab85b68ded94d02fc63e55d765f40f25f1d041e42a506ed7cb3b6cd52f405`.

FINAL Phase B: timestamp `2026-09-09T20:41:35.702Z`, phase `RESTART_PHASE_B_AFTER_FORCE_STOP`, overall PASS, Q8_SCHEMA_REOPEN PASS, visit=1 rediscovered from SQLite markers only, currentVisitState 0→0 delta=0, identical state hash.

There was no Reset, uninstall, or clear-data between FINAL A and FINAL B.

An earlier Phase B deliberately preceded by `Reset Synthetic Proof DB` failed because DB/schema/Visit no longer existed. This remains negative evidence, not a product defect.

## 11. Independent evidence-reuse decision

The `89d405d...` Application-Core and restart evidence remains accepted and is not rerun.

Basis: from `89d405d...` through Q12 target `87135cfe...`, there was no drift in:

- `src/application/**`;
- `src/bootstrap/**`;
- `src/device/capacitor-sqlite-adapter.ts`;
- `docs/schema/schema.sql`;
- `bootstrap/v1/checklist-v1.json`.

The Gate-6B changes between these runtime states added/diagnosed/corrected the Q12 proof boundary and did not alter the Application-Core or restart semantic paths covered by the reused evidence.

This is evidence reuse based on non-drift. It does **not** claim the `89d` physical APK and `871` physical APK were the same binary: `same_binary=false`.

## 12. Q12 implementation boundary

A remains the existing `CapacitorSqliteAdapter`.

B is a diagnostic-only Android Capacitor plugin using the same `net.zetetic:sqlcipher-android:4.17.0@aar`.

B validates the exact existing app-private probe file, verifies its own `PRAGMA database_list`, `sqlite_version()`, and probe-table readability, uses zero busy timeout with query/rawQuery-backed setter/readback, reports concrete BUSY/LOCKED outcomes, and closes deterministically.

The exact sequence and verdict rules are in `GATE6B-Q12-COMPETING-WRITER-PROOF-v1.md`.

## 13. Machine-readable Q12 evidence

The proof format remains version 1. No absolute private filesystem path, device serial, secrets or operational inspection data are emitted.

Q12 classifier semantics remain unchanged.

## 14. Diagnostic UI

The shell remains `GATE 6B DEVICE PROOF — NOT FIELD UI`. No product field UI was added in Gate 6B.

## 15. Host/CI regression baselines

- Gate 6B adapter mapping: 16/0;
- Gate 6B canonical-schema execution: 8/0;
- Gate 6B Q12 diagnostic/classifier: 20/0;
- Gate 5B adapter normalization: 6/0;
- Gate 5B bootstrap: 32/0;
- Gate 5C: 55/0;
- Gate 5D: 60/0;
- Gate 5E: 79/0;
- Gate 5F: 30/0;
- Gate 5G: 41/0;
- Gate 5H: 66/0;
- Gate 5I: 48/0;
- Gate 5J: 75/0;
- Gate 5K: 82/0;
- Gate 5L: 94/0;
- schema: 100/0.

Gate-6B CI also covered runtime typecheck, Vite build, Capacitor sync, resolved SQLCipher dependency assertion=4.17.0, Android assembleDebug, diff/no-drift/runtime-neutral checks, and artifact upload.

CI is not substituted for the accepted physical proof; the physical Q12 PASS is the reviewed Android evidence on `87135cfe...`.

## 16. Closure provenance and next Gate

Gate 6B: **`CLOSED / MERGED`**.

Q12: **`PHYSICAL_PASS_REVIEW_ACCEPTED`**.

`@capacitor-community/sqlite@8.1.1`: **`ADOPTED_BY_CLOSED_GATE6B`**.

PR: `#17`.

Reviewed branch head: `04dcf001e5494c38258c7112619ea1d508af694c`.

Merge SHA: `0905c6111269d62480e7ccadc31786bef29f3c51`.

`closure_authorized=true`.

Gate 6C: **`NEXT / NOT_STARTED`**. No Gate 6C implementation is part of this closure record.
