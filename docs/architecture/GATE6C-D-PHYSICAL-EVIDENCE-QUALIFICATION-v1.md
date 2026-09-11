# Gate 6C-D — Physical Android Evidence Qualification v1

Status: **OPEN / IN_PROGRESS — PHYSICAL QUALIFICATION IN PROGRESS; Q01 INTERRUPTED / NO PASS; Q02 FAIL / CORRECTION_REQUIRED / PHYSICAL RETEST REQUIRED; Q05 PROTOCOL_REVIEW_REQUIRED; Q07 PASS + CURRENT Q13 PASS**

This document governs the Project Owner's physical Android Evidence qualification for Gate 6C-D. It does **not** close Gate 6C-D, does **not** close Gate 6C, and does **not** begin Gate 6D.

The first physical Camera candidate is historical failure evidence and remains so even if a later correction passes:

- tested SHA: `d4f7f9f34a48202aea0639ab77b10b7f9262bd57`;
- verdict: **`FAIL — Q01 CAMERA PROCESS-DEATH RECOVERY`**;
- external Camera launched, the original application process died while Camera was foreground, and the application PID changed/recreated;
- after Camera completion, logcat reported `Unable to find a Capacitor plugin to handle requestCode ...`;
- `Restored Camera source = none`;
- SQLite Evidence row count remained `0`; Q08 reopened an intact but Evidence-empty synthetic database;
- cause of Android process death: **`UNKNOWN / UNESTABLISHED`**;
- technical qualification diagnosis: the tested `Camera.takePhoto()` / Camera v8.2.4 IonCameraFlow path did not demonstrate the required restoration behavior in that physical sequence.

The PROJECT-authorized narrow correction candidate routes Android `CAMERA_PHOTO` through the dependency's legacy `Camera.getPhoto()` URI path while preserving the existing EvidenceService/storage/SQLite architecture. Physical retest on exact SHA `560e5cf9c7b84554e79bb434afb6a662ac7d9376` has produced a Q07 genuine process-death recovery PASS and current Q13 durability/retrieval PASS. A later Q01 normal Camera Commit attempt on the same physical-tested APK was interrupted by a real process death while Camera was active and therefore produced **no valid Q01 PASS**; that attempt is recorded below as `INTERRUPTED_PROCESS_DEATH_NO_PASS`, not as a new product defect. Q02 on that same physical-tested APK reproducibly crashed in the dependency's Gallery post-selection path and remains `FAIL / CORRECTION_REQUIRED` pending physical retest of the project-owned native URI picker. Q05's previous permission-denial protocol is not executable under the current manifest and now requires separate protocol review. Host tests, GitHub Actions, or emulator runs cannot erase or supersede physical evidence by themselves.

The APK must visibly show:

`GATE 6C-D PHYSICAL EVIDENCE QUALIFICATION — NOT FIELD UI`

## 1. Evidence classes must remain separate

Three evidence classes exist and must not be conflated:

1. **Automated host/CI evidence** — typecheck, host regressions, closed baselines, canonical hash guards, production build, Android build, dependency/plugin guards and APK provenance.
2. **Emulator evidence** — repeat execution of the closed Gate-6C-C native EvidenceStorage and full EvidenceService Android integration proofs on API 24 and API 35.
3. **Physical-device evidence** — the Project Owner executes Q01→Q13 against the exact qualification APK on a real Android device. Only this class can qualify Gate 6C-D physical behavior.

A green GitHub Actions run is evidence that the harness and preserved automated contracts build and execute. It is **not** a physical Gate-6C-D PASS.

## 2. Scope and data policy

Use only synthetic qualification data created by the harness. Do not use a real Mission, Institution, Visit, inspection photo, operational Evidence, personal data, or sensitive data.

Successful Evidence creation uses the closed production seams:

`CapacitorEvidenceSourceAcquisition`
→ `EvidenceService`
→ `CapacitorEvidenceStorage`
→ native Gate6C Evidence adapter
→ SQLite `evidence` row.

Two diagnostic states are intentionally special:

- acquisition-only holds an `EvidenceSource` in volatile process memory only; it is not written into SQLite or a sidecar authority;
- Q09 may stage→publish a test object without inserting an Evidence row, solely to create the exact zero-row orphan state that normal startup reconciliation is designed to remove.

No second Evidence engine, cleanup algorithm, schema migration, server, backend, or sync layer is authorized.

