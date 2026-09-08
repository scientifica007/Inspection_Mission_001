# Gate 5A Decisions — v1 (incl. owner correction pass & Gate 4B alignment)

> **Gate:** 5A — Application Core Contracts & Transaction Design (DESIGN only; no production code), updated by the owner-authorized **correction pass (Part B: B1..B12)** and aligned to **Gate 4B** (`VOIDED` Finding lifecycle).
> **Fresh Read base (authoritative main):** `e4eca7dfdcbb8509c98806fb905a73d7a1b0a96f` ("Merge checklist applicability bridge v1").
> **Working branch:** `harness/application-core-design-v1` (no commit made in this gate).
> **Deliverables:** this file + `APPLICATION-CORE-v1.md` + `TRANSACTION-CONTRACTS-v1.md` + `RECOVERY-AND-IDEMPOTENCY-v1.md` (proposals, uncommitted) — plus the Gate-4B corrections to the closed-gate artifacts (see Gate-4B alignment record).

---

## D1 — Application-core technology

**Decision: the production domain core is a runtime-neutral / WebView-compatible TypeScript library, with SQLite 3 as the authoritative store against the exact `docs/schema/schema.sql` schema.** **Node.js ≥ 22 is the Ubuntu development/test host only** — the domain core never depends on `node:*` APIs. `node:sqlite` is the development/test adapter only; the future mobile adapter is a native SQLite adapter behind the same narrow seam, exposing parameterized SQL and an **affected-row count normalized across adapters** (B5). The seam is designed **async-capable from day one** (Promise-returning conceptual methods: `beginImmediate()`, `execute(...)`, `query(...)`, `commit()`, `rollback()`, `affectedRows`/`changes`); the Node adapter may internally wrap synchronous `node:sqlite`, but domain-service contracts never depend on synchronous `DatabaseSync` semantics, and the adapter must preserve the explicit `BEGIN IMMEDIATE … COMMIT/ROLLBACK` transaction boundary (never silently wrapping each statement in its own transaction inside a domain transaction). UI framework deferred; no driver implemented in this gate.

Justification against the selection criteria (unchanged from the initial 5A read): runtime-neutral core for local-only single-inspector use; offline SQLite file; phone/tablet via later WebView/native packaging with identical SQL/transactions; Arabic RTL and photo capture later; SQLite atomic commits + BEGIN IMMEDIATE units for crash safety; **testable now** — Node 24.20 `node:sqlite` (SQLite 3.53.4) executes `schema.sql` from scratch (15/44/1/24) and Python 3.12 sqlite 3.45.1 runs the cumulative suite (92/0 with Gate-4B); the surviving asset is the SQL + service contracts. Rejected: Python (re-host = throwaway), JVM/Kotlin (iOS coupling/toolchain), Flutter/Dart (toolchain absent), Rust (toolchain absent). The device-driver limitation is documented, not hidden.

---

## D2 — Durable Visit scope

**Decision (updated by B2/B3/B4):** the 15-table schema represents the intended Visit scope durably and unambiguously via **dense-grid `checklist_response` materialization while the Visit is PREPARATION**, over a **captured instrument universe**:

- **Captured universe:** at `createVisit` (T0) — **mission precondition: `mission.status IN ('PREPARATION','ACTIVE')`** (a COMPLETED/ARCHIVED Mission rejects a new Visit, `E_MISSION_CLOSED`; APP validation, no schema change) — the verified manifest's expected v1 P0 set is compared **exactly, both directions**, against the loaded DB `ACTIVE` + `priority='P0'` code set (expected code missing ACTIVE ⇒ `E_NO_ACTIVE_DEFINITION`/`E_BOOTSTRAP_DRIFT`; unexpected ACTIVE-P0 code ⇒ `E_BOOTSTRAP_DRIFT`; P1 excluded). Each expected code is then bound to its one ACTIVE definition and the institution-context cells (subject NULL) freeze that (code → version) map. Those rows are the authoritative universe for the Visit's whole life.
- **Contexts:** institution context (subject NULL, kind INSTITUTION) + in-scope subject rows (kind = `subject_type`).
- **Scope entry is atomic** per operation (`createVisit`, `addSubjectToScope`) and scope ≡ materialized rows; crash-before-commit = not in scope; crash-after-commit = fully in scope. No partial, no silent forgetting. `addSubjectToScope` on an existing subject compares the expected grid (captured universe × subject) with the actual cells inside the transaction: full ⇒ no-op success; empty ⇒ atomic insert; partial ⇒ `E_SCOPE_GAP` + ROLLBACK (never silently repaired) — making the existing-subject path genuinely Class A.
- **Answers operate only on existing true-pending cells** (B4) — a missing cell is `E_CELL_NOT_MATERIALIZED`, an answered/reasoned cell is `E_ALREADY_DISPOSITIONED` (use T6 correction); only scope-entry ops materialize rows.
- The verification table from the initial read (CHECKLIST-MODEL / DATA-MODEL / ENTITY-CATALOG / schema triggers / historical truth / `recorded_at` / finalization semantics — all VALID) remains in force; **`recorded_at`/`recorded_by` are cell-materialization audit and do NOT prove answer-time or answer-author attribution (B12)**.

