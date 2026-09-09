# Product Delivery Roadmap — v1

> **Status:** Gate 6A roadmap baseline — OWNER APPROVED
> **Authoritative base:** GitHub `main` at `bde4359eac5cdb8c9873164fe992bd03b9871a71`
> **Traceability:** PROJECT architecture/delivery decision. It does not replace or reinterpret DIRECT/DERIVED requirements.

## 1. Current completed baseline

The project has completed and merged:

- Gate 1 — Requirements
- Gate 2 — Checklist Design
- Gate 3 — Logical Data Model
- Gate 4 — Physical / Executable Schema
- Gate 4A — Checklist Applicability Bridge
- Gate 4B — Finding VOIDED Lifecycle
- Gate 4 — Revision 6 narrow correction
- Gate 5A — Application Core Contracts
- Gate 5B — Bootstrap
- Gate 5C — Visit Scope Composition
- Gate 5D — Initial Response Disposition
- Gate 5E — Corrections / Finding Source Lifecycle
- Gate 5F — T7 ensure-accounted
- Gate 5G — OBS-1 createAdHocObservation
- Gate 5H — Finding Status Transitions
- Gate 5I — createCorrectiveAction
- Gate 5J — CorrectiveAction Status Transitions
- Gate 5K — finalizeVisit
- Gate 5L — currentVisitState / restart reconstruction

Application Core therefore includes T0→T11, OBS-1 and durable restart reconstruction from SQLite.

## 2. Product objective

The next objective is not to add more domain Gates mechanically. It is to turn the completed Application Core into a **field-usable Android v1** while preserving:

- offline-first operation;
- SQLite local authority;
- restart reconstruction;
- closed-Gate semantics;
- Arabic RTL field usability;
- P0 Evidence;
- deterministic report generation;
- DOCX/PDF output.

## 3. Governing sequence

```text
Application Core
      ✓ CLOSED

        ↓

6A  Product Runtime Architecture & Delivery Roadmap
        ↓
6B  Android Shell + Native SQLite Adapter / Device Runtime Proof
        ↓
6C  Evidence Storage + Camera/File Pipeline
        ↓
6D  Arabic RTL Field UI + End-to-End Visit Workflow
        ↓
6E  ExternalSystemTracking application capability
        ↓
6F  Deterministic Report Model / Snapshot Generation
        ↓
6G  DOCX + PDF + Artifact Save/Share
        ↓
6H  Android Packaging + Field Qualification
        ↓
     FIELD-USABLE v1
```

No later phase should silently bypass an earlier dependency.

---

# Gate 6A — Product Runtime Architecture & Delivery Roadmap

**Type:** DESIGN ONLY

### Scope

- adopt Android-first delivery;
- adopt Capacitor Web Native architecture;
- adopt React + Vite + TypeScript as the default field UI stack;
- preserve runtime-neutral Application Core;
- define device adapter boundaries;
- define Evidence storage ordering;
- define SQLite as sole domain authority;
- define report snapshot/rendering separation;
- update repository orientation documentation.

### Explicit non-scope

- no native SQLite implementation;
- no UI screens;
- no camera code;
- no report renderer;
- no packaging;
- no sync/server.

### Exit condition

Architecture and delivery documents are merged to `main` and identify Gate 6B as the next executable Gate.

---

# Gate 6B — Android Shell + Native SQLite Adapter / Device Runtime Proof

**Purpose:** prove the existing core works on the real target runtime without semantic weakening.

### Required proof

```text
fresh app install
→ create/open SQLite DB
→ enable required pragmas
→ execute schema
→ bootstrap reference data
→ create Mission / Visit
→ exercise representative core writes
→ kill process/app
→ reopen same DB
→ currentVisitState
→ same durable state
```

### Must verify

- explicit `BEGIN IMMEDIATE` works as required;
- explicit commit/rollback boundaries are preserved;
- no hidden per-statement transaction breaks a domain transaction;
- `changes` is normalized correctly;
- foreign keys are enforced;
- schema/bootstrap run correctly on Android;
- persistence survives app/process restart;
- serialized single-inspector write assumptions hold;
- Application Core requires no `node:*` dependency or rewrite.

### Selection rule

Do not permanently adopt a SQLite plugin/driver until it passes this contract.

---

# Gate 6C — Evidence Storage + Camera/File Pipeline

**Purpose:** implement P0 phone photo/file evidence safely across SQLite + filesystem.

### Required capabilities

