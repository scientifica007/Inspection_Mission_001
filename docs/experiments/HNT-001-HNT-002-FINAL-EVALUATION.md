# HNT-001 / HNT-002 — Final Evaluation and Project Tooling Decision

> **Status:** completed experiment record and PROJECT workflow/tooling decision.
>
> **Governing repository:** `scientifica007/Inspection_Mission_001`
>
> **Governing base:** live `main` at `17803cd96f1c83be60528fb2544b9d7e7a6c7526`
>
> This document preserves the HNT-001 implementation experiment, the HNT-002 adversarial-review experiment, the project owner's resulting tooling decision, and the pre-Gate-6B technical state. It does **not** adopt either experimental implementation as product code and does **not** reopen or correct a closed Gate.

## 1. Purpose of the experiment

HNT-001 / HNT-002 tested two implementation paths on the same narrowly scoped repository task: a reusable HOST-side `SqlAdapter` qualification harness.

The experiment was designed to compare practical implementation/review behavior, evidence quality, maintainability, CI integration, and failure-detection characteristics. It was not a universal benchmark of AI systems, implementation agents, or development environments.

The task under test was deliberately HOST-side. It was not Gate 6B itself and did not prove Android/device behavior.

## 2. Governing base and preserved branches

Both HNT-001 candidates were created from the same governing base:

`17803cd96f1c83be60528fb2544b9d7e7a6c7526`

The four preserved evidence branches are:

| Experiment role | Branch | Frozen SHA | Verified relationship |
|---|---|---|---|
| HNT-001 ChatGPT implementation candidate | `experiment/chatgpt-sqladapter-qualification-v1` | `d56c7bf3955e575af66b5c8219d6d3c59563ea47` | merge-base = governing base; 4 commits ahead; additive 3-file candidate diff |
| HNT-001 Harness implementation candidate | `experiment/harness-sqladapter-qualification-v1` | `efb9af5fc83a831e4d36f8752116f44ccab0cb59` | merge-base = governing base; 1 commit ahead; additive 3-file candidate diff |
| HNT-002 ChatGPT review of Harness | `experiment/hnt002-chatgpt-review-harness-v1` | `c43ef51ea40f31ce9a5818f999265a71686a069a` | descends from frozen Harness candidate; adds review-only evidence |
| HNT-002 Harness review of ChatGPT | `experiment/hnt002-harness-review-chatgpt-v1` | `33260dc53f12bb8db3af8631dcc7c6e7001e962b` | descends from frozen ChatGPT candidate; adds review-only evidence |

The experimental branches remain evidence references. They are not cleanup targets in this task.

## 3. HNT-001 implementation round

### 3.1 Verified candidate scope

The ChatGPT candidate added only:

- `.github/workflows/sqladapter-qualification.yml`
- `tests/sqladapter_qualification.ts`
- `tests/support/sqladapter-qualification.ts`

Total candidate additions: 461 lines, with no pre-existing file modified.

The Harness candidate added only:

- `.github/workflows/sqladapter-host-qualification.yml`
- `tests/sqladapter-qualification/node-host-runner.ts`
- `tests/sqladapter-qualification/qualification-contract.ts`

Total candidate additions: 1,137 lines, with no pre-existing file modified.

Both candidates preserved the closed historical regression suites and stayed additive.

### 3.2 Implementation comparison

The two candidates pursued the same broad architectural idea:

- reusable host-side assertions separated from candidate-specific lifecycle/setup;
- existing runtime-neutral `SqlAdapter` abstraction;
- existing `BootstrapLoader` and canonical bootstrap artifact;
- real file-backed SQLite where multi-connection/reopen behavior was required;
- explicit non-claims about Android/device proof.

The Harness implementation was substantially larger and deeper in its initial focused qualification surface. Its frozen HOST run reported **103 passed / 0 failed** focused assertions.

The ChatGPT implementation was substantially smaller. Its focused runner reported **10 passed / 0 failed** qualification cases.

This size/depth difference is an experiment fact, not by itself a quality verdict. HNT-002 demonstrated that both candidates still contained material qualification blind spots.

### 3.3 GitHub Actions evidence

#### ChatGPT candidate