**Conclusion: no contradiction with Gates 1–4A (or 4B) artifacts; no schema change was needed for the scope design.**

---

## D3 — Definition-version freezing

**Decision:** a definition version becomes selected for (visit_id, item_code, context) at the instant its cell row is inserted, atomically inside scope-entry ops: `createVisit` first verifies the manifest-vs-ACTIVE-P0 **exact-set equality** (both directions, P1 excluded), then binds each expected code to its unique ACTIVE definition and freezes it via the institution-context cells; every later `addSubjectToScope` **reuses exactly those pinned versions from the captured universe** — it never discovers new codes from current ACTIVE definitions (B2). The selection *is* the row (`item_definition_id`), survives restart, and cannot be reinterpreted (`uq_response_ctx` + version-mix guards, I21); pin keeps one question version per item_code inside the Visit.

---

## D4 — note_rule cross-check (24 items)

**Result: PASS — no machine-readable-rule gap.** All CHK-001..CHK-024 note requirements reduce to *answered_value.semantic_class = NON_COMPLIANT ⇒ meaningful note at record time* (per-item table in APPLICATION-CORE §7). Implementation derives from `semantic_class` only; `note_rule` remains reference metadata; Arabic never parsed; item codes never hard-coded.

---

## D5 — Reference-data / bootstrap strategy (Gate 5B design, extended by B3)

`schema.sql` contains no seed data; canonical authorities stay FIELD-CHECKLIST-v1.md and APPLICABILITY-RULES-v1.md. Design:

1. **Generator** (deterministic) emits one committed artifact (e.g. `bootstrap/v1/checklist-v1.json`) with the 24 definition records (question, allowed values with `value_code` + `semantic_class`, priority, refs, rules, applicability payload verbatim) **plus a manifest section listing the expected v1 P0 item-code set** (CHK-001..CHK-020 in v1) — the manifest is the code-set authority, kept in data, never hard-coded in application logic.
2. **Provenance:** SHA-256 of each canonical source + generator version + generating commit SHA.
3. **Idempotent transactional loader** (one tx per item; re-runs are no-ops).
4. **Verification:** (a) loader count and ACTIVE-one-per-code; (b) drift test re-derives the artifact from current markdown and diffs; (c) `createVisit` verifies the **exact-set equality** manifest expected P0 set ⇔ loaded DB `ACTIVE`+`P0` set in **both directions** (missing-ACTIVE ⇒ `E_NO_ACTIVE_DEFINITION`/`E_BOOTSTRAP_DRIFT`; unexpected ACTIVE-P0 ⇒ `E_BOOTSTRAP_DRIFT`; P1 excluded) — a missing or extra canonical item never disappears or slips in silently (B3).
5. Editorial mapping tables (which option is NON_COMPLIANT; value_code tokens) live in the generator as explicit reviewable tables.

---

## D6 — Applicability evaluator (recorded contract)

Generic, data-driven; reads the exact selected definition's `applicability_rule` from SQLite; never `switch(item_code)` (formal contract in APPLICATION-CORE §5). HUMAN_CONFIRMATION requires an explicit inspector decision — **never inferred**; per B1, `NOT_APPLICABLE` may be a standalone `NA` decision **only on the unresolved pending HUMAN state** (T5, five predicates) while `APPLICABLE` is only ever co-recorded with the final disposition (answer / NOT_INSPECTED+reason) in the same operation; reversals are explicit T6 corrections, never a blind overlay-state swap.

---

## Correction pass record (owner brief Part B — B1..B12)

