# Gate 6C-D — Physical Android Evidence Qualification v1

Status: **CLOSED — Q01 PHYSICAL PASS ON SECOND PHYSICAL DEVICE; Q02/Q03/Q04/Q06/Q07/Q08/Q09/Q10/Q11/Q12/Q13 PHYSICAL PASS WITH Q08/Q13 STRICT AND Q12 LIMITED TO REAL_DEVICE_WRITE_FAILURE; Q05 NOT_APPLICABLE_UNDER_CURRENT_PRODUCTION_MANIFEST; LITERAL ENOSPC RESIDUAL GAP / NON-BLOCKING OWNER WAIVER; FORMER Q01 WAIVER SUPERSEDED AS CURRENT CLOSURE BASIS; NOT AN ALL-LITERAL-SCENARIOS PHYSICAL-PASS CLAIM**

This document governs the Project Owner's physical Android Evidence qualification for Gate 6C-D. Gate 6C-D is **CLOSED** on closure-governing base `1fef46731835e2640de9b11b88078b63bde3d918`. Subsequent reviewed physical evidence now establishes a valid normal Q01 Camera Commit **PHYSICAL PASS on a second real Android device using the exact same qualification APK**. The earlier Q01 owner-waiver decision remains durable engineering history but is `SUPERSEDED_AS_CURRENT_CLOSURE_BASIS_BY_SUBSEQUENT_Q01_PHYSICAL_PASS`. Closure documentation was merged through PR `#29` at merge SHA `f3839e65bd4258b1d673c71f4ec9cd2bcbfdec61`. This reconciliation does not begin Gate 6D executable implementation.

The first physical Camera candidate is historical failure evidence and remains so even after the later Q01 PASS:

- tested SHA: `d4f7f9f34a48202aea0639ab77b10b7f9262bd57`;
- verdict: **`FAIL — Q01 CAMERA PROCESS-DEATH RECOVERY`**;
- external Camera launched, the original application process died while Camera was foreground, and the application PID changed/recreated;
- after Camera completion, logcat reported `Unable to find a Capacitor plugin to handle requestCode ...`;
- `Restored Camera source = none`;
- SQLite Evidence row count remained `0`; Q08 reopened an intact but Evidence-empty synthetic database;
- cause of Android process death: **`UNKNOWN / UNESTABLISHED`**;
- technical qualification diagnosis: the tested `Camera.takePhoto()` / Camera v8.2.4 IonCameraFlow path did not demonstrate the required restoration behavior in that physical sequence.

The PROJECT-authorized narrow correction candidate routes Android `CAMERA_PHOTO` through the dependency's legacy `Camera.getPhoto()` URI path while preserving the existing EvidenceService/storage/SQLite architecture. Physical retest on exact SHA `560e5cf9c7b84554e79bb434afb6a662ac7d9376` produced a Q07 genuine process-death recovery PASS and an earlier Q13 durability/retrieval PASS. A later Q01 normal Camera Commit attempt on that physical-tested APK was interrupted by a real process death while Camera was active and therefore produced **no valid Q01 PASS**; that attempt remains historical `INTERRUPTED_PROCESS_DEATH_NO_PASS`, not a new proven product defect. Q02 on `560e5...` remains preserved as historical reproducible IonCamera Gallery failure evidence, but the project-owned native URI picker was subsequently physically retested on exact SHA `4ac992eb3fb4062ffbd3040db5ef967e3e126fd3` and **passed Q02**. Q03 then physically passed on the same `4ac992...` runtime/database without reset. Q04 on `4ac992...` physically demonstrated safe cancellation with zero row delta and no pending source, but the legacy `Camera.getPhoto()` cancellation was misclassified as `SOURCE_UNAVAILABLE`; that attempt remains historical **BLOCKED** evidence. The narrow classification correction on exact SHA `44a231a8281d1031a40e7105160c919633d32531` was then physically retested and **Q04 passed** with `USER_CANCELLED`, rows `0 → 0`, and no pending source.

Further physical qualification on APK `44a231a8281d1031a40e7105160c919633d32531` established PASS results for Q06, strict Q08, Q09, Q10, Q11, Q12 as `REAL_DEVICE_WRITE_FAILURE` only, and strict Q13. On the first physical environment, a Q01 attempt on this same APK ended in a broad Android process-death wave and remained `NO_PASS / BLOCKED_ON_FIRST_PHYSICAL_ENVIRONMENT`; root cause remains `UNKNOWN / UNESTABLISHED` and no product defect, impossibility, OOM/LMK, OPPO/ColorOS, Camera-plugin or USB cause is established. On a second physical Android device, the **same exact APK** subsequently produced a canonical normal-Q01 PASS. Host tests, GitHub Actions, or emulator runs do not erase or supersede physical evidence by themselves; each physical observation remains classified according to what it actually demonstrated.

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

Historical Camera-correction physical APK provenance:

- tested SHA: `560e5cf9c7b84554e79bb434afb6a662ac7d9376`;
- `app-debug.apk` SHA-256: `e855ff9d266dbfe22eca81fa2959939d71b62113640f1dd73c1332de6a22967d`;
- artifact ID: `10191115023`;
- artifact name: `gate6c-d-camera-correction-apk-560e5cf9c7b84554e79bb434afb6a662ac7d9376`;
- artifact ZIP SHA-256: `920df2197ca1fe42b5b5183f17950ef48f34b283b3fa274d772e020da0d047be`.

Physically tested Gallery-correction APK provenance for Q02/Q03 and the historical blocked Q04 attempt:

- tested SHA: `4ac992eb3fb4062ffbd3040db5ef967e3e126fd3`;
- artifact ID: `10273428748`;
- artifact name: `gate6c-d-gallery-correction-apk-4ac992eb3fb4062ffbd3040db5ef967e3e126fd3`;
- GitHub artifact ZIP SHA-256: `559d12d334890048404f57108ccd7cd5213baf8983c5c8a80cd20e3f6741f80a`;
- `app-debug.apk` SHA-256: `e67b64eec70b0e9610bb5ac744cb57cb2debd5e0eee13ac3609843163a815445`;
- local ZIP and APK hashes were verified before installation.

Current later-phase physically tested qualification APK provenance:

- tested SHA: `44a231a8281d1031a40e7105160c919633d32531`;
- artifact ID: `10280027500`;
- artifact name: `gate6c-d-gallery-correction-apk-44a231a8281d1031a40e7105160c919633d32531`;
- GitHub artifact ZIP SHA-256: `0d2dd011583c9bb188fe807477bca1137dfb453fd0928c5ea17b09c46205b50b`;
- `app-debug.apk` SHA-256: `d18d4eef683707e66c3aacae885d9d7871685f4bd0e869a74efca6bc5aee54f2`;
- the APK installed on the second device was independently hashed through ADB and matched this exact SHA-256.

First-device external evidence folder:

`https://drive.google.com/drive/folders/1nrBWWWwLHHjYO87CyGeYrvbzttMBZdv9?usp=drive_link`

Second-device Q01 evidence root:

`https://drive.google.com/drive/folders/1kWO4PXJutYyry_zl6u25abscK0iW2lPU?usp=drive_link`

Reviewed human-readable record:

`https://docs.google.com/document/d/1M91Csm83t-q6B2Xy254jvIWBh5qQlCYoJcHj-FXaZx8/edit`

For every scenario, copy the canonical JSON from the harness when it was actually preserved. The JSON intentionally omits raw acquisition URIs, raw resolve URIs, and device serials. Store physical evidence outside the repository until it has been reviewed for privacy. Never commit real source binaries or real inspection data. Do not invent hashes that were not independently recorded. Do not record device serial, IMEI, SIM identifiers, ADB GUID, local IP address, or other connection-identifying values.

## 4. Common setup

1. Launch the exact qualification APK.
2. Confirm the tested Git SHA displayed in the header matches the APK provenance.
3. Confirm runtime indicates native Android.
4. Press **Initialize / Reset Synthetic DB**.
5. Require `G6CD-SETUP-SYNTHETIC-OWNER` = `PASS`, an explicit synthetic Visit owner, Evidence readiness `READY`, and zero Evidence rows on a fresh reset.

Reset only when the scenario calls for a clean database. Do not reset between the two phases of a restart/reconciliation scenario because reset destroys the state being qualified.

## 5. Stable physical scenario matrix

| ID | Purpose | Physical action | Required result / current disposition |
|---|---|---|---|
| `G6CD-Q01-CAMERA-COMMIT` | Real Camera commit | Take a real disposable test photo | **PHYSICAL PASS on second real Android device using exact `44a231...` qualification APK; first-device blocked/no-pass attempts remain historical** |
| `G6CD-Q02-GALLERY-COMMIT` | Gallery/media commit | Select exactly one disposable image/video through the correction picker | **PHYSICAL PASS on `4ac992...`; no longer a blocker** |
| `G6CD-Q03-GENERIC-FILE-COMMIT` | SAF generic file | Select one disposable file through ACTION_OPEN_DOCUMENT | **PHYSICAL PASS on `4ac992...` after Q02 without DB reset** |
| `G6CD-Q04-CANCEL` | Real cancellation | Start Camera then cancel | **PHYSICAL PASS on `44a231...`; `USER_CANCELLED`; rows `0 → 0`; no pending source** |
| `G6CD-Q05-PERMISSION-DENIED` | Historical/conceptual permission-denial identity | No invalid revoke/prompt execution under current manifest | **`NOT_APPLICABLE_UNDER_CURRENT_PRODUCTION_MANIFEST` by Project Owner decision; not a physical PASS** |
| `G6CD-Q06-SOURCE-LOSS` | Lost volatile source | Acquire-only then make source unavailable externally | **PHYSICAL PASS; `E_EVIDENCE_SOURCE_UNAVAILABLE`; rows `1 → 1`; zero row delta** |
| `G6CD-Q07-RESTORED-CAMERA` | Genuine process death | Kill app process while external Camera is active, then return | **PHYSICAL PASS on `560e5...`; distinct from Q01** |
| `G6CD-Q08-RESTART-RECONCILIATION` | Startup reconciliation | Force-stop/relaunch with committed Evidence | **STRICT PHYSICAL PASS; explicit force-stop/relaunch; `MATCH`; `RESOLVED`** |
| `G6CD-Q09-ORPHAN-CLEANUP` | Zero-row orphan cleanup | Diagnostic publish without row, then restart | **PHYSICAL PASS; `orphanRemovedCount=1`; `ORPHAN_REMOVED`; zero orphan rows** |
| `G6CD-Q10-MISSING-FILE` | Missing historical file diagnosis | Delete app-private object externally with ADB after a valid commit | **PHYSICAL PASS; row retained; `BROKEN_STORAGE_REFERENCE`; fail closed** |
| `G6CD-Q11-LARGE-FILE` | Large-file streaming | Select a large generic file | **PHYSICAL PASS; exact `41943040` bytes; `MATCH`; `RESOLVED`** |
| `G6CD-Q12-WRITE-FAILURE` | Controlled real write failure | Make incoming directory temporarily non-writable | **PHYSICAL PASS for `REAL_DEVICE_WRITE_FAILURE` only; `enospcProven=false`; not ENOSPC PASS** |
| `G6CD-Q13-RETRIEVAL-AFTER-RESTART` | Durable retrieval | Restart after valid commit and retrieve by Evidence ID | **STRICT PHYSICAL PASS after independent explicit force-stop/relaunch** |

