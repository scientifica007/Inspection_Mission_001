# Gate 5G Decisions — v1 (OBS-1 `createAdHocObservation`)

> **Gate:** 5G — AdHocObservation Creation Contract & Service (OBS-1).
> **Base (authoritative main):** `2260ec8d0559a2cfb83797c3c5b84ac9d1a65c40` — working branch `harness/gate5g-observation-create-v1`.
> **Date/context:** 2026-09-08, Gate 5G of the Inspection Mission project (Gate 5F closed; current baselines: 5F 30/0, 5E 77/0, 5D 60/0, 5C 55/0, 5B 32/0, schema 100/0).
> **Status:** owner-approved contract — DESIGN + implementation/tests. It becomes persistent official project memory only after its documentation/code is reviewed, committed, pushed and merged into main. No commit made in this gate.
> **Deliverables:** this file + updates to `docs/application/APPLICATION-CORE-v1.md` (§4 catalog, §4.7 cross-ref, §4.12), `docs/application/TRANSACTION-CONTRACTS-v1.md` (§8 cross-ref, §12 Class B, §14), `docs/application/RECOVERY-AND-IDEMPOTENCY-v1.md` (§2, §5) + new service `src/application/observation-create.ts` + regression `tests/gate5g_regression.ts`.

---

## G5G-1 — Owner approval & context

The **OWNER explicitly approved a new application-core contract: OBS-1 — createAdHocObservation** in Gate 5G. The decision is owner-approved in this Gate; it becomes persistent official project memory only after review/commit/push/merge into main. The owner's traceability framing is adopted verbatim in spirit:

- **Primary project authority:** PRJ-03 — observations/notes, P0.
- **REQ-012** is supporting **DIRECT** evidence that field observations are used in the technical sheet/reporting outputs.
- **The exact OBS-1 API or transaction contract is NOT claimed DIRECT** from the official sources.
- **REQUIREMENTS-v1.md is NOT modified** merely to pretend this application contract came from the official sources.

## G5G-2 — Approved OBS-1 public contract

```
createAdHocObservation({
    visitId,
    subjectId?,       // nullable
    text,
    recordedAt,
    recordedBy
})
```

Creates **exactly one** durable AdHocObservation during an open field Visit — the Observation **ONLY**. It must **NOT** create a Finding, link to a Finding, create a Subject, attach Evidence, implement correction, implement T8+, or perform reporting/UI/sync behavior. A new row always begins with `finding_id = NULL`. If the inspector later decides this Observation represents a Finding, the already-adopted Gate-5F T7 operation (`createFindingWithObservationSource`) handles that separately.

## G5G-3 — Semantics: one new identity per invocation (Class-B identity-creating)

This is an **IDENTITY-CREATING Class-B operation**. Duplicate text/time is **not** reinterpreted as the same Observation: two intentional invocations with identical payloads are allowed to create two distinct observations. Nothing below was added:

- no UNIQUE constraint;
- no dedupe by text;
- no dedupe by timestamp;
- no hash-based idempotency;
- no sidecar idempotency table;
- no client request token.

No such identity key has been adopted by the project.

## G5G-4 — Input validation (adopted)

- `visitId`: the Visit must exist (else `E_VISIT_NOT_FOUND`).
- `text`: required; trimmed for meaningfulness; blank/whitespace-only ⇒ `E_CONFIG`; the normalized meaningful text is stored (project normalization conventions).
- `recordedBy`: required meaningful text, normalized per the established application audit conventions (trimmed).
- `recordedAt`: required app-supplied timestamp using the established application-core timestamp convention (ISO-8601 UTC text) — server/device time is never invented internally.
- `subjectId`: optional / NULL allowed. NULL means a general Visit/institution-level observation. When supplied: the Subject must exist (`E_SUBJECT_NOT_FOUND`) and `subject.institution_id` must equal `visit.institution_id` (mismatch ⇒ `E_CONTEXT`). OBS-1 does **not** create a Subject and does **not** invent an "active subject only" requirement (no adopted contract requires it).

## G5G-5 — Visit gate (PREPARATION only)

All mutable authorization reads occur **inside `BEGIN IMMEDIATE`**. Missing Visit ⇒ `E_VISIT_NOT_FOUND`. Creation is allowed **only** when `visit.status = 'PREPARATION'` AND `visit.finalized_at IS NULL`; otherwise `E_VISIT_NOT_PREPARATION`. **No backdated creation into a finalized Visit.** The DB floor (`trg_obs_bi`) enforces the same rule as defense in depth.

## G5G-6 — Immutable `recorded_at` / `recorded_by` semantics

`recorded_at`/`recorded_by` are written once by OBS-1, never defaulted, never overwritten, and fixed by `trg_obs_bu` (identity/ownership/audit immutability). They record the app-supplied instant/actor of the observation's durable entry into Visit storage.

## G5G-7 — Finding separation (OBS-1 / T7)

OBS-1 always creates `finding_id = NULL` and never accepts Finding creation data. T7 remains `createFindingWithObservationSource(existing observationId, ...)` (Gate 5F — Class A ensure-accounted). The two operations are **never** combined into one transaction/API. An Observation may remain informational forever. Gate-5F semantics are not modified (only the stale "no creation contract exists" comment in `observation-finding.ts` was updated to point at OBS-1).

## G5G-8 — Class-B rationale (idempotency/recovery)

OBS-1 creates a NEW observation identity and the project has no adopted durable request/idempotency key for it. Therefore:

- pre-COMMIT failure ⇒ transaction rollback ⇒ no Observation;
- successful COMMIT ⇒ one durable Observation;
- COMMIT/ACK-loss ⇒ the outcome may be ambiguous to the caller.

In an ambiguous post-COMMIT outcome the service does **not** automatically rerun the INSERT claiming exactly-once, and does **not** inspect text/time and decide that an existing row "must be" the same attempt. Recovery policy: reconstruct durable Visit observations and surface/reconcile the durable state to the inspector/caller; do not auto-resubmit the create command. A deliberate later invocation, even with the exact same payload, is a new Class-B create and may produce a second observation.

## G5G-9 — Deferred: general observation-correction gap (boundary note only)

`correctAdHocObservation` is **not** implemented in this Gate. The data model permits observation text/subject correction while the Visit is PREPARATION, and Gate 5E supports such correction when it rides on specific T6 source operations. A general correction API for an informational/unlinked Observation is a separate known gap — documented as deferred, not designed beyond this note.

## G5G-10 — No schema change

`docs/schema/schema.sql` is **not modified**. OBS-1 rides entirely on the existing `adhoc_observation` table and `trg_obs_bi`/`trg_obs_bu` guards. Expected result: schema regression stays 100/0.

## G5G-11 — Error taxonomy (reused codes only)

`E_VISIT_NOT_FOUND`, `E_VISIT_NOT_PREPARATION`, `E_SUBJECT_NOT_FOUND`, `E_CONTEXT`, `E_CONFIG`, `E_STATE_CONFLICT`. No observation-duplicate error (duplicates are not a domain error); no new code was needed.

## G5G-12 — Files touched

- New: `src/application/observation-create.ts`, `tests/gate5g_regression.ts`, this file.
- Modified (documentation only): `docs/application/APPLICATION-CORE-v1.md`, `docs/application/TRANSACTION-CONTRACTS-v1.md`, `docs/application/RECOVERY-AND-IDEMPOTENCY-v1.md`.
- Comment-only pointer update: `src/application/observation-finding.ts` (out-of-scope note).
- Untouched: `docs/requirements/REQUIREMENTS-v1.md`, `docs/schema/*`, all closed-Gate sources/tests.
