# ENGINEERING DECISIONS AND INCIDENTS — Inspection_Mission_001

> **Purpose:** durable index of engineering decisions, significant failures, rejected candidates, root causes, corrections, and consequences that future humans/AI must not reconstruct from chat history.
>
> **Authority rule:** this file is an index, not a replacement for canonical contracts, executable artifacts, Git history, `CURRENT-STATE`, or proof documents. Where an entry links to a more detailed record, the detailed record remains authoritative for its scope.
>
> **Classification:** preserve `DIRECT / DERIVED / PROJECT`. Do not attribute PROJECT decisions to official inspection sources.

## 1) Recording rules

Create or update an entry when a failure/decision has future engineering value, especially when it changes a contract interpretation, compatibility floor, threat boundary, workflow rule, accepted baseline, or rejected implementation path.

Each entry should contain, when applicable:

- **ID / date / Gate**;
- **type**: `DECISION`, `INCIDENT`, `CORRECTION`, or combined;
- **status**: `OPEN`, `RESOLVED`, `REJECTED`, `ADOPTED`, `HISTORICAL`, etc.;
- **classification**: `DIRECT`, `DERIVED`, `PROJECT`, or a clear combination;
- **problem or decision**;
- **evidence**;
- **root cause or rationale**;
- **decision / resolution**;
- **consequences / guards**;
- **validation / closure evidence**;
- **authoritative references**.

If a root cause was not established, record `UNKNOWN / UNESTABLISHED`. A later PASS does not rewrite an earlier FAIL/BLOCKED result; historical evidence remains historical.

---

## DEC-001 — GitHub `main` is the official persistent project memory

- **Date:** 2026-09-09
- **Gate:** project governance
- **Type:** DECISION
- **Status:** ADOPTED
- **Classification:** PROJECT
- **Decision:** live GitHub `main` + authoritative artifacts inside it are the official persistent engineering/project memory. Chat memory, external handoff prompts, stale feature branches, or implementation-agent reports are not authoritative by themselves.
- **Rationale:** the project must be transferable between humans/AI without depending on conversation history.
- **Consequences / guards:** Fresh Read of live `main` before substantive decisions; actual diff/files/CI must be inspected for implementation-sensitive work; state drift in handoff docs must be corrected before it compounds.
- **References:** `START-HERE.md`; `docs/project/WORKFLOW.md`; project-memory hardening merge history beginning at `17803cd96f1c83be60528fb2544b9d7e7a6c7526`.

## DEC-002 — Default implementation workflow = ChatGPT + GitHub + GitHub Actions

- **Date:** 2026-09-09
- **Gate:** project governance / HNT tooling evaluation
- **Type:** DECISION
- **Status:** ADOPTED
- **Classification:** PROJECT
- **Decision:** default execution path is `ChatGPT + GitHub + GitHub Actions`; Harness/local execution remains `ON_DEMAND_ONLY` for capabilities that actually require local/physical execution.
- **Rationale:** keep normal implementation reproducible and reviewable in GitHub while preserving local tools for physical Android/ADB/device-specific proof.
- **Consequences / guards:** role separation between Reviewing/Planning AI and Independent Implementation Agent when independent review matters; owner approval before merge; physical-device proof is not replaced by hosted CI when the Gate contract requires it.
- **References:** `docs/project/WORKFLOW.md`; commit `25cd1ed248b3962a9fefc6cc1c1115bf27961551`.

## INC-001 — Gate 5B stale `lastInsertRowid` leakage

