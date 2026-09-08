# Recovery & Idempotency — v1 (Gate 5A + owner correction pass)

> **Status:** DESIGN — Gate 5A with owner-authorized corrections (B5, B7, B11, B12) and Gate-4B `VOIDED` alignment. Base SHA `e4eca7dfdcbb8509c98806fb905a73d7a1b0a96f`. No commit.
> Companion: `docs/application/TRANSACTION-CONTRACTS-v1.md` (per-op SQL), `docs/application/APPLICATION-CORE-v1.md` (services), `docs/schema/schema.sql` (triggers).

---

## 1) Store & connection configuration

1. **Single authoritative store:** the SQLite database file created from `docs/schema/schema.sql`. No other persistence.
2. **`PRAGMA foreign_keys = ON` on every connection** — the schema's FK integrity (and cross-table triggers) assume it; SQLite does not persist it, so set it immediately after open, before any other statement.
3. **Write concurrency:** v1 is single-inspector/single-process. All writes go through one serialized write path (application-level mutex/queue). Multi-connection read-only views are allowed (each still sets the pragma).
4. **Recommended pragmas (Gate 5B validates on device profile):** `foreign_keys=ON` (mandatory); `journal_mode=WAL` (or `DELETE` if the driver lacks WAL); `synchronous=FULL` in v1; `busy_timeout=5000`; no STRICT tables, no mmap dependence.
5. **Driver seam — async-capable, normalized (B5):** the domain core is a **runtime-neutral TypeScript library** that never depends on `node:*` APIs or on synchronous `DatabaseSync` semantics; Node ≥ 22 is the development/test host only. The seam is designed async-capable from day one (conceptual Promise-returning methods: `beginImmediate()`, `execute(...)`, `query(...)`, `commit()`, `rollback()`; an **affected-row count** — `affectedRows`/`changes` — normalized across adapters). The Node adapter may internally wrap synchronous `node:sqlite`; the device adapter is a native SQLite adapter behind the same seam. The adapter must preserve the explicit application transaction boundary (`BEGIN IMMEDIATE … statements … COMMIT/ROLLBACK`) and must **not** silently wrap each statement in its own independent transaction inside a domain transaction. Every guarded write that must change exactly one row is followed by a cardinality check: `changes == 1` → continue; otherwise `ROLLBACK` + state re-read + idempotent-return or conflict error (TRANSACTION §1.5). Statements are fully parameterized; user text is never concatenated into SQL. No driver is implemented in this gate.

---

## 2) Transaction boundaries (what is one atomic unit)