## 3. Package and evidence handling

The debug package is `com.scientifica.inspection.gate6bproof`.

Before physical execution, record:

- APK artifact ID and exact artifact name;
- Git commit SHA shown by the harness;
- SHA-256 of the actual `app-debug.apk`;
- GitHub artifact ZIP SHA-256 digest;
- Android version/API level of the test device, without recording the device serial number.

Install the exact correction APK under qualification. Do not substitute the failed `d4f7...` APK or an older Gate-6C-C APK.

Current physically tested correction APK provenance remains historical physical evidence:

- tested SHA: `560e5cf9c7b84554e79bb434afb6a662ac7d9376`;
- `app-debug.apk` SHA-256: `e855ff9d266dbfe22eca81fa2959939d71b62113640f1dd73c1332de6a22967d`;
- artifact ID: `10191115023`;
- artifact name: `gate6c-d-camera-correction-apk-560e5cf9c7b84554e79bb434afb6a662ac7d9376`;
- artifact ZIP SHA-256: `920df2197ca1fe42b5b5183f17950ef48f34b283b3fa274d772e020da0d047be`.

The Gallery correction branch produces a newer exact-SHA APK candidate through CI. That newer APK does not become physical PASS evidence until the Project Owner performs the required physical Q02 retest.

For every scenario, copy the canonical JSON from the harness. The JSON intentionally omits raw acquisition URIs, raw resolve URIs, and device serials. Store physical evidence outside the repository until it has been reviewed for privacy. Never commit real source binaries or real inspection data.

## 4. Common setup

1. Launch the exact qualification APK.
2. Confirm the tested Git SHA displayed in the header matches the APK provenance.
3. Confirm runtime indicates native Android.
4. Press **Initialize / Reset Synthetic DB**.
5. Require `G6CD-SETUP-SYNTHETIC-OWNER` = `PASS`, an explicit synthetic Visit owner, Evidence readiness `READY`, and zero Evidence rows on a fresh reset.

Reset only when the scenario calls for a clean database. Do not reset between the two phases of a restart/reconciliation scenario because reset destroys the state being qualified.

## 5. Stable physical scenario matrix

| ID | Purpose | Physical action | Required result / current protocol status |
|---|---|---|---|
| `G6CD-Q01-CAMERA-COMMIT` | Real Camera commit | Take a real disposable test photo | Production commit; canonical ref/hash; bytes; resolve proof; one row |
| `G6CD-Q02-GALLERY-COMMIT` | Gallery/media commit | Select exactly one disposable image/video through the correction picker | Same production proof; current physical status remains `FAIL / CORRECTION_REQUIRED` until retest |
| `G6CD-Q03-GENERIC-FILE-COMMIT` | SAF generic file | Select one disposable file through ACTION_OPEN_DOCUMENT | Same production proof |
| `G6CD-Q04-CANCEL` | Real cancellation | Start Camera then cancel | `USER_CANCELLED`; zero row delta |
| `G6CD-Q05-PERMISSION-DENIED` | Real permission denial | **Do not execute current invalid revoke/prompt protocol** | `PROTOCOL_REVIEW_REQUIRED / NOT YET PHYSICALLY EXERCISABLE UNDER CURRENT MANIFEST` |
| `G6CD-Q06-SOURCE-LOSS` | Lost volatile source | Acquire-only then make source unavailable externally | safe source-unavailable failure; zero row delta |
| `G6CD-Q07-RESTORED-CAMERA` | Genuine process death | Kill app process while external Camera is active, then return | real restored `getPhoto` pending; no auto-row; explicit owner + Adopt; production commit |
| `G6CD-Q08-RESTART-RECONCILIATION` | Startup reconciliation | Force-stop/relaunch with committed Evidence | normal reconciliation, resolve/hash/metadata proof |
| `G6CD-Q09-ORPHAN-CLEANUP` | Zero-row orphan cleanup | Diagnostic publish without row, then restart | normal reconciliation reports/removes orphan; zero row remains |
| `G6CD-Q10-MISSING-FILE` | Missing historical file diagnosis | Delete app-private object externally with ADB after a valid commit | row retained; `BROKEN_STORAGE_REFERENCE`; no repair/replacement |
| `G6CD-Q11-LARGE-FILE` | Large-file streaming | Select a large generic file | no whole-binary JS path; byte size/hash correct; commit succeeds |
| `G6CD-Q12-WRITE-FAILURE` | Controlled real write failure | Make incoming directory temporarily non-writable | `STORAGE_WRITE_FAILED`; zero row delta; classify as write failure, not ENOSPC |
| `G6CD-Q13-RETRIEVAL-AFTER-RESTART` | Durable retrieval | Restart after valid commit and retrieve by Evidence ID | row/ref/bytes/hash/resolve survive restart |