## 6. Q01 — Camera commit

1. Start from READY synthetic runtime.
2. Press **Q01 Camera Commit**.
3. Capture a disposable qualification photo and accept it.
4. A successful protocol execution requires JSON status `PASS`.
5. A successful protocol execution requires source kind `CAMERA_PHOTO`, a positive Evidence ID, canonical `evidence/v1/objects/...` ref, canonical SHA-256, file size > 0, hash verification `MATCH`, resolve `RESOLVED`, and one row for the committed Evidence proof.
6. Record the Evidence ID for Q08/Q10/Q13 where useful when a valid Q01 commit exists.

For the correction candidate, the production Camera acquisition path must be the project-authorized legacy `Camera.getPhoto()` URI path; Q01 semantics themselves are unchanged.

The photo is qualification-only. Do not photograph people, records, identifiers, or real inspection material.

### Historical correction-candidate Q01 attempt on `560e5...` — `INTERRUPTED_PROCESS_DEATH_NO_PASS`

This physical attempt used the qualification APK built from `560e5cf9c7b84554e79bb434afb6a662ac7d9376`. It is **not** a Q01 PASS and is **not** classified by itself as a new proven product defect.

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

This historical attempt remains `INTERRUPTED_PROCESS_DEATH_NO_PASS`; Q07 PASS remains separate.

### Historical first-device Q01 retest on `44a231...` — `NO_PASS / BLOCKED_ON_FIRST_PHYSICAL_ENVIRONMENT`

The first-device physical Q01 retest used qualification APK `44a231a8281d1031a40e7105160c919633d32531` from a clean synthetic DB:

- valid synthetic Visit owner before Camera;
- Evidence readiness `READY`;
- Evidence rows `0`.

After pressing **Q01 Camera Commit**, capturing a disposable photo and accepting it, the application later returned with:

- `Synthetic Visit owner = not reconstructed`;
- Evidence readiness `NOT_OPEN`;
- Volatile source `none`;
- a real restored Camera source from `getPhoto / CAMERA_PHOTO`;
- no canonical Q01 PASS result;
- no new Evidence row.

Logcat establishes:

- Q01 launched the external Camera from application PID `18964`;
- while Camera remained foreground, a broad wave of Android processes died;
- `com.scientifica.inspection.gate6bproof` PID `18964` died within that wave;
- Android later created a new application process PID `21912`;
- `system_server` remained alive, so the evidence does not show a full-device reboot;
- root cause of the process-death wave remains **`UNKNOWN / UNESTABLISHED`**.

Do not attribute this historical first-device event conclusively to the application, Camera plugin, cable, USB hardware, low memory, OOM/LMK, ColorOS policy, OPPO hardware, or another cause. A later meminfo snapshot reported approximately Total RAM `2,854,240K`, status `normal`, Free RAM `481,322K`, ZRAM physical `165,648K` for `787,104K` swap, and application PSS about `167,050K`; because this snapshot was captured after the event, it neither proves nor disproves the memory state at the moment of death. `dmesg` was unavailable: `dmesg: klogctl: Permission denied`. Android DropBox lowmem search returned `Searching for: lowmem` / `No entries found.` There is therefore no direct established OOM/LMK evidence.

Latest external diagnostic filenames in the first-device evidence folder include:

- `Q01-retest-01-restored-state.png`;
- `Q01-retest-02-restored-state.png`;
- `Q01-retest-03-restored-state.png`;
- `Q01-retest-logcat-full.txt`;
- `Q01-retest-meminfo-after-event.txt`;
- `Q01-retest-dmesg-after-event.txt`;
- `Q01-retest-dropbox-lowmem.txt`.

Raw screenshots/logs remain outside GitHub. No hashes are invented for these files.

The Project Owner previously accepted this state for closure as:

**`DOCUMENTED_NON_BLOCKING_PHYSICAL_QUALIFICATION_RESIDUAL_RISK / OWNER_WAIVER_FOR_GATE6C_D_CLOSURE`**.

That decision remains historical and valid as a record of what was authorized at that time. It never converted Q01 to PASS. Subsequent second-device physical evidence supersedes it as the **current** closure basis.

### Second-device Q01 successful retest on `44a231...` — CURRENT PHYSICAL PASS

The same exact qualification APK was installed on a second real physical Android device and independently verified:

- manufacturer: `Samsung`;
- model: `SM-M356B`;
- Android: `16`;
- API: `36`;
- tested Git SHA: `44a231a8281d1031a40e7105160c919633d32531`;
- expected APK SHA-256: `d18d4eef683707e66c3aacae885d9d7871685f4bd0e869a74efca6bc5aee54f2`;
- SHA-256 independently calculated from the APK actually installed through ADB: exact match.

No device serial, IMEI, SIM identifier, ADB GUID, local IP address, or other connection-identifying value is recorded in GitHub.

From READY synthetic runtime, normal external Samsung Camera execution produced canonical Q01 result:

- `scenarioId=G6CD-Q01-CAMERA-COMMIT`;
- `status=PASS`;
- `sourceKind=CAMERA_PHOTO`;
- `evidenceId=1`;
- `sqliteRowCount=1`;
- `acquisitionOutcome=SUCCESS`;
- `canonicalContentHash=true`;
- `canonicalStorageRef=true`;
- `contentHash=sha256:84f5a589b1b640dac6c057681c522b8c0e5725104b23c9a997f6284fe53b2ee2`;
- `fileSize=6801739`;
- `hashVerificationResult=MATCH`;
- `resolveResult.status=RESOLVED`;
- `resolveResult.handleScheme=content`;
- `storageRef=evidence/v1/objects/ce1b97c3-1a12-4d9b-9f65-df6ae123dfb4.jpg`;
- `testedGitSha=44a231a8281d1031a40e7105160c919633d32531`;
- `timestamp=2026-09-12T10:40:38.761Z`;
- runtime `android=true`, `native=true`, `platform=android`;
- owner `VISIT / 1`;
- readiness `READY`;
- scenario-level `physical_pass_claimed=true`.

Canonical JSON also reported one historical reconciliation classification:

- `kind=ORPHAN_REMOVED`;
- `storageRef=evidence/v1/objects/6d9832cf-7217-43c7-b1a0-83427703f036.jpg`.

That orphan belonged to an earlier execution. It is **not** the newly committed Q01 Evidence object and is **not** a Q01 failure.

Supplementary PID evidence during this successful round trip:

- application PID before Camera: `26910`;
- PID after Initialize / Reset Synthetic DB: `26910`;
- PID while external Samsung Camera was foreground: `26910`;
- PID after accepting the photo and returning to the application: `26910`.

Therefore **NO PROCESS DEATH WAS OBSERVED DURING THIS SUCCESSFUL Q01 ROUND TRIP**. PID continuity is supplementary physical evidence and is not retroactively added as a mandatory Q01 protocol criterion.

External evidence root:

`https://drive.google.com/drive/folders/1kWO4PXJutYyry_zl6u25abscK0iW2lPU?usp=drive_link`

Reviewed evidence record:

`https://docs.google.com/document/d/1M91Csm83t-q6B2Xy254jvIWBh5qQlCYoJcHj-FXaZx8/edit`

Current interpretation: a valid normal Q01 Camera commit has now been physically demonstrated on a second Android device using the exact same qualification APK. The former owner waiver remains historical but is **`SUPERSEDED_AS_CURRENT_CLOSURE_BASIS_BY_SUBSEQUENT_Q01_PHYSICAL_PASS`**.

## 7. Q02 — Gallery/media commit

The stable Q02 success contract remains unchanged: scenario ID `G6CD-Q02-GALLERY-COMMIT`, status `PASS`, source kind `GALLERY_MEDIA`, acquisition outcome `SUCCESS`, a positive Evidence ID, canonical storage ref/hash, file size > 0, hash verification `MATCH`, resolve status `RESOLVED`, and a committed SQLite row through the normal EvidenceService pipeline.

### Historical recorded physical failure — `Q02 FAIL / CORRECTION_REQUIRED` on `560e5...`

The physical failure was reproduced at least twice on the older physical correction APK built from exact SHA `560e5cf9c7b84554e79bb434afb6a662ac7d9376`. This remains historical negative evidence and is not rewritten by the later successful retest.

- Attempt A: PID `4875`, crash timestamp `2026-09-11 15:15:04`, after selecting a disposable JPEG from `/storage/emulated/0/DCIM/Screenshots/...jpg`.
- Attempt B: PID `6805`, crash timestamp `2026-09-11 15:16:13`, after selecting a disposable JPEG from `/storage/emulated/0/WhatsApp/Media/WhatsApp Images/...jpg`.
- Both attempts produced `java.io.FileNotFoundException: ... (Permission denied)`.
- An older Dropbox occurrence at `2026-09-11 09:18:11` showed the same failure pattern.

The confirmed dependency stack includes:

`android.media.ExifInterface`
→ `io.ionic.libs.ioncameralib.processor.IONCAMRMediaProcessor.createImageMediaResult`
→ `IONCAMRGalleryManager.onChooseFromGalleryResult`
→ `com.capacitorjs.plugins.camera.IonCameraFlow.processResultFromGallery`.

The historical direct qualification classification remains:

**`Q02 FAIL — REPRODUCIBLE DEPENDENCY CRASH IN chooseFromGallery / IonCamera POST-SELECTION PROCESSING`**

The crash occurred before EvidenceService received a usable Gallery source. It is not attributed to EvidenceService, SQLite, EvidenceStorage/hash processing, low memory, USB behavior, or process-death recovery. Raw crash/log files remain external and are not committed to GitHub.

### Q02 correction path

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

### Recorded physical retest — `ACCEPT — Q02 GALLERY COMMIT PHYSICAL RETEST PASSED`

Physical retest on the exact `4ac992...` APK passed:

- `scenarioId = G6CD-Q02-GALLERY-COMMIT`;
- `status = PASS`;
- `acquisitionOutcome = SUCCESS`;
- `sourceKind = GALLERY_MEDIA`;
- `canonicalContentHash = true`;
- `canonicalStorageRef = true`;
- `contentHash = sha256:863bedd52b2269ad33dd57d863c3055a3676a24ff3f9519237c7f8c99d483912`;
- `ownerKind = VISIT`; `ownerRef = 1`; `readiness = READY`;
- `evidenceId = 1`; `failureCode = null`; `failureStage = null`;
- `fileSize = 222222`;
- `hashVerificationResult = MATCH`;
- `resolveResult.handleScheme = content`; `resolveResult.status = RESOLVED`;
- `runtime.android = true`; `runtime.native = true`; `runtime.platform = android`;
- `sqliteRowCount = 1`;
- `storageRef = evidence/v1/objects/4fb1acd6-08d3-4f4d-b6d8-eed2bccd79c5.jpg`;
- `testedGitSha = 4ac992eb3fb4062ffbd3040db5ef967e3e126fd3`;
- timestamp `2026-09-11T18:05:18.517Z`.

