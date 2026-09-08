# Application Core Contracts — v1 (Gate 5A + owner correction pass)

> **Status:** DESIGN — Gate 5A with the owner-authorized correction pass (Part B: B1..B12) and alignment to the Gate-4B `VOIDED` Finding lifecycle.
> **Base (authoritative main):** `e4eca7dfdcbb8509c98806fb905a73d7a1b0a96f` — working branch `harness/application-core-design-v1`.
> **Scope:** executable-quality contracts for the single-inspector offline v1 core. No UI, no screens, no report generation, no physical evidence-file storage, no server/API/sync, no production code, no commit in this gate.
> **Companion files:** `docs/application/TRANSACTION-CONTRACTS-v1.md`, `docs/application/RECOVERY-AND-IDEMPOTENCY-v1.md`, `docs/application/GATE5A-DECISIONS-v1.md`.

---

## 1) Technology decision (summary — authority: GATE5A-DECISIONS-v1.md §D1)

- **Production domain core:** a **runtime-neutral / WebView-compatible TypeScript library** (no dependency on `node:*` APIs). **Node.js ≥ 22 (present: Node 24.20) is the Ubuntu development/test host only** — it is not a runtime requirement of the shipped core.
- **Store:** **SQLite 3** is the single authoritative store — exactly the `docs/schema/schema.sql` schema (15 tables / 44 triggers / 1 view / 24 explicit indexes; Gate-4B `VOIDED` included). No second database, no sidecar JSON, no volatile cache as authority.
- **SQLite driver seam:** `node:sqlite` (`DatabaseSync`) is the **development/test adapter only**. The future mobile adapter is a native SQLite adapter behind the same seam. **The SQL text, transactions and domain services are identical in both.** The seam is designed **async-capable from day one**: conceptual methods return Promises — `beginImmediate()`, `execute(...)`, `query(...)`, `commit()`, `rollback()`, and an **affected-row count** (`affectedRows`/`changes`) normalized across adapters. The Node adapter may internally wrap synchronous `node:sqlite`, but **domain-service contracts never depend on synchronous `DatabaseSync` semantics**. The adapter must preserve the explicit application transaction boundary (`BEGIN IMMEDIATE … statements … COMMIT/ROLLBACK`) and must **not** silently wrap each statement in its own independent transaction inside a domain transaction. No driver is implemented in this gate.
- `tests/gate4a_regression.py` (Python stdlib sqlite3 3.45.1) remains the schema-level reference suite. The 92/0 figure cited in the Gate-5A adoption decisions was the Gate-4B-era baseline; the CURRENT cumulative schema-regression count is maintained in `docs/schema/PHYSICAL-SCHEMA-v1.md` / `CONSTRAINT-MATRIX-v1.md` and is 100/0 after the owner-authorized Revision-6 correction (conditional reconciliation-row DELETE during PREPARATION).
- **No UI framework is implemented or chosen for implementation in this gate.**

---

## 2) Architectural posture

1. The physical schema is the **hard floor**: every rule the DB enforces is relied upon and never duplicated in a weaker form by the app.
2. All obligations the DB **cannot** enforce (CONSTRAINT-MATRIX-v1.md §و, items 1..8 incl. the Gate-4B VOID ordering; APPLICABILITY-RULES-v1.md §10) are owned by exactly one domain service each (§4).
3. No new entity/table is added in this gate or in Gate 4B; the durable Visit scope is represented by existing rows (§3.2) and the Finding `VOIDED` state by the extended status value-set + triggers.
4. All checklist business truth is loaded from the verified bootstrap artifact (Gate 5B; GATE5A-DECISIONS-v1.md §D5); the runtime never parses Arabic prose and never switches on `item_code`.

---

## 3) Core concepts

### 3.1 Visit lifecycle (as designed by the schema)

`PREPARATION` (creation + field work; rows writable/correctable) → atomic finalization to `COMPLETED` (no NOT_INSPECTED rows) or `COMPLETED_WITH_UNINSPECTED` (≥ 1 NOT_INSPECTED row, each with a reason). After `finalized_at` the visit is immutable; no reopen in v1 (`trg_visit_bu`).

