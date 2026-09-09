# Gate 6B — Android Runtime Proof Preparation v1

> **Status:** `IN_PROGRESS / DEVICE_PROOF_PENDING`  
> **Governing base:** `main@608314ae62721af44d8ed4f50c1c618ac469fc66`  
> **Implementation branch:** `implementation/gate6b-android-runtime-proof-v1`  
> **SQLite candidate status:** `PROVISIONAL_CANDIDATE_PENDING_DEVICE_PROOF`  
> **Closure:** **NOT AUTHORIZED / NOT CLAIMED**  
> **PHYSICAL DEVICE PROOF NOT YET EXECUTED**

## 1. Scope

This branch prepares the first executable phase of Gate 6B only:

- React + Vite + TypeScript diagnostic shell;
- Capacitor Android target;
- one provisional native SQLite adapter candidate behind the existing `SqlAdapter` seam;
- canonical schema/bootstrap execution path;
- adapter qualification and Application-Core proof harness;
- two-phase physical restart protocol;
- CI/build/regression evidence and a debug APK suitable only for synthetic Gate-6B proof.

It does **not** implement EvidenceStorage, camera/file picking, product field UI, reports, sync, server, authentication, or any Gate 6C+ capability.

## 2. Exact package/tool versions

Application package versions are pinned exactly in `package.json` and the generated `package-lock.json`:

| Package/tool | Version |
|---|---:|
| `@capacitor/core` | `8.5.1` |
| `@capacitor/android` | `8.5.1` |
| `@capacitor/cli` | `8.5.1` |
| `@capacitor-community/sqlite` | `8.1.1` |
| React / React DOM | `19.2.8` |
| Vite | `8.2.2` |
| `@vitejs/plugin-react` | `6.1.1` |
| TypeScript | `7.0.2` |
| CI Node | `24` |
| CI Java | Temurin `21` |
| CI Python | `3.12` |

The SQLite engine version is not assumed from package metadata. The proof runner records `SELECT sqlite_version()` from the opened Android database.

## 3. Provisional SQLite candidate investigation

Primary candidate: `@capacitor-community/sqlite@8.1.1`.

The candidate is **not adopted**. Upstream API/source inspection established these implementation assumptions that the physical proof must still verify:

1. Android uses an app-private database path for normal named databases.
2. Android open enables foreign-key constraints internally, but this project still explicitly executes and verifies `PRAGMA foreign_keys = ON` on every authoritative open/reopen.
3. `SQLiteDBConnection.execute(statements, transaction=false)` forwards the `transaction=false` option and executes statements without invoking the plugin transaction helper.
4. `SQLiteDBConnection.run(statement, values, transaction=false)` similarly disables the plugin's per-statement transaction wrapper.
5. Android `run` returns a connection-level `lastId`; it can therefore retain an earlier INSERT identity after UPDATE/DELETE. The adapter must normalize it rather than expose it blindly.
6. The plugin's named native connection dictionary has one `RW_<database>` connection key per database. A second independent RW connection to the same file is not exposed through the normal API; therefore a genuine competing-write `BEGIN IMMEDIATE` proof remains an explicit device-qualification limitation unless a reviewed independent path is established.

### Disproved hypothesis

**Hypothesis:** the plugin's `beginTransaction()` helper can be treated as the project's required `BEGIN IMMEDIATE`.  
**Result:** disproved as an acceptable proof basis. The Android source calls the Android transaction helper; that is not literal executable evidence of the exact SQL command required by the project contract. Gate 6B therefore does not use it.

## 4. Adapter mapping

Implementation: `src/device/capacitor-sqlite-adapter.ts`.

The existing `src/bootstrap/adapter.ts` interface is unchanged.

| `SqlAdapter` method | Gate-6B mapping |
|---|---|
| `beginImmediate()` | `connection.execute("BEGIN IMMEDIATE;", false)` |
| `commit()` | `connection.execute("COMMIT;", false)` |
| `rollback()` | `connection.execute("ROLLBACK;", false)` |
| `run(sql, params)` | `connection.run(sql, params, false, "no")` |
| `query(sql, params)` | `connection.query(sql, params)` |

The `false` argument is mandatory: it disables the plugin's normal per-statement transaction wrapper so Application Core owns the single explicit transaction boundary.

### `changes`

`run()` reads `result.changes.changes`, validates it as a non-negative safe integer, and returns it as the existing `SqlResult.changes` number.

### `lastInsertRowid`

The Gate-5B normalization contract is preserved exactly at the adapter boundary:

- top-level INSERT with `changes > 0` + numeric `lastId` → numeric row id;
- UPDATE → `null`;
- DELETE → `null`;
- zero-change/no-op INSERT → `null`.

The adapter classifies only the top-level SQL statement shape (`/^\s*INSERT\b/i`) and never trusts plugin connection-level `lastId` on non-INSERT statements.

## 5. Database open/persistence strategy