## 6. Q01 — Camera commit

1. Start from READY synthetic runtime.
2. Press **Q01 Camera Commit**.
3. Capture a disposable qualification photo and accept it.
4. Require JSON status `PASS`.
5. Require source kind `CAMERA_PHOTO`, a positive Evidence ID, canonical `evidence/v1/objects/...` ref, canonical SHA-256, file size > 0, hash verification `MATCH`, resolve `RESOLVED`, and one row for the committed Evidence proof.
6. Record the Evidence ID for Q08/Q10/Q13 where useful.

For the correction candidate, the production Camera acquisition path must be the project-authorized legacy `Camera.getPhoto()` URI path; Q01 semantics themselves are unchanged.

The photo is qualification-only. Do not photograph people, records, identifiers, or real inspection material.

### Recorded correction-candidate Q01 attempt — `INTERRUPTED_PROCESS_DEATH_NO_PASS`

This physical attempt used the same qualification APK provenance above, built from `560e5cf9c7b84554e79bb434afb6a662ac7d9376`. It is **not** a Q01 PASS and is **not** classified by itself as a new proven product defect.

Pre-attempt runtime after Q08 was valid:

- Synthetic Visit owner = `1`;
- Evidence readiness = `READY`;
- committed Evidence count = `1`;
- existing committed Evidence remained Evidence ID `1`.

Observed sequence after pressing **Q01 Camera Commit**:

- production Camera acquisition used `Camera.getPhoto`;
- external Camera activity opened normally;
- a disposable non-sensitive qualification photo was captured and accepted;
- application PID executing Q01 was `27313`;
- while external Camera was active, PID `27313` died;
- Android later recreated the application as PID `28843`;
- exact OS/root cause for killing PID `27313` remains **`UNKNOWN / UNESTABLISHED`**.

After recreation, the qualification UI showed:

- Synthetic Visit owner = `not reconstructed`;
- Evidence readiness = `NOT_OPEN`;
- Volatile source = `none`;
- Restored Camera source = real `restored-... / getPhoto / CAMERA_PHOTO`;
- Q01 result fields were empty;
- canonical JSON was `{}` / no Q01 result was produced;
- no new Evidence row was committed; committed Evidence count remained `1`.

The captured physical log was preserved externally as `gate6cd-q01-normal-camera-failure-logcat.txt`. The raw log is **not** committed to GitHub pending explicit privacy review. The log establishes only the process transition `PID 27313 → process died → PID 28843`; it does not establish a more specific Android kill reason.

Without closing or resetting the app, **Q08 Reopen + Reconcile** was then executed. It reconstructed owner `1` and readiness `READY`; the same restored Camera source remained pending; no automatic Evidence row was created. The restored source was deliberately **not** adopted through Q07, because doing so would convert the interrupted Q01 attempt into a Q07 recovery/adoption scenario. The Project Owner pressed **Discard Restored Source** instead.

Final state after discard:

- owner = `1`;
- readiness = `READY`;
- volatile source = `none`;
- restored Camera source = `none`;
- committed Evidence count = `1`.

Qualification interpretation:

- Q01 still requires a normal direct Camera commit that produces an actual Q01 `PASS` result;
- this attempt is classified **`Q01 NORMAL CAMERA COMMIT — INTERRUPTED BY REAL PROCESS DEATH; NO Q01 PASS PRODUCED`** / `INTERRUPTED_PROCESS_DEATH_NO_PASS`;
- Q07 genuine process-death recovery remains a separately qualified path and its existing PASS is unchanged; Q07 PASS does not substitute for Q01 PASS;
- the observed restored-source behavior is consistent with the existing recovery contract: it remains uncommitted until owner reconstruction plus explicit adoption, or explicit discard;
- this observation alone does not establish a new defect in EvidenceService or the restored-result coordinator;
- do not auto-attach restored Camera sources and do not bypass explicit owner reconstruction/adoption semantics.