The application PID remained `16121` before and after this Q02 attempt, so no process recreation was observed in this run. External physical evidence folder: `https://drive.google.com/drive/folders/1uFtiNs_bXYMmsADpzg7v4TMQ2ECTm4hl?usp=drive_link` containing at least `Q02.json`, a Google Doc named `Q02`, and supporting screenshots.

Q02 is **no longer a blocker**. The older `560e5...` failure remains historical evidence only.

## 8. Q03 — Generic file commit

1. Place a disposable non-sensitive test file in a provider accessible through Android's document picker.
2. Press **Q03 Generic File Commit**.
3. Select one file.
4. Require `PASS`, source kind `GENERIC_FILE`, canonical ref/hash, authoritative byte count, resolve proof, and committed row.

The external `content://` identifier is transient source authority only. The final `storage_ref` must never be an external URI.

### Recorded physical result — `ACCEPT — Q03 GENERIC FILE COMMIT PHYSICAL PASS`

Q03 was executed after the Q02 PASS **without resetting the database** on the exact `4ac992...` runtime. A non-sensitive PDF was selected through the Android document picker. Confirmed physical facts:

- `status = PASS`;
- Evidence row count `1 → 2`;
- new Evidence `ID = 2`;
- `bytes = 187387`;
- `storage_ref = evidence/v1/objects/b1e341a3-9b4f-4e16-9b81-c7ce6958e3f5.pdf`;
- `content_hash = sha256:4370b50c534ef391ba2380e002d2975e62377ab590b2463c8662882f30391eb6`;
- prior Q02 Evidence remained `ID = 1`, `bytes = 222222`, `content_hash = sha256:863bedd52b2269ad33dd57d863c3055a3676a24ff3f9519237c7f8c99d483912`.

A complete canonical Q03 JSON was **not preserved outside the conversation**, so no unobserved Q03 JSON fields are invented here.

## 9. Q04 — Real cancellation

The current package does not declare application-level `android.permission.CAMERA`; Q04 therefore exercises cancellation of the external Camera flow and does not depend on an application-level Camera permission prompt.

1. Press **Q04 Camera → Cancel**.
2. Cancel/back out of the real Camera operation without accepting an image.
3. Require `PASS`, acquisition outcome `USER_CANCELLED`, and identical rows-before/rows-after values.

### Historical recorded physical result on `4ac992...` — `Q04 BLOCKED — REAL CANCELLATION SAFE, LEGACY getPhoto CANCELLATION MISCLASSIFIED`

On the exact `4ac992...` physical APK, real Camera opened and the user returned/cancelled without capturing or accepting a photo. The harness reported:

- `status = BLOCKED`;
- `acquisitionOutcome = SOURCE_UNAVAILABLE`;
- `expectedOutcome = USER_CANCELLED`;
- `sqliteRowCount = 2`;
- `rowsBefore = 2`; `rowsAfter = 2`;
- `pendingSourceCreated = false`;
- `failureCode = null`.

Therefore the **safe behavior is correct**: no Evidence row was created, no row delta occurred, and no pending source was created. The classification was incorrect.

A diagnostic physical attempt after `adb logcat -c` established the observed legacy Camera error for this tested device/run:

`pluginId = Camera`, `methodName = getPhoto`, `success = false`, error message **`User cancelled photos app`**, with **no `error.code`**.

The decisive historical diagnostic log line was of the form:

`Sending plugin error: {"save":false,"callbackId":"...","pluginId":"Camera","methodName":"getPhoto","success":false,"error":{"message":"User cancelled photos app"}}`

This observation is specific to the physically tested legacy `getPhoto` behavior and must not be generalized to all devices or Camera errors. The `4ac992...` result remains historical **BLOCKED** evidence and is not rewritten by the later correction/retest.

### Recorded physical retest — `ACCEPT — Q04 REAL CAMERA CANCELLATION PHYSICAL RETEST PASSED`

The Project Owner physically retested `G6CD-Q04-CANCEL` on the exact APK built from `44a231a8281d1031a40e7105160c919633d32531` after the narrow cancellation-classification correction.

Precondition/setup was physical and clean:

- synthetic Visit owner = `1`;
- Evidence readiness = `READY`;
- fresh/reset synthetic database;
- committed Evidence rows = `0`;
- setup = `PASS`.

Physical sequence and canonical result:

- Project Owner pressed **Q04 Camera → Cancel**;
- real external OPPO Camera opened;
- no photo was captured or accepted;
- the Camera operation was cancelled and control returned to the qualification app;
- `status = PASS`;
- `acquisitionOutcome = USER_CANCELLED`;
- `expectedOutcome = USER_CANCELLED`;
- `rowsBefore = 0`; `rowsAfter = 0`;
- `pendingSourceCreated = false`;
- no Evidence row was inserted and no pending source was created.

Physical log evidence establishes that Android `android.media.action.IMAGE_CAPTURE` launched `com.oppo.camera/.Camera`, focus moved from the qualification app to OPPO Camera, and focus then returned to the qualification app. A later logged death of process `com.oppo.camera` concerns the **external OPPO Camera process**, not `com.scientifica.inspection.gate6bproof`; this retest must not be described as process death of the qualification application.

The preserved Q04 retest logcat did **not** preserve the exact Capacitor text `User cancelled photos app`. No claim is made that it did. That absence does not change the physical PASS because the harness itself returned `USER_CANCELLED`, zero row delta, and no pending source.

External reviewed physical evidence folder: `https://drive.google.com/drive/folders/1oQ1iEhkDu25q-E9Fujat-MLHf1uiMJm9?usp=drive_link`.

