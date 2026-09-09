# Product Runtime Architecture — v1

> **Status:** Gate 6A architecture baseline — DESIGN ONLY
> **Authoritative base:** GitHub `main` at `bde4359eac5cdb8c9873164fe992bd03b9871a71`
> **Decision class:** PROJECT / owner-approved architecture decision. This document does not attribute these runtime choices to the official sources.

## 1. Purpose

This document defines the product-runtime architecture that follows the completed Application Core. It does not reopen Requirements, Checklist Design, Logical/Physical Schema, or Gates 5A–5L.

The governing invariant remains:

> SQLite is the local authoritative store for the single-inspector offline-first v1. UI/process memory is never operational authority.

The completed runtime-neutral TypeScript Application Core remains the domain layer. Device-specific capabilities are introduced only behind narrow adapters.

## 2. Target product shape

### 2.1 Platform strategy

- **Android-first field product** for phone/tablet use.
- **Web Native shell** using Capacitor as the default runtime architecture.
- **React + Vite + TypeScript** is the default UI stack for the field client.
- No server is required for field-usable v1.
- No sync/multi-user backend is introduced in Gate 6A.
- iOS remains architecturally possible later, but is not a v1 qualification target.

### 2.2 Why this fits the existing core

Gate 5A already established that the production domain core is runtime-neutral / WebView-compatible TypeScript and that `node:sqlite` is only a development/test adapter. The product architecture therefore preserves the existing core and adds native/device adapters rather than rewriting domain logic.

## 3. Runtime layers

```text
+--------------------------------------------------+
| Arabic RTL Field UI (React/Vite)                 |
+--------------------------------------------------+
| UI/application orchestration                     |
| - calls domain services                          |
| - treats UI state as disposable projection      |
+--------------------------------------------------+
| Runtime-neutral TypeScript Application Core      |
| - T0..T11                                        |
| - OBS-1                                          |
| - currentVisitState                              |
| - no node:* imports                              |
+--------------------------------------------------+
| Narrow ports/adapters                            |
| - SqlAdapter                                     |
| - EvidenceStorage                                |
| - Camera/File import                             |
| - Document artifact writer/share                |
+--------------------------------------------------+
| Android native services                          |
| - SQLite                                         |
| - app-private filesystem                         |
| - camera / picker                                |
| - share/save                                     |
+--------------------------------------------------+
```

## 4. State ownership

### 4.1 Authority

SQLite remains authoritative for domain/operational state.

The UI must not create a second source of truth. Any React state, route state, form cache, or memoized projection is disposable and must be reconstructable from SQLite.

Preferred interaction pattern:

```text
domain command
→ SQLite transaction commits
→ durable read / currentVisitState
→ render fresh projection
```

Optimistic UI may be considered later, but never at the cost of durable-state authority.

### 4.2 Restart rule

The device product must preserve the Gate-5L guarantee:

```text
process/app death
→ reopen application
→ connect to the same SQLite file
→ currentVisitState(visitId)
→ complete durable reconstruction
```

No cache, sidecar, browser storage, or in-memory store may be required to reconstruct a Visit.

## 5. SQLite device strategy

The existing `SqlAdapter` seam remains the contract boundary. Gate 6A does **not** select a final SQLite plugin/driver by brand.

A candidate native SQLite adapter must prove:

- parameterized SQL;
- explicit `BEGIN IMMEDIATE`;
- explicit `COMMIT` / `ROLLBACK`;
- no hidden per-statement transaction that breaks domain boundaries;
- normalized affected-row count (`changes`);
- deterministic row values compatible with the core;
- `PRAGMA foreign_keys=ON`;
- persistence across app/process restart;
- schema/bootstrap compatibility;
- correct behavior under serialized single-inspector writes.

The first executable phase after Gate 6A is therefore an **adapter-contract bake-off / device-runtime proof**, not UI expansion.

## 6. Evidence architecture

Evidence is a P0 product capability, but binary files remain outside SQLite. SQLite stores only evidence metadata and a durable `storage_ref`.

Gate 6A adopts the following ordering principle for evidence creation:

```text
capture/import file
→ copy to durable app-private storage
→ compute metadata/hash where required
→ BEGIN IMMEDIATE
→ INSERT Evidence metadata with storage_ref
→ COMMIT
```

Rationale: a crash after file creation but before SQLite commit can leave an orphan file that is discoverable and cleanable. A database row referencing a file that was never durably stored is the more dangerous failure mode and must be avoided.

The future Evidence gate must explicitly define:

- storage naming;
- app-private directory policy;
- content-hash policy;
- owner validation;
- orphan cleanup;
- restart reconciliation;
- retention/deletion rules;
- camera/import permission behavior;
- large-file handling.

SQLite + filesystem are **not** treated as one atomic transaction.

## 7. Arabic RTL UI architecture

RTL is a structural UI requirement from the first field screen, not a late styling pass.

Baseline rules:

- root document uses Arabic + RTL semantics;
- CSS logical properties are preferred over left/right-specific layout rules;
- codes, identifiers, timestamps, filenames and technical tokens require deliberate bidi treatment;
- UI never re-implements domain rules that already exist in Application Core;
- domain errors and blocker lists are rendered, not translated into new business semantics.

The first UI delivery must be a complete vertical field slice rather than many disconnected screens.

## 8. Report architecture

Report generation is separated into two stages:

```text
durable domain state
→ deterministic Report Model / snapshot
→ renderer(s)
   ├─ DOCX
   └─ PDF
```

A report is not a live view of mutable database state. Each generated report represents a known snapshot with its own metadata (`data_snapshot_ref`, `generated_at`, `generated_by`). A later follow-up report is a new Report record/artifact, not an overwrite of a historical report.

DOCX/PDF generation must remain outside React components and outside core field-state mutation logic.

## 9. External-system integration boundary

For v1, systems such as «تسيير» and the inspection platform remain externally operated systems whose events are recorded manually through `ExternalSystemTracking`.

No API integration is assumed in field-usable v1. API integration belongs to a later phase and must not block the local-first product.

## 10. Security / repository boundary

GitHub stores code, design, schemas, templates, tests and synthetic fixtures only.

GitHub must not contain:

- real field photos;
- real evidence files;
- personal operational data;
- production SQLite databases;
- sensitive inspection records.

## 11. Gate boundaries after this baseline

Gate 6A is design-only. It authorizes the roadmap and adapter boundaries but does not implement them.

The next executable Gate is **Gate 6B — Android Shell + Native SQLite Adapter / Device Runtime Proof**.

No UI, Evidence, reports, sync, server or packaging phase should bypass the Gate-6B runtime proof.