Q01 therefore remains **UNRESOLVED / INTERRUPTED BY PROCESS DEATH / NO PASS PRODUCED**. Do not infer that Q01 is impossible on this device; this physical attempt simply did not produce a valid Q01 PASS.

## 7. Q02 — Gallery/media commit

The stable Q02 success contract remains unchanged: a successful physical retest must produce scenario ID `G6CD-Q02-GALLERY-COMMIT`, status `PASS`, source kind `GALLERY_MEDIA`, acquisition outcome `SUCCESS`, a positive Evidence ID, canonical storage ref/hash, file size > 0, hash verification `MATCH`, resolve status `RESOLVED`, and a committed SQLite row through the normal EvidenceService pipeline.

### Recorded physical failure — `Q02 FAIL / CORRECTION_REQUIRED`

The physical failure was reproduced at least twice on the already-recorded physical correction APK built from exact SHA `560e5cf9c7b84554e79bb434afb6a662ac7d9376`. That historical APK provenance must not be rewritten by the later Gallery correction candidate.

- Attempt A: PID `4875`, crash timestamp `2026-09-11 15:15:04`, after selecting a disposable JPEG from `/storage/emulated/0/DCIM/Screenshots/...jpg`.
- Attempt B: PID `6805`, crash timestamp `2026-09-11 15:16:13`, after selecting a disposable JPEG from `/storage/emulated/0/WhatsApp/Media/WhatsApp Images/...jpg`.
- Both attempts produced `java.io.FileNotFoundException: ... (Permission denied)`.
- An older Dropbox occurrence at `2026-09-11 09:18:11` showed the same failure pattern.

The confirmed dependency stack includes:

`android.media.ExifInterface`
→ `io.ionic.libs.ioncameralib.processor.IONCAMRMediaProcessor.createImageMediaResult`
→ `IONCAMRGalleryManager.onChooseFromGalleryResult`
→ `com.capacitorjs.plugins.camera.IonCameraFlow.processResultFromGallery`.

The direct qualification classification is:

**`Q02 FAIL — REPRODUCIBLE DEPENDENCY CRASH IN chooseFromGallery / IonCamera POST-SELECTION PROCESSING`**

The crash occurs before EvidenceService receives a usable Gallery source. It must not be attributed to EvidenceService, SQLite, EvidenceStorage/hash processing, low memory, USB behavior, or process-death recovery. The app's native-crash Dropbox / `data_app_native_crash` evidence contained no corresponding native crash entry for this application. Any unrelated `dumpsys` SIGSEGV observed during diagnostics must not be attributed to the application. Raw crash/log files remain external and are not committed to GitHub.

### Q02 correction candidate

Production Q02 no longer uses `Camera.chooseFromGallery()` and does not use `Camera.pickImages()`. Gallery/media acquisition is routed through the project-owned native `Gate6CEvidence` plugin using Android system document/media URI semantics:

- `Intent.ACTION_OPEN_DOCUMENT`;
- `Intent.CATEGORY_OPENABLE`;
- image/video MIME filtering (`image/*`, `video/*`);
- exactly one item;
- read-only URI grant;
- selected authority retained as `content://` or `file://`;
- one `ContentResolver.openInputStream(uri)` readability probe that is closed immediately;
- no raw filesystem DATA-path lookup;
- no `ExifInterface` on external raw paths;
- no Base64, `webPath`, or whole-object Java/JavaScript buffering;
- no `READ_EXTERNAL_STORAGE` or `WRITE_EXTERNAL_STORAGE` permission;
- no dependency upgrade/fork and no Filesystem plugin.

After acquisition, the existing `EvidenceSource` → `EvidenceService` → `CapacitorEvidenceStorage` → app-private object → SQLite row path remains unchanged. The native picker itself does not create an Evidence row.

Physical retest is mandatory. Q02 remains **`FAIL / CORRECTION_REQUIRED / PHYSICAL_RETEST_REQUIRED`** until a new exact-SHA Gallery correction APK passes the stable Q02 contract above on a real Android device. Automated CI/emulator PASS does not synthesize or substitute a physical PASS.

## 8. Q03 — Generic file commit

1. Place a disposable non-sensitive test file in a provider accessible through Android's document picker.
2. Press **Q03 Generic File Commit**.
3. Select one file.
4. Require `PASS`, source kind `GENERIC_FILE`, canonical ref/hash, authoritative byte count, resolve proof, and committed row.