### 3.2 Scope cell model (decision D2 — durable Visit scope)

A **context** is either:
- the **institution context** — `subject_id IS NULL`, context kind `INSTITUTION` (every Visit is on exactly one institution, so this context is always in scope), or
- a **subject context** — `subject_id` = an `inspected_subject` row of the Visit's institution, context kind = its `subject_type`.

A **scope cell** is the pair (definition, context): the single durable decision/answer slot for one checklist definition in one context of the Visit. Because `checklist_response` has `UNIQUE (visit_id, item_definition_id, COALESCE(subject_id,0))`, **one context × one definition version = at most one row** — the row *is* the cell.

The intended Visit scope is **materialized as `checklist_response` rows while the Visit is PREPARATION**, over the **captured instrument universe** (§3.5):

- when a context enters scope, the app selects the definition versions of the captured universe (§6) and materializes **one row per (definition × context)** in a single transaction;
- each row immediately receives its applicability outcome: `NOT_APPLICABLE` → `overlay_state='NA'`; `APPLICABLE`/`HUMAN_CONFIRMATION` → pending `overlay_state='NOT_INSPECTED'` with reason NULL;
- pending rows are later **dispositioned in place** (UPDATE while PREPARATION) by an actual answer or a deliberate `NOT_INSPECTED` + reason.

**Durability statement:** durable Visit scope ≡ the set of materialized cells (rows). Scope entry is atomic per operation (`createVisit`/`addSubjectToScope`), so a crash never leaves a partial subject in scope and never forgets a durably made scope entry; restart reconstructs state purely from rows (RECOVERY §6). Answering is allowed **only on an existing materialized cell** (B4) — no answer operation expands scope.

### 3.3 Cell state machine (only while Visit is PREPARATION)

| State (physical) | Meaning | Transitions |
|---|---|---|
| `overlay_state='NOT_INSPECTED'`, reason NULL | **pending**: in scope, not dispositioned. For HUMAN cells this always means **unresolved HUMAN decision** (B1) | answer; deliberate NOT_INSPECTED+reason; (HUMAN cells only, via explicit decision) NA |
| `answered_value_id` set | inspected answer; a HUMAN cell answered here is *explicitly resolved APPLICABLE and answered* (the explicit decision is part of the same operation) | another answer (correction) |
| `overlay_state='NOT_INSPECTED'`, reason non-blank | deliberate «لا يُعاين»; on a HUMAN cell it is *explicitly resolved APPLICABLE, not inspected* | none until finalization (corrections while PREPARATION via correction op) |
| `overlay_state='NA'` | «غير معني» — not applicable for this context; on a HUMAN cell this is the explicit `NOT_APPLICABLE` decision | AUTO-NA: none. HUMAN-decided NA: correctable while PREPARATION |

There is **no durable standalone "resolved APPLICABLE but still pending" state** (B1): an APPLICABLE confirmation is never persisted by itself — it is supplied as the `humanDecision=APPLICABLE` parameter of the same operation that records the final disposition (`answerSingle`, `answerSchedule`, `markNotInspected`).

The schema **can** physically represent any overlay/answer UPDATE while the Visit is PREPARATION (there is no physical ban on `NA ↔ NOT_INSPECTED`-style writes); the **domain contract** restricts them. Adopted domain transitions (enforced by the service, never by a blind overlay-swap API):
- pending (reason-less `NOT_INSPECTED`, answer NULL) → initial answer, or deliberate NOT_INSPECTED+reason;
- **HUMAN-only**: unresolved pending → `NA` (standalone T5 `NOT_APPLICABLE` decision), see §4.4;
- **HUMAN decision reversals** (Visit PREPARATION only, via the T6 explicit-correction operation): HUMAN `NA` → answered value with `humanDecision=APPLICABLE`; HUMAN `NA` → deliberate NOT_INSPECTED+reason with `humanDecision=APPLICABLE`; HUMAN answered / reasoned NOT_INSPECTED → `NA` with explicit `decision=NOT_APPLICABLE` (if the old answer was NON_COMPLIANT with a Finding, normal source/VOID rules apply — §4.7/§4.9);
- an answer → another answer (correction); a cell holding a **deliberate NOT_INSPECTED reason** changes to an answer only through the T6 correction contract (never as an initial answer).