- **Date:** 2026-09-09
- **Gate:** closed Gate 5B narrow correction
- **Type:** INCIDENT + CORRECTION
- **Status:** RESOLVED / MERGED
- **Classification:** PROJECT authorization + DERIVED runtime contradiction
- **Problem:** the Node development/test adapter forwarded connection-level `lastInsertRowid` after non-insert statements. After a prior INSERT, UPDATE, zero-match UPDATE, DELETE, and no-op `INSERT OR IGNORE` could expose the stale previous row identity, contradicting the adopted `SqlResult` semantics.
- **Evidence:** pre-correction probes showed stale rowid values after non-insert operations.
- **Root cause:** `node:sqlite` exposes SQLite connection-level last-insert-rowid state; the adapter normalized numeric type but not semantic meaning for the current statement.
- **Resolution:** keep the `SqlResult` contract unchanged; normalize the Node adapter so a numeric identity is exposed only for an audited top-level INSERT shape with `changes > 0`; otherwise return `null`.
- **Consequences / guards:** added separate Gate-5B adapter normalization regression **6 / 0**; all higher Gate-5 baselines and Schema remained green; future complex INSERT/UPSERT SQL shapes require deliberate review rather than silently broadening the classifier.
- **Validation:** CI run `34359830705` on technical validation commit `6a4b1dddf8426bb1a2a43520d5c41f7b3be4a363`; merged correction recorded at `608314ae62721af44d8ed4f50c1c618ac469fc66`.
- **References:** `docs/application/GATE5B-LASTINSERTROWID-CORRECTION-v1.md`; `docs/project/CURRENT-STATE.json`; `docs/project/TEST-BASELINES.md`.

## INC-002 — Gate 6B canonical schema failed through Capacitor SQLite statement splitting

- **Date:** 2026-09-09
- **Gate:** 6B
- **Type:** INCIDENT + CORRECTION
- **Status:** RESOLVED / PHYSICALLY CONFIRMED
- **Classification:** DERIVED implementation correction
- **Problem:** physical Android Adapter Qualification on build `5a642ac73ddaac1df5a49840e2ea4c4c49aae6dc` produced Q8 FAIL with `Execute: not an error (code 0)`; Q9 was not reached.
- **Root cause:** `@capacitor-community/sqlite@8.1.1` Android execution path splits input on literal `;\n` with limited trigger repair, fragmenting multi-statement trigger bodies and potentially splitting before comment cleanup.
- **Resolution:** preserve `docs/schema/schema.sql` byte-for-byte as the sole schema authority; add a Gate-6B loader that lexically segments complete SQLite statements, preserves trigger units, and transports statements separately through the plugin DDL path.
- **Rejected approach:** `run()/executeSet()` for canonical DDL because their Android non-INSERT path is not the required DDL `execSQL` path.
- **Consequences / guards:** schema authority did not fork; host regression **8 / 0**; adopted inventory remained 15 tables / 44 triggers / 1 view / 24 explicit indexes.
- **Validation:** corrected physical build `89d405d6254108ce735125638ccdb2fb2e67c568` passed Q1-Q11 including Q8/Q9; final Gate-6B qualification later passed Q1-Q12 on `87135cfe80ae3de79a34e941828249fc6889139c`.
- **References:** `docs/architecture/GATE6B-ANDROID-SCHEMA-EXECUTION-CORRECTION-v1.md`.

## DEC-003 — Gate 6B Q12 requires a genuine independent native competing writer

- **Date:** 2026-09-09
- **Gate:** 6B / Q12
- **Type:** DECISION
- **Status:** ADOPTED BY CLOSED GATE 6B
- **Classification:** DERIVED qualification design
- **Decision:** Q12 cannot be proven by Promise timing or by a second JavaScript wrapper around the same Capacitor SQLite connection dictionary. Writer B must be an independent native SQLCipher writer against the exact same physical database file and same native SQLCipher engine.
- **Rationale:** the plugin normalizes ordinary RW connections and rejects a second RW entry for the same database; that cannot establish real competing-writer behavior.
- **Consequences / guards:** diagnostic-only `Gate6BCompetingWriterPlugin`; same-file validation; same engine/version; preflight write; `BEGIN IMMEDIATE`; only concrete native BUSY/LOCKED outcomes accepted for PASS; no product architecture dependency on diagnostic writer.
- **Validation:** final physical Q12 PASS on `87135cfe80ae3de79a34e941828249fc6889139c` using SQLCipher `4.17.0`, with BUSY/code=5 while primary lock held and successful retry after release.
- **References:** `docs/architecture/GATE6B-Q12-COMPETING-WRITER-PROOF-v1.md`.

## INC-003 — Q12 native-open result with insufficient diagnostics

