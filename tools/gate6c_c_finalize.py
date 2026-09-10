from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise SystemExit(f"missing expected marker: {label}")
    return text.replace(old, new, 1)


build_gradle = Path("android/app/build.gradle")
text = build_gradle.read_text(encoding="utf-8")
text = text.replace('    ndkVersion "27.0.12077973"\n', "")
native_block = """    externalNativeBuild {
        cmake {
            path file('src/main/cpp/CMakeLists.txt')
            version '3.22.1'
        }
    }
"""
text = replace_once(text, native_block, "", "externalNativeBuild")
build_gradle.write_text(text, encoding="utf-8")

for raw in (
    "android/app/src/main/java/com/scientifica/inspection/gate6bproof/Gate6CAtomicPublisher.java",
    "android/app/src/main/cpp/gate6c_atomic_publish.c",
    "android/app/src/main/cpp/CMakeLists.txt",
):
    path = Path(raw)
    if path.exists():
        path.unlink()

state_json = Path("docs/project/CURRENT-STATE.json")
text = state_json.read_text(encoding="utf-8")
text = replace_once(
    text,
    '"current_substage_status": "NEXT_NOT_STARTED"',
    '"current_substage_status": "IN_PROGRESS_IMPLEMENTATION_REVIEW"',
    "current_substage_status",
)
text = replace_once(
    text,
    '"gate_6c_status": "IN_PROGRESS_6C_A_CLOSED_MERGED_6C_B_CLOSED_MERGED_6C_C_NEXT_NOT_STARTED",',
    '"gate_6c_status": "IN_PROGRESS_6C_A_CLOSED_MERGED_6C_B_CLOSED_MERGED_6C_C_IN_PROGRESS_IMPLEMENTATION_REVIEW",\n  "gate6c_c_started": true,',
    "gate_6c_status",
)
text = replace_once(
    text,
    '"6C Evidence Storage + Camera/File Pipeline — IN_PROGRESS / 6C-A CLOSED / MERGED / 6C-B CLOSED / MERGED / 6C-C NEXT / NOT_STARTED"',
    '"6C Evidence Storage + Camera/File Pipeline — IN_PROGRESS / 6C-A CLOSED / MERGED / 6C-B CLOSED / MERGED / 6C-C IN_PROGRESS / IMPLEMENTATION_REVIEW"',
    "roadmap 6C-C",
)
state_json.write_text(text, encoding="utf-8")

state_md = Path("docs/project/CURRENT-STATE.md")
text = state_md.read_text(encoding="utf-8")
text = replace_once(
    text,
    "Gates 1→5L و6A و6B مغلقة/معتمدة/مدمجة كما هو موثق في history. Gate 6C-A وGate 6C-B مغلقتان/مدمجتان كـsub-stages، بينما Gate 6C ككل ما تزال IN_PROGRESS وGate 6C-C هي المرحلة التالية ولم تبدأ.",
    "Gates 1→5L و6A و6B مغلقة/معتمدة/مدمجة كما هو موثق في history. Gate 6C-A وGate 6C-B مغلقتان/مدمجتان كـsub-stages، بينما Gate 6C ككل ما تزال IN_PROGRESS وGate 6C-C قيد التنفيذ في حالة IMPLEMENTATION_REVIEW.",
    "human state overview",
)
text = replace_once(
    text,
    "الحالة: **`NEXT / NOT_STARTED`**.\n\nلم يبدأ تنفيذ Camera/gallery/generic-file Android adapters، ولا `content://` streaming/copy spikes، ولا `appRestoredResult`، ولا durable Android EvidenceStorage. تتطلب 6C-C تفويضًا مستقلًا قبل التنفيذ.",
    "الحالة: **`IN_PROGRESS / IMPLEMENTATION_REVIEW`**.\n\nبدأ تنفيذ Android Camera/gallery/generic-file acquisition وdurable EvidenceStorage وتم الوصول إلى executable emulator qualification على API24 وAPI35، بما في ذلك full EvidenceService integration وstartup reconciliation. سجل الإثبات المرشح: `docs/architecture/GATE6C-C-ANDROID-EVIDENCE-QUALIFICATION-v1.md`. هذه الحالة لا تعني إغلاق Gate 6C-C ولا تمثل Gate 6C-D physical qualification.",
    "human 6C-C status",
)
state_md.write_text(text, encoding="utf-8")

