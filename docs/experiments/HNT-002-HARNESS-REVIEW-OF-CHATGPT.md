# HNT-002 — Adversarial Review of the HNT-001 ChatGPT Candidate (Harness)

> **Review type:** adversarial, executable-evidence-backed. Review only — the
> target candidate was NOT modified, improved or merged.
>
> **Reviewer:** Harness (deepseek-v4-pro, DeepSeek Harness)
> **Target:** HNT-001 ChatGPT candidate — `experiment/chatgpt-sqladapter-qualification-v1`
> **Review branch:** `experiment/hnt002-harness-review-chatgpt-v1` (local only)

## 1. Authority verification

| Check | Result |
|---|---|
| Local repository identity | `scientifica007/Inspection_Mission_001` (origin verified) ✓ |
| Live `main` SHA | `17803cd96f1c83be60528fb2544b9d7e7a6c7526` — **equals governing HNT-001 base** ✓ |
| Frozen candidate HEAD | `d56c7bf3955e575af66b5c8219d6d3c59563ea47` — **exact match** ✓ |
| Candidate ancestry | `17803cd9…` is an ancestor of `d56c7bf3…` ✓ |
| Minimum refs fetched | only `main` + `experiment/chatgpt-sqladapter-qualification-v1` ✓ |
| Off-limits refs | `experiment/harness-sqladapter-qualification-v1` and `experiment/hnt002-chatgpt-review-harness-v1` were **not fetched, read, diffed or compared** ✓ |

The review branch starts exactly at `d56c7bf3…`. No merge, no commit, no push.

## 2. Exact target diff scope (verified, not assumed)

`git diff 17803cd9…..d56c7bf3…` — 3 files added, 461 insertions, 0 deletions,
**no pre-existing file modified**:

| Status | File |
|---|---|
| A | `.github/workflows/sqladapter-qualification.yml` |
| A | `tests/sqladapter_qualification.ts` |
| A | `tests/support/sqladapter-qualification.ts` |

Candidate commit sequence (oldest first):
`69c088a` Add reusable SqlAdapter qualification contract →
`21a0bf0` Add node reference SqlAdapter qualification runner →
`f1d3ff9` Add GitHub Actions qualification and regression workflow →
`d56c7bf` Fix CI checkout depth for provenance regression.

No generated DB, binary, secret or sensitive file exists in the diff or in the
tracked tree. `git diff --check` against the base: clean.

## 3. GitHub Actions runs inspected (read-only)

| Run ID | Commit | Conclusion | Notes |
|---|---|---|---|
| `34339929482` | `f1d3ff9` | **failure** | First workflow run. Failed only in the Application-Core regression step: Gate-5B provenance cases (`recorded generating_git_commit … does not resolve to a commit`, `no parent commit available for simulation`) — the default shallow checkout lacked Git history. All suites before Gate-5B were green. |
| `34339995973` | `d56c7bf` | **success** | Final frozen candidate run. 10/10 qualification cases; baselines 94/82/75/48/66/41/30/79/60/55/32 (all 0 failed); schema 100/0; diff-hygiene step ran. Job completed in 24 s. |

The first-run failure was a CI setup issue (shallow checkout) that the frozen
HEAD itself fixed with `fetch-depth: 0`; it does not exist in the frozen
candidate and is not counted as a product defect. Annotations on the green run
warn that `actions/checkout@v4`, `setup-node@v4`, `setup-python@v5` run on the
deprecated Node.js 20 Actions runtime (NOTE, see below).

## 4. Local tests and reproducers run

Commands executed from the review branch (`d56c7bf3…`):