Verified external files include `Q04-physical-pass-44a231.png`, `Q04-logcat-44a231.txt`, the exact artifact ZIP, and `app-debug.apk`. GitHub stores only reviewed metadata/hashes and this external folder link; raw physical evidence binaries are not committed.

- `Q04-physical-pass-44a231.png` SHA-256: `41a9444dfb53162c5b1dc70843a7725a8685c93c81f5783f9bf0972860604d9a`;
- `Q04-logcat-44a231.txt` SHA-256: `329d927b25ea425d2d684525bff98ef0a387083c4cb2e14de5527a1f6fd7a2ea`.

Q04 is now **PHYSICAL PASS on `44a231...`** and no longer awaits physical retest. This does not alter the historical Q01/Q02/Q04 attempts.

## 10. Q05 — Permission-denial scenario identity and current Owner disposition

Scenario identity remains **`G6CD-Q05-PERMISSION-DENIED`** for historical/conceptual traceability.

### Historical protocol-review state

The earlier qualification protocol required `adb shell pm revoke com.scientifica.inspection.gate6bproof android.permission.CAMERA` and expected an application-level Camera permission prompt. The current production/qualification package manifest does **not** declare `android.permission.CAMERA`; therefore that revoke/prompt sequence was classified `PROTOCOL_REVIEW_REQUIRED / NOT YET PHYSICALLY EXERCISABLE UNDER CURRENT MANIFEST`. That historical protocol finding remains preserved.

### Project Owner disposition — 2026-09-12

Current Q05 status is:

**`NOT_APPLICABLE_UNDER_CURRENT_PRODUCTION_MANIFEST`**.

Meaning:

- the current production/qualification manifest does not declare application-level `android.permission.CAMERA`;
- external Camera can launch without an application-level Camera permission prompt;
- the old revoke/prompt scenario is not a realistic executable test under the current manifest;
- do not synthesize/mock denial and do not record a synthetic PASS;
- do not add `android.permission.CAMERA` merely to manufacture a denial scenario;
- no Q05 physical PASS is claimed;
- this resolves the prior protocol-review question by Project Owner decision, not by changing product behavior.

## 11. Q06 — Source loss

Use a disposable source that can actually be removed or invalidated after selection.

1. Press **Q06 Acquire Generic File Only** and select the disposable source.
2. Confirm the UI shows a volatile pending ID/kind and that no Evidence row was added.
3. Outside the app, delete/move/revoke the selected source so the original URI can no longer be opened. Provider behavior varies; verify that the source is genuinely unavailable.
4. Return to the still-running harness and press **Commit Pending as Q06**.
5. Require `PASS`, failure code `E_EVIDENCE_SOURCE_UNAVAILABLE`, and rows-before = rows-after.

If the provider keeps the source readable and the commit succeeds, the source-loss condition was not established. That run is not a Q06 PASS; use a source/provider where loss can be demonstrated.

### Recorded current physical result — PASS

- `status = PASS`;
- `failureCode = E_EVIDENCE_SOURCE_UNAVAILABLE`;
- rows `1 → 1`;
- `zeroEvidenceRowDelta = true`;
- no Evidence ID;
- no storage ref;
- hash verification `NOT_RUN`;
- resolve `NOT_RUN`.

Q06 is no longer pending.

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

This PASS validates the Q07 correction path only. Historical Q01 failures/no-pass attempts remain historical, while current Q01 PASS is established independently by the second-device normal Q01 execution.

## 13. Q08 — Restart/reconciliation

Protocol:

1. Create at least one valid committed Evidence object.
2. Record its Evidence ID/ref/hash/size.
3. Force-stop the app:

```sh
adb shell am force-stop com.scientifica.inspection.gate6bproof
```

4. Relaunch the APK.
5. Press **Q08 Reopen + Reconcile**.
6. Require the same synthetic DB/Visit is reconstructed, normal Evidence startup reconciliation runs, committed objects classify as valid, and readiness is `READY`.
7. For committed Evidence used in this scenario, require retrieval/resolve succeeds, SHA-256 verifies `MATCH`, and persisted size/hash/ref metadata match the reopened object.

A reset between steps 3 and 5 invalidates this scenario.

### Historical reopen/reconciliation observation after Q02/Q03 — not strict Q08 protocol PASS

After closing and later reopening the application during the `4ac992...` qualification sequence, the initial UI state was `Synthetic Visit owner = not reconstructed`, `Evidence readiness = NOT_OPEN`, `Volatile source = none`, `Restored Camera source = none`. Pressing **Q08 Reopen + Reconcile** reconstructed owner `1`, returned readiness `READY`, and the already committed Q02 Evidence ID `1` remained present; after Q03 there were two committed rows.

That historical observation did not record the protocol-required preceding force-stop and therefore remains non-strict historical evidence.

### Recorded current Q08 result — STRICT PHYSICAL PASS

A later independent execution used a real explicit `adb shell am force-stop com.scientifica.inspection.gate6bproof`, relaunched the qualification app, ran normal reconciliation, and demonstrated that the same committed Evidence survived. Hash verification was `MATCH` and resolve was `RESOLVED`.

Q08 is therefore **STRICT PHYSICAL PASS**. The earlier non-strict observation remains historical and is not rewritten.

## 14. Q09 — Diagnostic zero-row orphan cleanup

1. Start READY.
2. Press **Q09 Acquire Orphan Source** and select a disposable generic file.
3. Press **Publish Pending as Q09 Zero-Row Orphan**.
4. Require the intermediate JSON shows a canonical published object, `zeroRowOrphanPublished=true`, final object exists, and SQLite row count for that storage ref is zero. Intermediate status remains `BLOCKED` because cleanup has not yet been exercised.
5. Force-stop and relaunch the app.
6. Press **Q09 Reopen + Normal Orphan Cleanup**.
7. Require normal `EvidenceService` reconciliation reports at least one `ORPHAN_REMOVED`, confirms zero rows for the removed orphan, returns readiness `READY`, and Q09 status `PASS`.