proof = Path("docs/architecture/GATE6C-C-ANDROID-EVIDENCE-QUALIFICATION-v1.md")
proof.write_text("""# Gate 6C-C — Android Evidence Adapter Candidate Qualification v1

Status: **IN_PROGRESS / IMPLEMENTATION_REVIEW**  
Classification: **PROJECT / executable qualification evidence**  
Gate 6C-C is **not CLOSED**. Gate 6C-D physical qualification has **not started**.

## 1. Scope and governing boundary

Governing live-main basis for this qualification sequence: `976b48106824f84f0dbbbca82832cbad4e53afb7`.

Gate 6C-C qualifies Android Camera/gallery/generic-file acquisition seams and durable app-private `EvidenceStorage` against the already-closed Gate-6C-A storage contract and Gate-6C-B Evidence orchestration. Gate 6C-C does not reopen `src/application/**`, `src/bootstrap/**`, the canonical schema, or canonical bootstrap.

The adopted publication candidate is the composite guarded Android `Os.rename` sequence in `Gate6CEvidenceStore`: allocate a fresh canonical destination, preflight destination absence, stage and hash a complete object, check destination absence again immediately before publication, execute `Os.rename`, verify the published object, then rely on the closed application transaction/reconciliation protocol for cross-store convergence.

Its exact concurrency/threat boundary is the Gate-6C-A boundary: in-contract Evidence maintenance/write operations are serialized by the shared single-process Evidence boundary and storage is app-private. It does **not** claim syscall-level `RENAME_NOREPLACE` protection against privileged/root/direct external filesystem mutation or arbitrary out-of-contract concurrent writers. SQLite's transactional `storage_ref` recheck, startup reconciliation, and hash verification remain part of the composite safety model.

## 2. Native Evidence qualification

Executable Android instrumentation on Web-runtime compatibility candidate `8bcfb86815e668a4f62e89c868e0f0d292369d76`, workflow run `34519077891`:

- API 24: **18 / 18 PASS**.
- API 35: **18 / 18 PASS**.

The native suite proves canonical lowercase UUID-v4 refs, synthetic `content://` streaming copy with a fixed **64-KiB** buffer, incremental SHA-256, `file_size` from actual copied bytes, large-input bounded-memory behavior, byte-for-byte preservation of a pre-existing destination, before/after-rename interruption behavior, and reopen/stat/hash/resolve of the published app-private object.

The production Evidence binary does not traverse JavaScript as Base64, `Blob`, `ArrayBuffer`, or `Uint8Array`; the adopted production path has no JNI binary transport.

## 3. Full EvidenceService integration qualification

Run `34519077891` executed the production Vite bundle and exact `Gate6CEvidenceIntegrationInstrumentedTest` class on both emulator levels.

### API 24

- selected provider: `com.android.chrome 69.0.3497.100`;
- provider-switch command result: `Success`;
- `GATE6C_INTEGRATION_TEST_START`, `Starting 2 tests`, `Finished 2 tests`, `BUILD SUCCESSFUL`, and `GATE6C_INTEGRATION_TEST_COMPLETE` were observed;
- completion marker and in-test assertion used exact Git SHA `8bcfb86815e668a4f62e89c868e0f0d292369d76`;
- result: **2 / 2 PASS**.

### API 35

- actual provider: `com.android.webview 124.0.6367.219`;
- the same start/test-count/build-success/completion markers were observed;
- exact tested Git SHA: `8bcfb86815e668a4f62e89c868e0f0d292369d76`;
- result: **2 / 2 PASS**.

The normal integration path asserts:

`synthetic content://` → closed `EvidenceService` → Android `EvidenceStorage` → complete stage / actual-byte size / SHA-256 → publication → `BEGIN IMMEDIATE` → Evidence INSERT → successful COMMIT → close SQLite/runtime → reopen the same SQLite → startup reconciliation → reopened metadata match → `verifyHash = MATCH` → managed FileProvider `content://` resolution.

The diagnostic deliberately supplies `sizeHint = 1`; persisted `file_size` equals the independently measured source byte count. Event recording requires `storage.publish.complete` before `db.beginImmediate.start`, publication before `db.evidenceInsert.start`, Evidence INSERT before successful `db.commit.complete`, and successful COMMIT.

## 4. Real zero-row orphan reconciliation proof

The second full integration test proves:

complete stage → successful rename publication → injected stop before any Evidence row is committed → exact SQLite lookup proves zero rows for that `storage_ref` → close/recreate runtime → **closed Gate-6C-B `EvidenceService` / `EvidenceApplicationContext` startup reconciliation** → zero-row final orphan detected → cleanup through the existing reconciliation contract → readiness `READY` → orphan final absent → still zero Evidence rows.

No native direct deletion substitutes for this proof. The path passed on API24 and API35 in run `34519077891`.

## 5. Web runtime compatibility decision

The preceding API24 run with the `es2022` production target failed before proof registration with `Uncaught SyntaxError: Unexpected token ?` on the usable Chrome 69 provider. Classification: `API24_WEB_RUNTIME_BUILD_TARGET_INCOMPATIBILITY`, not an Evidence/native/storage contradiction.

Focused production-build result: **`WEB_RUNTIME_COMPATIBILITY_SPIKE_PASS`**.

- Vite `8.2.2`;
- candidate production target `chrome69`;
- no `@vitejs/plugin-legacy`;
- no speculative polyfills;
- passing-spike assets included `index-B-a16-81.js`, `web-RjdCDqQr.js`, `web-BLj64B_g.js`, and `index-DerZeG6_.css`;
- main JS `505.06 kB` (`126.65 kB` gzip), versus preceding `es2022` candidate `501.60 kB` (`125.55 kB` gzip): `+3.46 kB` raw, `+1.10 kB` gzip;
- authoritative proof is execution of both integration tests in the actual API24 Chrome 69 WebView, not syntax grep.

`minSdkVersion = 24` is the Android OS/native floor. Separately, production JavaScript is compiled for Chrome 69+ syntax compatibility. This is a **PROJECT/runtime compatibility decision**, not an official inspection-source requirement. Supporting this syntax floor is not a recommendation to deploy insecure or end-of-life Android/WebView software.

## 6. Rejected candidates retained as historical findings

- **`RENAMEAT2_NOREPLACE_REJECTED_FOR_API24_BASELINE`** — API24 executable result: **`ENOSYS (38)`**. The JNI/C syscall candidate is rejected and removed from production.
- Android `Os.link` — **REJECTED / `EACCES`**. It is not the production publication primitive.
- **`FILESYSTEM_PLUGIN_REJECTED_FOR_EVIDENCE_STORAGE`** — `@capacitor/filesystem@8.1.3` did not expose a primitive-level no-replace publication contract sufficient for the EvidenceStorage publication proof. It is removed from `package.json` and `package-lock.json`; final Capacitor sync must not load Filesystem.

## 7. Security, permissions, and qualification limit

- `minSdkVersion` remains **24**.
- Evidence storage remains app-private.
- no `READ_EXTERNAL_STORAGE`, `WRITE_EXTERNAL_STORAGE`, or `MANAGE_EXTERNAL_STORAGE` permission is introduced.
- imported files are copied through the bounded read-only acquisition path into managed app-private storage.
- qualification data is synthetic only; no real Evidence, production database, personal data, device serial, or secret is used.
- emulator API24/API35 evidence is **not** physical Gate-6C-D qualification.

## 8. Candidate disposition

Gate 6C remains **IN_PROGRESS**. Gate 6C-A and Gate 6C-B remain **CLOSED / MERGED**. Gate 6C-C advances only to **IN_PROGRESS / IMPLEMENTATION_REVIEW** with `gate6c_c_started = true`. Gate 6C-D and Gate 6D remain **NOT_STARTED**.

A completely new exact-final-SHA CI run is required after cleanup, dependency removal, workflow removal, proof, and state update. Final run/APK artifact identifiers are reported in the implementation handoff rather than embedded here because this document itself is part of the SHA that the final run qualifies.
""", encoding="utf-8")