Device manager: `src/device/gate6b-database.ts`.

Persistent proof DB name: `inspection_gate6b_runtime_proof_v1`.

Focused adapter-probe DB name: `inspection_gate6b_adapter_probe_v1`.

Every authoritative open/reopen obtains/opens the named native Android database, executes `PRAGMA foreign_keys = ON` with plugin transaction wrapping disabled, queries `PRAGMA foreign_keys` and refuses the connection unless the value is `1`, then records `SELECT sqlite_version()`.

No LocalStorage, IndexedDB, sessionStorage, JSON sidecar, React state, or process cache is used as durable domain authority.

## 6. Canonical schema asset — no duplicate authority

The Vite bundle imports the exact repository asset `docs/schema/schema.sql?raw`. No second schema copy is maintained.

The proof runner:

1. computes SHA-256 over those exact bundled bytes;
2. executes that exact SQL text on a fresh Gate-6B proof database using `execute(..., false)`;
3. derives expected table/trigger/view/index **names from the canonical SQL text itself** after stripping SQL line comments;
4. reads the actual non-`sqlite_%` `sqlite_master` inventory;
5. requires symmetric exact-set equality, not counts only;
6. separately requires adopted counts `15 tables / 44 triggers / 1 view / 24 explicit indexes`;
7. requires `PRAGMA integrity_check = ok`.

This distinguishes “the canonical asset was executed and its exact object names match” from “the database has plausible counts.”

## 7. Canonical bootstrap asset — no duplicate authority

The bundle imports exact `bootstrap/v1/checklist-v1.json?raw`, parses it with the existing runtime-neutral artifact parser, and loads it through existing `BootstrapLoader`.

Required proof: first load 24 definitions; exact artifact-derived allowed-value count; P0/P1 manifest validation by existing loader; second load 24 `alreadyPresent`/zero newly loaded; SHA-256 over exact raw asset.

## 8. Qualification matrix prepared

| ID | Requirement | Prepared evidence |
|---|---|---|
| Q1 | Parameter binding | Arabic + apostrophe/quotes + integer + null round trip |
| Q2 | Affected rows | INSERT 1 / UPDATE 1 / zero UPDATE 0 / DELETE 1 |
| Q3 | `lastInsertRowid` | real INSERT numeric; UPDATE/DELETE/zero/no-op INSERT null |
| Q4 | Transaction commit | literal `BEGIN IMMEDIATE`; multiple `run(..., false)` writes; literal COMMIT; durable rows |
| Q5 | Rollback | literal transaction; UPDATE+INSERT; ROLLBACK; old state restored |
| Q6 | Foreign keys | `PRAGMA foreign_keys=1`; invalid FK write rejected |
| Q7 | Usability after rejection | valid write succeeds after rejected FK statement |
| Q8 | Schema | exact canonical bytes + exact object-name inventory + adopted counts + integrity_check |
| Q9 | Bootstrap | existing canonical BootstrapLoader + exact counts + idempotent reload |
| Q10 | Persistence | close connection, reopen same app-private DB, marker survives |
| Q11 | no Node dependency | Android/WebView build + CI static ban on `node:*` in `src/application` and `src/bootstrap` |
| Q12 | Transaction ownership | literal SQL + `transaction=false` mapping + rollback proof; competing RW path remains unresolved |

### Unresolved device-qualification item — competing writer

The normal plugin API/native connection dictionary rejects a second `RW_<database>` connection for the same database name. Gate 6B therefore does **not** claim the special competing-write proof by measuring whether a JavaScript Promise resolves quickly. That would repeat the HNT-001/HNT-002 weakness.

Current status: `UNRESOLVED DEVICE-QUALIFICATION ITEM`.

A later reviewed physical-device procedure must either establish a genuinely independent competing SQLite writer to the same file or retain this limitation as blocking Gate-6B closure. The contract will not be weakened to make the candidate pass.

## 9. Representative existing Application-Core flow

`src/gate6b/proof-runner.ts` calls existing services directly and does not duplicate their business rules:

1. exact schema;
2. canonical BootstrapLoader;
3. direct synthetic Mission/Institution prerequisites (no adopted creation service exists);
4. `VisitScopeService.createVisit` (T0);
5. `VisitScopeService.addSubjectToScope` (T1) for one synthetic WORKSHOP;
6. `InitialDispositionService.answerSingle` (T2) for pinned CHK-001 and pinned allowed value;
7. `ObservationCreateService.createAdHocObservation` (OBS-1);
8. `ObservationFindingService.createFindingWithObservationSource` (T7);
9. `CorrectiveActionCreateService.createCorrectiveAction` (T9);
10. `CurrentVisitStateService.currentVisitState` (Gate 5L).

All names/data are synthetic.

## 10. T11 finalization proof preparation

A separate synthetic Visit is composed through existing services. The harness obtains its current state through Gate 5L and disposes only still-pending cells through existing Gate-5D `markNotInspected`, including explicit `humanDecision=APPLICABLE` when Gate 5L classifies a cell `UNRESOLVED_HUMAN`.

