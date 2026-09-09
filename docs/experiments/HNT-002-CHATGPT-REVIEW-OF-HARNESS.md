# HNT-002 — ChatGPT Adversarial Review of HNT-001 Harness

## 1. Review identity and authority

- Repository: `scientifica007/Inspection_Mission_001`
- Governing branch: `main`
- Live `main` HEAD fresh-read before substantive review: `17803cd96f1c83be60528fb2544b9d7e7a6c7526`
- HNT-001 fixed base: `17803cd96f1c83be60528fb2544b9d7e7a6c7526`
- Target branch: `experiment/harness-sqladapter-qualification-v1`
- Frozen target HEAD reviewed: `efb9af5fc83a831e4d36f8752116f44ccab0cb59`
- Review branch: `experiment/hnt002-chatgpt-review-harness-v1`
- Review branch was created directly from frozen target HEAD `efb9af5fc83a831e4d36f8752116f44ccab0cb59`.

The review used live GitHub repository state as the sole project authority. Before reviewing the candidate implementation I fresh-read:

- `START-HERE.md`
- `docs/project/CURRENT-STATE.md`
- `docs/project/CURRENT-STATE.json`
- `docs/project/WORKFLOW.md`
- `docs/project/TEST-BASELINES.md`
- `docs/architecture/DEVICE-ADAPTER-CONTRACT-v1.md`
- relevant `SqlAdapter`, `NodeSqliteAdapter`, bootstrap loader/artifact/manifest, and `docs/schema/schema.sql` files.

The competing HNT-001 implementation branch was not inspected, searched, compared against, or used as review evidence.

## 2. Target ancestry and exact diff scope

GitHub compare established:

- merge base of `17803cd96f1c83be60528fb2544b9d7e7a6c7526` and target `efb9af5fc83a831e4d36f8752116f44ccab0cb59` is exactly the fixed base;
- target is exactly one commit ahead and zero commits behind that base;
- target commit `efb9af5f...` has the fixed base as its direct parent;
- no pre-existing repository file was modified.

Exact target diff:

| File | Status | Additions | Deletions |
|---|---|---:|---:|
| `.github/workflows/sqladapter-host-qualification.yml` | added | 60 | 0 |
| `tests/sqladapter-qualification/node-host-runner.ts` | added | 175 | 0 |
| `tests/sqladapter-qualification/qualification-contract.ts` | added | 902 | 0 |

No committed SQLite database, generated binary, credential, secret, or sensitive operational artifact appears in the target diff.

Review-only additions are listed in section 11. No target candidate file was edited on the review branch.

## 3. CI/workflow runs inspected

### Candidate-native run

- GitHub Actions run `34344297671`
- Workflow: `sqladapter-host-qualification`
- Branch: `experiment/harness-sqladapter-qualification-v1`
- Head: `efb9af5fc83a831e4d36f8752116f44ccab0cb59`
- Conclusion: **success**
- Job `102442126077`: all workflow steps completed successfully.

### Same frozen target SHA on newly created review branch

- GitHub Actions run `34344975037`
- Workflow: `sqladapter-host-qualification`
- Head: `efb9af5fc83a831e4d36f8752116f44ccab0cb59`
- Conclusion: **success**
- Job `102444321403` logs inspected in full.
- Runner: Ubuntu 24.04; Node `v22.23.2`.
- HOST qualification: **103 passed / 0 failed**.
- Historical baselines: all exact adopted counts, all zero failures; see section 7.

### Review adversarial evidence run

- GitHub Actions run `34345876893`
- Workflow: `hnt002-adversarial-review`
- Head: `ef67c5020bde1eeb496c54373793f7148984276e`
- Conclusion: **success**
- Job `102447228460` logs inspected.
- Verified target ancestry, exact target three-file scope, `git diff --check` for fixed base→target, and review-only path hygiene.
- Re-ran frozen target HOST qualification: **103 / 0**.
- Ran the HNT-002 adversarial reproducers; all intended reproductions behaved as predicted.

### Candidate workflow after review-evidence commit

- GitHub Actions run `34345876698`
- Workflow: `sqladapter-host-qualification`
- Head: `ef67c5020bde1eeb496c54373793f7148984276e`
- Conclusion: **success**.

The candidate workflow uses `actions/checkout@v4` with `fetch-depth: 0`, which is sufficient for the Gate-5B provenance regression. It pins Node major version 22. It invokes `python3` from the GitHub-hosted Ubuntu image rather than explicitly pinning a Python version.