No answer op returns to the reason-less pending state.

### 3.4 recorded_at / recorded_by semantics (B12)

`recorded_at`/`recorded_by` are immutable per row (`trg_response_bu`) and record the **instant the cell entered durable visit storage** and the actor who materialized it (scope author). This is the audit of durable scope entry; it **does NOT prove answer-time or answer-author attribution** and nothing in this design claims otherwise. A draft→answer UPDATE intentionally keeps these fields. If answer-time attribution ever becomes a requirement it needs an explicit later schema decision — not part of this pass.

### 3.5 Captured instrument universe (B2/B3, exact-set equality)

- **Authority for expected codes:** the verified bootstrap manifest (GATE5A-DECISIONS §D5) defines the expected v1 P0 `item_code` set. Application logic never hard-codes CHK codes; the manifest is the authority.
- **At `createVisit` (T0), before inserting the Visit,** the service verifies that the **manifest expected P0 set equals the loaded DB `ACTIVE` + `priority='P0'` item-code set, in both directions**:
  - an expected code with **no** ACTIVE definition ⇒ `E_NO_ACTIVE_DEFINITION` / `E_BOOTSTRAP_DRIFT`;
  - an **unexpected** ACTIVE-P0 code not present in the verified manifest ⇒ `E_BOOTSTRAP_DRIFT`.
  P1 definitions do not enter this comparison. Either direction fails ⇒ Visit creation is blocked (a missing or extra canonical item must never disappear or slip in silently).
- For each expected code the service then selects its one `ACTIVE` definition (`uq_active_def_per_code` guarantees at most one) and materializes the institution-context cells (subject NULL) — **those rows freeze the (code → version) map and are the authoritative captured instrument universe of the Visit**.
- **At `addSubjectToScope` (T1):** the subject's cells are materialized **only** for the codes present in the captured institution-context universe, reusing exactly those pinned `item_definition_id` values (even if a definition was later SUPERSEDED/ARCHIVED). The service **never queries current ACTIVE definitions to discover new codes** for an existing Visit.
- A definition code released **after** Visit creation never retro-enters that Visit; it enters only Visits composed later. Restart reconstruction uses the same institution-context rows as the authoritative universe (RECOVERY §6).

---

## 4) Domain-service catalog (APP-only obligations → services)

Obligations from CONSTRAINT-MATRIX-v1.md §و (1..8) and APPLICABILITY-RULES-v1.md §10 map to exactly one operation below. Names are contract-level; behavior must not change.

| Obligation | Domain operation | Documented in |
|---|---|---|
| applicability_rule evaluation | `evaluateApplicability`; HUMAN explicit decision via op params | §5 |
| completeness of every applicable P0 item/context before finalization | `finalizeVisit` preflight (inside the finalization transaction) | §4.10, TRANSACTION T11 |
| active definition-version selection + captured universe | selection rule in `createVisit`/`addSubjectToScope` | §3.5/§6, T0/T1 |
| dynamic note requirement | validation inside `answerSingle`/`answerSchedule` (§7 semantic rule) | §7 |
| "existing Finding covers same issue" | `findFindingCoversIssue` (decision aid) + link via answer ops | §4.7 |
| atomic Finding OPEN → first-source link | `createFindingWithResponseSource` / `createFindingWithObservationSource` | §4.7, T2/T7 |
| atomic Finding/CorrectiveAction transition + FollowUp | `transitionFindingStatus` / `transitionCorrectiveActionStatus` | §4.8, T8/T10 |
| **Finding VOID / re-home+VOID lifecycle (Gate 4B + micro-correction)** | **dedicated `voidOpenFindingByLastSourceCorrection` (T6-VOID)** and **`rehomeLastSourceAndVoidFinding` (T6-REHOME)** — never generic status buttons | §4.9, T6-VOID / T6-REHOME |
| no orphan Finding from partial failure | transaction atomicity + affected-row guards + state-based retry | TRANSACTION §13, T6/T6-VOID |
| finalization contract | `finalizeVisit` | §4.10, T11 |
| crash-safe restart reconstruction | `currentVisitState` | §4.11, RECOVERY §6 |