- **Date:** 2026-09-09
- **Gate:** 6B / Q12
- **Type:** INCIDENT
- **Status:** HISTORICAL / BLOCKED
- **Classification:** qualification evidence
- **Problem:** physical run on `c3cc890b35d7f9612214559f83d8091f98e96a68` kept Q1-Q11 PASS but Q12 was BLOCKED at `native_open`.
- **Root cause:** **UNKNOWN / UNESTABLISHED** because then-current instrumentation collapsed the native rejection detail.
- **Resolution:** improve diagnostics rather than reclassify the failure as product incompatibility.
- **Consequences / guards:** a failed/rejected native open cannot establish `samePhysicalFile`; default `false` must not be misread as a post-open same-file contradiction.
- **References:** `docs/architecture/GATE6B-Q12-COMPETING-WRITER-PROOF-v1.md`; `docs/project/CURRENT-STATE.json`.

## INC-004 — Q12 `busy_timeout` PRAGMA transported through wrong API

- **Date:** 2026-09-09
- **Gate:** 6B / Q12
- **Type:** INCIDENT + CORRECTION
- **Status:** RESOLVED
- **Classification:** qualification-tool defect, not primary-adapter defect
- **Problem:** physical run on `7ebe780b1caffeb1a9240ff4010e5483e1c70b7b` produced Q12 BLOCKED at `native_open/set_busy_timeout` with `SQLiteException: Queries can be performed using SQLiteDatabase query or rawQuery methods only.`
- **Root cause:** row-producing `PRAGMA busy_timeout = 0;` was incorrectly sent through `execSQL`.
- **Resolution:** execute setter through `scalarLong()` → `rawQuery()` and step/read the returned row; independently read back `PRAGMA busy_timeout;`; both must be zero.
- **Consequences / guards:** Q12 classifier semantics were not weakened; generic errors remain BLOCKED; only BUSY/LOCKED can satisfy the locked-writer step.
- **Validation:** host Q12 regression **20 / 0**; final physical Q12 PASS on `87135cfe...`.
- **References:** `docs/architecture/GATE6B-Q12-COMPETING-WRITER-PROOF-v1.md`.

## DEC-004 — Gate 6C-A Evidence storage identity/hash rules

- **Date:** 2026-09-10
- **Gate:** 6C-A
- **Type:** DECISION
- **Status:** OWNER_APPROVED / ADOPTED / CLOSED
- **Classification:** PROJECT
- **Decision:** managed Evidence uses canonical `storage_ref = evidence/v1/objects/<uuid-v4>.<safe-extension>` and staging `evidence/v1/.incoming/<uuid-v4>.part`; UUID v4 is canonical lowercase; new Gate-6C Evidence requires SHA-256 formatted `sha256:<64 lowercase hex>`; historical pre-Gate6C `content_hash=NULL` remains valid.
- **Rationale:** durable cross-store identity, collision handling, recovery/reconciliation, and integrity verification require a stable contract.
- **Consequences / guards:** binary outside SQLite; metadata in SQLite; published object + DB row converge through serialized publication/transaction/reconciliation protocol; no normal Evidence deletion in v1; failure to acquire Evidence never blocks Finding.
- **References:** `docs/architecture/GATE6C-EVIDENCE-STORAGE-CONTRACT-v1.md`; `docs/project/CURRENT-STATE.json`.

## DEC-005 — Gate 6C-C publication threat boundary uses composite application protocol, not a primitive-level no-replace claim

- **Date:** 2026-09-10
- **Gate:** 6C-C
- **Type:** DECISION
- **Status:** ADOPTED BY CLOSED GATE 6C-C
- **Classification:** PROJECT / executable qualification
- **Decision:** adopt the guarded Android `Os.rename` publication sequence only within the Gate-6C-A supported boundary: app-private storage + shared single-process Evidence serialization + destination absence checks + complete staged object + rename + verification + transactional SQLite recheck/insert + reconciliation.
- **Rationale:** the project needs complete/no-overwrite publication within its supported application contract, but does not claim protection against privileged filesystem mutation or arbitrary out-of-contract concurrent writers.
- **Consequences / guards:** explicitly **no** claim that `Os.rename` itself is `RENAME_NOREPLACE`; contract safety is composite; SQLite/reconciliation/hash verification remain part of the model.
- **Validation:** native API24/API35 qualification 18/18 each and full Evidence integration 2/2 each in accepted qualification sequence; final exact-SHA run `34531511138` on `9de6c69eef90c490319c02eac48d236482597210`.
- **References:** `docs/architecture/GATE6C-C-ANDROID-EVIDENCE-QUALIFICATION-v1.md`; `docs/project/CURRENT-STATE.json`.