## 4. Executable validation performed

Review-only executable evidence is in `tests/review/hnt002/adversarial-repros.ts` and run `34345876893`.

Observed output included:

```text
[REPRO PASS] non-insert rowid gap: UPDATE changes=1, rowid=1; zero-match changes=0, rowid=1
[REPRO PASS] exact-schema false positive: deliberately mutated trg_ca_bi still qualified (103 passed, 0 failed)
[REPRO PASS] close/reopen verification gap: 19 logical close() calls were no-ops, yet qualification reported 103 passed, 0 failed
[DISPROVED] provisioning PRAGMA synchronous=OFF is connection-local: reopened value=2
```

The schema mutation did not change schema object counts or names. It replaced the body of the adopted `trg_ca_bi` corrective-action trigger with a no-op `SELECT 1`, thereby removing closed domain enforcement while retaining the trigger object. The complete reusable harness still reported `103 passed, 0 failed`.

## 5. Findings

### BLOCKER HNT002-B1 — “Exact adopted schema” can be false-passed

**Files / ranges**

- `tests/sqladapter-qualification/qualification-contract.ts`, `case01SchemaProvisioned`, approximately lines 298–340.
- Related seam declaration: same file, `HostQualificationSeam` / `QualificationEnvironment`, approximately lines 64–85.

**Violated requirement**

HNT-001 mandatory coverage #1 requires that the **exact adopted schema** can be provisioned and is present. The review instructions additionally require determining whether the claim of exactness is actually proven rather than inferred from counts.

**Why this is a real defect**

HQ-01 checks:

- exact table count and table-name set;
- trigger **count only**;
- view count and one view name;
- explicit-index count plus only two selected index names;
- a second connection only re-checks table count.

It does not compare the complete trigger set, complete index set, or the SQL definitions of tables/triggers/views/indexes against the adopted schema. Consequently, a database can retain the expected 15/44/1/24 inventory yet have materially weakened closed schema semantics and still qualify.

This is not hypothetical. The review reproducer replaced the canonical `trg_ca_bi` body—which normally enforces corrective-action creation invariants—with a no-op while preserving its name and all object counts. The complete HNT-001 harness returned **103/0**.

That is a false success on a mandatory HNT-001 contract and can certify a schema that materially weakens closed project semantics. It therefore meets the supplied BLOCKER definition.

**Executable reproduction**

- `tests/review/hnt002/adversarial-repros.ts` → `reproduceMutatedSchemaFalsePositive()`.
- GitHub Actions run `34345876893`, job `102447228460`.
- Result: mutated non-exact schema qualified at **103/0**.

**Smallest reasonable correction direction**

The reusable qualification should establish an independent exact schema signature from the canonical `docs/schema/schema.sql` authority and compare the candidate database against it—not just counts. A reasonable narrow approach is to build a reference database from canonical schema and compare complete relevant `sqlite_master` object identity/definitions (with deliberate normalization where SQLite legitimately rewrites SQL), or use an equivalently strong canonical schema fingerprint plus targeted semantic checks. The target is not modified in this review.

---

### MAJOR HNT002-M1 — SqlResult non-insert row-id contract violation qualifies successfully

**Files / ranges**

- `tests/sqladapter-qualification/qualification-contract.ts`, `case03AffectedRows`, approximately lines 417–472.
- Governing existing contract: `src/bootstrap/adapter.ts`, `SqlResult`, approximately lines 10–17.
- Existing reference adapter behavior: `dev/node-sqlite-adapter.ts`, `run`, approximately lines 38–49.

**Violated requirement**

The harness must depend faithfully on the existing `SqlAdapter` abstraction and qualify `SqlResult` normalization. The existing `SqlResult` contract explicitly defines `lastInsertRowid` as the last insert rowid **when the statement inserted a row, else null**.

**Why this is a real defect**

HQ-03 verifies positive insert row identity and `changes == 1/0`, but it never checks `lastInsertRowid === null` for UPDATE or a zero-match guarded UPDATE.

On the actual Node 22 reference runtime, `node:sqlite` retains the previous insert rowid in its statement result for subsequent UPDATE statements. `NodeSqliteAdapter.run()` passes any numeric/native rowid straight through. Therefore the existing reference adapter returns a stale insert id for non-insert statements, contrary to the governing seam, while HQ-03 reports PASS.

This is a concrete false positive in adapter normalization coverage and can allow materially wrong `SqlResult` behavior to qualify.

**Executable reproduction**