The external `content://` identifier is transient source authority only. The final `storage_ref` must never be an external URI.

## 9. Q04 — Real cancellation

The current package does not declare application-level `android.permission.CAMERA`; Q04 should therefore exercise cancellation of the external Camera flow and must not depend on an application-level Camera permission prompt.

1. Press **Q04 Camera → Cancel**.
2. Cancel/back out of the real Camera operation without accepting an image.
3. Require `PASS`, acquisition outcome `USER_CANCELLED`, and identical rows-before/rows-after values.

## 10. Q05 — Real permission denial

Scenario identity remains **`G6CD-Q05-PERMISSION-DENIED`**, but its current execution protocol is:

**`PROTOCOL_REVIEW_REQUIRED / NOT YET PHYSICALLY EXERCISABLE UNDER CURRENT MANIFEST`**.

The current qualification package manifest does **not** declare `android.permission.CAMERA`. Therefore the previous instruction to execute:

`adb shell pm revoke com.scientifica.inspection.gate6bproof android.permission.CAMERA`

and then expect an application-level Camera permission prompt is not a valid guaranteed protocol for this package and must not be used.

Under the current manifest, external Camera launch can occur without an application-level `CAMERA` permission prompt. Consequently:

- do not synthesize a denial event and do not mark Q05 PASS from a mocked/synthetic error;
- do not add `android.permission.CAMERA` merely to make Q05 exercisable as part of this Q02 Gallery correction;
- do not change Camera acquisition routing in this task;
- Q05 requires a separate narrow design/Project Owner decision defining a valid physical permission-denial protocol or a deliberately permission-enabled qualification build;
- this Q05 protocol limitation does not block acceptance of the narrow Q02 executable correction candidate itself;
- Gate 6C-D remains open and Q05 remains unresolved until that separate protocol decision and physical exercise occur.

No Q05 physical PASS is claimed by this document.

## 11. Q06 — Source loss

Use a disposable source that can actually be removed or invalidated after selection.

1. Press **Q06 Acquire Generic File Only** and select the disposable source.
2. Confirm the UI shows a volatile pending ID/kind and that no Evidence row was added.
3. Outside the app, delete/move/revoke the selected source so the original URI can no longer be opened. Provider behavior varies; verify that the source is genuinely unavailable.
4. Return to the still-running harness and press **Commit Pending as Q06**.
5. Require `PASS`, failure code `E_EVIDENCE_SOURCE_UNAVAILABLE`, and rows-before = rows-after.

If the provider keeps the source readable and the commit succeeds, the source-loss condition was not established. That run is not a Q06 PASS; use a source/provider where loss can be demonstrated.

## 12. Q07 — Genuine Camera process death / appRestoredResult

This scenario must exercise Android/Capacitor lifecycle restoration. Do **not** inject `acceptRestoredEvent()` from the UI. The failed `d4f7...` physical sequence must remain available as negative historical evidence; this section defines the independent retest of the correction candidate.

1. Start from initialized synthetic state and note the current total Evidence row count.
2. Press **Q07 Start Camera — Kill App While Camera Active**. The external Camera activity must be visible.
3. While Camera is foreground and the app process is background, record the current application PID for external evidence. The originally documented command was:

```sh
adb shell am kill com.scientifica.inspection.gate6bproof
```

On the tested OPPO/ColorOS build this command was rejected with `SecurityException` / missing `KILL_BACKGROUND_PROCESSES`. The debug package did permit:

```sh
adb shell run-as com.scientifica.inspection.gate6bproof id
```

Therefore an approved **physical-qualification fallback** is:

```sh
PID=$(adb shell pidof com.scientifica.inspection.gate6bproof | tr -d '\r')
adb shell run-as com.scientifica.inspection.gate6bproof kill -9 "$PID"
```

Use this fallback only when all of the following are true: `run-as` succeeds for this debug package; external Camera is foreground; the old PID is captured; immediate post-kill `pidof` proves that old process disappeared; after Camera completion a new PID is observed. Do **not** substitute `am force-stop` for Q07 because force-stop changes stopped-package/activity semantics. This fallback is qualification tooling only and must not become production behavior. Do not commit the device serial number to GitHub.