No diagnostic cleanup button exists; the cleanup algorithm under test is the closed normal reconciliation path.

### Recorded current Q09 result — PHYSICAL PASS

- a zero-row orphan was physically published;
- after restart, normal reconciliation removed it;
- `orphanRemovedCount=1`;
- classification `ORPHAN_REMOVED`;
- zero SQLite rows remained for the removed orphan;
- existing valid Evidence remained intact.

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

### Recorded current Q10 result — PHYSICAL PASS

- a private final object was deliberately removed after a valid historical commit;
- the SQLite row remained exactly once;
- reconciliation classified `BROKEN_STORAGE_REFERENCE`;
- resolve failed closed with `E_EVIDENCE_BROKEN_STORAGE_REFERENCE`;
- no silent repair or replacement occurred.

## 16. Q11 — Large file bounded-memory behavior

Gate 6C-C already proved the native 64-KiB streaming buffer and a 32-MiB executable case. Gate 6C-D adds real-device qualification.

1. Prepare a non-sensitive disposable large file. A file clearly larger than the prior 32-MiB synthetic case is preferred when practical; do not impose a product file-size cap.
2. Press **Q11 Acquire Large File** and select it via the generic file picker.
3. Press **Commit Pending as Q11**.
4. Require `PASS`, authoritative final byte count, canonical SHA-256, canonical ref, and committed row.
5. Force-stop/relaunch and run Q13 for that Evidence ID.
6. Require restart retrieval/hash verification `PASS`.

The production path must not Base64 or otherwise transport the entire binary through JavaScript.

### Recorded current Q11 result — PHYSICAL PASS

- file size: exact `41943040` bytes (40 MiB);
- Evidence ID `1`;
- `storage_ref=evidence/v1/objects/605c1422-83d6-4ecd-8d0d-df911542ef2d.bin`;
- `content_hash=sha256:80a3721188e40218b08b26776bc53bdae81e4784fff71d71450a197319cba113`;
- hash verification `MATCH`;
- resolve `RESOLVED`.

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

### Recorded current Q12 result — PHYSICAL PASS for `REAL_DEVICE_WRITE_FAILURE` only

- `status=PASS`;
- `failureCode=E_EVIDENCE_STORAGE_WRITE_FAILED`;
- `writeFailureVariant=REAL_DEVICE_WRITE_FAILURE`;
- `enospcProven=false`;
- rows `1 → 1`;
- zero Evidence-row delta;
- physical execution temporarily set `files/evidence/v1/.incoming` to mode `500`;
- the directory was restored immediately to mode `700` after the controlled write-failure attempt;
- restoration was verified as `drwx------`;
- this permission manipulation and verified restoration do **not** prove literal ENOSPC.

This is **not** literal ENOSPC PASS.

### Project Owner literal-ENOSPC disposition — 2026-09-12

Literal `REAL_DEVICE_ENOSPC` remains:

**`DOCUMENTED_RESIDUAL_GAP / NON_BLOCKING_OWNER_WAIVER`**.

Do not fill or destabilize the Project Owner's device storage merely to force ENOSPC. The residual evidence gap is documented and non-blocking by owner waiver, but `enospcProven=false` must remain explicit.

## 18. Q13 — Retrieval after restart

Protocol:

1. Use a valid committed Evidence ID, preferably the Q11 large-file Evidence.
2. Force-stop and relaunch the app without reset.
3. Enter the Evidence ID.
4. Press **Q13 Retrieve After Restart**.
5. Require startup reconciliation sees a valid reference, row/ref/size/hash metadata remain present, hash verification is `MATCH`, resolve succeeds, and status is `PASS`.

### Historical Q13 durability/retrieval result on `560e5cf9...`

For Evidence ID `1`, the earlier observed run reported: `sqliteRowCount=1`, `validReferenceAfterRestart=true`, `metadataSurvivedRestart=true`, reconciliation `VALID_REFERENCE`, hash verification `MATCH`, resolve `RESOLVED`, and the same `storageRef`, content hash, and `fileSize=4984630` survived.

External evidence: `https://drive.google.com/drive/folders/1_5aypRPoBtZbooKvQdp-PncIuV4VfeFi?usp=drive_link`.

That historical Q13 result followed a real runtime recreation after leaving the qualification app for Drive but did **not** record an explicit force-stop. It remains valid historical durability evidence and is not rewritten.

### Recorded current Q13 result — STRICT PHYSICAL PASS

A later independent Q13 execution used an explicit force-stop/relaunch after Q11. The Evidence metadata survived with the same:

- `storage_ref=evidence/v1/objects/605c1422-83d6-4ecd-8d0d-df911542ef2d.bin`;
- `content_hash=sha256:80a3721188e40218b08b26776bc53bdae81e4784fff71d71450a197319cba113`;
- file size `41943040`.

Reconciliation classified `VALID_REFERENCE`; hash verification was `MATCH`; resolve was `RESOLVED`.