### 4.1 `createVisit` (with institution context and captured universe)
One transaction (T0): **precondition — the mission exists and its status is `PREPARATION` or `ACTIVE`** (a COMPLETED/ARCHIVED Mission must not accept a new Visit through the domain service — APP validation `E_MISSION_CLOSED`, no schema change); create the Visit row (PREPARATION); verify the manifest-vs-ACTIVE-P0 exact-set equality (§3.5, both directions; missing-ACTIVE ⇒ `E_NO_ACTIVE_DEFINITION`/`E_BOOTSTRAP_DRIFT`, unexpected-ACTIVE-P0 ⇒ `E_BOOTSTRAP_DRIFT`); materialize the institution-context cell set — freezing the captured instrument universe. Errors: constraint violations, `E_MISSION_CLOSED`, bootstrap drift (never silently skipped).

### 4.2 `addSubjectToScope(subjectId | newSubjectData)`
One transaction (T1) over the **captured Visit universe × this subject context**:
- **existing `subjectId`** — inspect the actual cells for that subject inside the transaction: (A) actual == expected full grid ⇒ idempotent success, COMMIT/return with **no INSERT**; (B) actual count == 0 ⇒ insert the entire expected grid atomically; (C) partial/mismatched grid ⇒ `ROLLBACK` + `E_SCOPE_GAP` — never silently repaired.
- **new subject data** — the subject's creation remains identity-creating (idempotency **class B**), performed first in the same transaction, then the full-grid insert (branch B semantics for the new context).
Preconditions: Visit PREPARATION; subject institution == Visit institution. Errors: `E_VISIT_NOT_PREPARATION`, subject problems, `E_SCOPE_GAP` on partial grids. This op is a scope-entry op, so it does not raise the answer-side `E_CELL_NOT_MATERIALIZED`.

### 4.3 `evaluateApplicability(rule, context, visitType)`
The **generic** evaluator — formal contract in §5. Reads the exact selected definition's `applicability_rule` payload from SQLite. Never `switch(item_code)`.

### 4.4 HUMAN_CONFIRMATION decisions (B1 + reversal semantics)
- **`resolveHumanApplicability(visitId, itemDefinitionId, context, decision=NOT_APPLICABLE)`** — standalone operation for the **`NOT_APPLICABLE`** branch only. It may operate **only** on the unresolved pending HUMAN state and must require all of: pinned rule `decision_kind='HUMAN_CONFIRMATION'`; current `overlay_state='NOT_INSPECTED'`; `answered_value_id IS NULL`; `not_inspected_reason IS NULL`; `finding_id IS NULL`. It writes `overlay_state='NA'` (T5).
- **`APPLICABLE` is never a standalone durable decision.** It is supplied as `humanDecision=APPLICABLE` to the operation that records the final disposition: `answerSingle`, `answerSchedule`, or `markNotInspected`. Each of those: (1) verifies the pinned definition's rule has `decision_kind='HUMAN_CONFIRMATION'` and the context kind ∈ `subject_kinds`; (2) requires the explicit `humanDecision=APPLICABLE`; (3) records the answer or the deliberate NOT_INSPECTED+reason **in the same transaction**. If the process crashes after the user taps "APPLICABLE" but before that operation commits, no decision was durably made and the inspector must confirm again — acceptable and truthful.
- **Human decision reversals** (Visit PREPARATION only) go through the **T6 explicit-correction operation**, never through a blind overlay-state swap API (no raw "flip the overlay" command exists):
  - HUMAN `NA` → answered value, with explicit `humanDecision=APPLICABLE`;
  - HUMAN `NA` → deliberate NOT_INSPECTED + reason, with explicit `humanDecision=APPLICABLE`;
  - HUMAN answered / reasoned NOT_INSPECTED → `NA`, with explicit `decision=NOT_APPLICABLE`;
  - if the old answered value was NON_COMPLIANT with a Finding, the normal source/VOID rules apply (§4.7/§4.9).
- No new column/state is introduced.