## INC-005 — Android hard-link publication candidate rejected

- **Date:** 2026-09-10
- **Gate:** 6C-C
- **Type:** INCIDENT / REJECTED CANDIDATE
- **Status:** REJECTED
- **Classification:** executable qualification finding
- **Problem:** Android `Os.link` candidate could not satisfy the supported publication path.
- **Evidence:** API24/API35 executable attempts returned `EACCES` under the tested Android/SELinux environment.
- **Decision:** do not use hard-link publication in production; remove rejected path/remnants.
- **Consequences / guards:** final production path contains no hard-link primitive; CI guards against `Os.link(` reappearing in Gate-6C Evidence production code.
- **References:** `docs/architecture/GATE6C-C-ANDROID-EVIDENCE-QUALIFICATION-v1.md`; final Gate-6C-C workflow/history.

## INC-006 — `renameat2(RENAME_NOREPLACE)` rejected for API24 baseline

- **Date:** 2026-09-10
- **Gate:** 6C-C
- **Type:** INCIDENT / REJECTED CANDIDATE
- **Status:** REJECTED
- **Classification:** executable qualification finding
- **Problem:** JNI/C `renameat2(RENAME_NOREPLACE)` candidate was incompatible with the retained API24 baseline.
- **Evidence:** API24 result `ENOSYS (38)`; later API levels could not justify dropping the declared support floor mid-Gate.
- **Decision:** reject and remove JNI/C/renameat2 candidate rather than raise `minSdkVersion` merely to simplify Gate 6C-C.
- **Consequences / guards:** `minSdkVersion` remains 24; no JNI/CMake/renameat2 production remnants in final Gate-6C-C candidate.
- **References:** `docs/architecture/GATE6C-C-ANDROID-EVIDENCE-QUALIFICATION-v1.md`; commits around `e291ee45186a266b8926e7932694d98b0edd89d7` and final cleanup.

## INC-007 — Capacitor Filesystem candidate rejected for EvidenceStorage contract

- **Date:** 2026-09-10
- **Gate:** 6C-C
- **Type:** INCIDENT / REJECTED CANDIDATE
- **Status:** REJECTED
- **Classification:** PROJECT selection based on executable contract proof
- **Problem:** `@capacitor/filesystem@8.1.3` did not provide sufficient executable evidence for the complete Gate-6C EvidenceStorage publication contract required by this project.
- **Decision:** reject Filesystem for this specific EvidenceStorage role and use the qualified narrow Android adapter.
- **Important non-claim:** this does **not** mean the Filesystem plugin is intrinsically unsafe and does not imply Gate 6C-A requires primitive-level `RENAME_NOREPLACE`.
- **Consequences / guards:** Filesystem removed from package/lock and final runtime plugin set; dependency-absence/rejection guard retained.
- **Validation:** Gate-6C-C Filesystem rejection host regression **4 / 0**; final exact-SHA qualification remained green.
- **References:** `docs/architecture/GATE6C-C-ANDROID-EVIDENCE-QUALIFICATION-v1.md`; `docs/project/TEST-BASELINES.md`.

## INC-008 — API24 production bundle incompatible with `es2022` target