- `tests/review/hnt002/adversarial-repros.ts` → `reproduceNonInsertRowidContractGap()`.
- GitHub Actions run `34345876893` on Node `v22.23.2`.
- Observed:
  - matched UPDATE: `changes=1`, `lastInsertRowid=1`;
  - zero-match UPDATE: `changes=0`, `lastInsertRowid=1`;
  - frozen HQ-03 still passes as part of `103/0`.

**Smallest reasonable correction direction**

Add negative row-id qualification assertions for non-insert writes, at least a matched guarded UPDATE and zero-match guarded UPDATE, requiring `lastInsertRowid === null` per the existing seam. Any production/reference adapter correction should be handled separately; this review does not modify it.

---

### MAJOR HNT002-M2 — Competing-writer proof hard-wires rejection and can deadlock a conforming blocking adapter

**File / range**

- `tests/sqladapter-qualification/qualification-contract.ts`, `case06CompetingBeginImmediate`, approximately lines 542–576.

**Violated requirement**

The reusable harness must not be hard-wired to `node:sqlite` semantics, and a future candidate should be able to supply a narrow lifecycle seam without rewriting qualification logic. Mandatory coverage #6 requires that B cannot successfully acquire a competing `BEGIN IMMEDIATE` while A owns the write reservation and that B remains usable after release.

**Why this is a real defect**

The test does:

1. A acquires `BEGIN IMMEDIATE`.
2. It immediately `await`s `c2.beginImmediate()` inside `expectReject`.
3. A's `COMMIT` is executed only **after** that awaited call returns/rejects.

This requires candidate B to fail/reject before A releases. A driver that correctly blocks/queues the competing begin until the lock becomes available also satisfies the HNT semantic requirement—it does not acquire while A owns the lock—but the harness cannot release A because it is waiting on B first. If the driver has no finite busy timeout, the case can hang until the 40-minute workflow timeout. With a long finite timeout it is unnecessarily slow and tests a driver-specific busy policy rather than the required serialization invariant.

The reference `node:sqlite` candidate happens to reject promptly under its current busy behavior, so the delivered reference run passes. The defect is in reusable qualification semantics.

**Executable reproduction / precise reasoning**

This finding is established by deterministic control-flow analysis of lines 542–576. I did not claim a physical Android/plugin reproduction. A platform-specific blocking implementation was not available in this host-only review, and the HNT contract explicitly forbids treating host evidence as Android proof.

**Smallest reasonable correction direction**

Start B's competing begin concurrently, use a bounded observation to prove it has not successfully acquired while A still owns the transaction, release A, then accept/inspect the candidate's allowed outcome (e.g. busy rejection or acquisition only after release) and prove B remains usable. Add a bounded per-case/per-operation timeout so a candidate cannot stall CI indefinitely.

---

### MAJOR HNT002-M3 — Durable “close/reopen” can pass even when close is a no-op

**Files / ranges**

- `tests/sqladapter-qualification/qualification-contract.ts`, `case09DurableCloseReopen`, approximately lines 690–727.
- Same file, `case10BootstrapPersistence`, approximately lines 730–797.
- Lifecycle seam: same file, `QualifiedConnection.close`, approximately lines 66–75.

**Violated requirement**

Mandatory coverage #9 and #10 require durable close/reopen and bootstrap persistence across close/reopen. Review dimension J specifically requires determining whether the original authoritative connection is genuinely closed before reopening the same DB.

**Why this is a real defect**

HQ-09 and HQ-10 call `await c1.close()` and then open a new connection, but they never establish that `c1` was actually closed. A lifecycle seam whose `close()` resolves successfully while leaving the original authoritative connection open still receives a full qualification pass.

The reference Node runner's implementation does call `DatabaseSync.close()`, so this does not assert that the delivered reference lifecycle is fake. It shows that the reusable qualification logic cannot distinguish genuine close/reopen from “open another connection while the first remains alive,” which is materially weaker than the mandatory lifecycle proof and could qualify a broken future lifecycle implementation.

**Executable reproduction**

- `tests/review/hnt002/adversarial-repros.ts` → `reproduceNoopCloseFalsePositive()`.
- The review seam deliberately made every `QualifiedConnection.close()` a no-op while opening real file-backed secondary connections.
- GitHub Actions run `34345876893` observed **19 no-op logical close calls** and nevertheless the complete harness returned **103/0**.

**Smallest reasonable correction direction**