Q13 is therefore **STRICT PHYSICAL PASS**. The earlier non-strict Q13 evidence remains historical.

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
- durable committed Evidence survived, as the historical Q13 result demonstrates;
- Q02 physical PASS on `4ac992...` retained PID `16121` before and after the attempt, so no process recreation occurred in this Q02 run;
- the Q04 physical PASS on `44a231...` launched Android `android.media.action.IMAGE_CAPTURE` into `com.oppo.camera/.Camera`, moved focus from the qualification app to the external OPPO Camera, then returned focus to the qualification app after cancellation;
- the later logged death of `com.oppo.camera` in the Q04 evidence concerns the external Camera process and is **not** qualification-app process death evidence;
- the preserved Q04 retest logcat did not retain the exact Capacitor text `User cancelled photos app`; the Q04 PASS rests on the harness result `USER_CANCELLED`, rows `0 → 0`, and no pending source;
- the older normal Q01 Camera Commit attempt on `560e5...` physically proved `PID 27313 → process died → PID 28843` while external Camera was active; its process-death cause remains **`UNKNOWN / UNESTABLISHED`**;
- the first-device Q01 Camera Commit retest on `44a231...` launched external Camera from PID `18964`; a broad Android process-death wave occurred while Camera remained foreground; app PID `18964` died within the wave; Android later created app PID `21912`; `system_server` remained alive. Cause remains **`UNKNOWN / UNESTABLISHED`**;
- later first-device meminfo values do not establish event-time OOM/LMK; `dmesg` was denied and DropBox lowmem search had no entries. No direct OOM/LMK evidence is established;
- after the first-device incident Android recorded `UsbDeviceManager: try set disable adb`, `Setting USB config to midi`, and later `Setting USB config to mtp,adb`. This proves ADB was disabled and later re-enabled and is consistent with the Project Owner's observed computer disconnect/reconnect;
- the first-device USB/ADB observation does **not** establish a causal relationship between Q01/Camera and USB mode switching;
- on the second device, the successful Q01 round trip retained application PID `26910` before Camera, after initialization/reset, while external Samsung Camera was foreground, and after return; no process death was observed;
- second-device PID continuity is supplementary evidence and not a mandatory protocol requirement;
- do not use the second-device success to infer a defect in OPPO hardware, ColorOS, memory handling, Camera plugin, cable, USB, or any other first-device component;
- root cause of the first-device process-death observations remains **`UNKNOWN / UNESTABLISHED`**.

These are qualification-environment observations, not established product defects.

## 21. Gate acceptance boundary / current Project Owner disposition

Historical negative evidence remains historical and is not rewritten:

- `d4f7...` remains **FAIL — Q01 CAMERA PROCESS-DEATH RECOVERY** with cause `UNKNOWN / UNESTABLISHED`;
- the `560e5...` normal-Q01 attempt remains historical `INTERRUPTED_PROCESS_DEATH_NO_PASS`;
- the first-device `44a231...` Q01 attempt remains **`NO_PASS / BLOCKED_ON_FIRST_PHYSICAL_ENVIRONMENT`**, with root cause `UNKNOWN / UNESTABLISHED`, no established product defect and no impossibility claim;
- Q02 IonCamera failure on `560e5...` remains historical FAIL;
- Q04 cancellation on `4ac992...` remains historical BLOCKED;
- the earlier Q08 reopen/reconcile observation remains non-strict historical evidence;
- the earlier Q13 durability run remains historical non-strict-force-stop evidence.

Current physical qualification matrix:

- Q01: **PHYSICAL PASS ON SECOND PHYSICAL DEVICE**; scenario-level `physical_pass_claimed=true`; same exact qualification APK `44a231...`; installed APK hash matched; canonical Evidence commit succeeded; no process death observed in that successful round trip.
- Q02: **PHYSICAL PASS**.
- Q03: **PHYSICAL PASS**.
- Q04: **PHYSICAL PASS**.
- Q05: **`NOT_APPLICABLE_UNDER_CURRENT_PRODUCTION_MANIFEST`** by Project Owner decision; not physical PASS.
- Q06: **PHYSICAL PASS**.
- Q07: **PHYSICAL PASS**.
- Q08: **STRICT PHYSICAL PASS**.
- Q09: **PHYSICAL PASS**.
- Q10: **PHYSICAL PASS**.
- Q11: **PHYSICAL PASS**.
- Q12: **PHYSICAL PASS for `REAL_DEVICE_WRITE_FAILURE` only**; `enospcProven=false`.
- Q13: **STRICT PHYSICAL PASS**.
- literal `REAL_DEVICE_ENOSPC`: **`DOCUMENTED_RESIDUAL_GAP / NON_BLOCKING_OWNER_WAIVER`**, not ENOSPC PASS.

Current closure interpretation:

- Gate 6C-D remains **CLOSED**.
- Gate 6C remains **CLOSED** because Gate 6C-A, 6C-B, 6C-C and 6C-D are all closed.
- The former Q01 closure waiver remains durable history but is **`SUPERSEDED_AS_CURRENT_CLOSURE_BASIS_BY_SUBSEQUENT_Q01_PHYSICAL_PASS`**.
- Current Gate 6C-D closure basis includes accepted Q01 second-device physical PASS evidence, Q05 N/A owner disposition, the accepted Q02/Q03/Q04/Q06/Q07/Q08/Q09/Q10/Q11/Q12/Q13 evidence, and literal ENOSPC non-blocking owner waiver.
- `physical_device_pass_claimed` remains false at Gate 6C-D level only because Q05 is N/A rather than PASS and literal ENOSPC remains unproven; it is **not** false because of Q01.
- Gate 6D remains **NEXT / NOT_STARTED**; `gate6d_started=false`; this reconciliation does not start Gate 6D executable implementation.
- `field_usable_v1=false`.

Closure documentation is merged through PR `#29` at merge SHA `f3839e65bd4258b1d673c71f4ec9cd2bcbfdec61`. Repository merge provenance is now recorded; no further `PENDING_MERGE` claim applies to this closure.