- **Date:** 2026-09-10
- **Gate:** 6C-C
- **Type:** INCIDENT + COMPATIBILITY DECISION
- **Status:** RESOLVED
- **Classification:** PROJECT runtime compatibility
- **Problem:** API24 usable Chrome 69 WebView failed before proof registration with `Uncaught SyntaxError: Unexpected token ?` when the Vite production target was `es2022`.
- **Root cause:** production JavaScript syntax target exceeded the actual API24 Web runtime capability; not an Evidence/native/storage contradiction.
- **Resolution:** set Vite production build target to `chrome69`; no plugin-legacy and no speculative polyfill layer.
- **Consequences / guards:** Android OS/native floor remains `minSdkVersion=24`; JavaScript compatibility floor is separately compiled for Chrome 69+ syntax. This is not a recommendation to deploy obsolete software.
- **Validation:** actual full EvidenceService integration executed on API24 Chrome `69.0.3497.100` and API35 WebView; final run `34531511138` passed.
- **References:** `docs/architecture/GATE6C-C-ANDROID-EVIDENCE-QUALIFICATION-v1.md`; commit `8bcfb86815e668a4f62e89c868e0f0d292369d76`.

## INC-009 — Full-integration CI shell harness used assumptions not valid for runner execution model

- **Date:** 2026-09-10
- **Gate:** 6C-C
- **Type:** INCIDENT + CI CORRECTION
- **Status:** RESOLVED
- **Classification:** CI harness defect; not product Evidence defect
- **Problem:** full-integration emulator job contained `set -euo pipefail` and multiline shell `if/then/else` inside the emulator-runner `script:` body; the resulting harness failed before the intended integration proof completed.
- **Resolution:** replace the stateful/bash-style block with independent POSIX-compatible physical commands using one-line conditions; preserve explicit START/COMPLETE markers around the exact integration test invocation.
- **Consequences / guards:** CI failures that occur before test START markers must not be misclassified as product runtime failures; qualification must prove that the intended test actually executed.
- **Evidence:** commit `fd71dc0d64a19f489c6013135ee772c5b8a68141` changes only `.github/workflows/gate6c-c-android-evidence.yml` from the multiline block to independent conditional commands.
- **Validation:** later final run `34531511138` executed 2/2 integration tests on both API24 and API35.
- **References:** commit `fd71dc0d64a19f489c6013135ee772c5b8a68141`; final Gate-6C-C qualification history.

## INC-010 — Brittle API24 WebView provider assertion introduced and removed

- **Date:** 2026-09-10
- **Gate:** 6C-C
- **Type:** INCIDENT + CI CORRECTION
- **Status:** RESOLVED
- **Classification:** CI assertion defect; not product runtime defect
- **Problem:** after provider selection, CI added a hard assertion using `settings get secure webview_provider`; that namespace/key assumption was not stable for the tested API24 environment and could fail before integration tests despite successful provider-switch command.
- **Evidence:** commit `ed524d36d705d0239089b4ac39915ced91f6be7f` added the Settings.Secure assertion; final commit `9de6c69eef90c490319c02eac48d236482597210` removed exactly those three assertion lines.
- **Resolution:** retain evidence that is actually portable/observable for this qualification: provider-switch command result `Success`, installed Chrome 69 version, and—most importantly—actual production-bundle integration test START/2-tests/BUILD SUCCESSFUL/COMPLETE markers on the exact SHA.
- **Consequences / guards:** avoid internal implementation-detail assertions when behavior can be proven directly; do not invent an alternative Settings namespace without evidence.
- **Validation:** final exact-SHA run `34531511138` passed all five jobs; API24 full integration executed 2/2.
- **References:** commits `ed524d36d705d0239089b4ac39915ced91f6be7f` and `9de6c69eef90c490319c02eac48d236482597210`; Gate-6C-C closure provenance in `CURRENT-STATE.json`.

## DEC-006 — Gate 6C-C closure and adopted evidence

- **Date:** 2026-09-10
- **Gate:** 6C-C
- **Type:** DECISION / CLOSURE
- **Status:** CLOSED / MERGED
- **Classification:** PROJECT governance + accepted qualification evidence
- **Decision:** accept Gate 6C-C final reviewed head `9de6c69eef90c490319c02eac48d236482597210`, qualification run `34531511138`, PR #23 merge `f221b215358f83dce381ac5261a856a7de4e5c98`, then post-merge closure reconciliation via PR #24.
- **Adopted repeatable host baselines:** device adapter 14/0; restored-result 11/0; Filesystem rejection guard 4/0.
- **Qualification evidence, not ordinary host baselines:** native API24 18/0; native API35 18/0; full integration API24 2/0; full integration API35 2/0.
- **Consequences:** Gate 6C remains IN_PROGRESS; Gate 6C-D becomes `NEXT / NOT_STARTED`; Gate 6D remains NOT_STARTED; `field_usable_v1=false`.
- **References:** `docs/project/CURRENT-STATE.json`; `docs/project/CURRENT-STATE.md`; `docs/project/TEST-BASELINES.md`; `docs/architecture/GATE6C-C-ANDROID-EVIDENCE-QUALIFICATION-v1.md`.