Relevant GitHub Actions runs:

- `34339929482` at `f1d3ff95e2bee3477a8d67d0cc5030a218c955f3` — **failure**.
  - The focused `SqlAdapter` qualification passed.
  - The Application Core regression step failed in Gate 5B provenance checks because the default checkout was shallow (`fetch-depth: 1`).
  - The failures were specifically that the recorded generating commit could not be resolved and no parent commit was available for the simulation case.
- `34339995973` at frozen HEAD `d56c7bf3955e575af66b5c8219d6d3c59563ea47` — **success**.
  - The candidate corrected checkout to `fetch-depth: 0`.
  - Qualification: **10 / 0**.
  - All adopted Gate 5B→5L baselines and schema **100 / 0** were green.
  - The workflow job completed in about 24 seconds.

The 24-second CI duration is **not** a measured end-to-end HNT-001 ChatGPT implementation time. No reliable formal total ChatGPT implementation elapsed time was preserved, so this record does not invent one.

#### Harness candidate

Relevant GitHub Actions run:

- `34344297671` at frozen HEAD `efb9af5fc83a831e4d36f8752116f44ccab0cb59` — **success**.
  - HOST qualification: **103 / 0**.
  - All adopted Gate 5B→5L baselines and schema **100 / 0** were green.
  - The workflow used full Git history for Gate-5B provenance.

Owner-recorded HNT-001 Harness operational evidence:

- elapsed time: approximately **22 minutes 42 seconds**;
- API cost: approximately **USD 0.11**.

These are owner-recorded experiment metrics, not GitHub Actions measurements.

## 4. HNT-002 adversarial-review round

The two candidates were reviewed independently by the opposite implementation path.

### 4.1 ChatGPT adversarial review of Harness

Preserved evidence document:

`docs/experiments/HNT-002-CHATGPT-REVIEW-OF-HARNESS.md`

Frozen review HEAD:

`c43ef51ea40f31ce9a5818f999265a71686a069a`

Owner-recorded elapsed time:

**18 minutes 25 seconds**

Final finding count:

- BLOCKER: **1**
- MAJOR: **3**
- MINOR: **1**
- NOTE: **4**

Final verdict:

**FAIL — BLOCKER**

Important executable evidence included GitHub Actions run `34345876893`.

The most important reproduced defect was a false success on mandatory exact-schema qualification: the review replaced the body of a canonical enforcement trigger while retaining the expected schema inventory shape, and the complete Harness qualification still reported **103 / 0**.

Additional significant findings:

- non-INSERT `lastInsertRowid` normalization was not negatively asserted and the Node reference adapter could return a stale numeric rowid for UPDATE/non-insert statements;
- the competing `BEGIN IMMEDIATE` proof assumes prompt rejection and is not neutral to a conforming implementation that blocks/queues until the lock is released;
- close/reopen qualification could false-pass when logical `close()` was deliberately implemented as a no-op;
- cleanup/disposal failures were suppressed and could coexist with a green result.

Important hypotheses were also investigated and disproved. In particular, the review showed that provisioning-only `PRAGMA synchronous=OFF` was connection-local in this setup; a fresh qualification connection reopened with `synchronous=2`, so that provisioning optimization did not leak into the authoritative test connections.

### 4.2 Harness adversarial review of ChatGPT

Preserved evidence document:

`docs/experiments/HNT-002-HARNESS-REVIEW-OF-CHATGPT.md`

Frozen review HEAD:

`33260dc53f12bb8db3af8631dcc7c6e7001e962b`

Owner-recorded elapsed time:

**65 minutes 48 seconds**

Final finding count:

- BLOCKER: **0**
- MAJOR: **1**
- MINOR: **4**
- NOTE: **6**

Final verdict:

**FAIL — MAJOR DEFECTS**

The most important executable finding was also an exact-schema false positive, but through a different weakened provisioning. The review demonstrated that the ChatGPT qualification could report **10 / 0** when the database had the expected 15 tables but **0 triggers, 0 views, and 0 explicit indexes**.

Additional findings:

- `PRAGMA foreign_keys` was not independently verified on reopened authoritative connections;
- bootstrap allowed-value persistence after reopen was checked only as `> 0` rather than the exact knowable count;
- the competing-writer rejection lacked a bounded timeout inside the reusable qualification contract;
- the workflow's clean-checkout `git diff --check` invocation did not meaningfully inspect committed diff hygiene.

The Harness review also disproved candidate-defect hypotheses. Notably, its `control-autocommit-detection.ts` showed that a per-statement-autocommit adapter fails the transaction cases, so the ChatGPT transaction coverage had real discriminatory value.

### 4.3 Harness-review execution-environment limitation

The Harness review encountered an intermittent local/environmental file-backed SQLite `fsync` stall. The reviewer reproduced the same stall with plain `node:sqlite` and `schema.sql` loops containing no candidate code, and used local workaround/intervention to complete affected runs.

This is preserved as an experiment-environment limitation. It is **not** classified as a defect in the reviewed ChatGPT candidate.

## 5. Historical baselines

Both HNT-001 frozen candidates preserved the adopted historical regression state:

| Suite | Adopted result |
|---|---:|
| Gate 5L | 94 / 0 |
| Gate 5K | 82 / 0 |
| Gate 5J | 75 / 0 |
| Gate 5I | 48 / 0 |
| Gate 5H | 66 / 0 |
| Gate 5G | 41 / 0 |
| Gate 5F | 30 / 0 |
| Gate 5E | 79 / 0 |
| Gate 5D | 60 / 0 |
| Gate 5C | 55 / 0 |
| Gate 5B | 32 / 0 |
| Schema | 100 / 0 |

No HNT candidate changed the closed Application Core/schema/bootstrap artifacts on the governing base.

## 6. Experiment result

The experiment result is narrower than a universal ranking.

What HNT-001/HNT-002 established for this project:

1. Both implementation paths were capable of producing additive, repository-hosted host qualification infrastructure while preserving historical regressions.
2. Harness produced the deeper/more extensive initial qualification implementation.
3. ChatGPT produced a materially smaller implementation and integrated the implementation/validation loop directly with GitHub and GitHub Actions.
4. ChatGPT's first CI attempt exposed a real shallow-history integration problem; the candidate corrected it before freezing.
5. Independent adversarial review found material false-positive coverage defects in **both** candidates.
6. The two reviews had materially different execution characteristics:
   - the ChatGPT review of Harness used GitHub-hosted executable reproducers efficiently;
   - the Harness review of ChatGPT encountered a local file-backed SQLite/fsync environmental stall and required local workaround/intervention.
7. Neither experiment establishes that one implementation agent is universally superior for all engineering work.
8. Neither HNT-001 candidate is sufficiently justified for adoption or merge **as-is**.

### Experimental artifact status

The HNT implementation candidates and HNT-002 review reproducers are **experimental evidence only**.

They are **not adopted product artifacts**.

Neither HNT-001 candidate is to be merged into `main` as-is.

The HNT-002 review test/reproducer files are not to be merged into product `main` through this experiment-closure task.

## 7. Limitations and potential biases

The experiment has important limits:

- It tested one scoped repository task: HOST-side `SqlAdapter` qualification. It is not a general benchmark of coding/review ability.
- It did not test physical Android/device implementation, ADB/USB, hardware lifecycle, app-private storage, device reboot, or real plugin behavior.
- The initial candidates were not identical in size/depth, so raw assertion counts are not a normalized quality metric.
- The two reviewers operated in different execution environments and with different operational constraints.
- Owner-recorded elapsed times were not produced by one standardized measurement harness and should not be over-interpreted as precise performance ratios.
- A formal full HNT-001 ChatGPT implementation elapsed time was not preserved.
- Local execution friction in one reviewer environment cannot be generalized to all Harness/local-agent use.
- GitHub-hosted execution cannot replace physical-device validation when a task genuinely requires local hardware.
- Reviewer findings are evidence about these frozen artifacts, not a proof that future implementations by the same tool will have the same defect pattern.

## 8. PROJECT OWNER DECISION

The project owner explicitly decided:

> "I will continue the work using ChatGPT."

This is a **PROJECT workflow/tooling decision**. It is not a DIRECT official-source requirement and not a product-domain requirement.