4. Complete/accept the Camera operation.
5. Verify Android recreated the application process (new PID) and relaunch the qualification APK only if the system does not automatically recreate it.
6. Require the **Restored Camera source** field to show a pending ID, method `getPhoto`, and source kind `CAMERA_PHOTO`.
7. Confirm no Evidence row has been created automatically.
8. Press **Q08 Reopen + Reconcile** to explicitly reconstruct/select the synthetic Visit owner and establish normal Evidence readiness. This must not consume the restored source.
9. Require the restored pending source is still shown and still reports method `getPhoto`.
10. Press **Q07 Explicit Adopt to Synthetic Visit**.
11. Require Q07 `PASS`, explicit owner reconstruction, exactly one new committed Evidence row, canonical ref/hash, resolve/hash proof.
12. Force-stop/relaunch again and run Q13 against the new Evidence ID; require durable retrieval/hash/resolve `PASS`.

Discard is also exposed and must remove the volatile restored source without attaching it anywhere.

If restored source remains `none`, requestCode/plugin mapping fails again, or adoption cannot complete through the normal EvidenceService pipeline, Q07 remains `FAIL`; do not replace this with a synthetic restored event.

### Recorded Q07 correction result — physical PASS on `560e5cf9...`

The controlled genuine process-death run produced:

- physically observed Camera method: `getPhoto`;
- old application PID: `20398`;
- controlled `run-as` SIGKILL: succeeded;
- immediate `pidof`: no PID;
- recreated application PID: `25602`;
- real `appRestoredResult`: `pluginId=Camera`, `methodName=getPhoto`, `success=true`;
- restored source: `getPhoto / CAMERA_PHOTO`;
- before adoption: owner not reconstructed; readiness `NOT_OPEN`;
- Q08 Reopen + Reconcile: owner `1`, readiness `READY`, restored pending source retained;
- Q07 Explicit Adopt: **PASS**;
- `evidenceId=1`; `rowsBeforeAdopt=0`; `rowsAfterAdopt=1`;
- `acquisitionOutcome=RESTORED_SUCCESS`; `restoredMethodName=getPhoto`; `explicitOwnerReconstruction=true`;
- hash verification `MATCH`; resolve `RESOLVED`; `fileSize=4984630`; canonical storage-ref/content-hash flags true;
- `storageRef=evidence/v1/objects/b0b4c6e0-c5b6-45d4-be2b-eb55ae06dc7a.jpg`;
- `contentHash=sha256:e73171389429fa084b9188246f67852dbf96c73c82d3698082ce6b12b45cabc4`.

External physical evidence: `https://drive.google.com/drive/folders/1rsZkAJZkK1UyjrZETdgUyB9B_-lpRdiS?usp=drive_link`.

This PASS validates the Q07 correction path only. It does not convert the historical `d4f7...` Q01 failure to PASS and does not substitute for the still-unresolved normal Q01 Camera Commit requirement.

## 13. Q08 — Restart/reconciliation

1. Create at least one valid committed Evidence object (Q01/Q02/Q03).
2. Record its Evidence ID/ref/hash/size.
3. Force-stop the app:

```sh
adb shell am force-stop com.scientifica.inspection.gate6bproof
```

4. Relaunch the APK.
5. Press **Q08 Reopen + Reconcile**.
6. Require the same synthetic DB/Visit is reconstructed, normal Evidence startup reconciliation runs, committed objects classify as valid, and readiness is `READY`.
7. For each committed Evidence used in this scenario, require retrieval/resolve succeeds, SHA-256 verifies `MATCH`, and persisted size/hash/ref metadata match the reopened object.

A reset between steps 3 and 5 invalidates this scenario.

## 14. Q09 — Diagnostic zero-row orphan cleanup

1. Start READY.
2. Press **Q09 Acquire Orphan Source** and select a disposable generic file.
3. Press **Publish Pending as Q09 Zero-Row Orphan**.
4. Require the intermediate JSON shows a canonical published object, `zeroRowOrphanPublished=true`, final object exists, and SQLite row count for that storage ref is zero. Intermediate status remains `BLOCKED` because cleanup has not yet been exercised.
5. Force-stop and relaunch the app.
6. Press **Q09 Reopen + Normal Orphan Cleanup**.
7. Require normal `EvidenceService` reconciliation reports at least one `ORPHAN_REMOVED`, confirms zero rows for the removed orphan, returns readiness `READY`, and Q09 status `PASS`.