| Artifact | Result |
|---|---|
| `node --experimental-strip-types tests/sqladapter_qualification.ts` | **10/10 local** (reviewer serial retry attempt 3 — see §5.1); 10/10 in CI run `34339995973`; additionally the project owner independently ran the untouched suite on their own machine (`TMPDIR=/dev/shm`, exit 0): **10/10**. |
| `tests/review/hnt002/repro-schema-identity.ts` | **CONFIRMED** — suite reports 10/10 against a provisioning with 15 tables but **0 triggers / 0 views / 0 explicit indexes** (demonstrates MAJOR-1). |
| `tests/review/hnt002/repro-reopen-fk.ts` | **CONFIRMED** — suite reports 10/10 when `reopen()` returns a connection with `PRAGMA foreign_keys = OFF` (demonstrates MINOR-1). |
| `tests/review/hnt002/control-autocommit-detection.ts` | **CONTROL CONFIRMED** — a per-statement-autocommit adapter yields 7 passed / 3 failed with exactly the three transaction cases failing (disproves "the suite cannot detect autocommit"). |
| 11 × historical gate baselines | **All 11 green locally**: 94/82/75/48/66/41/30/79/60/55/32 (all 0 failed) — the flake-affected Gate-5L run completed green (see §5.1); all 11 also green in CI run `34339995973`. |
| `python3 tests/gate4a_regression.py` | 100/0 locally (tables=15, triggers=44, views=1, explicit_indexes=24). |
| `git diff --check` | clean. |

## 5. Environment note (important, not a candidate defect)

### 5.1 Local execution flake — investigated and disproved as a candidate defect

In this review environment, runs involving file-backed SQLite (`mkdtemp` +
`node:sqlite DatabaseSync`) intermittently hang in an uninterruptible
`fsync` syscall (process in `D` state). Evidence collected:

- `strace -f` of the target suite: the run progressed through many successful
  journal/fsync commit cycles, then a single `fsync(21)` on the SQLite journal
  never returned; the process sat in `D` state until killed.
- A **plain loop with zero candidate code** (`new DatabaseSync(path)` +
  `db.exec(schemaSql)` × 30 on fresh files) hung identically on its 5th
  iteration — proving the hang is independent of the candidate.
- Isolated probes (competing `BEGIN IMMEDIATE`, peer isolation, 200 committed
  transactions) completed instantly.
- The identical candidate code is green in GitHub Actions (run `34339995973`,
  24 s).

Conclusion: environment filesystem behavior, not a product defect. Local
suite/baseline runs were retried until completion; the flake-affected local
runs (Gate-5L baseline, review reproducers/control) were additionally executed
under the standard `eatmydata` LD_PRELOAD wrapper, which neuters `fsync`
without changing any file or assertion (the qualification's assertions never
test OS-level crash durability; close/reopen is exercised through the adapter
layer as designed). CI is the authoritative green record for the frozen
candidate, and the project owner independently confirmed the untouched suite
as 10/10 on their own machine (`TMPDIR=/dev/shm`, exit 0).

## 6. Findings (BLOCKER → MAJOR → MINOR → NOTE)

### MAJOR-1 — "exact adopted schema is present" proves only table cardinality

- **File:** `tests/support/sqladapter-qualification.ts` — case
  `"exact adopted schema is present"` (lines 120–130).
- **Violated requirement:** HNT-001 mandatory coverage item 1 — *"Exact adopted
  schema can be provisioned and is present."*
- **Why it is a real defect:** the case executes a single assertion: exactly 15
  non-`sqlite_` tables exist. It never verifies the 44 enforcement triggers,
  the `v_response_outcome` view, the 24 explicit indexes, table columns,
  CHECKs, or any statement text. "Exact adopted schema is present" is claimed
  while only cardinality is proven. A materially broken adapter whose DDL
  execution silently drops non-table objects (or substitutes different
  tables/columns) passes this case and — because no other case exercises
  triggers, the view, indexes or non-bootstrap table columns — passes the
  whole suite 10/10.
- **Executable reproduction:** `tests/review/hnt002/repro-schema-identity.ts`
  provisions a schema with 0 triggers / 0 views / 0 explicit indexes (15
  tables only) through an otherwise faithful factory; the suite reports
  `10 passed, 0 failed`. The adopted object counts (15/44/1/24) are pinned in
  `CURRENT-STATE.json` and re-verified by the Gate-4A schema suite (100/0),
  so the expected values are canonical and cheap to assert.