| # | Correction | Where applied |
|---|---|---|
| B1 | No durable standalone HUMAN→APPLICABLE state; explicit APPLICABLE supplied with the final disposition op; restart semantics fixed | APPLICATION-CORE §3.3/§4.4/§5.5; TRANSACTION T2/T4/T5; RECOVERY §6 |
| B2 | Instrument universe captured once at createVisit (institution-context cells); addSubjectToScope derives codes only from that universe | APPLICATION-CORE §3.5/§4.2/§6; TRANSACTION T0/T1; RECOVERY §6/§6.1 |
| B3 | Bootstrap manifest defines expected v1 P0 codes; createVisit validates every code has exactly one ACTIVE definition | APPLICATION-CORE §3.5/§4.1; TRANSACTION T0; GATE5A-DECISIONS D5 |
| B4 | No answer INSERT fallback; answer ops operate only on existing materialized cells | APPLICATION-CORE §4.5/§5.4; TRANSACTION §4/§5/§6 |
| B5 | Affected-row cardinality (`changes == 1`) on every guarded write; zero-row ⇒ ROLLBACK + re-read | TRANSACTION §1/§13; RECOVERY §1/§3 |
| B6 | Finalization = one BEGIN IMMEDIATE with preflight inside; no TOCTOU | APPLICATION-CORE §4.10/§8; TRANSACTION T11; RECOVERY §2 |
| B7 | Idempotency split into classes A (state-idempotent) and B (identity-creating; serialize + surface, no exactly-once claim) | TRANSACTION §12; RECOVERY §5 |
| B8 | CHK-012 NEW-Finding path fully atomic (T3A); T3B existing-finding; compliant / NOT_INSPECTED branches | TRANSACTION §5 |
| B9 | Removed invented rules: direct OPEN→RESOLVED is legal; CorrectiveActions optional (0..*) | APPLICATION-CORE §4.8; TRANSACTION §9/§10 |
| B10 | Dedicated `voidOpenFindingByLastSourceCorrection` (never a generic status button) with single-tx ordering | APPLICATION-CORE §4.9; TRANSACTION §7 (T6-VOID) |
| B11 | Recovery/grid reconstruction uses captured universe × captured contexts; VOIDED listed as history; source-less OPEN = E_ORPHAN | RECOVERY §6/§6.1 |
| B12 | recorded_at/by wording: cell materialization audit only; no answer-time attribution claims | APPLICATION-CORE §3.4; RECOVERY §1 |

---

## Final limited correction pass record (owner brief corrections 1..8)

| # | Correction | Where applied |
|---|---|---|
| 1 | Runtime-neutral / WebView-compatible TypeScript core; Node ≥ 22 is the dev/test host only; no `node:*` dependency in the core; `node:sqlite` = dev/test adapter only; async-capable seam (`beginImmediate`/`execute`/`query`/`commit`/`rollback`, normalized `affectedRows`/`changes`); adapter preserves the explicit transaction boundary (no per-statement auto-commit inside a domain transaction) | APPLICATION-CORE §1; RECOVERY §1.5; GATE5A-DECISIONS D1 |
| 2 | `createVisit` mission precondition restored: `mission.status IN ('PREPARATION','ACTIVE')`, `E_MISSION_CLOSED` otherwise (APP validation; no schema change) | APPLICATION-CORE §4.1; TRANSACTION T0; RECOVERY §2 |
| 3 | `createVisit` checks manifest expected P0 set ≡ loaded DB `ACTIVE`+`P0` set **exactly, both directions** (missing ⇒ `E_NO_ACTIVE_DEFINITION`/`E_BOOTSTRAP_DRIFT`; unexpected ACTIVE-P0 ⇒ `E_BOOTSTRAP_DRIFT`; P1 excluded) before inserting the Visit | APPLICATION-CORE §3.5/§4.1/§6; TRANSACTION T0; DECISIONS D2/D3/D5 |
| 4 | `addSubjectToScope` exact contract: expected grid = captured universe × subject; A full → no-op success; B empty → atomic insert; C partial → ROLLBACK `E_SCOPE_GAP` (never repaired); new-subject creation stays class B, existing-subject path is genuinely class A | APPLICATION-CORE §4.2; TRANSACTION T1; RECOVERY §2/§5 |
| 5 | HUMAN semantics corrected: no "physical NA↔NOT_INSPECTED ban" claim (schema can write it; the DOMAIN restricts it); T5 NOT_APPLICABLE operates only on the unresolved pending HUMAN state (5 predicates); reversals via explicit T6 corrections, never a blind overlay-state swap | APPLICATION-CORE §3.3/§4.4/§5.5; TRANSACTION §6/§7 |
| 6 | T2/T3 initial answers consume a TRUE pending cell only (`overlay_state='NOT_INSPECTED'`, answer NULL, reason NULL, finding NULL) and explicitly write `overlay_state=NULL` + `not_inspected_reason=NULL`; a reasoned cell → answer is a T6 correction | APPLICATION-CORE §4.5/§4.6; TRANSACTION T2/T3 |
| 7 | T6-VOID has real branch-specific source-correction SQL shapes: A NC→COMPLIANT, B NC→NA (valid HUMAN correction only), C NC→deliberate NOT_INSPECTED, D AdHoc retraction; each changes==1; then zero-source verification + FollowUp + OPEN→VOIDED + COMMIT; any failure rolls back everything | TRANSACTION §7 (T6-VOID) |
| 8 | DB-vs-APP VOIDED boundary corrected: the DB guarantees current-state checks only (creation OPEN; source required to leave OPEN toward IN_TREATMENT/RESOLVED; OPEN→VOIDED current-state preconditions; terminal rules; no source/action attach to VOIDED); the causal "last-source correction" lifecycle, the no-source-less-OPEN-at-rest rule, the single-transaction ordering, and the mandatory FollowUp are APP/domain guarantees — no claim that the DB alone proves the causal lifecycle | PHYSICAL-SCHEMA §8; CONSTRAINT-MATRIX I22/§و; APPLICATION-CORE §2/§4.9; RECOVERY §3; TRANSACTION §7 |