## INC-011 — Documentation state drift after Gate 6C-C closure

- **Date:** 2026-09-11
- **Gate:** project memory / handoff
- **Type:** INCIDENT + DOCUMENTATION CORRECTION
- **Status:** CORRECTION IN REVIEW
- **Classification:** PROJECT governance
- **Problem:** `CURRENT-STATE` correctly recorded Gate 6C-C CLOSED/MERGED and Gate 6C-D NEXT/NOT_STARTED, but `START-HERE.md` and `docs/project/WORKFLOW.md` still described Gate 6C as `NEXT / NOT_STARTED` from the earlier Gate-6B-era handoff.
- **Root cause:** closure reconciliation updated the canonical state/baseline files but did not propagate the new state to all human handoff summaries.
- **Resolution:** refresh START-HERE and WORKFLOW and introduce this permanent decision/incident index before Gate 6C-D starts.
- **Consequences / guards:** handoff reading order now includes this log; WORKFLOW explicitly requires state/memory reconciliation and incident/decision recording after meaningful merges/corrections.
- **Validation target:** documentation-only branch must change exactly `START-HERE.md`, `docs/project/WORKFLOW.md`, and this file; Gate 6C-D remains NOT_STARTED.
- **References:** live `CURRENT-STATE.json`; pre-correction `START-HERE.md`; pre-correction `WORKFLOW.md`.

## INC-012 — Accidental placeholder write directly to `main` during this memory-hardening task

- **Date:** 2026-09-11
- **Gate:** project workflow / memory hardening
- **Type:** INCIDENT + IMMEDIATE CORRECTION
- **Status:** RESOLVED; history retained
- **Classification:** workflow/operator error
- **Problem:** while starting this documentation task, creation of this log was attempted before the dedicated branch existed; a subsequent tool call mistakenly targeted `main`, creating a file containing only `placeholder` in commit `8551dc8e9eba3e980ac857ae6c7a8bf93bcd2db1`.
- **Root cause:** incorrect write-operation ordering/target selection: branch creation should have occurred before any content write, and write target should have been revalidated after the first branch-not-found failure.
- **Resolution:** stop normal work; fetch the accidental blob; delete the placeholder from `main` in corrective commit `b2fdfa3c4d1ad2bdd69be45f9a47fbdec43cc8b4`; then create `docs/project-memory-hardening-v1` from that corrected HEAD and resume only on the branch.
- **Consequence:** two no-op historical commits remain visible on `main`; history was **not** rewritten. The repository tree after the corrective commit is exactly tree `10e9b6bba15c3860e699b2ffc63002547ae7f390`, the same tree as the prior accepted PR #24 merge commit, so project content was restored before scoped work resumed.
- **New guard:** documentation hardening is subject to the same branch discipline as implementation; after any failed branch-targeted write, re-read target branch before retrying a mutation.
- **References:** commits `8551dc8e9eba3e980ac857ae6c7a8bf93bcd2db1` and `b2fdfa3c4d1ad2bdd69be45f9a47fbdec43cc8b4`; `docs/project/WORKFLOW.md` branch rule.

---

## 2) Current disposition

At the creation of this index:

- Gates 1→5L, 6A, 6B, 6C-A, 6C-B, 6C-C are closed/merged in their recorded scopes.
- Gate 6C remains `IN_PROGRESS`.
- Gate 6C-D is `NEXT / NOT_STARTED`.
- Gate 6D is `NOT_STARTED`.
- `field_usable_v1=false`.

Always verify these statements against live `docs/project/CURRENT-STATE.json` before acting; this log records engineering history, not the authoritative live HEAD.