Make the close lifecycle observable to qualification rather than merely trusted: after close, demonstrate that the old connection can no longer execute/query, then open a distinct new connection to the same durable database and perform persistence assertions. The exact seam can remain narrow; the target is not modified here.

---

### MINOR HNT002-m1 — Cleanup failures are intentionally suppressed and cannot fail qualification

**Files / ranges**

- `tests/sqladapter-qualification/qualification-contract.ts`, `runHostQualification` finally block, approximately lines 878–890.
- `tests/sqladapter-qualification/node-host-runner.ts`, `close()` / `dispose()`, approximately lines 75–105.

**Violated requirement**

The declared environment contract says `dispose()` closes remaining connections and removes durable storage. Review dimension J requires inspection of cleanup behavior and crash/error cleanup paths.

**Why this is a real defect**

The reusable orchestrator suppresses every `env.dispose()` exception without recording even a failed assertion. The reference runner also suppresses `db.close()` and `rmSync()` failures. Therefore a cleanup failure or leaked temporary DB directory can coexist with a green qualification result, and diagnostics are lost.

This is limited in severity because the observed GitHub-hosted runs completed cleanly, temporary resources are outside the repository, and the runner is ephemeral. It is nevertheless a real resource-lifecycle/diagnostic weakness.

**Executable reproduction / precise reasoning**

The behavior follows directly from the unconditional empty `catch` blocks in the cited ranges. No actual cleanup failure occurred in the reviewed Actions runs, so this is not represented as an observed leak.

**Smallest reasonable correction direction**

Keep case-result preservation, but record cleanup failures as qualification failures/diagnostics after the case result is captured. The candidate-specific runner should not silently declare successful disposal if DB close or temporary-directory removal fails unexpectedly.

---

### NOTE HNT002-N1 — A/B runtime separation is structurally sound

The reusable `qualification-contract.ts` imports no `node:*` APIs and no `dev/*` adapter. It depends on the existing runtime-neutral `SqlAdapter`, bootstrap artifact/loader, and manifest modules. Node-specific file/database lifecycle is isolated in `node-host-runner.ts`. This satisfies the intended architectural split; the findings above concern completeness/semantics, not a hidden Node import leak in Part A.

### NOTE HNT002-N2 — Core host SQL/FK/bootstrap/isolation checks are substantive on the reference runner

The reference environment opens distinct `DatabaseSync` connections to the same file path, explicitly sets `PRAGMA foreign_keys = ON` on every qualification connection, and HQ-07 performs real invalid FK writes on two connections. HQ-04 tests uncommitted invisibility and post-commit visibility across two file-backed connections. HQ-08/HQ-10 use the existing `BootstrapLoader`, canonical committed bootstrap artifact, manifest verification, idempotent reload, and persistence after reopening. I found no false-positive defect in those specific checks beyond the independent close-lifecycle issue in M3.

### NOTE HNT002-N3 — Provisioning-only `PRAGMA synchronous=OFF` does not weaken qualification connections

This hypothesis was specifically investigated because the runner sets `PRAGMA synchronous = OFF` during schema provisioning. The review reproducer showed the provisioning connection at `synchronous=0`; after closing it, a fresh connection to the same DB reported `synchronous=2`. The setting is connection-local in this use. The test connections therefore do not inherit provisioning `synchronous=OFF`.

This setting is appropriately characterized as fixture-creation optimization, not evidence of weakened transaction/close-reopen semantics in the qualification connections. It still does not prove power-loss/device durability, and the candidate correctly makes no such claim.

### NOTE HNT002-N4 — CI baseline coverage and provenance history are complete; Python version is implicit

The candidate workflow runs the focused harness, every adopted TypeScript baseline Gate 5B through 5L, and Gate-4A schema regression. `fetch-depth: 0` supplies the history required by Gate-5B provenance. Node 22 is explicitly selected. Python is not explicitly version-pinned; it relies on `python3` from `ubuntu-latest`. Because the schema regression is standard-library-oriented and the reviewed run passed at exactly 100/0, I treat this as a reproducibility observation rather than a defect in the delivered candidate.

## 6. Important hypotheses investigated and disproved