---

## Micro-correction pass (T7 idempotency + last-source re-home + VOID) — Gate-5A design only

This pass touches the four Gate-5A proposals only (no schema/Gate-4B changes, no suite changes). Record:

| # | Correction | Where applied |
|---|---|---|
| M1 | **T7 is an ensure-accounted operation**: pre-read the AdHocObservation (`E_OBSERVATION_NOT_FOUND`; Visit PREPARATION/not finalized when creating a new relationship); if `observation.finding_id` is already set → return the existing linked Finding **without** INSERT; only `finding_id IS NULL` creates a Finding OPEN (origin = observation's Visit) with a guarded link `WHERE finding_id IS NULL` requiring `changes==1`; zero-row → ROLLBACK (new Finding disappears) + re-read + return the existing link; never blindly overwrites `observation.finding_id` | APPLICATION-CORE §4.7; TRANSACTION §8 (T7); RECOVERY §2/§5 |
| M2 | **T6-REHOME `rehomeLastSourceAndVoidFinding`**: dedicated branch for "source remains valid but its Finding association was wrong" — replaces the previous `E_LAST_SOURCE` dead-end; preconditions (F_old OPEN, origin Visit open, last source, zero actions, valid target OPEN/IN_TREATMENT/same institution/confirmed covers-same-issue/never VOIDED-RESOLVED); forms **A existing target** and **B new target** (`origin_visit_id` = the source's Visit so first-source integrity holds); guarded re-assignment `changes==1`, verify F_old zero sources, FollowUp VOIDED for F_old, F_old → VOIDED, COMMIT; any failure rolls back everything incl. the new target; supports ChecklistResponse (answer stays NON_COMPLIANT) and AdHocObservation (only finding_id changes unless a requested text/subject correction rides along) | APPLICATION-CORE §4.7/§4.9; TRANSACTION §7 (T6-REHOME); RECOVERY §2/§5 |
| M3 | **Ordinary re-home rules clarified**: F_old retains ≥1 other source → ordinary re-home, F_old stays active; last source → ordinary re-home NOT allowed, use T6-REHOME; F_old IN_TREATMENT/RESOLVED → last-source re-home refused; F_old with any CorrectiveAction → last-source re-home/VOID refused (`E_VOID_HAS_ACTIONS`) | TRANSACTION §7 |
| M4 | **State-based retry for re-home+VOID** (no idempotency table): retry reads `source.finding_id` and F_old.status → intended target + F_old VOIDED = idempotent success; never a second target Finding on blind retry; NEW-target durable `source.finding_id` identifies the already-created target after restart | TRANSACTION §7/§12; RECOVERY §5; APPLICATION-CORE §4.9 |
| M5 | **Narrow audit of create+link paths**: T2 (NEW Finding + response), T3A (NEW Finding + schedule response), T7 (NEW Finding + observation). T2/T3A are already safe (guarded true-pending source UPDATE; zero-row rolls back the just-inserted Finding then re-reads the existing cell/finding link) and were NOT rewritten; T7 was corrected per M1 | TRANSACTION §12 audit note; APPLICATION-CORE §4.7 |

---

## Gate-4B alignment record (Part A — VOIDED lifecycle)

Aligned closed-gate artifacts (Gate 4B narrow correction): `docs/data-model/DATA-MODEL-v1.md` (entity 3.10 lifecycle, §4 lifetime, rules 4/15 + new rule 22, Q1 note), `docs/data-model/ENTITY-CATALOG-v1.md` (dictionary split Finding vs CorrectiveAction states, §2.10, §2.13 status_after), `docs/schema/schema.sql` (Revision 5 header; `finding.status` + `follow_up.status_after` CHECKs + conditional VOIDED⇒FINDING; extended `trg_finding_bu`, `trg_ca_bi`, `trg_response_bi/bu`, `trg_obs_bi/bu`; **no new trigger/table — counts stay 15/44/1/24**), `docs/schema/PHYSICAL-SCHEMA-v1.md`, `docs/schema/CONSTRAINT-MATRIX-v1.md` (M10/A8/I15/I22/§و/§ز), and the cumulative suite `tests/gate4a_regression.py` (S12, 21 new cases; **92 total / 0 failures**).

Adopted semantics used identically across all files: `OPEN → VOIDED` only; VOIDED terminal; origin Visit PREPARATION & `finalized_at NULL`; zero sources and zero corrective actions at the instant of voiding; zero-source OPEN still cannot reach IN_TREATMENT/RESOLVED; FollowUp event `status_target=FINDING`, `status_after=VOIDED`; VOIDED never regains a source or action; `CorrectiveAction` has no VOIDED; direct `OPEN → RESOLVED` remains legal; CorrectiveActions remain optional (0..*).

---

## Blockers

**None.** No contradiction with closed-gate artifacts (Gates 1–4B); no schema correction beyond the owner-approved Gate-4B change; no machine-readable note-rule gap; the production-intended technology executes in this workspace.

Open/deferred items (explicit, not blockers): device SQLite driver validation (UI/device gate); `recorded_at` answer-time attribution would need an explicit later schema decision (B12 — not added); editorial value_code/semantic mapping tables (Gate 5B, D5); HUMAN-confirmation UI prompt content (later UI gate; the service contract is fixed); Gate-5B bootstrap manifest artifact generation.

---

## Verification record

### A) Every APP-only obligation is covered (CONSTRAINT-MATRIX §و 1..8)
Applicability evaluation/completion (§5 + T11 preflight) · transition events incl. VOIDED as FollowUp (T8/T10/T6-VOID; no raw status API) · ACTIVE selection + captured universe (§3.5/§6) · dynamic note rule (§7) · covers-same-issue judgment (§4.7) · OPEN→first-source atomic (T2(b)/T7) · VOID ordering (T6-VOID) · evidence hash/storage deferred.

### B) Gate-3/4B invariants I1..I22 (no adopted rule dropped)
I1 fixedness (PREPARATION-only writes; §3.3) · I2 NC accountability · I3 NA≠NOT_INSPECTED + closure states · I4 source/origin + VOIDED exception (rule 4) · I5 classification independence · I6 evidence deferred · I7 action ownership · I8 FollowUp append-only/status_target · I9 external tracking append-only · I10 reference date · I11 versioning + canonical rule · I12 CHK-012 · I13 value integrity/view · I14 response uniqueness · I15 closure consistency (+VOIDED) · I16 institution consistency · I17 evidence referentiality deferred · I18 audit trail · I19 no reopen · I20 report deferred · I21 single version per (visit,item_code,context) · I22 VOIDED lifecycle (Gate 4B).

### C) Gate-4A applicability contract honored
Rule stored/versioned by schema; evaluation is APP; P0-only finalization; no item-code hard-coding; 24 canonical payloads loadable (s10/s11 still green in the 92-case cumulative run).

### D) Static checks (document review)
Gate-5A docs no longer contain: INSERT answer fallback for answers; "direct OPEN→RESOLVED forbidden"; a mandatory-CorrectiveAction claim; a standalone durable HUMAN→APPLICABLE state; the claim that a physical `NA ↔ NOT_INSPECTED` transition is impossible (it is physically representable; the domain restricts it); a claim that every write command is exactly/state idempotent (classes A/B documented, T1 grid comparison exact); addSubjectToScope discovering new item codes from current ACTIVE definitions (captured universe only); claims that the DB alone prevents a committed source-less OPEN Finding or proves the causal VOID lifecycle (DB-vs-APP boundary documented); **T7 blindly overwriting `observation.finding_id` (it is ensure-accounted with a pre-read and a `finding_id IS NULL` guard); the last-source "wrong finding" correction dead-ending in `E_LAST_SOURCE` (it now has the dedicated T6-REHOME branch with state-based retry).**

### E) Files & scope discipline
Gate-4B modified (closed-gate): the six Part-A files listed in the alignment record. Gate-5A modified: the four `docs/application/*` proposals. No UI, no schema beyond Gate-4B, no production source, no commit. `git status --short` recorded in the gate report.
