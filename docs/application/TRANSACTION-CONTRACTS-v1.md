# Transaction Contracts — v1 (Gate 5A + owner correction pass)

> **Status:** DESIGN — Gate 5A with owner-authorized corrections (B1..B12) and Gate-4B `VOIDED` alignment. Base SHA `e4eca7dfdcbb8509c98806fb905a73d7a1b0a96f`. No commit.
> **Authority files:** `docs/schema/schema.sql` (triggers/CHECKs referenced by name), `docs/application/APPLICATION-CORE-v1.md` (service catalog), `docs/application/RECOVERY-AND-IDEMPOTENCY-v1.md` (crash/idempotency).
> Each contract is the exact set of SQL statements (order is dictated by the trigger set) executed inside one `BEGIN IMMEDIATE … COMMIT`. Values are parameters; the domain service never concatenates user text into SQL. **The driver seam exposes an affected-row count (`changes`) for every write; every statement expected to affect exactly one row is followed by a cardinality check (B5).**

---

## 1) Transaction principles

1. **One domain operation = one transaction.** No distributed/2PC, no cross-operation transactions.
2. Every write transaction opens `BEGIN IMMEDIATE`. Read-only service calls use a plain read (or a `BEGIN` only when a consistent multi-statement read is needed).
3. Trigger interplay is **relied on, then re-verified** in preflight where required (finalization). If a trigger aborts, the whole transaction rolls back; the service maps the SQLite error to a domain error code.
4. Statement order inside a transaction is chosen so intermediate states never violate a trigger even transiently:
   - create the Finding (OPEN) **before** linking its first source;
   - set a SCHEDULE response's overall value (clearing overlay) **before** inserting its reconciliation rows;
   - when detaching the last source of a Finding that is being **voided**, the zero-source OPEN state exists only inside the transaction (Gate-4B ordering, T6-VOID);
   - when detaching a source by ordinary correction/re-home, the Finding keeps ≥1 source at every statement boundary.
5. **Affected-row cardinality (B5):** every guarded write expected to change exactly one row MUST check the driver's `changes`. Expected `== 1` → continue. `!= 1` → `ROLLBACK`, then re-read durable state: an already-applied identical target → idempotent success where appropriate; otherwise a conflict/domain error. **Never COMMIT after an expected-single-row UPDATE returned 0.** This is critical when an earlier INSERT (Finding/FollowUp) preceded the guarded UPDATE: a zero-row UPDATE must roll the earlier INSERT back.
6. **Driver seam is async-capable and transaction-boundary-preserving:** the domain contracts call the seam through Promise-returning methods (`beginImmediate`, `execute`, `query`, `commit`, `rollback`, `affectedRows`/`changes` normalized across adapters) and never depend on synchronous `DatabaseSync` semantics; the adapter must keep the explicit `BEGIN IMMEDIATE … COMMIT/ROLLBACK` boundary and must not wrap each statement in its own independent transaction inside a domain transaction (APPLICATION-CORE §1, RECOVERY §1.5).
7. All `recorded_at`/`created_at`/`event_datetime`/`finalized_at` values are app-supplied ISO-8601 UTC text; one transaction reuses the same timestamp for related rows (`status_changed_at` == `follow_up.event_datetime`).

---

## 2) T0 — `createVisit` (Visit row + captured instrument universe + institution cells) (B2/B3)

**Preconditions:** mission exists **with `status IN ('PREPARATION','ACTIVE')`** (APP validation: a COMPLETED/ARCHIVED Mission must not accept a new Visit through the domain service — no schema change); institution exists; visit_type ∈ {SURPRISE, PLANNED}; actor known; the **verified bootstrap manifest** is available and consistent.

```
BEGIN IMMEDIATE;
-- 0) mission gate: re-read mission.status; NOT IN ('PREPARATION','ACTIVE')
--      => ROLLBACK + E_MISSION_CLOSED (APP validation; schema unchanged)
-- 1) manifest-vs-loaded exact-set equality (BOTH directions, P1 excluded):
--      SELECT DISTINCT d.item_code FROM checklist_item_definition d
--        WHERE d.status='ACTIVE' AND d.priority='P0';
--      expected (manifest) ⊇ loaded-ACTIVE-P0  and  expected ⊆ loaded-ACTIVE-P0
--      expected code missing ACTIVE def          => E_NO_ACTIVE_DEFINITION / E_BOOTSTRAP_DRIFT -> ROLLBACK
--      loaded ACTIVE-P0 code not in manifest     => E_BOOTSTRAP_DRIFT -> ROLLBACK
-- 2) create the Visit (PREPARATION)
INSERT INTO visit(mission_id, institution_id, visit_type, visit_date, status,
                  inspector, created_at, created_by)
VALUES (?,?,?,?,'PREPARATION',?,?,?);            -- trg_visit_bi allows PREPARATION only
-- 3) materialize the institution context (subject_id NULL) for every code of the
--      manifest universe, in item_code order (deterministic) — these rows ARE the
--      captured instrument universe of the Visit.
INSERT INTO checklist_response(visit_id, item_definition_id, subject_id, overlay_state, ...)
VALUES (?,?,NULL,'NA',...);                       -- outcome NOT_APPLICABLE
INSERT INTO checklist_response(visit_id, item_definition_id, subject_id, overlay_state, ...)
VALUES (?,?,NULL,'NOT_INSPECTED',...);            -- outcome APPLICABLE/HUMAN (reason NULL = pending)
COMMIT;
```
**Guards relied on:** `trg_response_bi` (PREPARATION; no version mixing since fresh; subject NULL OK; overlay XOR OK). **Rollback:** any failure leaves no Visit and no cells (all-or-nothing). Retry after an uncertain commit is an idempotency **class B** case (identity-creating) — serialize and surface the existing Visit instead of blind re-INSERT (TRANSACTION §12, RECOVERY §5).