The resulting default project implementation workflow is:

**ChatGPT + GitHub + GitHub Actions**

This decision uses the completed HNT-001/HNT-002 experiment as evidence, but it is ultimately an explicit owner choice. The experiment does not mathematically prove a universal winner.

## 9. Resulting default operating workflow

The normal implementation structure is now:

```text
Project Owner
    ↓
Reviewing / Planning AI
    - Fresh Read
    - architecture
    - Gate/task definition
    - implementation prompt/brief
    - adversarial review
    - acceptance recommendation
    ↓
Independent ChatGPT Implementation Agent
    - dedicated GitHub branch
    - scoped implementation
    - GitHub Actions
    - final implementation report
    ↓
Reviewing / Planning AI
    - reads actual GitHub diff/files/CI
    - accepts or requests narrow correction
    ↓
Project Owner approval
    ↓
PR / main
```

Where independent review matters, the Reviewing/Planning AI and the independent ChatGPT implementation executor are distinct roles.

Another implementation agent may be substituted in the future. This workflow decision is current project policy, not an irreversible architecture constraint.

## 10. Harness / local-agent on-demand policy

Harness is no longer a routine/default workflow component.

Harness or another local execution agent is **ON-DEMAND ONLY** when a concrete task materially requires local/physical capabilities that GitHub-hosted execution cannot efficiently provide, for example:

- a physical Android phone;
- ADB / USB;
- real local-device lifecycle;
- hardware-specific reproduction;
- local filesystem/device behavior unavailable in GitHub-hosted CI.

The on-demand policy preserves the ability to use local agents where they add unique value. It does not characterize Harness as obsolete, useless, or generally inferior.

## 11. Pending narrow closed-Gate correction review

The experiment uncovered a concrete potential contradiction in closed Gate-5B adapter behavior.

Live governing `main` currently defines:

- `src/bootstrap/adapter.ts`: `SqlResult.lastInsertRowid` is the inserted row id when the statement inserted a row, **otherwise `null`**.
- `dev/node-sqlite-adapter.ts`: `NodeSqliteAdapter.run()` normalizes any numeric/native `lastInsertRowid` returned by `node:sqlite` to a number.

HNT-002 executable evidence on the Node reference runtime showed that after an INSERT, a later UPDATE/non-insert statement can receive the previous numeric rowid from `node:sqlite`, and `NodeSqliteAdapter` can propagate that stale number.

Status:

**PENDING NARROW CLOSED-GATE CORRECTION REVIEW**

This experiment-closure task does not decide the correction semantics, does not modify the adapter contract, does not modify the Node adapter, and does not modify Gate-5B regressions.

The contradiction must be reviewed/resolved through the owner-authorized narrow closed-Gate correction workflow **before Gate 6B technical implementation relies on the `SqlAdapter` contract for native/device qualification**.

## 12. Gate 6B state and next step

Gate 6B remains the next **product Gate**:

**Gate 6B — Android Shell + Native SQLite Adapter / Device Runtime Proof**

Status remains:

**NOT_STARTED**

Experiment closure does not start Gate 6B.

The immediate next technical step is:

1. complete the pending narrow closed-Gate correction review for `SqlResult.lastInsertRowid` non-insert behavior;
2. resolve it through the existing owner-authorized narrow-correction workflow if correction is approved;
3. only then begin Gate 6B implementation using the default `ChatGPT + GitHub + GitHub Actions` workflow;
4. use Harness/local execution on demand only if Gate 6B work reaches a concrete physical-device/local capability that GitHub-hosted execution cannot provide efficiently.

## 13. Closure statement

### EXPERIMENT RESULT

Both HNT-001 candidates preserved scope and regressions and both supplied useful host-side qualification evidence, but adversarial review found material qualification blind spots in both frozen implementations. The experiment therefore closes without adopting or merging either candidate as-is.

### PROJECT OWNER DECISION

The owner selected **ChatGPT + GitHub + GitHub Actions** as the project's default implementation workflow going forward, with Harness/local execution reserved for concrete on-demand local/physical capability needs.

These are distinct conclusions: the first is an experiment evidence summary; the second is the owner's project workflow decision.