### 4.5 `answerSingle` / `answerSchedule` (only existing true-pending cells, B4/B6-correction)
Record an inspected answer for a SINGLE_VALUE/SCHEDULE cell. **Precondition: the cell exists as a materialized `checklist_response` row in the true pending state** (`overlay_state='NOT_INSPECTED'`, `answered_value_id IS NULL`, `not_inspected_reason IS NULL`, `finding_id IS NULL`); anything else ⇒ `E_CELL_NOT_MATERIALIZED` / `E_ALREADY_DISPOSITIONED` (no INSERT fallback, no overwriting a deliberate reason — a reasoned NOT_INSPECTED changing to an answer is a T6 correction). Writing an answered value always sets `overlay_state=NULL` and `not_inspected_reason=NULL`. Parameters include `humanDecision` when the pinned rule is HUMAN_CONFIRMATION. Subsumes value-from-same-definition, note rule (§7), CHK-012 reconciliation rows + overall result (T3A/T3B), and finding accountability (NC ⇒ `finding_id` set in the same statement — schema-enforced). NC paths delegate to §4.6 for finding selection.

### 4.6 `markNotInspected(visitId, itemDefinitionId, context, reason, humanDecision?)`
Deliberate «لا يُعاين» with a meaningful (non-blank) reason, on an existing **true-pending** cell (B4/B6-correction); `humanDecision=APPLICABLE` required for HUMAN cells (B1). Replacing a prior answer or a prior reason while PREPARATION happens only through the correction contract (T6).