No diagnostic cleanup button exists; the cleanup algorithm under test is the closed normal reconciliation path.

## 15. Q10 — Missing-file diagnosis

Create a valid committed Evidence first. Record its Evidence ID and canonical `storage_ref`.

Delete the app-private final object externally with ADB/run-as, substituting the exact canonical ref displayed by the harness:

```sh
adb shell run-as com.scientifica.inspection.gate6bproof rm "files/evidence/v1/objects/<uuid-v4>.<ext>"
```

If the device's `run-as` starts in another working directory, first inspect only the debug package's sandbox with:

```sh
adb shell run-as com.scientifica.inspection.gate6bproof pwd
```

Then use the correct app-private path. Do not add a production deletion API to manufacture this state.

After deletion:

1. Force-stop and relaunch the app.
2. Enter the historical Evidence ID in the Q10/Q13 input.
3. Press **Q10 Diagnose Missing File**.
4. Require the SQLite row remains exactly once, reconciliation contains `BROKEN_STORAGE_REFERENCE`, the final object is missing, resolve fails with the closed broken-reference error, and no replacement/silent repair occurs.

## 16. Q11 — Large file bounded-memory behavior

Gate 6C-C already proved the native 64-KiB streaming buffer and a 32-MiB executable case. Gate 6C-D adds real-device qualification.

1. Prepare a non-sensitive disposable large file. A file clearly larger than the prior 32-MiB synthetic case is preferred when practical; do not impose a product file-size cap.
2. Press **Q11 Acquire Large File** and select it via the generic file picker.
3. Press **Commit Pending as Q11**.
4. Require `PASS`, authoritative final byte count, canonical SHA-256, canonical ref, and committed row.
5. Force-stop/relaunch and run Q13 for that Evidence ID.
6. Require restart retrieval/hash verification `PASS`.

The production path must not Base64 or otherwise transport the entire binary through JavaScript.

## 17. Q12 — Safe real write failure; literal ENOSPC remains separate

Do **not** fill the Project Owner's storage.

A bounded debug-package technique is to make only the Gate-6C incoming directory temporarily non-writable after acquiring the source but before staging:

1. Press **Q12 Acquire Write-Failure Source** and select a disposable generic file.
2. From ADB, inspect the debug sandbox if needed, then temporarily remove write permission from the incoming directory:

```sh
adb shell run-as com.scientifica.inspection.gate6bproof chmod 500 files/evidence/v1/.incoming
```

3. Press **Commit Pending as Q12**.
4. Require failure code `E_EVIDENCE_STORAGE_WRITE_FAILED`, zero Evidence-row delta, and JSON details:
   - `writeFailureVariant = REAL_DEVICE_WRITE_FAILURE`
   - `enospcProven = false`
5. Immediately restore the directory permission even if the scenario failed:

```sh
adb shell run-as com.scientifica.inspection.gate6bproof chmod 700 files/evidence/v1/.incoming
```

If this device/filesystem does not allow the controlled permission failure to be established, report `BLOCKED` and restore normal permissions.

This scenario does **not** prove literal low-storage/ENOSPC. `REAL_DEVICE_ENOSPC` remains an explicit physical qualification gap unless it can be reproduced safely without filling or destabilizing the owner's device. Never relabel a controlled permission/write failure as ENOSPC.

## 18. Q13 — Retrieval after restart

1. Use a valid committed Evidence ID, preferably one from Q11 for the large-file end-to-end proof.
2. Force-stop and relaunch the app without reset.
3. Enter the Evidence ID.
4. Press **Q13 Retrieve After Restart**.
5. Require startup reconciliation sees a valid reference, row/ref/size/hash metadata remain present, hash verification is `MATCH`, resolve succeeds, and status is `PASS`.

### Recorded current Q13 durability/retrieval result — PASS on `560e5cf9...`

For Evidence ID `1`, the observed run reported: `sqliteRowCount=1`, `validReferenceAfterRestart=true`, `metadataSurvivedRestart=true`, reconciliation `VALID_REFERENCE`, hash verification `MATCH`, resolve `RESOLVED`, and the same `storageRef`, content hash, and `fileSize=4984630` survived.

External evidence: `https://drive.google.com/drive/folders/1_5aypRPoBtZbooKvQdp-PncIuV4VfeFi?usp=drive_link`.