- **Smallest reasonable correction:** in the schema case, also assert the
  adopted object counts — triggers == 44, views == 1, explicit indexes == 24
  (via `sqlite_master` type counts) — and, ideally, compare per-object SQL
  text against `schema.sql` (normalized), or at least verify key columns of
  representative tables (`checklist_item_definition`, `checklist_response`,
  `visit`, `finding`).

### MINOR-1 — `PRAGMA foreign_keys` is never verified on `reopen()` connections

- **File:** `tests/support/sqladapter-qualification.ts` — the foreign-key case
  (lines 216–231) checks primary and `openPeer()` only; cases
  `"committed durable state survives close/reopen …"` and
  `"bootstrap state also survives close/reopen"` use `reopen()` connections
  without any pragma check.
- **Violated requirement:** HNT-001 item 7 — *"PRAGMA foreign_keys ON for every
  authoritative qualification connection"*. The reopened connections are used
  as authoritative readers in the suite.
- **Executable reproduction:** `tests/review/hnt002/repro-reopen-fk.ts` — a
  factory whose `reopen()` returns a connection with
  `PRAGMA foreign_keys = OFF` still passes 10/10.
- **Smallest correction:** assert `PRAGMA foreign_keys == 1` on the reopened
  connection in both reopen cases (or add a shared helper used by every
  connection the suite touches). (The reference runner itself is unaffected:
  its `openManaged()` sets `PRAGMA foreign_keys = ON` for every connection.)

### MINOR-2 — Bootstrap-persistence assertion is weaker than the knowable exact count

- **File:** `tests/support/sqladapter-qualification.ts` line 269 —
  `count(*) > 0` on `checklist_allowed_value` after reopen.
- **Why:** the canonical artifact deterministically yields exactly 48 allowed
  values; asserting `> 0` accepts any partial loss on reopen. Case 9's exact
  probe partially backstops this, but only for its own scratch table.
- **Smallest correction:** assert exactly 48 (or derive the count from
  `assets.bootstrapArtifact.definitions[*].allowed_values`).

### MINOR-3 — Unbounded wait around the competing-writer rejection

- **File:** `tests/support/sqladapter-qualification.ts` — `expectReject`
  (lines 62–69) awaits the candidate promise without any timeout; used for the
  competing `BEGIN IMMEDIATE` (line 205).
- **Why:** the reusable contract cannot configure a candidate connection's
  `busy_timeout` (connection setup is candidate-owned), so a candidate whose
  busy handling waits a long time before failing can stall the suite
  indefinitely. The reference runner is safe (`PRAGMA busy_timeout = 0`), and
  the CI workflow bounds the whole job with `timeout-minutes: 20`, but the
  reusable contract itself provides no bound or diagnostic.
- **Smallest correction:** race the awaited call against a documented timeout
  (e.g. `Promise.race` with a `setTimeout` rejection labelled
  "timed out waiting for competing BEGIN IMMEDIATE to fail") so a waiting
  candidate fails fast with a precise reason.

### MINOR-4 — CI `git diff --check` step is vacuous

- **File:** `.github/workflows/sqladapter-qualification.yml` lines 65–66.
- **Why:** `git diff --check` with no arguments compares the working tree
  against the index. In a clean `actions/checkout` working tree (including PR
  merge checkouts) there is never a diff, so the step always passes and never
  checks the committed changes it exists to check. Locally, the meaningful
  check (`git diff --check <base>...HEAD`) is clean — the hygiene itself is
  fine; only the CI step is inert.
- **Smallest correction:** check the actual range, e.g.
  `git diff --check ${{ github.event.pull_request.base.sha }}...HEAD` for PRs
  and `git diff --check HEAD^...HEAD` (or against the default branch) for
  pushes.

### NOTE-1 — Idempotent bootstrap reload is not exercised

`BootstrapLoader.load()` twice is not run by the qualification. HNT-001 does
not require it (item 8 requires load + manifest semantics only), and the
Gate-5B regression (G5B-7/8/9) already covers idempotent reload against the
reference adapter. A useful extra, not a defect.