### 4.7 Finding source contracts
- `findFindingCoversIssue(nonCompliantContext, search)` — APP judgment "existing Finding covers same issue": candidates restricted to findings of the **same institution** (schema), status OPEN (or IN_TREATMENT at the inspector's explicit choice), sharing the subject context when present; the inspector confirms coverage (never auto-linked). VOIDED findings are excluded from candidates and never regain a source (schema).
- `createFindingWithResponseSource(...)` — atomic Finding(OPEN) + first-source link in origin Visit (T2(b)/T3A; idempotency safe by construction — narrow audit in TRANSACTION §12).
- `createFindingWithObservationSource(observationId, ...)` — **ensure-accounted** operation (T7): pre-reads the AdHocObservation; if `observation.finding_id` is already set it returns the existing linked Finding **without** inserting another one; only a `finding_id IS NULL` observation receives a new Finding OPEN (origin = the observation's Visit) via a guarded link requiring `changes == 1`. It never blindly overwrites `observation.finding_id`, so a retry after "COMMIT succeeded but ACK lost" cannot create a second Finding or orphan the first one.
- Retraction, ordinary re-home, and the two dedicated correction operations live in the correction contract (T6): **T6-VOID** (`voidOpenFindingByLastSourceCorrection` — the last source is corrected/retracted so the source ceases to be a source) and **T6-REHOME** (`rehomeLastSourceAndVoidFinding` — the source stays valid NON_COMPLIANT/observation but its Finding association was wrong and moves from F_old to an existing or newly-created F_target, then F_old is VOIDED). No source-less OPEN finding rests (G4), except `VOIDED` which is expected source-less (Gate 4B).

### 4.8 Status transition operations (H, Gate-4B aligned)
`transitionFindingStatus(findingId, to, event, actor, contextVisit?)` and `transitionCorrectiveActionStatus(actionId, to, event, actor, ...)`. Each is one transaction: validate the allowed transition, insert the required append-only `follow_up` row, update the target status, require **affected rows == 1**, commit (T8/T10). Allowed **Finding** transitions (adopted, Gate-4B): `OPEN → IN_TREATMENT`, `OPEN → RESOLVED` (legal directly), `IN_TREATMENT → RESOLVED`; `OPEN → VOIDED` is reachable **only** through the dedicated correction operations of §4.9 (T6-VOID / T6-REHOME), never through a generic status update. FollowUp insert failure ⇒ status update rolls back and vice versa. **No raw "update status" API exists.**
- CorrectiveActions are **optional (0..*)**: resolving a Finding never *requires* a corrective action; if actions exist, the schema still blocks Finding RESOLVED while any is OPEN/IN_TREATMENT.

### 4.9 Dedicated Finding correction operations (B10, Gate-4B + micro-correction)
Two dedicated operations exist — never generic status buttons:
- **`voidOpenFindingByLastSourceCorrection(...)` (T6-VOID)** — full contract in TRANSACTION-CONTRACTS T6-VOID. Preconditions: finding OPEN; origin Visit PREPARATION with `finalized_at IS NULL`; the corrected/retracted source is the finding's **last** recorded source; the finding has **zero** corrective actions; the correction is otherwise valid; actor + meaningful void reason supplied. One transaction: re-validate preconditions → correct/retract the source and remove its `finding_id` (changes==1) → verify source count is zero → INSERT FollowUp (`status_target='FINDING'`, `status_after='VOIDED'`, same `event_datetime`) → UPDATE finding to `VOIDED` with `status_changed_at = event_datetime` (changes==1) → COMMIT. Any failure ⇒ ROLLBACK including the source correction. If the finding has another source → ordinary correction/re-home applies (no VOID). If IN_TREATMENT/RESOLVED → last-source retraction remains refused in v1. If any corrective action exists → `E_VOID_HAS_ACTIONS`.
- **`rehomeLastSourceAndVoidFinding(...)` (T6-REHOME)** — used when the **source remains valid** (a NON_COMPLIANT answer or a valid observation) but its Finding association was wrong and must move from **F_old** to a target. Preconditions: F_old OPEN; F_old origin Visit PREPARATION and not finalized; this source is F_old's **last** recorded source; F_old has zero CorrectiveActions; the target (existing form) is OPEN or IN_TREATMENT, same institution, inspector-confirmed covers-same-issue, never VOIDED/RESOLVED; actor + meaningful note. Two forms: **(A) existing target** F_target — guarded source re-assignment (`finding_id` F_old → F_target, changes==1), verify F_old has zero sources, FollowUp VOIDED for F_old, F_old → VOIDED; **(B) new target** — INSERT a new OPEN Finding whose `origin_visit_id` equals the source's Visit (first-source-in-origin integrity), then the same guarded re-assignment/verify/FollowUp/void sequence; any failure rolls back everything including the new target. State-based retry: re-read `source.finding_id` and F_old.status and converge (no second target Finding; the durable `source.finding_id` identifies the created target after restart).

VOIDED findings are retained as history, have zero sources by definition, are excluded from active candidates, do **not** trigger `E_ORPHAN_FINDING` at finalization, cannot receive a new source or action, and are terminal.

### 4.10 `finalizeVisit(visitId)` — single-transaction preflight + finalization (I/B6)
One `BEGIN IMMEDIATE` transaction: re-read the Visit; run **all** preflight SELECT checks (§8) inside the same transaction; if blockers ⇒ ROLLBACK and return the structured blocker list; otherwise run the guarded `UPDATE visit` requiring **affected rows == 1**; COMMIT. No state may change between the validated snapshot and finalization; no silent auto-fix. An idempotent retry sees `finalized_at NOT NULL` and returns the existing final state without reopening (T11).

### 4.11 `currentVisitState(visitId)` — restart reconstruction
Pure read at app open: rebuilds the scope grid from durable rows (captured universe = institution-context cells; contexts = institution context + distinct subjects durably present), pending/HUMAN lists, findings/actions and VOIDED history from rows (RECOVERY §6). Runs the grid self-check (RECOVERY §6.1). Never trusts process memory.

---

## 5) Applicability evaluator — formal contract (C)

### 5.1 Inputs
| Input | Source | Notes |
|---|---|---|
| `rule` | `checklist_item_definition.applicability_rule` for the **exact selected `item_definition_id`** (frozen/pinned version) | canonical JSON object per APPLICABILITY-RULES-v1.md §4.1; schema validates structure |
| `context.kind` | `INSTITUTION` (subject NULL) or `inspected_subject.subject_type` | closed set incl. OTHER |
| `visitType` | `visit.visit_type` (`SURPRISE`/`PLANNED`) | immutable after creation |

### 5.2 Output
Exactly one of `NOT_APPLICABLE` (cell → `NA`), `APPLICABLE` (must be answered or deliberately NOT_INSPECTED), `HUMAN_CONFIRMATION` (with the payload's `missing_context`; explicit inspector decision required — §4.4). Never inferred.

### 5.3 Algorithm (pure, deterministic, data-driven)
```
1. structural: parse rule; malformed/missing keys → raise E_CONFIG (never silently decide).
2. if rule.visit_type present AND visitType NOT IN rule.visit_type.allowed → NOT_APPLICABLE.
3. if context.kind NOT IN rule.subject_kinds → NOT_APPLICABLE.
4. if rule.decision_kind == 'AUTO' → APPLICABLE.
5. else (HUMAN_CONFIRMATION) → HUMAN_CONFIRMATION(missing_context = rule.missing_context).
```

### 5.4 Errors
| Code | Condition |
|---|---|
| `E_CONFIG` | unparseable/unknown payload or missing key (data corruption; block) |
| `E_CONTEXT` | context references a subject of another institution or an unknown kind |
| `E_HUMAN_NEEDS_DECISION` | an answer/mark op on a HUMAN cell without `humanDecision` |
| `E_CELL_NOT_MATERIALIZED` | answer op on a cell with no existing `checklist_response` row (B4) |
| `E_ALREADY_DISPOSITIONED` | initial answer op on a cell that is not in the true pending state (already answered or already reasoned NOT_INSPECTED — use T6 correction) |

### 5.5 HUMAN_CONFIRMATION lifecycle (B1 + reversals)
1. Compose → cell in the **unresolved pending HUMAN state** (NOT_INSPECTED, answer NULL, reason NULL, finding NULL) = **unresolved HUMAN decision**.
2. Disposition is one of:
   - `resolveHumanApplicability(NOT_APPLICABLE)` **on that unresolved state only** → row `NA` (explicit NOT_APPLICABLE; §4.4 preconditions);
   - `answerSingle/answerSchedule(..., humanDecision=APPLICABLE)` → answered (explicit APPLICABLE + answer in one tx);
   - `markNotInspected(..., humanDecision=APPLICABLE, reason)` → deliberate NOT_INSPECTED (explicit APPLICABLE, not inspected).
3. **Reversals while PREPARATION** use the T6 explicit-correction operation (§4.4); there is no blind overlay-state swap API and no durable standalone "APPLICABLE-pending".
4. After restart: reason-less pending HUMAN = unresolved; answered HUMAN = explicit APPLICABLE resolved and answered; reasoned NOT_INSPECTED HUMAN = explicit APPLICABLE resolved, not inspected; `NA` = explicit NOT_APPLICABLE (or a recorded T6 reversal). Finalization preflight refuses any reason-less pending cell, which includes unresolved HUMAN cells (§8).

---

## 6) Definition-version selection & freezing (E)

**Selection instant:** a definition version is selected for (visit_id, item_code, context) at the instant the context's cell is materialized — the single INSERT of the `checklist_response` row — atomically inside `createVisit`/`addSubjectToScope`. The row is the selection and survives restart by construction.

**Selection rule:**
1. `createVisit`: verify the manifest-vs-ACTIVE-P0 **exact-set equality** (§3.5, both directions), then for each expected P0 code select the unique `ACTIVE` definition (missing ⇒ `E_NO_ACTIVE_DEFINITION`/`E_BOOTSTRAP_DRIFT`; unexpected ACTIVE-P0 ⇒ `E_BOOTSTRAP_DRIFT`); the institution-context rows freeze the (code → version) universe.
2. Every later `addSubjectToScope` reuses exactly the pinned `item_definition_id` values from the captured universe (even if a definition later became SUPERSEDED/ARCHIVED); it never queries current ACTIVE definitions for new codes (B2).

**Guarantees:** once a cell exists, a later ACTIVE version can never add a second row for the same (visit, item_code, context) (unique index + version-mix guards) — I21 preserved; historical interpretation uses the frozen definition (rule 11); selection survives restart (rows); new codes enter only Visits composed after they appear in the manifest as ACTIVE.

---

## 7) note_rule — v1 domain validation rule (F)

**Cross-check result: all 24 adopted items (CHK-001..CHK-024) reduce to the single generic rule:**

> When a response's `answered_value.semantic_class = 'NON_COMPLIANT'`, a **meaningful note** (non-blank trimmed text) is required at the moment the answer is recorded.

Evidence per item — the FIELD-CHECKLIST «ملاحظة» clause is *mandatory exactly at the non-compliant value* in every row:

| Item(s) | Non-compliant value(s) in FIELD-CHECKLIST | «ملاحظة» clause | Reduces to semantic rule |
|---|---|---|---|
| CHK-001 | غير مُفعَّلة | إلزامية عند «غير مُفعَّلة» | YES |
| CHK-002 | لا تُستغل | إلزامية عند «لا تُستغل» | YES |
| CHK-003 | غير ملتزم | إلزامية عند «غير ملتزم» | YES |
| CHK-004 | غير متوفرة | إلزامية عند «غير متوفرة» | YES |
| CHK-005 | يوجد خلل | إلزامية عند «يوجد خلل» | YES |
| CHK-006 / CHK-007 | غير منتظم | إلزامية عند «غير منتظم» | YES |
| CHK-008 / CHK-009 | توجد / يوجد (تسرب، اهتراء) | إلزامية عند «توجد» / «يوجد» | YES |
| CHK-010 / CHK-011 | غير متوفرة / توجد أعطال | إلزامية عند النقص / «توجد أعطال» | YES |
| CHK-012 | غير مطابقة (فوارق) — overall | إلزامية عند «غير مطابقة» (تسرد الفوارق) | YES (structured reconciliation rows are in addition; the overall NC note still required) |
| CHK-013..CHK-019 | غير جاهزة | إلزامية عند «غير جاهزة» | YES |
| CHK-020 | غير متوفرة | إلزامية عند «غير متوفرة» | YES |
| CHK-021..CHK-024 | غير ملائمة / غير متوفرة | إلزامية عند غير المطابقة | YES |

Companion rules (already schema/domain, not parsing): `NA` never requires the note; `NOT_INSPECTED` uses `not_inspected_reason` (schema demands it before any finalization keeping NOT_INSPECTED); CHK-012's reconciliation rows are in addition to its overall-NC note. Gate 5B implements note validation from `semantic_class`, never from `item_code`; `note_rule` remains reference metadata.

---

## 8) Finalization contract (I/B6) — blocking checks run inside the finalization transaction

| Code | Check |
|---|---|
| `E_VISIT_NOT_PREPARATION` | Visit `status='PREPARATION'`, `finalized_at IS NULL` |
| `E_SCOPE_GAP` | grid self-check inside the tx: expected cell set (captured universe × captured contexts, deterministic from the institution-context rows and rule payloads) equals the actual row set — intended durable scope recoverable and complete |
| `E_UNRESOLVED_PENDING` | every APPLICABLE P0 cell dispositioned: no reason-less `NOT_INSPECTED` remains (subsumes "every P0 applicable context has a response" and "every HUMAN_CONFIRMATION context has explicit resolution") |
| `E_UNINSPECTED_NEEDS_REASON` | every `NOT_INSPECTED` cell has a meaningful reason |
| `E_NC_UNACCOUNTED` | every `NON_COMPLIANT` answered cell linked to a Finding (re-check) |
| `E_NC_NEEDS_NOTE` | note rule satisfied on every NC cell (re-check) |
| `E_CHK012` | CHK-012 physical constraints satisfied (re-check) |
| `E_ORPHAN_FINDING` | no Finding with origin = this Visit that is **OPEN with zero recorded sources** — `VOIDED` findings are expected to be source-less and are **not** orphans (Gate 4B) |

If clean: guarded `UPDATE visit SET status = (COMPLETED if no NOT_INSPECTED rows remain else COMPLETED_WITH_UNINSPECTED), finalized_at = now WHERE visit_id=? AND status='PREPARATION' AND finalized_at IS NULL`, **require affected rows == 1**, COMMIT. No silent auto-fix at any point; no state can change between preflight and finalization (same transaction).

---

## 9) Explicitly deferred (not this gate)

Evidence physical storage/hash (later storage gate); report generation (later); export; UI; server/API/sync; runtime bootstrap loader implementation (Gate 5B, strategy in decisions doc §D5); production source code.