It then calls existing `VisitFinalizationService.finalizeVisit` and requires success, durable `COMPLETED_WITH_UNINSPECTED`, exact supplied `finalized_at`, and a subsequent post-finalization `ObservationCreateService` field-truth attempt rejected with `E_VISIT_NOT_PREPARATION`.

The harness does not reimplement T11 preflight rules and never forces final status with raw SQL.

## 11. Gate 5L zero-write proof preparation

On the same authoritative connection: `SELECT total_changes()` → existing `currentVisitState(visitId)` → `SELECT total_changes()` again. Required delta: `0`. No proof rows are inserted into the domain schema.

## 12. Physical two-phase restart protocol

### Phase A — before kill

The diagnostic screen deletes only the synthetic proof database, executes canonical schema/bootstrap, inserts synthetic prerequisites, runs the representative existing-core flow, calls `currentVisitState` and verifies zero-write, emits a deterministic SHA-256 of canonicalized reconstructed state plus proof JSON, and closes the DB connection.

Then perform a **real process stop**, preferably:

```text
adb shell am force-stop com.scientifica.inspection.gate6bproof
```

Do not uninstall the app and do not reset/delete the DB.

### Phase B — after restart

After relaunch, Phase B opens the same named persistent DB, re-enables/verifies FKs, rediscovers the synthetic Visit by Mission/Institution markers stored in SQLite, calls existing `currentVisitState`, measures zero-write, verifies the fixed synthetic scenario, and emits state hash + matrix. It consumes no prior Visit id from React/process state.

No LocalStorage/sessionStorage/IndexedDB/global/JSON sidecar is involved.

## 13. Diagnostic UI boundary

`src/ui/Gate6BProofApp.tsx` exposes only adapter qualification, Application-Core proof, Restart Phase A/B, synthetic DB reset, and proof JSON copy. The header explicitly states `GATE 6B DEVICE PROOF — NOT FIELD UI`. This is not Gate 6D/product workflow UI.

## 14. Machine-readable proof format

Output includes gate/version, tested Git SHA when injected, app id, Capacitor/plugin versions and provisional status, SQLite engine version, schema/bootstrap SHA-256, phase/timestamp, per-case PASS/FAIL/BLOCKED evidence, SQLite-recovered Visit id, Gate-5L total_changes values, deterministic reconstructed-state hash, and overall result. It never records real inspection data, secrets, or device serial numbers.

## 15. CI

Workflow: `.github/workflows/gate6b-android-runtime-proof.yml`.

The first branch run uses official npm/Capacitor tooling to generate and persist the exact `package-lock.json` and native `android/` project once. Subsequent runs use `npm ci` and require: full-history checkout; CURRENT-STATE JSON validation; no-`node:*`/no-Capacitor-import checks for runtime-neutral `src/application` + `src/bootstrap`; TypeScript typecheck; Gate-6B host adapter regression; every historical Gate 5B→5L baseline; schema 100/0; Vite build; `cap sync android`; Android debug APK build; `git diff --check origin/main...HEAD`; and synthetic debug APK upload.

An Android build or future emulator run is **not** physical-device evidence.

## 16. Self-review / attack list

- Literal BEGIN IMMEDIATE? **Yes by adapter mapping; physical execution still must be observed.**
- Hidden per-statement transactions? **Explicitly disabled by `transaction=false`; rollback qualification attacks this.**
- Stale rowid? **Explicit normalization + host/device cases.**
- FK after reopen? **Explicit set + read-back every open.**
- Schema/bootstrap duplicate authority? **No.**
- Same DB after restart? **Named app-private DB; Phase B discovers from SQLite only.**
- LocalStorage/process memory dependency? **None.**
- Capacitor imports in Application Core? **None; only device/UI/proof layers.**
- Gate 6D UI? **No; diagnostic-only screen.**
- Count-only schema proof? **No; exact object-name symmetric set comparison.**
- Async lock test hang? **No fake competing-write Promise test; unsupported independent RW path is BLOCKED.**
- CI/emulator mislabeled physical proof? **No.**
- Premature closure? **No. Gate remains IN_PROGRESS / DEVICE_PROOF_PENDING.**

## 17. Remaining steps before Gate-6B closure

1. independent review of branch/diff/CI/proof design;
2. install reviewed debug APK on a physical Android device;
3. run adapter qualification and preserve JSON;
4. run Application-Core/T11/zero-write proof and preserve JSON;
5. execute Restart Phase A;
6. perform real process force-stop;
7. relaunch and execute Restart Phase B against same SQLite file;
8. preserve proof outputs in GitHub through a separately authorized evidence update;
9. independently review device evidence, especially unresolved competing-writer qualification;
10. only then consider separate authorization to close Gate 6B.

**PHYSICAL DEVICE PROOF NOT YET EXECUTED.**