### NOTE-2 — Canonical counts duplicated as literals

`15` (tables), `24` (definitions) and `20` (P0) are literals duplicating
knowledge derivable from `schema.sql`/the artifact. This pins the suite to the
canonical assets — arguably desirable — but any future adopted schema/artifact
change must update these constants; deriving them would remove the drift risk.

### NOTE-3 — ROLLBACK durability is not followed by close/reopen

HNT-001 item 5 ("ROLLBACK restores the pre-transaction durable state") is
satisfied: the post-rollback state is asserted on both primary and peer, which
is the durable layer. Reopening after rollback would strengthen the proof but
is not required by the contract wording.

### NOTE-4 — No-op-update `changes` edge is untested

An `UPDATE` that matches a row but writes identical values yields
`changes == 0` in node:sqlite (`sqlite3_changes` semantics). A future adapter
that reports matched-rows instead of modified-rows would not be caught by the
suite, and closed contracts using `changes == 1` could misbehave. Outside the
explicit HNT-001 item-3 wording (match → 1, non-match → 0, insert identity),
so a NOTE.

### NOTE-5 — Actions pinning on deprecated runtime

Run `34339995973` annotates that `actions/checkout@v4`, `setup-node@v4`,
`setup-python@v5` target the deprecated Node.js 20 Actions runtime (forced to
24). Functional today; pinning by SHA or updating majors is advisable.

### NOTE-6 — Push trigger limited to `experiment/**`

The workflow triggers on `push` only for `experiment/**` branches (plus all
PRs and `workflow_dispatch`). Deliberate and fine for a qualification harness;
pushes to other branches rely on PRs for CI coverage.

## 7. Disproved hypotheses (investigated, with evidence)

1. **"A per-statement-autocommit adapter could pass."** DISPROVED —
   `tests/review/hnt002/control-autocommit-detection.ts` shows the suite fails
   cases 4 (peer isolation), 5 (rollback) and 6 (competing BEGIN IMMEDIATE)
   for such an adapter. The suite has real teeth on transaction semantics.
2. **"The peer connection could target a different database and still pass."**
   DISPROVED by design — case 4 reads the primary-created probe table through
   the peer WITHOUT `expectReject`, so a different-DB peer errors and fails
   the case. Peer/primary same-DB-ness is enforced transitively by probe-table
   visibility.
3. **"A rejection of the competing `BEGIN IMMEDIATE` could occur for the wrong
   reason and still pass."** DISPROVED for realistic classes — an adapter that
   rejects `beginImmediate()` unconditionally fails case 4 (its own
   `beginImmediate` must succeed there); an adapter that rejects only while
   another connection holds the write lock fails for the correct reason.
4. **"`bigint` leakage of `changes`/`lastInsertRowid` could pass."** DISPROVED —
   the asserts use strict `=== 1` plus `typeof … === "number"`, which rejects
   `1n` and `"1"`.
5. **"A shared in-memory fake could pass durability."** DISPROVED by design —
   a single shared in-memory DB would leak uncommitted writes to the peer in
   case 4 and fail.
6. **"The local hang of the target suite is a candidate defect."** DISPROVED —
   plain `node:sqlite` + `schema.sql` loops with zero candidate code hang
   identically in this environment (strace: stuck kernel `fsync`, `D` state);
   the frozen candidate is green in GitHub Actions.
7. **"The first CI failure is a product defect in the frozen candidate."**
   DISPROVED — it was the shallow-checkout Gate-5B provenance failure on
   `f1d3ff9`; the frozen HEAD `d56c7bf` carries `fetch-depth: 0` and its run
   is green.

## 8. Historical baseline results

Adopted baselines (from `docs/project/TEST-BASELINES.md`):