Qualification nuance: this Q13 PASS followed a real runtime recreation observed after leaving the qualification app for Drive. This exact run did **not** record an explicit `adb shell am force-stop`. Preserve it as physical durability evidence, but do not claim it satisfied the strict force-stop mechanism for that exact execution. A later strict Q13 repetition after Q11 may still be required by this versioned protocol.

## 19. Machine-readable result requirements

Every copied scenario JSON uses schema:

`gate6c-d-physical-evidence-qualification-v1`

and includes at least:

- stable scenario ID;
- tested Git SHA embedded into the production bundle;
- runtime platform/native/Android indication;
- UTC timestamp;
- acquisition outcome;
- Evidence ID when applicable;
- storage ref plus canonical-ref flag when applicable;
- authoritative file size;
- content hash plus canonical-hash flag;
- reconciliation classifications;
- resolve result (scheme/status only in GitHub-safe JSON);
- hash verification result;
- relevant SQLite row count;
- `PASS`, `FAIL`, or `BLOCKED`;
- failure stage/code where applicable.

The local UI may display an app-private resolve handle for manual qualification, but GitHub-intended canonical JSON must not include raw source URI contents, device serials, or other sensitive URI payloads.

## 20. Physical test-environment observations

Record these separately from product verdicts:

- repeated switching from the qualification app to Google Drive was followed by the qualification UI returning to `owner=not reconstructed`, `readiness=NOT_OPEN`, `volatile source=none`, `restored source=none`; this is consistent with runtime/process recreation, but every occurrence was not independently PID-proven;
- durable committed Evidence survived, as the Q13 result demonstrates;
- a later normal Q01 Camera Commit attempt physically proved a spontaneous application process transition `PID 27313 → process died → PID 28843` while external Camera was active; the process-death cause remains **`UNKNOWN / UNESTABLISHED`** and this observation is not by itself a product-defect verdict;
- during one ADB/logcat sequence ColorOS logged `isUsbActive=false`, then `try set disable adb`, then `Setting USB config to midi`, after which the log ended / ADB disconnected;
- the trigger for `isUsbActive=false` remains **`UNKNOWN / UNESTABLISHED`**;
- do not attribute these observations conclusively to cable quality, low memory, ColorOS task management, USB hardware, the application, Camera app, or any other cause without evidence.

These are qualification-environment observations, not established product defects.

## 21. Gate acceptance boundary

The first physical candidate failed and remains historical failure evidence. The correction candidate now has partial physical qualification evidence, but Gate 6C-D is not self-closing:

- historical `d4f7...` verdict remains **FAIL — Q01 CAMERA PROCESS-DEATH RECOVERY** and its Android process-death cause remains `UNKNOWN / UNESTABLISHED`;
- correction-candidate Q01 normal Camera Commit is **UNRESOLVED / INTERRUPTED BY PROCESS DEATH / NO PASS PRODUCED** (`INTERRUPTED_PROCESS_DEATH_NO_PASS`); it is not a PASS and does not establish a new proven product defect by itself;
- Q02 is **FAIL / CORRECTION_REQUIRED / PHYSICAL_RETEST_REQUIRED** until the project-owned native Gallery URI picker passes a new physical `G6CD-Q02-GALLERY-COMMIT` execution;
- Q05 is **PROTOCOL_REVIEW_REQUIRED / NOT YET PHYSICALLY EXERCISABLE UNDER CURRENT MANIFEST**; no synthetic denial may substitute for a real protocol and no CAMERA permission is added by this Q02 correction;
- Q07 correction path on `560e5cf9...` remains recorded as physical **PASS**;
- current Q13 durability/retrieval evidence on `560e5cf9...` remains recorded as **PASS** with the actual runtime-recreation mechanism stated above;
- Q03/Q04/Q06, formal committed-Evidence Q08 restart, Q09/Q10/Q11/Q12 remain pending;
- literal ENOSPC remains a named qualification gap;
- Gate 6C remains `IN_PROGRESS`;
- Gate 6C-D remains `OPEN / IN_PROGRESS`, not accepted/closed;
- Gate 6D remains `NOT_STARTED`;
- `field_usable_v1=false`.

No PR or merge is implied by this document. Independent review must evaluate the exact correction branch/head, APK provenance, and physical-device evidence before any Gate 6C-D closure decision.