- camera capture;
- file/image import;
- durable app-private storage;
- Evidence metadata creation;
- `storage_ref` retrieval;
- owner validation;
- optional content hash according to adopted storage policy;
- restart recovery;
- orphan-file cleanup;
- permission denial handling;
- large-file/image handling.

### Failure ordering

Preferred sequence:

```text
capture/import
→ durable file copy
→ metadata/hash
→ SQLite transaction
→ Evidence row
→ commit
```

Do not pretend SQLite and filesystem form one atomic transaction.

---

# Gate 6D — Arabic RTL Field UI + End-to-End Visit Workflow

**Purpose:** deliver the first complete inspector-facing vertical slice.

### Required vertical flow

1. Mission selection/creation.
2. Visit creation.
3. Institution context.
4. Add inspected subjects.
5. Checklist navigation.
6. HUMAN_CONFIRMATION decisions.
7. Answer / NA / deliberate NOT_INSPECTED.
8. Ad-hoc observation.
9. Finding creation/use.
10. CorrectiveAction creation/status visibility.
11. Evidence attachment.
12. Finalization preflight.
13. Structured blockers.
14. Finalize.
15. Kill/close app.
16. Reopen.
17. Reconstruct same Visit from SQLite.

### UI rules

- Arabic RTL from the first field screen;
- CSS logical properties preferred;
- technical identifiers/codes use deliberate bidi handling;
- UI does not implement a parallel business-rule engine;
- UI state is disposable projection, not authority.

---

# Gate 6E — ExternalSystemTracking application capability

**Purpose:** expose the already modeled append-only external-system event history.

### v1 boundary

- manual recording only;
- no API integration with «تسيير» or the inspection platform;
- later status/event change creates a new row, never rewrites history.

Representative application operation may be designed as an append-only `recordExternalSystemEvent(...)` service, subject to its own contract review.

---

# Gate 6F — Deterministic Report Model / Snapshot Generation

**Purpose:** generate report content from durable state without coupling the report logic to Word/PDF rendering.

### Architecture

```text
SQLite/domain state
→ deterministic Report Model
→ immutable report snapshot metadata
```

### Required properties

- exact Visit/Mission/Institution scope is recorded;
- generated content is traceable to a known data cut;
- historical generated reports are not overwritten;
- post-finalization remediation can produce a later report without rewriting the original field report;
- report generation does not mutate historical field truth.

---

# Gate 6G — DOCX + PDF + Artifact Save/Share

**Purpose:** fulfill P0 document-output requirements.

### Required outputs

- DOCX;
- PDF;
- deterministic filename/artifact metadata;
- Arabic RTL layout;
- tables/page breaks/header/footer rules as adopted;
- device save/share path;
- Report artifact metadata linked to the generated Report record/snapshot.

DOCX/PDF renderers consume the Report Model; they do not query and reinterpret operational tables independently.

---

# Gate 6H — Android Packaging + Field Qualification

**Purpose:** qualify the product for real field use rather than merely producing a build.

### Qualification scenarios

- clean install;
- schema/bootstrap initialization;
- full Visit workflow;
- camera/file Evidence;
- process kill during ordinary use;
- restart/resume;
- finalization;
- DOCX/PDF generation;
- reopening historical Visit;
- app upgrade with preserved data;
- low-storage behavior;
- denied permissions;
- large images/files;
- Arabic keyboard/bidi usability;
- rotation/background/resume where applicable;
- interruption during Evidence save;
- report artifact persistence.

### Exit condition

A real Android device can complete the adopted P0 field workflow offline, survive restart, preserve durable truth, and produce required report artifacts.

---

# 4. Deferred P1 / v1.x roadmap

After field-usable v1, candidates include:

- CSV export (PRJ-05);
- XLSX export (PRJ-06);
- readiness indicators/aggregation;
- deadlines/reminders;
- weekly provincial reporting;
- committee/multi-role workflows;
- multi-inspector support;
- sync;
- server/backend;
- web dashboard;
- external APIs («تسيير», inspection platform).

These are intentionally deferred so they do not destabilize the local-first field v1.

## 5. Architecture stop rule

A later Gate must not reopen a closed Gate merely for elegance. Reopening is justified only by a concrete executable contradiction, following the precedent used during Gate 5L review.

## 6. Next action

After Gate 6A documentation is merged, the next executable design/implementation task is:

> **Gate 6B — Android Shell + Native SQLite Adapter / Device Runtime Proof**

No UI-first shortcut is adopted.