| Suite | Expected | Local | CI (run 34339995973) |
|---|---|---|---|
| Gate 5L | 94/0 | 94/0 ✓ | **94/0** ✓ |
| Gate 5K | 82/0 | 82/0 ✓ | 82/0 ✓ |
| Gate 5J | 75/0 | 75/0 ✓ | 75/0 ✓ |
| Gate 5I | 48/0 | 48/0 ✓ | 48/0 ✓ |
| Gate 5H | 66/0 | 66/0 ✓ | 66/0 ✓ |
| Gate 5G | 41/0 | 41/0 ✓ | 41/0 ✓ |
| Gate 5F | 30/0 | 30/0 ✓ | 30/0 ✓ |
| Gate 5E | 79/0 | 79/0 ✓ | 79/0 ✓ |
| Gate 5D | 60/0 | 60/0 ✓ | 60/0 ✓ |
| Gate 5C | 55/0 | 55/0 ✓ | 55/0 ✓ |
| Gate 5B | 32/0 | 32/0 ✓ | 32/0 ✓ |
| Schema | 100/0 | 100/0 ✓ | 100/0 ✓ |

No baseline was weakened. No test was deleted or skipped.

## 9. Contract dimensions summary

- **Scope integrity:** exact base, exact 3-file additive diff, no pre-existing
  file modified, no hidden artifacts. ✓
- **Reusability:** the reusable contract imports only
  `src/bootstrap/{adapter,artifact,loader}.ts` (runtime-neutral — `src/`
  contains no `node:` imports, comments aside) and exposes a narrow
  factory/lifecycle seam (`createFresh` / `openPeer` / `reopen` / `cleanup`).
  No production business logic duplicated — the real `BootstrapLoader` is
  exercised. ✓
- **Parameter semantics:** Arabic + quote text, integer, NULL round-tripped
  through parameterized SQL. ✓
- **Affected rows/rowid:** changes 1/1/0 numeric, `lastInsertRowid` number,
  used as a live parameter. ✓
- **Explicit transactions / rollback / competing writers:** genuine file-backed
  multi-connection proofs, `busy_timeout = 0` in the reference setup, correct
  failure and post-release usability. ✓
- **Foreign keys:** primary + peer verified ON and real invalid writes
  rejected; reopen connections unverified (MINOR-1). ⚠
- **Bootstrap:** canonical committed artifact through the real loader;
  manifest semantics enforced by `verifyLoadedActiveP0` inside `load()`. ✓
- **Durability:** genuine close/reopen of the same durable file DB; cleanup
  robust on success/failure (idempotent closes, `finally` + best-effort
  `rmSync`). ✓
- **No overclaim:** the reusable header and runner both explicitly state the
  host-side subset and defer Android/device proofs to Gate 6B. ✓

## 10. Residual uncertainty

- Local executable runs in this review environment are subject to an
  intermittent kernel-level `fsync` stall (see §5.1). The frozen candidate's
  authoritative green evidence is GitHub Actions run `34339995973`
  (qualification 10/10 + all 12 adopted baselines). Local retries were run to
  completion wherever the environment allowed.
- The review reproducers demonstrate failure modes of the qualification
  contract itself; they are simulations of plausible broken adapters, not
  observations of the reference candidate (which is correctly implemented).

## 11. Final verdict

**FAIL — MAJOR DEFECTS**

The candidate is well-structured, faithfully separated (reusable contract vs.
node-specific lifecycle), honestly scoped (no Android/device overclaim), and
green on every adopted baseline. However, mandatory HNT-001 coverage item 1
("Exact adopted schema can be provisioned and is present") is implemented as a
table-count check only: a materially broken adapter that silently drops the 44
enforcement triggers, the derived view and all 24 indexes passes the entire
qualification 10/10 (demonstrated by `repro-schema-identity.ts`). Until the
schema case verifies materially stronger schema identity, the harness can
qualify an adapter whose provisioning silently weakens the closed Application
Core semantics — the exact failure mode the Gate-6B qualification exists to
prevent. This is a real coverage defect in a mandatory contract item, not a
style issue. The four MINOR findings (reopen foreign_keys unverified, weak
allowed-value count, unbounded competing-writer wait, vacuous CI diff check)
are limited and easily correctable.