1. **Provisioning `synchronous=OFF` contaminates qualification connections / creates a false durability proof — disproved.** A fresh connection reopened with `PRAGMA synchronous = 2`, not 0.
2. **The reusable contract leaks `node:*` or the Node reference adapter into Part A — disproved.** Part A imports only runtime-neutral/core bootstrap modules.
3. **The transaction/isolation tests accidentally use unrelated `:memory:` databases — disproved for the reference runner.** The runner creates one real temp-file path per environment and each connection opens that same path.
4. **Foreign-key enforcement is asserted only by PRAGMA and not behaviorally — disproved.** HQ-07 performs real invalid FK inserts on two authoritative connections and then proves both remain usable for valid writes.
5. **The canonical bootstrap is bypassed or reimplemented inside the harness — disproved.** The runner reads `bootstrap/v1/checklist-v1.json`; Part A uses existing `BootstrapLoader` and manifest functions.
6. **Hard-coded schema inventory counts are inherently improper coupling — not supported.** Version-pinned v1 counts are legitimate. The defect in B1 is that counts/partial names are presented as proof of exact schema semantics when they are insufficient.

## 7. Historical baseline results

From inspected GitHub Actions run `34344975037` at the exact frozen target SHA:

| Suite | Adopted baseline | Observed |
|---|---:|---:|
| Gate 5L | 94 / 0 | **94 / 0** |
| Gate 5K | 82 / 0 | **82 / 0** |
| Gate 5J | 75 / 0 | **75 / 0** |
| Gate 5I | 48 / 0 | **48 / 0** |
| Gate 5H | 66 / 0 | **66 / 0** |
| Gate 5G | 41 / 0 | **41 / 0** |
| Gate 5F | 30 / 0 | **30 / 0** |
| Gate 5E | 79 / 0 | **79 / 0** |
| Gate 5D | 60 / 0 | **60 / 0** |
| Gate 5C | 55 / 0 | **55 / 0** |
| Gate 5B | 32 / 0 | **32 / 0** |
| Schema | 100 / 0 | **100 / 0** |

The candidate did not weaken the adopted historical suites. The candidate HOST suite itself reported **103 / 0** on the frozen target SHA.

## 8. CI and maintainability assessment

### Positive

- Workflow triggers on pushes and pull requests.
- Permissions are read-only (`contents: read`).
- No secrets are required.
- Full Git history is fetched for provenance regression.
- Node 22 is selected explicitly.
- All documented historical TypeScript baselines and schema regression run.
- Target diff is additive and clean.
- Failure output is organized by case ID and assertion message.
- Each case receives a fresh environment and the reference runner uses real file-backed SQLite.
- Explicit Android/device non-claims are clear and faithful to HNT-001 scope.

### Weaknesses beyond classified findings

- Candidate CI itself does not run `git diff --check`; the review workflow did and the delivered target diff is clean. I do not classify this as a target correctness defect.
- `ubuntu-latest` and implicit system `python3` allow environmental drift, although current tests are simple and the reviewed run is green.
- The workflow's 40-minute job timeout is not an adequate substitute for bounded concurrency-case timeouts; this is included in M2.

## 9. Finding count

- BLOCKER: **1**
- MAJOR: **3**
- MINOR: **1**
- NOTE: **4**

## 10. Residual uncertainty

- This review is HOST-side only. It does not and cannot establish Android app-private storage, Capacitor/WebView lifecycle, process-kill/reboot persistence, camera/filesystem behavior, Android-plugin-specific transaction behavior, or physical-device `currentVisitState` restart proof. The candidate correctly does not claim those.
- M2's blocking/queued `BEGIN IMMEDIATE` problem is established from the reusable harness control flow, not from a specific Android plugin run. No Android candidate was part of HNT-001 or this review.
- I did not induce real filesystem permission/cleanup failures on GitHub-hosted runners; the cleanup MINOR is based on explicit exception suppression in code.
- GitHub-hosted runner/tool versions can change after this review; exact run IDs above preserve the observed environment/results.

## 11. Review-only artifacts

Added only on `experiment/hnt002-chatgpt-review-harness-v1`:

1. `tests/review/hnt002/adversarial-repros.ts`
2. `.github/workflows/hnt002-adversarial-review.yml`
3. `docs/experiments/HNT-002-CHATGPT-REVIEW-OF-HARNESS.md`

No HNT-001 target candidate file was changed.

## 12. Final verdict

**FAIL — BLOCKER**

The candidate has strong scope discipline, a clean runtime-neutral/core-vs-Node split, genuine reference-host transaction/FK/bootstrap exercises, and preserves every adopted regression baseline. However, the reusable harness can report full success for a materially non-exact schema, which is an executable false success on mandatory HNT-001 coverage. The additional row-id and close/reopen false positives, plus the competing-writer rejection/deadlock assumption, confirm that the qualification logic is not complete enough to serve as a reliable reusable adapter qualification contract as delivered.