---

## 3) T1 — `addSubjectToScope` (B2/B3/B4-idempotency)

**Preconditions:** Visit PREPARATION; subject institution == visit.institution_id.

**Contract (inside one BEGIN IMMEDIATE):**
1. Compute the **expected cell set = captured Visit universe × this subject context** (codes + pinned `item_definition_id`s from the institution-context cells; never a current-ACTIVE discovery).
2. Inspect the actual cells for this subject (`SELECT ... FROM checklist_response WHERE visit_id=? AND subject_id=?`):
   - **A — actual == expected (full grid):** idempotent success — `COMMIT`/return with **no INSERT** (this is what makes an existing-subject call genuinely Class A);
   - **B — actual count == 0:** insert the entire expected grid atomically (below);
   - **C — partial / mismatched grid:** `ROLLBACK` + `E_SCOPE_GAP` — do **not** silently repair it.
3. Branch B inserts (all rows reference the captured universe's pinned definitions):

```
BEGIN IMMEDIATE;
-- (when the subject is created on site / pre-defined for this visit — identity-
--   creating, class B: only the NEW-subject path performs this INSERT)
INSERT INTO inspected_subject(...) VALUES (...);
-- full expected grid for this subject
INSERT INTO checklist_response(visit_id, item_definition_id, subject_id, overlay_state, ...)
VALUES (?,?,?, 'NA'|'NOT_INSPECTED', ...);        -- one row per (captured definition, this subject)
COMMIT;
```
**Guards relied on:** `trg_response_bi` subject-institution check; `uq_response_ctx` uniqueness; version-mix guard. **Rollback:** subject + cells disappear together; branch C rolls back without repair. A later ACTIVE release never adds codes to this Visit; codes released after composition enter only new Visits.

---

## 4) T2 — `answerSingle` (existing TRUE-pending cells only — B4)

**Precondition (all initial-answer shapes): the cell exists in the true pending state** — materialized `checklist_response` row with `overlay_state='NOT_INSPECTED'`, `answered_value_id IS NULL`, `not_inspected_reason IS NULL`, `finding_id IS NULL`. A missing cell ⇒ `E_CELL_NOT_MATERIALIZED`; a cell already answered or already carrying a deliberate NOT_INSPECTED reason ⇒ `E_ALREADY_DISPOSITIONED` (changing it to an answer is a **T6 correction**, not an initial answer). **No answer operation INSERTs a scope cell.** If the pinned rule is HUMAN_CONFIRMATION the caller must supply `humanDecision=APPLICABLE` in the same call (B1) — otherwise `E_HUMAN_NEEDS_DECISION`.

Every initial-answer UPDATE below consumes a true-pending cell **and** explicitly writes `overlay_state=NULL` and `not_inspected_reason=NULL` alongside the answered value. Each is followed by: `if changes != 1: ROLLBACK; re-read; identical target → idempotent success; else conflict error` (B5). For brevity the check is written as `-- require changes == 1 (B5)`.

**(a) COMPLIANT answer**
```
BEGIN IMMEDIATE;
UPDATE checklist_response
   SET answered_value_id = ?, overlay_state = NULL, note = ?, not_inspected_reason = NULL, finding_id = NULL
 WHERE response_id = ? AND overlay_state = 'NOT_INSPECTED' AND answered_value_id IS NULL
   AND not_inspected_reason IS NULL AND finding_id IS NULL
   AND visit PREPARATION;                        -- optimistic guard: TRUE pending only
-- require changes == 1 (B5)
COMMIT;
```
**(b) NON_COMPLIANT answer linked to a NEW Finding** (G1 — atomic OPEN→first-source)
```
BEGIN IMMEDIATE;
INSERT INTO finding(origin_visit_id, description, defect_type, defect_type_other, location,
                    subject_id, urgency, impact, status, status_changed_at, created_at, created_by)
VALUES (?,?,?,?,?,?,?,?,'OPEN',NULL,?,?);        -- trg_finding_bi: must be OPEN
UPDATE checklist_response
   SET answered_value_id = ?, overlay_state = NULL, note = ?, not_inspected_reason = NULL, finding_id = ?
 WHERE response_id = ? AND overlay_state = 'NOT_INSPECTED' AND answered_value_id IS NULL
   AND not_inspected_reason IS NULL AND finding_id IS NULL
   AND visit PREPARATION;
-- require changes == 1 (B5); note (meaningful) is mandatory for NC
COMMIT;
```
Order note: Finding first, source second — the response UPDATE carries `finding_id`, satisfying the NC-must-link trigger at that statement; the AFTER first-source triggers see response.visit == Finding.origin_visit_id when it is the first source.

**(c) NON_COMPLIANT answer linked to an EXISTING Finding "covers same issue"** (B5/G2)
- Application step: `findFindingCoversIssue` returns candidate findings in the same institution (OPEN preferred; same subject context preferred); the inspector explicitly confirms. VOIDED findings are never candidates. The DB still enforces institution/origin/source integrity on the link.
- Statements identical to (b) minus the Finding INSERT, with the picked `finding_id` and the same true-pending guard + `not_inspected_reason = NULL` write; if the picked Finding has no other source, the response's Visit must equal its `origin_visit_id` (first-source rule).

**Idempotency:** a duplicate request re-reads the cell: already answered with the same value → return success with the existing finding_id; no second Finding (state-idempotent, class A).

---

## 5) T3 — `answerSchedule` (CHK-012): T3A (NEW Finding) / T3B (EXISTING Finding) / COMPLIANT / NOT_INSPECTED (B8)

The inspector composes reconciliation rows **in the form** and submits atomically; nothing is persisted until submit. All shapes act on an **existing materialized SCHEDULE cell in the true pending state** (B4/B6-correction: `overlay_state='NOT_INSPECTED'`, `answered_value_id IS NULL`, `not_inspected_reason IS NULL`, `finding_id IS NULL` — otherwise `E_ALREADY_DISPOSITIONED`); every guarded UPDATE requires changes == 1 (B5) and writes `not_inspected_reason = NULL`; HUMAN_CONFIRMATION is not applicable to CHK-012 (AUTO) so `humanDecision` is not required here.

**T3A — NON_COMPLIANT overall + NEW Finding** (fully atomic):
```
BEGIN IMMEDIATE;
-- 1) verify the existing true-pending SCHEDULE cell (E_CELL_NOT_MATERIALIZED /
--    E_ALREADY_DISPOSITIONED otherwise)
-- 2) INSERT Finding OPEN (origin = this Visit)
INSERT INTO finding(origin_visit_id, description, ..., urgency, impact, status, created_at, created_by)
VALUES (?, ..., 'OPEN', ?, ?);
-- 3) guarded response UPDATE: overall NC + meaningful note + new finding_id
UPDATE checklist_response
   SET answered_value_id = ?, overlay_state = NULL, note = ?, not_inspected_reason = NULL, finding_id = ?
 WHERE response_id = ? AND overlay_state = 'NOT_INSPECTED' AND answered_value_id IS NULL
   AND not_inspected_reason IS NULL AND finding_id IS NULL;
--    require changes == 1 (B5)
-- 4) insert ALL reconciliation rows (any discrepancy row ⇒ overall must be NC)
INSERT INTO equipment_reconciliation_row(response_id, category, declared_qty, observed_qty,
                                         difference, discrepancy_type, discrepancy_desc, sort_order)
VALUES (?,?,?,?,?,?,?,?);                         -- repeated per category
COMMIT;
```
Any row failure ⇒ ROLLBACK of the Finding + response update + rows. **No separate pre-created orphan Finding exists at any point.**

**T3B — NON_COMPLIANT overall + EXISTING Finding** (explicit inspector confirmation that it covers the same issue): guarded response UPDATE with the picked `finding_id` + meaningful note + `not_inspected_reason = NULL`, then rows, same transaction; the DB keeps source/institution rules.

**COMPLIANT schedule branch:** guarded response UPDATE to the COMPLIANT overall value (`finding_id NULL`, `not_inspected_reason NULL`, no note required) + all zero-difference reconciliation rows in the same transaction. `trg_response_chk012_bu`/`trg_recon_*` reject COMPLIANT with any discrepancy row and any overlay with rows.

**NOT_INSPECTED schedule branch:** deliberate NOT_INSPECTED + reason and **zero** rows (any overlay forbids rows) — «لا يُعاين» (تعذّر إجراء المطابقة). A reasoned cell that later becomes an answer is a T6 correction, not an initial T3 answer.

---

## 6) T4/T5 — `markNotInspected` and HUMAN `NOT_APPLICABLE` resolution (B1/B4)

```
-- T4 deliberate «لا يُعاين» on an existing TRUE-pending cell (B4). For HUMAN cells
--    the caller must supply humanDecision=APPLICABLE in the same call (B1):
UPDATE checklist_response
   SET overlay_state = 'NOT_INSPECTED', not_inspected_reason = ?, answered_value_id = NULL
 WHERE response_id = ? AND visit PREPARATION AND overlay_state = 'NOT_INSPECTED'
   AND answered_value_id IS NULL AND not_inspected_reason IS NULL AND finding_id IS NULL;
-- require changes == 1 (B5); reason meaningful (trim length > 0)
-- (changing a prior answer OR a prior reason is a T6 correction, not T4)

-- T5 HUMAN cell resolved NOT_APPLICABLE. Operates ONLY on the unresolved pending
--    HUMAN state (all five predicates) — never on an answered/reasoned cell:
UPDATE checklist_response
   SET overlay_state = 'NA', answered_value_id = NULL
 WHERE response_id = ? AND visit PREPARATION
   AND overlay_state = 'NOT_INSPECTED' AND answered_value_id IS NULL
   AND not_inspected_reason IS NULL AND finding_id IS NULL
   AND pinned rule decision_kind = 'HUMAN_CONFIRMATION';   -- service pre-checks predicate
-- require changes == 1 (B5)
```
There is **no** standalone durable "APPLICABLE-but-pending" state; APPLICABLE is co-recorded with the answer or NOT_INSPECTED+reason in T2/T3/T4. Reversing a HUMAN decision (e.g. `NA` → answered with `humanDecision=APPLICABLE`, or answered → `NA` with `NOT_APPLICABLE`) is an explicit **T6 correction**, never a blind overlay-state swap.

---

## 7) T6 — Corrections, T6-VOID and T6-REHOME (dedicated correction operations) (B10/Gate-4B + micro-correction)

Principles: responses are correctable only while PREPARATION; the **domain guarantee** is that no committed `OPEN` finding rests with zero sources — unless it is `VOIDED` (Gate 4B). This guarantee is enforced by the domain service through the single-transaction contracts here; the **DB's guarantees are current-state checks only** (origin visit open, zero current sources, zero actions at the moment of an OPEN→VOIDED update; source required to leave OPEN toward IN_TREATMENT/RESOLVED) and do not by themselves prove the causal "this was the last-source correction" history (PHYSICAL-SCHEMA-v1.md §8, CONSTRAINT-MATRIX-v1.md I22).

**Ordinary correction / re-home and last-source discipline:**
- **If F_old will retain ≥ 1 other source** after the change: ordinary re-home is sufficient and F_old remains active. The link is dropped/relinked with `changes == 1` while F_old keeps ≥1 source at every statement boundary.
- **If this source is F_old's LAST source: ordinary re-home is NOT allowed.** Use the dedicated **T6-REHOME — re-home last source + VOID old Finding** below (`E_LAST_SOURCE` is replaced by the dedicated branch).
- **If F_old is IN_TREATMENT or RESOLVED:** last-source re-home remains refused in v1 (no invented cancellation semantics).
- **If F_old has any CorrectiveAction:** last-source VOID/re-home remains refused in v1 (`E_VOID_HAS_ACTIONS`).
- NC → COMPLIANT/NA/NOT_INSPECTED(reason) while the finding **has another source**: drop the link in the same UPDATE that clears the answer (schema: compliant/overlay never linked to finding); require changes == 1.
- **HUMAN decision reversals** (Visit PREPARATION only; explicit, never a blind overlay-state swap):
  - HUMAN `NA` → answered value with `humanDecision=APPLICABLE` (answered value written, overlay/reason cleared);
  - HUMAN `NA` → deliberate NOT_INSPECTED + reason with `humanDecision=APPLICABLE`;
  - HUMAN answered / reasoned NOT_INSPECTED → `NA` with explicit `decision=NOT_APPLICABLE`;
  - if the old answered value is NON_COMPLIANT and linked to a Finding, the normal source/VOID rules apply below.
- **NC retraction that removes the LAST source of an OPEN finding with zero corrective actions while origin Visit is PREPARATION** (the answer/observation itself is being corrected to non-source or retracted) → use **T6-VOID** below — **not** an ordinary retraction.
- Subject/context immutability: `subject_id`, `item_definition_id`, `visit_id`, `recorded_*` are immutable on a response — corrections never touch them.

**T6-VOID — `voidOpenFindingByLastSourceCorrection(...)` (B10; never a generic status button):**

Preconditions (re-validated inside the tx): finding status = OPEN; origin Visit PREPARATION and `finalized_at IS NULL`; the corrected/retracted source is the finding's **last** recorded source; finding has **zero** corrective actions (else `E_VOID_HAS_ACTIONS`); the requested correction is itself valid (branch below); actor + meaningful void note supplied.

Source correction is **branch-specific** (exact SQL shapes, within the SAME VOID transaction; every source UPDATE requires changes == 1, B5):

**A. NC → COMPLIANT (response source)**
```
UPDATE checklist_response
   SET answered_value_id = <compliant value>, overlay_state = NULL, note = ?,
       not_inspected_reason = NULL, finding_id = NULL
 WHERE response_id = ? AND finding_id = ? AND visit PREPARATION;   -- changes == 1
```
**B. NC → NA (response source)** — only through a valid HUMAN applicability correction
```
UPDATE checklist_response
   SET answered_value_id = NULL, overlay_state = 'NA', note = ?,
       not_inspected_reason = NULL, finding_id = NULL
 WHERE response_id = ? AND finding_id = ? AND visit PREPARATION;   -- changes == 1
```
**C. NC → deliberate NOT_INSPECTED (response source)**
```
UPDATE checklist_response
   SET answered_value_id = NULL, overlay_state = 'NOT_INSPECTED', note = NULL,
       not_inspected_reason = <meaningful reason>, finding_id = NULL
 WHERE response_id = ? AND finding_id = ? AND visit PREPARATION;   -- changes == 1
```
**D. AdHocObservation source retraction**
```
UPDATE adhoc_observation
   SET finding_id = NULL, text = <corrected text if genuinely part of the requested correction>,
       subject_id = <corrected subject only if genuinely part of the correction>
 WHERE observation_id = ? AND finding_id = ?;                     -- changes == 1
```
Then, still in the same transaction:
```
-- verify zero remaining sources:
--   SELECT count(*) FROM checklist_response WHERE finding_id = ?   (must be 0)
--   SELECT count(*) FROM adhoc_observation    WHERE finding_id = ?   (must be 0)
-- INSERT FollowUp FINDING/VOIDED (same event_datetime as the status change)
INSERT INTO follow_up(finding_id, status_target, status_after, event_datetime, actor_role,
                      actor_role_other, actor_name, note, recorded_by)
VALUES (?, 'FINDING', 'VOIDED', ?, ?, ?, ?, ?, ?);
-- UPDATE finding OPEN -> VOIDED
UPDATE finding
   SET status = 'VOIDED', status_changed_at = ?
 WHERE finding_id = ? AND status = 'OPEN';
-- require changes == 1 (B5) — DB re-validates current-state conditions (origin open,
-- zero sources, zero actions) at this instant
COMMIT;
```
Any failure ⇒ ROLLBACK **including the source correction**. The zero-source OPEN state exists only inside this transaction; the APP contract never commits it. If the finding has another source → ordinary correction/re-home applies (do NOT void). If IN_TREATMENT/RESOLVED → last-source retraction remains refused in v1 (no invented action-cancellation semantics). VOIDED findings: retained in history, zero current sources by definition, excluded from active candidates, do not trigger `E_ORPHAN_FINDING` at finalization, cannot receive a new source or CorrectiveAction, terminal.

**T6-REHOME — `rehomeLastSourceAndVoidFinding(source, targetOption, ...)` — dedicated last-source re-home + VOID old Finding (this micro-correction; never a generic status operation):**

Purpose: the source **remains valid** (a NON_COMPLIANT answer or a valid observation), but its Finding association was wrong and must move from **F_old** to **F_target**. This removes the previous `E_LAST_SOURCE` dead-end for the "wrong finding" correction while keeping F_old from resting source-less.

Preconditions (re-validated inside the tx): F_old.status = OPEN; F_old origin Visit PREPARATION and not finalized; this source is F_old's **last** recorded source; F_old has **zero** CorrectiveActions (else `E_VOID_HAS_ACTIONS`); the correction itself is valid; actor + meaningful void/correction note supplied. **Target finding (existing form)**: status OPEN or IN_TREATMENT; same institution; the inspector explicitly confirms it covers the same issue; the target must never be VOIDED or RESOLVED.

**A. EXISTING target Finding F_target**
```
BEGIN IMMEDIATE;
-- 1) revalidate F_old / source / actions / origin preconditions
-- 2) validate F_target (OPEN/IN_TREATMENT, same institution, covers-same-issue confirmed)
-- 3) guarded source re-assignment (response or observation; the source stays valid;
--    only finding_id changes; an explicitly requested legitimate text/subject
--    correction of an observation may ride along):
UPDATE checklist_response SET finding_id = ? WHERE response_id = ? AND finding_id = ?;  -- OR
UPDATE adhoc_observation    SET finding_id = ?, text = <if requested>, subject_id = <if requested>
 WHERE observation_id = ? AND finding_id = ?;
-- require changes == 1 (B5)
-- 4) verify F_old now has zero sources (both source tables)
-- 5) INSERT FollowUp for F_old (FINDING / VOIDED, meaningful re-home note, event_datetime = now)
-- 6) UPDATE F_old OPEN -> VOIDED with status_changed_at = event_datetime
--    require changes == 1 (B5)
COMMIT;
```
**B. NEW target Finding**
```
BEGIN IMMEDIATE;
-- 1) revalidate F_old / source / actions / origin preconditions
-- 2) INSERT new target Finding OPEN with origin_visit_id = the SOURCE's Visit
--    (keeps first-source-in-origin integrity), explicit urgency/impact etc. (never auto-filled)
-- 3) guarded source re-assignment to the new target (as in A.3), changes == 1
-- 4) verify F_old now has zero sources
-- 5) INSERT FollowUp VOIDED for F_old
-- 6) UPDATE F_old OPEN -> VOIDED, changes == 1
COMMIT;
```
Any failure ⇒ ROLLBACK **everything, including creation of the new target Finding**. No transient source-less committed F_old is ever created. Both source kinds are supported: ChecklistResponse (the answer remains NON_COMPLIANT; only `finding_id` changes) and AdHocObservation (the observation remains valid; only `finding_id` changes unless an explicitly requested text/subject correction is part of the same correction).

**State-based retry (no idempotency table):** after COMMIT but before ACK, a retry first reads `source.finding_id` and F_old.status:
- if the source points to the intended target **and** F_old is VOIDED → return idempotent success;
- do **not** create another target Finding on a blind retry;
- for the NEW-target form, the durable `source.finding_id` identifies the already-created target after restart (Class A convergence).

---

## 8) T7 — `createFindingWithObservationSource` — ensure-accounted (G3, idempotent)

T7 is **not** "INSERT a Finding, then assign it". It is an *ensure this Observation is accounted for by one Finding* operation on an **EXISTING** AdHocObservation (the observation row itself is created separately by OBS-1 `createAdHocObservation`, Gate 5G — §14): the observation is the durable key, so retry after "COMMIT succeeded but ACK lost" must **never** create a second Finding or reassign an existing link (that would leave the original Finding source-less OPEN).

```
BEGIN IMMEDIATE;
-- 1) pre-read the AdHocObservation:
--      missing observation            => ROLLBACK + E_OBSERVATION_NOT_FOUND
--      its Visit must be PREPARATION / not finalized when a NEW source
--      relationship would be created  => else ROLLBACK
-- 2) if observation.finding_id IS NOT NULL:
--      do NOT insert another Finding; NEVER overwrite/reassign finding_id.
--      The existing linked Finding is the durable/idempotent result of an
--      IDENTICAL historical retry only. For a request carrying a NEW-Finding
--      draft, "identical" means the durable Finding matches the requested
--      semantic creation identity:
--        * origin_visit_id == observation.visit_id
--        * subject_id == observation.subject_id (null-safe)
--        * normalized description
--        * defect_type
--        * defect_type_other
--        * normalized location
--        * urgency
--        * impact
--        * created_by == request actor
--      Deliberately NOT part of retry identity: created_at (a retry generates
--      a fresh clock) and the Finding's CURRENT status — a later legitimate
--      status transition does not invalidate an identical historical retry.
--      If the durable link exists but the requested semantic creation target
--      DIFFERS: conflicting retry => typed conflict, no write, no
--      reassignment, never silent success. T7 is not an existing-Finding
--      selection/re-home API — T6 remains the only correction/re-home path.
--      (read-only return; no writes)  => COMMIT
-- 3) only when finding_id IS NULL, create the Finding OPEN:
INSERT INTO finding(origin_visit_id, description, defect_type, defect_type_other, location,
                    subject_id, urgency, impact, status, status_changed_at, created_at, created_by)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', NULL, ?, ?);   -- origin_visit_id = observation.visit_id
-- 4) guarded source link (never blindly overwrites an existing link):
UPDATE adhoc_observation
   SET finding_id = ?
 WHERE observation_id = ? AND finding_id IS NULL;
-- require changes == 1 (B5)
-- 5) if changes != 1: ROLLBACK (the newly inserted Finding disappears); re-read durable
--      state; if the observation is now already linked AND the durable link matches the
--      identical requested semantic creation target (the step-2 identity), return that
--      existing link as the converged state; otherwise return a typed conflict.
COMMIT;
```
Guards: `trg_obs_finding_bi` first-source-in-origin; institution consistency. An informational observation keeps `finding_id NULL` (allowed — no Finding is created for it). Idempotency: the pre-read + `finding_id IS NULL` guard make this genuinely **Class A**: an IDENTICAL retry (step-2 semantic creation identity) converges on the already-linked Finding and never creates a second Finding or orphans the first one; a conflicting retry is a typed conflict with no write and no reassignment.

---

## 9) T8 — `transitionFindingStatus` (H, Gate-4B aligned)

**Adopted transition graph** (no invented restrictions; B9):
- `OPEN → IN_TREATMENT` (requires ≥ 1 source — schema)
- `OPEN → RESOLVED` (**legal directly** when the other adopted integrity conditions hold: ≥ 1 source and no OPEN/IN_TREATMENT corrective action; requires its FollowUp event)
- `IN_TREATMENT → RESOLVED` (requires no OPEN/IN_TREATMENT corrective actions; FollowUp recorded)
- `OPEN → VOIDED` — reachable **only** via the dedicated `voidOpenFindingByLastSourceCorrection` operation (T6-VOID), never via this generic transition op.
- Backwards moves, `IN_TREATMENT → VOIDED`, `RESOLVED → VOIDED`, and anything out of terminal `RESOLVED`/`VOIDED` are rejected (schema + domain).

```
BEGIN IMMEDIATE;
INSERT INTO follow_up(finding_id, corrective_action_id, visit_id, status_target, status_after,
                      event_datetime, actor_role, actor_role_other, actor_name, note, recorded_by)
VALUES (?, NULL, ?, 'FINDING', ?, ?, ?, ?, ?, ?, ?);       -- note NOT NULL (meaningful)
UPDATE finding
   SET status = ?, status_changed_at = ?                    -- == event_datetime
 WHERE finding_id = ? AND status = <old status>;            -- optimistic guard
-- require changes == 1 (B5); else ROLLBACK, re-read, idempotent-return or conflict
COMMIT;
```
FollowUp insert failure ⇒ status update rolls back; status update failure ⇒ FollowUp rolls back. `visit_id` optional context (same-institution follow-up visit or NULL).

**Retry identity (Gate-5H clarification of the Class-A "identical duplicates converge" rule):** "already at target" alone is NOT idempotent success. An already-at-target retry converges (`applied: false`, no second FollowUp) only when the **durable transition-event identity** matches the requested event exactly: the canonical FollowUp row (`finding_id`, `corrective_action_id IS NULL`, `status_target='FINDING'`, `status_after` = requested target, null-safe `visit_id` == requested contextVisitId, `event_datetime`, `actor_role`, null-safe `actor_role_other`, null-safe `actor_name`, normalized `note`, normalized `recorded_by`) **plus** `finding.status_changed_at == event_datetime`. Already at target with a **different** audit event, a mismatching `status_changed_at`, or **duplicate** matching FollowUp rows ⇒ `E_STATE_CONFLICT` (a silent "current status == requested target" shortcut would absorb a DIFFERENT FollowUp event, and duplicate rows are an integrity conflict — never silent convergence). A stale retry to a target the Finding has already legitimately ADVANCED beyond (e.g. `OPEN → IN_TREATMENT` committed, then `→ RESOLVED`, then a retry requests `IN_TREATMENT`) also conflicts: never backwards, never claimed target convergence.

---

## 10) T9/T10 — CorrectiveAction (optional 0..*, Gate-4B aligned)

**T9 create:** `INSERT INTO corrective_action(...) VALUES (... 'OPEN' ...)` — refused under a finding whose status is `RESOLVED` **or** `VOIDED` (`trg_ca_bi`). CorrectiveActions are **optional**: a Finding may be resolved without any corrective action (B9); if actions exist, Finding RESOLVED requires them all RESOLVED. Creating a corrective action is identity-creating (idempotency class B).

**T10 transition:** same shape as T8 but `status_target='CORRECTIVE_ACTION'`, `corrective_action_id` mandatory; for `RESOLVED` the UPDATE also sets `closed_at`, `verified_by` (and optional `verification_note`) in the same statement — CHECK/`trg_ca_bu` require verified_by non-empty at RESOLVED, closure fields immutable once set. `corrective_action.status` has **no VOIDED** (Gate 4B).

```
BEGIN IMMEDIATE;
INSERT INTO follow_up(finding_id, corrective_action_id, visit_id, status_target, status_after,
                      event_datetime, actor_role, actor_name, note, recorded_by)
VALUES (?, ?, ?, 'CORRECTIVE_ACTION', ?, ?, ?, ?, ?, ?);
UPDATE corrective_action
   SET status = ?, closed_at = ?, verified_by = ?, verification_note = ?
 WHERE action_id = ? AND status = <old status>;
-- require changes == 1 (B5)
COMMIT;
```

---

## 11) T11 — `finalizeVisit` (single-transaction preflight, B6)

One `BEGIN IMMEDIATE` transaction — **no read-only preflight outside the tx** (no TOCTOU window; "one domain operation = one tx"):

```
BEGIN IMMEDIATE;
-- 1) re-read the Visit (status/finalized_at)
-- 2) run ALL finalization preflight SELECT checks (APPLICATION-CORE §8) inside this tx:
--    scope grid self-check (captured universe × contexts), no reason-less NOT_INSPECTED,
--    reasons on every NOT_INSPECTED, NC accountability + note, CHK-012, no source-less
--    OPEN finding (VOIDED source-less is expected and NOT a blocker)
-- 3) if blockers: ROLLBACK; return structured blocker list
-- 4) otherwise the guarded final UPDATE:
UPDATE visit
   SET status = CASE WHEN EXISTS (SELECT 1 FROM checklist_response cr
                                   WHERE cr.visit_id = ? AND cr.overlay_state = 'NOT_INSPECTED')
                     THEN 'COMPLETED_WITH_UNINSPECTED' ELSE 'COMPLETED' END,
       finalized_at = ?
 WHERE visit_id = ? AND status = 'PREPARATION' AND finalized_at IS NULL;
-- require changes == 1 (B5)
COMMIT;
```
No state may change between the validated snapshot and finalization (same tx). No silent auto-fix. **Idempotent retry:** if `finalized_at IS NOT NULL` on re-read, return the existing final state without reopening (class A).

---

## 12) Idempotency & retry — two classes (B7)

**A. Naturally state-idempotent operations** (retry after an uncertain commit converges safely):
- answer/correct an existing materialized cell (T2/T3/T4/T5/T6) — identity is the (visit, item, context) cell;
- Finding/Action transitions (T8/T10) with the affected-row guard + state re-read — for T8, "identical" retry convergence requires the **exact durable transition-event identity** (the canonical FollowUp row of §9 plus `finding.status_changed_at == event_datetime`), never mere "already at target"; a different audit event ⇒ typed conflict (§9, Gate-5H clarification);
- finalization (T11);
- Finding creation attached to an existing response cell — **T2/T3A are already safe**: the guarded source UPDATE targets the cell's durable identity and its zero-row failure rolls back the just-inserted Finding before re-reading the existing answer/link (narrow audit: T2/T3A/T7 all satisfy this);
- **T7 ensure-accounted** (this micro-correction): pre-reads the observation; never inserts when `observation.finding_id` is already set — an already-linked observation converges only as an IDENTICAL historical retry whose durable linked Finding matches the requested NEW-Finding semantic creation identity (origin/subject null-safe/normalized description/defect_type/defect_type_other/location/urgency/impact/created_by == request actor; `created_at` and the current status deliberately excluded — see §8), and a requested target that differs is a typed conflict with no write and no reassignment; the guarded link requires `finding_id IS NULL`, and a zero-row guard rolls back the new Finding and returns the existing link only on the identical durable target (no blind reassignment, no orphaned first Finding);
- `addSubjectToScope` for an **existing** `subjectId` — genuinely Class A via the exact grid comparison inside the transaction (T1: full grid → no INSERT; empty → insert; partial → `E_SCOPE_GAP` + ROLLBACK, never silently repaired);
- the dedicated VOID operation (T6-VOID) and the dedicated last-source re-home + VOID operation (**T6-REHOME**): retry first reads `source.finding_id` and F_old.status — if the source points to the intended target and F_old is VOIDED, return idempotent success; a NEW-target retry converges on the already-created target identified by the durable `source.finding_id` (no second target Finding on blind retry).

**B. Identity-creating commands with no durable idempotency key:**
- `createVisit`;
- creating a **new** `inspected_subject` inside `addSubjectToScope(newSubjectData)`;
- `createAdHocObservation` (OBS-1, Gate 5G — §14);
- `createCorrectiveAction`;
- (any similar create-new-identity operation).

For class B: do **not** claim exactly-once/state-idempotency after "COMMIT succeeded but ACK lost". Instead: serialize write commands; prevent same-process UI double-tap / in-flight duplicate execution; after an uncertain crash/restart, re-read durable state and **surface the existing records for inspector selection** rather than blindly re-INSERTing; no sidecar journal and no new idempotency table in this gate.

---

## 13) Failure/rollback behavior table

| Failure point | Effect | Guarantee |
|---|---|---|
| Any statement aborts (constraint/trigger) | whole tx ROLLBACK | no partial Finding/FollowUp/response/cell set; no orphan |
| Guarded UPDATE changes == 0 (B5) | ROLLBACK + re-read | identical target → idempotent success; else conflict error; never committed as no-op |
| Guarded UPDATE changes == 0 after an earlier INSERT in the same tx (B5) | ROLLBACK | the earlier Finding/FollowUp insert is rolled back too |
| COMMIT fails (disk/busy) | ROLLBACK, retry by state | class A converges; class B surfaces existing records |
| Crash after COMMIT, before ack | state re-read on retry | class A idempotent finish; class B serialize + surface |
| Crash before COMMIT | nothing persisted | clean re-run |
| FollowUp insert fails in T8/T10/T6-VOID | status update (and source correction) rolled back | no status change without its event |
| Status update fails in T8/T10/T6-VOID | FollowUp (and source correction) rolled back | no event without its status change |

---

## 14) OBS-1 — `createAdHocObservation` (Gate 5G — owner-approved application contract)

**Traceability:** PROJECT — PRJ-03 (observations/notes, P0); REQ-012 is supporting DIRECT evidence that field observations feed the technical sheet/reporting outputs. The exact OBS-1 API/transaction contract is an owner-approved Gate-5G PROJECT decision (GATE5G-DECISIONS-v1.md) — not claimed DIRECT/DERIVED from the official sources.

Creates **exactly one** durable AdHocObservation identity during an open field Visit — the Observation ONLY: no Finding is created or linked (`finding_id` always NULL on creation), no Subject, no Evidence, no correction/reporting/sync behavior. If the inspector later decides the Observation represents a Finding, the adopted T7 operation (§8) handles that separately; OBS-1 and T7 are never combined into one transaction/API.

**Preconditions:** the Visit exists; `visit.status = 'PREPARATION'` AND `visit.finalized_at IS NULL`; when `subjectId` is supplied, the Subject exists and belongs to the Visit's institution; `text` meaningful; `recordedAt` app-supplied; `recordedBy` meaningful.

```
BEGIN IMMEDIATE;
-- 1) authoritative Visit read INSIDE the write transaction (no TOCTOU window):
--      missing row                            => ROLLBACK + E_VISIT_NOT_FOUND
--      status <> 'PREPARATION'
--        OR finalized_at IS NOT NULL          => ROLLBACK + E_VISIT_NOT_PREPARATION
--        (no backdated creation into a finalized Visit)
-- 2) optional Subject read (same transaction):
--      missing subject                        => ROLLBACK + E_SUBJECT_NOT_FOUND
--      subject.institution_id <> visit.institution_id
--                                              => ROLLBACK + E_CONTEXT
--      (the Subject is never created/modified here; subjectId NULL = a
--       general Visit/institution-level observation — no "active subject
--       only" rule is invented)
-- 3) normalize text / recorded_at / recorded_by (project conventions):
--      trim to meaningfulness; blank/whitespace-only
--                                              => ROLLBACK + E_CONFIG
--      (recorded_at is app-supplied — never invented internally;
--       recorded_by normalized as adopted)
-- 4) the single identity-creating INSERT (nothing else is created):
INSERT INTO adhoc_observation(visit_id, subject_id, text, finding_id, recorded_at, recorded_by)
VALUES (?, ?, ?, NULL, ?, ?);                  -- finding_id = NULL ALWAYS on creation
-- require changes == 1 (B5) and a present lastInsertRowid
--      otherwise ROLLBACK + E_STATE_CONFLICT
-- 5) return the created durable Observation identity/state
COMMIT;
```

**Guards relied on:** `trg_obs_bi` re-enforces PREPARATION/not-finalized and subject-institution integrity at the DB floor (defense in depth; the domain reads above hold the write lock for the whole unit, so the INSERT cannot race a finalization).

**Idempotency — deliberately Class B (§12 / RECOVERY §5):** the project has adopted **no** durable request/idempotency key for observation creation: no UNIQUE constraint, no dedupe by text or timestamp, no hash-based key, no sidecar idempotency table, no client request token. Two intentional invocations with identical payloads create two distinct observations (duplicates are not a domain error — no observation-duplicate code exists). After "COMMIT succeeded but ACK lost" the caller must treat the outcome as ambiguous; the service never auto-resubmits the create command and never inspects text/time to decide an existing row "must be" the same attempt — recovery reconstructs the durable Visit observations and surfaces/reconciles them to the inspector (RECOVERY §5). A deliberate later invocation with the exact same payload is a new Class-B create and may produce a second observation.

**Deferred:** a general correction API for an informational/unlinked Observation is NOT part of OBS-1 (GATE5G-DECISIONS-v1.md); observation correction rides only on the specific Gate-5E T6 source-correction operations. No schema change is introduced by OBS-1.