| Operation | One transaction covers |
|---|---|
| `createVisit` (T0) | mission status gate (PREPARATION/ACTIVE) + manifest-vs-ACTIVE-P0 equality + Visit row + institution-context cell set |
| `addSubjectToScope` (T1) | existing-subject: expected-grid comparison (A full → no INSERT / B empty → insert / C partial → ROLLBACK `E_SCOPE_GAP`); new-subject: subject creation (identity-creating, class B) + full-grid insert |
| `answerSingle` (T2) | value + note + (NC) Finding creation/link — Finding + response link together; `humanDecision` when HUMAN |
| `answerSchedule` (T3A/T3B) | overall result + all reconciliation rows (+ NEW Finding in T3A) |
| `markNotInspected` / HUMAN NOT_APPLICABLE (T4/T5) | single response UPDATE (+ explicit decision semantics) |
| corrections (T6) | every response/finding change of the correction together (ordinary re-home + drop in one tx; HUMAN decision reversals) |
| **`voidOpenFindingByLastSourceCorrection` (T6-VOID)** | source correction/retraction + FollowUp(VOIDED) + status update — zero-source OPEN only inside the tx |
| **`rehomeLastSourceAndVoidFinding` (T6-REHOME)** | last-source re-assignment to an existing or NEW target Finding + FollowUp(VOIDED for F_old) + F_old OPEN→VOIDED — new-target creation rolls back with the tx on any failure |
| `createFindingWithObservationSource` (T7) | **ensure-accounted** for an EXISTING observation: pre-read observation; if already linked → no INSERT, no reassignment — return the existing Finding only for an IDENTICAL historical retry (the durable linked Finding matches the requested NEW-Finding semantic creation identity: origin/subject null-safe/normalized description/defect_type/defect_type_other/location/urgency/impact/created_by == request actor; `created_at` and the current status excluded — a later legitimate status transition does not invalidate an identical retry; a differing requested target is a typed conflict with no write — T6 remains the only correction/re-home path); else INSERT Finding OPEN (origin = observation's Visit) + guarded link `WHERE finding_id IS NULL` (`changes==1`; zero-row → ROLLBACK so the new Finding disappears, re-read and converge only on the identical durable target) |
| `transitionFindingStatus` / `transitionCorrectiveActionStatus` (T8/T10) | FollowUp event + status update (+ closure fields) |
| `createCorrectiveAction` (T9) | action row (+ optional FollowUp event) |
| `finalizeVisit` (T11) | **preflight checks run inside the same BEGIN IMMEDIATE** as the guarded final UPDATE (B6) |

Each unit is complete and independently valid; a service call spanning units calls them in order, each committing on its own.

---

## 3) Rollback behavior

- Any SQLite error inside a unit aborts the whole unit. **No compensating write is ever needed** because nothing partial was committed.
- The intentional multi-statement ordering constraints: (a) "no Finding may rest with zero sources unless it is VOIDED" (G4/Gate-4B) — Finding creation + first-source link live in one unit, and the VOID unit (T6-VOID) keeps the zero-source OPEN state strictly inside the transaction; (b) guarded writes check affected-row counts (B5) — a zero-row guarded UPDATE rolls the unit back instead of being silently committed.
- Explicit rollback on any unexpected exception (finally-block) guarantees the connection is never left inside a transaction.
- **DB-vs-APP boundary (Gate-4B):** the DB itself does **not** prevent a committed source-less OPEN Finding from existing at rest (creation is OPEN; the triggers only guard transitions and the OPEN→VOIDED current-state checks). Preventing that rest state, using VOIDED only for a genuinely last-source correction, and recording the FollowUp causal event are **domain/APP guarantees** realized by the single-transaction contracts (T6/T6-VOID) — see PHYSICAL-SCHEMA-v1.md §8 and CONSTRAINT-MATRIX-v1.md I22.

---

## 4) Crash windows and their guarantees

| Window | Durable effect | Recovery |
|---|---|---|
| Crash before `COMMIT` | none | clean re-run of the operation |
| Crash between statements inside a unit | none (single tx) | clean re-run |
| Crash after `COMMIT`, before the UI confirms | the unit is durably applied | retry by class (§5): class A converges; class B surfaces existing records |
| Crash mid-finalization | either fully finalized or untouched | restart sees PREPARATION + runs the single-tx preflight/finalize again, or finalized + immutable |
| OS/power loss | SQLite durability by journal/synchronous settings | integrity always; recency per synchronous choice |

**No window exists in which the durable Visit scope is partially materialized or silently forgotten:** scope entry units (T0/T1) are atomic; scope == materialized rows; the captured instrument universe is the institution-context row set (B2/B11).

---

## 5) Idempotency & retry — accurate classes (B7)

**Class A — naturally state-idempotent** (identical duplicates converge; no duplicate side effects):
- answer/correct/mark an existing materialized cell;
- Finding/Action transitions (guarded `WHERE status = <old>`; on zero changes re-read: already at target → success, no duplicate FollowUp);
- finalization (`finalized_at NOT NULL` → return existing final state);
- Finding creation attached to an existing response cell (T2/T3A): the guarded source UPDATE's zero-row failure rolls back the just-inserted Finding, then re-reads the cell's existing answer/link — no second Finding;
- **T7 ensure-accounted (micro-correction):** the observation is pre-read; when `observation.finding_id` is already set the operation never INSERTs another Finding and never reassigns — the existing linked Finding is returned as the durable result of an **identical historical retry** only, i.e. the durable Finding matches the requested NEW-Finding semantic creation identity (`origin_visit_id` = the observation's Visit, `subject_id` null-safe, normalized description/`defect_type`/`defect_type_other`/location, `urgency`, `impact`, `created_by` = request actor; `created_at` and the current status are deliberately excluded, so a later legitimate status transition does not invalidate an identical retry), while a requested semantic target that differs from the durable link is a typed conflict with no write; and the guarded link requires `finding_id IS NULL` — a retry after "COMMIT succeeded but ACK lost" never creates a second Finding and never reassigns/orphans the first one;
- `addSubjectToScope` for an **existing** subject id — genuinely Class A through the exact grid comparison inside the transaction (T1: actual == expected full grid → no INSERT; actual == 0 → insert; partial → `E_SCOPE_GAP` + ROLLBACK, never silently repaired);
- the dedicated VOID operation (T6-VOID) and the dedicated last-source re-home + VOID operation (**T6-REHOME**) — retry first reads `source.finding_id` and F_old.status: if the source points to the intended target and F_old is VOIDED, return idempotent success; a NEW-target retry converges on the already-created target identified by the durable `source.finding_id` (no second target Finding on blind retry).

**Class B — identity-creating commands without a durable idempotency key:** `createVisit`; creating a **new** subject inside `addSubjectToScope(newSubjectData)`; `createCorrectiveAction`; similar create-new-identity operations. For class B the docs make **no exactly-once/state-idempotency claim** after "COMMIT succeeded but ACK lost". Controls: write commands are serialized; the UI prevents same-process double-tap/in-flight duplicate execution; after an uncertain crash/restart the app re-reads durable state and **surfaces the existing records for the inspector to select**, never blindly re-INSERTing. No sidecar journal and no new idempotency table in this gate.

**Retry policy:** `SQLITE_BUSY` is absorbed by `busy_timeout`; a residual busy/locked error triggers one retry of the operation (safe per the class rules above), then a transient error is surfaced.

---

## 6) Application restart — reconstructing current Visit state from durable storage

On process start the app opens the DB (pragmas §1) and rebuilds state **only** from rows:

1. List missions/visits from `mission`/`visit`; the current/in-progress Visit = one with `status='PREPARATION'` chosen by the inspector (v1 single inspector).
2. **Captured instrument universe (B2/B11) = the institution-context cells of that Visit** (`checklist_response` rows with `subject_id IS NULL`), joined to definitions for `item_code`/`priority` and their pinned `item_definition_id`. **Current ACTIVE definitions are never used to reconstruct an existing Visit.**
3. **Contexts** = the institution context + every distinct subject context durably present in the grid (rows reference them).
4. **Expected grid** = captured universe × captured contexts (recompute per §6.1) — a later definition release adds nothing to an existing Visit.
5. **Cell classifications:** reason-less `NOT_INSPECTED` = **pending, unresolved** (for a HUMAN cell: unresolved HUMAN decision); answered cell = inspected (HUMAN: explicitly resolved APPLICABLE and answered); reasoned `NOT_INSPECTED` = deliberate uninspected (HUMAN: explicitly resolved APPLICABLE, not inspected); `NA` = not applicable (HUMAN: explicit NOT_APPLICABLE decision or a recorded T6 reversal) (B1).
6. **Findings/actions:** `finding`/`corrective_action`/`follow_up` as usual — `follow_up` is the append-only audit of every transition. **VOIDED findings are listed separately as historical/audit records**: zero-source VOIDED is expected, not corruption; **source-less OPEN remains `E_ORPHAN_FINDING`** (Gate 4B).
7. **Pinned versions** = the definitions referenced by the rows — reused by any later `addSubjectToScope` for the same Visit.

### 6.1 Grid self-check (integrity re-verification)
Recompute the expected cell set deterministically from the **captured universe** (institution-context rows) and the **captured contexts** (rows), using the pinned definitions' rule payloads; compare with actual rows (every expected (definition, context) cell exists exactly once, states consistent). A mismatch (manual DB edit, partial write, older app version) is reported as `E_SCOPE_GAP` and blocks finalization — never silently "repaired" (no auto-fix rule).

### 6.2 No volatile authority
No in-memory cache or sidecar is ever the source of truth for scope, selections, HUMAN decisions, or state. Any process kill is reconstructed identically by §2–§6.

---

## 7) Backup / portability note (v1)

SQLite is a single file: copying the file (writer idle or via backup API / `VACUUM INTO`) is the v1 backup/export primitive. Documentation for a later export gate — nothing implemented here.
