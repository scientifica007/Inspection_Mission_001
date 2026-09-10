# Gate 6C-A — Evidence Storage Contract & Failure Model v1

> **Gate:** 6C — Evidence Storage + Camera/File Pipeline
>
> **Sub-stage:** 6C-A — Evidence Storage Contract & Failure Model
>
> **Status:** `DESIGN_REVIEW` — Gate 6C is `IN_PROGRESS`; Gate 6C is **not** closed.
>
> **Owner decisions:** the three category-C project decisions were explicitly **OWNER_APPROVED / ADOPTED** by the Project Owner on `2026-09-10`.
>
> **Mode:** DESIGN / CONTRACT ONLY. No Camera, Filesystem, picker, Evidence service, UI, APK, dependency, schema, bootstrap, or physical-device implementation is introduced by this document.
>
> **Authoritative starting point:** live GitHub `main@0fbd9ca3db6f2a34f063a682e4f997becefb83ad`.
>
> **Traceability:** inherited requirements retain `DIRECT` / `DERIVED` / `PROJECT`. The three category-C choices identified below are now owner-approved PROJECT decisions; future choices explicitly marked `PROPOSED PROJECT DECISION — OWNER APPROVAL REQUIRED` remain unapproved until separately authorized.

## 1. Purpose and governing boundary

Gate 6C-A removes ambiguity from the storage/failure contract before executable Evidence work begins. It preserves all closed Gate 5A→5L and Gate 6B semantics and does not reopen them.

The governing Evidence baseline is:

- `PRJ-04` is a **PROJECT / P0** requirement for phone photo/file Evidence; it is not attributed to the official source documents.
- Evidence is optional metadata linked to an existing domain record. Inability to acquire Evidence must not block recording a Finding.
- Evidence may be attached at record time or later. Gate 6C does not invent a `Visit.PREPARATION`-only attachment restriction.
- Binary Evidence remains outside SQLite. SQLite stores committed Evidence metadata and a durable `storage_ref`.
- SQLite remains the authoritative domain/ownership store. Filesystem state never becomes authority for `owner_kind` / `owner_ref`.
- The six owner kinds remain exactly: `VISIT`, `CHECKLIST_RESPONSE`, `ADHOC_OBSERVATION`, `FINDING`, `CORRECTIVE_ACTION`, `FOLLOW_UP`.
- Existing `trg_evidence_bi` owner-existence enforcement remains the hard database floor.
- Existing Evidence metadata is immutable after INSERT except `note`; Evidence rows are no-delete in v1.
- Gate 6A's adopted creation ordering remains authoritative:

```text
capture/import source
→ durable app-private file copy
→ metadata/hash
→ BEGIN IMMEDIATE
→ INSERT Evidence metadata with storage_ref
→ COMMIT
```

SQLite and the filesystem are **not** one atomic transaction. The system therefore prefers a recoverable unreferenced file over a committed database row that points to a file that was never durably stored.

## 2. Evidence source abstraction

Acquisition and durable storage are separate responsibilities.

A runtime-neutral acquisition result is conceptually:

```ts
type EvidenceSourceKind =
  | "CAMERA_PHOTO"
  | "GALLERY_MEDIA"
  | "GENERIC_FILE";

interface EvidenceSource {
  kind: EvidenceSourceKind;
  sourceRef: string;          // opaque, transient adapter reference/URI
  displayName?: string;       // source/provider name when available
  declaredMimeType?: string;  // descriptive only
  sizeHint?: number;          // advisory only
  capturedAt?: string;        // when meaningful/available
}
```

The exact TypeScript type is deferred to 6C-B. The semantic rules are fixed for this Gate:

1. `sourceRef` is an opaque acquisition handle. It may represent a Camera URI, gallery/media URI, Android `content://` URI, or file URI.
2. `sourceRef` is **not** a durable `storage_ref` and must never be written into the Evidence row as one.
3. The acquisition adapter does not INSERT Evidence rows and does not decide domain ownership.
4. The durable-storage adapter does not launch UI or decide which owner receives Evidence.
5. Source metadata is advisory until the durable copy is completed and statted. The final persisted object metadata is authoritative for `file_size`; MIME remains descriptive rather than a security assertion.
6. A newly captured Camera photo, an existing gallery/media selection, and a generic imported file all enter the same persistence/orchestration pipeline after acquisition.

If a source has no meaningful original filename (for example, a newly captured Camera photo), 6C-B may synthesize a user-facing `file_name` because the schema requires it. That display name is metadata only and must never be used as the physical storage key.

## 3. Runtime-neutral ports

### 3.1 Acquisition boundary

Gate 6C-B should depend on a narrow source-acquisition abstraction rather than Capacitor objects. The conceptual operations are:

```ts
interface EvidenceSourceAcquisition {
  takeCameraPhoto(): Promise<AcquisitionOutcome>;
  chooseGalleryMedia(): Promise<AcquisitionOutcome>;
  chooseGenericFile(): Promise<AcquisitionOutcome>;
}
```

`AcquisitionOutcome` must distinguish success, cancellation, permission/access denial, source unavailability, and unsupported source. The native adapter maps platform/plugin error codes to the runtime-neutral taxonomy in §18.

### 3.2 EvidenceStorage boundary

`EvidenceStorage` is a narrow device-facing port comparable in architectural role to `SqlAdapter`, but it never becomes a second domain database. Its conceptual responsibilities are:

```ts
interface EvidenceStorage {
  allocate(): Promise<EvidenceObjectAllocation>;
  stage(source: EvidenceSource, allocation: EvidenceObjectAllocation): Promise<StagedEvidenceObject>;
  publish(staged: StagedEvidenceObject): Promise<StoredEvidenceObject>;
  stat(storageRef: string): Promise<StoredEvidenceStat>;
  resolve(storageRef: string): Promise<ResolvedEvidenceHandle>;
  listManagedObjects(): Promise<ManagedEvidenceObject[]>;
  removeConfirmedOrphan(storageRef: string): Promise<void>;
  verifyHash(storageRef: string, expectedHash: string): Promise<HashVerification>;
}
```

These signatures are illustrative, not implementation. The port contract is:

- `allocate()` creates a collision-resistant object identity **before** any Evidence row exists.
- `stage()` copies/streams the source into a non-addressable incoming object and obtains durable-object metadata using bounded memory.
- before `publish()`, Gate 6C-B must verify through the storage port that the final managed object path for the candidate canonical `storage_ref` does not already exist;
- `publish()` makes a complete staged object visible under its final managed reference; it returns only after the final object is complete and stattable, and it MUST provide no-overwrite/no-replace semantics for an already existing final destination;
- if the final destination already exists, the storage operation must not overwrite, truncate, replace, or reuse it for the new attempt; the candidate identity is abandoned and a fresh UUID/`storage_ref` is allocated, while cleanup/reconciliation of the pre-existing object remains governed by §10;
- `stat()` / `resolve()` validate the `storage_ref` grammar and remain confined to the managed app-private root.
- `listManagedObjects()` enumerates only the managed Evidence namespace required for reconciliation.
- `removeConfirmedOrphan()` may remove only an object that the application has already proved is not referenced by committed SQLite Evidence metadata.
- `verifyHash()` is streaming/bounded-memory and never requires loading the entire binary into JavaScript memory.

The port must not contain UI semantics, owner-kind business rules, SQLite access, public-gallery behavior, or report/export behavior.

## 4. `storage_ref` contract

### 4.1 Required semantics

A committed `storage_ref` MUST:

- be logical and application-relative;
- be stable across ordinary process/app restarts;
- resolve only inside the managed app-private Evidence store;
- never be an absolute Android filesystem path;
- never be a transient `content://` URI, Camera URI, gallery URI, or picker URI;
- contain the adopted versioned namespace so future storage migrations can be explicit;
- contain no source filename component that can cause collision or path traversal;
- be validated before resolution, with malformed/out-of-root references rejected as `BROKEN_STORAGE_REFERENCE`.

### 4.2 Canonical v1 grammar — OWNER-APPROVED PROJECT DECISION

**OWNER_APPROVED / ADOPTED — 2026-09-10**

The canonical committed reference is:

```text
evidence/v1/objects/<uuid-v4>.<safe-extension>
```

with a non-addressable staging namespace:

```text
evidence/v1/.incoming/<uuid-v4>.part
```

Rationale:

- `evidence/v1/` makes the logical contract version explicit;
- `objects/` distinguishes committed physical objects from staging;
- UUID v4 can be created before `evidence_id` exists and provides collision resistance without coupling the file name to SQLite identity;
- `.incoming` is never a valid committed `storage_ref`, so incomplete objects are mechanically distinguishable;
- the original/user-facing filename remains only in `evidence.file_name`.

The parser must accept only the canonical grammar. It must reject absolute paths, URI schemes, `..`, empty segments, alternate separators, percent-decoded traversal, and any path outside the configured managed root.

This grammar is now project policy for Gate 6C implementation.

### 4.3 One committed row per canonical reference — DERIVED TECHNICAL CONSEQUENCE

For **Gate-6C-managed Evidence**, one canonical committed `storage_ref` MUST correspond to **at most one committed Evidence row**.

This is an **APPLICATION-LEVEL invariant for Gate 6C v1**. It is a **DERIVED TECHNICAL CONSEQUENCE**, not a new database constraint and not a DIRECT requirement. The current schema does **not** define `UNIQUE(storage_ref)`, and Gate 6C-A does not change the schema or claim that SQLite itself enforces this invariant.

The owner-approved UUID-v4 naming policy makes accidental allocation collision extremely unlikely, but probability is not a correctness rule. Gate 6C-B must still provide deterministic behavior for collision, retry, uncertain COMMIT, and pre-existing corruption. No code path may infer uniqueness merely from UUID randomness.

Gate 6C-B therefore uses **two application-level SQLite guards** for every NEW attempt:

1. a read-only pre-publication collision preflight by exact candidate canonical `storage_ref`, performed before any final managed object is published; and
2. the existing cardinality recheck inside the same `BEGIN IMMEDIATE` transaction that performs owner revalidation and the Evidence INSERT.

The read-only pre-publication preflight MAY occur before staging to avoid wasted work. If staging occurs first, it must still occur before final publication. The critical invariant is:

> **NO final managed object may be published under a canonical `storage_ref` already referenced by committed SQLite Evidence.**

For the **pre-publication SQLite preflight** of a NEW attempt:

- **zero committed rows** → the candidate may continue to the final-path existence check and, if that also passes, publication;
- **exactly one committed row** → do not publish any file under that `storage_ref`; abandon that candidate identity and allocate a fresh UUID/canonical `storage_ref`; this is an ordinary collision outcome and does not mutate the historical row;
- **more than one committed row** → do not publish; surface `STORAGE_REF_CONFLICT` because the lookup has exposed pre-existing integrity corruption; preserve all rows and any existing managed file;
- never use the new file to “repair” a missing managed file for an already committed Evidence row.

Before publication, Gate 6C-B must also verify that the exact final managed object path does **not** already exist. If SQLite returns zero rows but the final path exists, the object may be an orphan or unresolved residue, but the new attempt MUST NOT overwrite, truncate, replace, or reuse it. The candidate is abandoned and a fresh UUID/`storage_ref` is allocated; cleanup/reconciliation of the pre-existing object remains exclusively under §10.

After successful publication, inside the **same `BEGIN IMMEDIATE` transaction** that performs owner revalidation and the Evidence INSERT, Gate 6C-B must repeat the exact candidate canonical `storage_ref` query, for example:

```sql
SELECT evidence_id, owner_kind, owner_ref, storage_ref, content_hash,
       file_name, mime_type, file_size, captured_at, recorded_at, recorded_by
  FROM evidence
 WHERE storage_ref = ?
 ORDER BY evidence_id;
```

For this **transactional recheck**:

- **zero rows** → the insertion may proceed, subject to the normal owner and metadata guards;
- **one or more existing rows** after the pre-publication checks passed → this is an exceptional integrity/state-drift path, not the ordinary collision path; do not INSERT, do not overwrite or mutate any committed row, do not silently claim success, and surface `STORAGE_REF_CONFLICT`;
- because a committed row now references the same canonical `storage_ref`, do **not** automatically delete the already published final file as compensation; preserve state for diagnosis;
- if the recheck exposes `>1` committed rows, preserve all rows and the referenced managed file and do not choose an arbitrary row.

Recovery of the **same uncertain attempt** is not treated as an ordinary new-attempt collision; it follows the deterministic 0/1/>1 convergence rules in §9.1.

### 4.4 Evidence maintenance/write serialization boundary — DERIVED TECHNICAL CONSEQUENCE

Normal Gate-6C Evidence creation and reconciliation/cleanup operations use the same **application-level single-process Evidence maintenance/write serialization boundary**.

Within the supported single-process product architecture, a NEW Evidence attempt holds this boundary across candidate allocation, optional staging, the pre-publication SQLite preflight, final-path existence verification, publication, `BEGIN IMMEDIATE`, transactional `storage_ref` recheck, INSERT, and transaction completion. Reconciliation/cleanup does not run concurrently with that create critical section.

This prevents another in-contract Gate-6C operation in the same process from allocating/publishing the same candidate between the preflight and the transactional recheck. The transactional recheck remains mandatory because it detects unexpected state drift and protects the application contract at the last point before INSERT.

This application-level serialization boundary does **not** claim to protect against arbitrary external processes, out-of-contract direct SQLite manipulation, filesystem tampering, or other writers that bypass the Gate-6C application contract. Such interference is diagnosed through the transactional recheck, restart reconciliation, hash verification, and existing integrity/state-conflict paths rather than assumed impossible.

## 5. Physical storage directory policy

The already governing architecture requires committed Evidence to be durable and app-private. It must not be placed into public Gallery or public Documents merely to store Evidence.

For Android/Capacitor v8, official Filesystem documentation describes `Directory.Data` as the directory holding application files on Android and states that those files are deleted when the application is uninstalled. The same documentation says Android read/write permission requests are required only for `Directory.Documents` or `Directory.ExternalStorage`, not `Directory.Data`.

Therefore:

- **ALREADY GOVERNING:** committed Evidence is app-private and device-local by default.
- **DERIVED TECHNICAL CONSEQUENCE:** an Android adapter must use an app-private persistent location that survives ordinary process/app restart and does not require broad external-storage permission solely for committed Evidence storage.
- **TECHNICAL IMPLEMENTATION CANDIDATE:** `@capacitor/filesystem` `Directory.Data` is the preferred candidate root for Gate 6C-C because its documented Android semantics fit the contract.
- The plugin/directory choice is a technical implementation decision, not a DIRECT source requirement.
- `Directory.Documents`, public Gallery, or other public storage is not the committed Evidence store. A later explicit user-facing export/share operation may create a separate public copy; that is not Gate 6C storage authority.
- **Uninstall semantics:** app-private Evidence under `Directory.Data` is deleted on uninstall. Gate 6C does not claim uninstall survival. Backup/export/restore across uninstall is deferred to a later explicit contract.

The project currently does not install `@capacitor/filesystem`, `@capacitor/camera`, or `@capacitor/app`; 6C-A installs nothing.

## 6. Object naming and collision policy

A physical object identifier MUST be allocated before the Evidence database row because file persistence precedes the SQLite INSERT.

**OWNER_APPROVED / ADOPTED — 2026-09-10**

Use a cryptographically random UUID v4 in canonical lowercase textual form as the v1 object token.

Rules:

- never derive the object key from `evidence_id`;
- never derive the object key from the original filename;
- never trust directory segments from imported names;
- allocation collision must fail closed and generate a fresh token rather than overwrite;
- a committed-SQLite-reference collision detected before publication must abandon the candidate before any final object is published;
- a pre-existing final-path collision must abandon the candidate rather than overwrite or reuse that object;
- the final object must be created without overwriting an existing managed object;
- the extension is normalized separately from the original filename;
- UUID-v4 collision resistance does not replace the application-level one-row-per-canonical-`storage_ref` invariant or the two SQLite guards in §4.3.

For the adopted grammar, `<safe-extension>` is lowercase ASCII `a-z0-9`, one short extension segment only, with no leading dot inside the stored value and no separators. A known safe extension may be derived from trusted Camera output metadata or a conservative MIME/filename normalization. Unknown types use a neutral extension such as `bin`. The exact user-facing source filename is retained separately in `file_name` and is never concatenated into a managed path.

## 7. Content-hash policy

The schema deliberately permits `content_hash IS NULL`; Gate 6C-A does not rewrite that historical fact as though the database schema itself mandates hashing.

### 7.1 Adopted policy — OWNER-APPROVED PROJECT DECISION

**OWNER_APPROVED / ADOPTED — 2026-09-10**

For Evidence newly committed by Gate 6C, SHA-256 is required and stored as:

```text
sha256:<64 lowercase hexadecimal characters>
```

Historical/pre-Gate-6C rows remain valid with `content_hash = NULL`; no schema change is proposed.

Rationale: Evidence is an audit-supporting artifact, and an immutable content digest allows deterministic integrity verification without making the filesystem authoritative for ownership.

### 7.2 Execution semantics

- Hash during the source→`.incoming` copy, before final publication and before SQLite `BEGIN IMMEDIATE`.
- Hash incrementally/streamingly; whole-file buffering is prohibited.
- A hashing failure before publication returns `HASH_FAILED`; no Evidence row is inserted.
- `publish()` returns the final size and digest so the application writes immutable metadata exactly once.
- Hash verification of an already committed object is a separate bounded-memory operation.
- Ordinary restart reconciliation must always check reference syntax and existence/stat. Full re-hashing of every Evidence binary on every startup is **not** mandated by this contract because it can be expensive. A reconciliation/diagnostic mode must support hash verification; when performed, a mismatch is `HASH_MISMATCH` and the Evidence row/file are retained for diagnosis.

## 8. Creation state machine and cross-store atomicity

The canonical NEW-attempt application flow is:

```text
0  enter the single-process Evidence maintenance/write serialization boundary
1  optional early owner preflight (read-only; advisory, not the hard floor)
2  acquire source
3  allocate collision-resistant UUID-v4 object token / candidate storage_ref
4  optionally stream/copy source → evidence/v1/.incoming/<token>.part
5  read-only SQLite preflight for exact candidate canonical storage_ref
6  verify exact final managed object path does not already exist
7  finish staging/stat/hash if not already complete; publish complete final object with no-overwrite semantics
8  BEGIN IMMEDIATE
9  revalidate owner inside the transaction
10 repeat SQLite cardinality query for exact candidate canonical storage_ref
11 only when transactional recheck returns zero rows: INSERT Evidence metadata
12 COMMIT
13 leave serialization boundary and return committed Evidence result
```

The read-only SQLite preflight MAY occur before staging to avoid wasted work. Regardless of where optional staging occurs, **steps 5 and 6 MUST complete successfully before step 7 publishes any final managed object**.

The application may perform an early owner preflight to avoid an expensive copy for an obviously invalid owner, but it must revalidate in the SQLite transaction. `trg_evidence_bi` remains authoritative hard enforcement and is never bypassed.

Gate 6C-B therefore has two distinct SQLite `storage_ref` guards: the read-only pre-publication collision preflight and the authoritative transactional recheck immediately before INSERT. The second guard is not removed or weakened by the first. Both are application-level Gate-6C requirements because the current schema has no `UNIQUE(storage_ref)` constraint.

The pre-publication SQLite guard prevents a new binary from being published into a physically missing path already named by an unrelated committed historical Evidence row. A missing physical file does not make the historical row's canonical `storage_ref` available for reuse, and a new Evidence attempt must never use its binary to “repair” that historical reference.

The final-path existence guard is separate from the SQLite preflight. Even when SQLite reports zero committed rows, an already existing final managed object is not reusable by a new attempt. It may be an orphan or unresolved residue; the new attempt abandons that candidate and leaves cleanup/reconciliation to §10.

A final `storage_ref` must not be written to SQLite until the storage adapter has positively reported that the complete final object exists. A filesystem failure can never be converted into a metadata-only success.

If the transactional recheck unexpectedly returns one or more committed rows after both pre-publication guards passed and the final object was published, Gate 6C-B MUST NOT INSERT. It surfaces `STORAGE_REF_CONFLICT`, preserves committed rows, and does not automatically delete the final file while a committed row references that same `storage_ref`. This is an exceptional integrity/state-drift path for diagnosis, not the normal collision path.

The publish operation should be implemented as a same-filesystem atomic rename/move from `.incoming` where the platform/API can prove that property. Official Capacitor Filesystem documentation exposes `rename(...)` but does not document an atomicity guarantee. Therefore:

> **REQUIRES EXECUTABLE SPIKE IN 6C-C:** prove whether the selected Android adapter can provide the required complete-object publication semantics, including interruption behavior and no-overwrite/no-replace behavior at the final managed destination. Do not infer atomicity or no-replace semantics merely from the existence of a `rename` API.

If the official Filesystem API cannot prove the required property, a narrow native implementation behind `EvidenceStorage` may provide it; the domain contract does not change.

## 9. Exact failure model

| Boundary / failure | SQLite Evidence row | Filesystem residue allowed | Required outcome / recovery |
|---|---|---|---|
| user cancels Camera | none | none | `USER_CANCELLED`; safe no-op |
| user cancels gallery/file picker | none | none | `USER_CANCELLED`; safe no-op |
| permission/access denied | none | none | `PERMISSION_DENIED`; owner record unaffected |
| source inaccessible before durable copy | none | no final object; partial incoming possible only if copy began | `SOURCE_UNAVAILABLE`; remove incoming best-effort, startup cleanup otherwise |
| unsupported/virtual source cannot yield bytes | none | none or partial incoming | `UNSUPPORTED_SOURCE`; no DB write |
| copy/write fails | none | partial `.incoming` may remain | `STORAGE_WRITE_FAILED`; startup removes incomplete object |
| hash fails | none | `.incoming` may remain | `HASH_FAILED`; no publish/DB write; cleanup incoming |
| stat/metadata finalization fails | none | `.incoming` may remain | `STORAGE_WRITE_FAILED`; no publish/DB write |
| pre-publish SQLite candidate query returns exactly one committed row | no new row | no new final object published | ordinary candidate collision; abandon identity and allocate fresh UUID/`storage_ref`; never mutate/repair historical row |
| pre-publish SQLite candidate query returns >1 committed rows | no new row | no new final object published; existing referenced file retained if present | `STORAGE_REF_CONFLICT`; preserve all rows/file; do not publish, choose, delete, or overwrite |
| pre-publish final managed path already exists after SQLite returned zero rows | no new row | pre-existing final object retained; staged `.incoming` may remain until normal cleanup | abandon candidate and allocate fresh UUID/`storage_ref`; never overwrite/truncate/reuse; reconciliation decides whether pre-existing object is orphan/residue |
| final publish/rename fails | none | `.incoming`, or implementation-specific unreferenced final residue | `STORAGE_WRITE_FAILED`; no DB write; startup reconciliation cleans proven orphan |
| process death during `.incoming` copy | none | partial `.incoming` | restart removes `.incoming` before new Evidence work |
| process death after complete stage but before publish | none | complete `.incoming` | restart removes `.incoming` |
| process death after final publish but before SQLite BEGIN | none | unreferenced final object | restart deletes only after proving no committed Evidence row references it |
| SQLite `BEGIN IMMEDIATE` fails | none | unreferenced final object | `SQLITE_FAILED`; best-effort orphan cleanup or restart reconciliation |
| owner validation fails inside transaction | none | unreferenced final object | rollback; `OWNER_NOT_FOUND` / `OWNER_INVALID`; best-effort cleanup |
| post-publish transactional `storage_ref` recheck unexpectedly returns one or more committed rows | no new row | published final object preserved while committed row(s) reference that canonical `storage_ref` | `STORAGE_REF_CONFLICT`; rollback/no INSERT; do not choose, overwrite, delete rows, or auto-delete referenced final file; diagnose state drift |
| Evidence INSERT/trigger fails | none after rollback | unreferenced final object | rollback; map owner error when applicable, otherwise `SQLITE_FAILED`; cleanup only after no committed row is proven |
| process death after INSERT but before COMMIT | none (uncommitted tx rolls back) | unreferenced final object | restart reconciliation deletes proven orphan |
| COMMIT returns a definite rollback/failure | none | unreferenced final object | `SQLITE_FAILED`; orphan may be removed after DB re-read proves absence |
| COMMIT result is uncertain / ACK lost | unknown until fresh re-read | final object must be preserved | **do not delete**; apply exact 0/1/>1 convergence in §9.1; inability to establish committed state preserves the file and surfaces `SQLITE_FAILED` |
| process death after COMMIT before caller/UI acknowledgement | committed row | referenced final object | restart treats as valid committed Evidence; no compensation/delete |
| committed row later references missing file | committed row retained | file absent | `BROKEN_STORAGE_REFERENCE`; never delete row as compensation |
| committed row/file hash verification mismatches | committed row retained | file retained | `HASH_MISMATCH`; retain both for diagnosis |

Filesystem compensation is therefore asymmetric: unreferenced files may be cleaned after proof; committed Evidence metadata is never deleted to make a filesystem problem disappear.

### 9.1 Uncertain COMMIT convergence — exact 0/1/>1 semantics

After a COMMIT whose result is uncertain (including ACK loss), Gate 6C-B must preserve the final managed file and perform a **fresh committed-state SQLite query by the exact attempt `storage_ref`**. It must not interpret the result through UUID probability or choose an arbitrary row.

Use the exact-attempt comparison set below when one row is returned. The comparison is null-safe and exact for the values the attempt supplied:

- `owner_kind`;
- `owner_ref`;
- `storage_ref`;
- `content_hash`;
- `file_name`;
- `mime_type`;
- `file_size`;
- `captured_at` where applicable;
- `recorded_at`;
- `recorded_by`.

`note` is not part of this convergence identity because the existing schema permits it to change after insertion. The purpose of the comparison is to establish that the committed immutable attempt identity/metadata corresponds to the operation whose COMMIT acknowledgement was uncertain.

The result cardinality is authoritative for recovery:

**A — ZERO committed rows**

- no committed Evidence row for the exact attempt `storage_ref` is established;
- only after this fresh zero-row SQLite proof may the final file be classified as an unreferenced orphan under §10;
- the operation continues/returns according to the existing uncertain-commit recovery contract: no success is claimed; cleanup may proceed only under the orphan rules, and a subsequent ordinary new attempt uses a fresh UUID/`storage_ref` rather than blindly reusing the abandoned identity;
- if the recovery read itself cannot establish the zero-row state, preserve the file and surface `SQLITE_FAILED`.

**B — EXACTLY ONE committed row**

- compare the row against the exact expected attempt identity/metadata listed above;
- exact expected match → converge to committed **SUCCESS** and return the existing `evidence_id`; do not INSERT a second row;
- any mismatch → `STORAGE_REF_CONFLICT` (state/integrity conflict); do not overwrite, delete, relink, or silently accept either the row or the managed file as the attempted Evidence.

**C — MORE THAN ONE committed row**

- this violates the Gate-6C application-level one-row-per-canonical-`storage_ref` invariant;
- classify as `STORAGE_REF_CONFLICT` integrity failure;
- do not arbitrarily choose one row;
- do not INSERT another row;
- do not delete any committed Evidence row;
- do not delete the referenced managed file as compensation;
- surface deterministic diagnostic/state-conflict information including the canonical `storage_ref` and conflicting `evidence_id` values, without logging binary contents or sensitive source URI data.

These convergence rules are an application/recovery contract. They do not imply or claim a schema-level `UNIQUE(storage_ref)` constraint.

## 10. Orphan cleanup contract

Cleanup distinguishes three mandatory categories:

### 10.1 Incomplete temporary objects

Objects under the canonical `.incoming` namespace are never valid committed `storage_ref`s. At startup/reconciliation, when no Evidence write is active, they are incomplete work and may be deleted automatically.

### 10.2 Final managed objects with no committed Evidence row

A final object is an orphan only after a fresh SQLite read proves that **zero committed Evidence rows** reference its exact canonical `storage_ref`. It may then be deleted automatically.

This rule safely resolves crashes after final file publication but before database commit. It also protects the uncertain-COMMIT case: if one row actually committed, the fresh SQLite reference set prevents deletion. A canonical `storage_ref` referenced by **more than one** committed Evidence row is also **not an orphan**; it is the duplicate-reference integrity condition defined in §§4.3, 9.1, and 11, and its referenced managed file must not be auto-deleted.

An object discovered by the pre-publication final-path check when SQLite currently reports zero rows is likewise **not overwritten by the new attempt**. It remains untouched until the existing reconciliation/orphan rules prove whether deletion is safe.

### 10.3 Committed Evidence row whose file is missing

This is **not** an orphan-row cleanup case. It is a broken reference / integrity failure:

- retain the Evidence row;
- do not synthesize a replacement file;
- do not delete the Evidence row;
- surface `BROKEN_STORAGE_REFERENCE` with the Evidence identity and logical `storage_ref` suitable for diagnosis, without logging file contents or sensitive source URI data.

A later NEW attempt that happens to allocate the same canonical `storage_ref` MUST NOT publish a replacement binary into the missing path. The pre-publication SQLite collision preflight in §4.3 abandons that candidate before publication.

### 10.4 Cleanup serialization

Startup/init reconciliation MUST run under the same single-process Evidence maintenance/write serialization boundary used by new Evidence persistence, and SHOULD complete before new Evidence acquisition/persistence is accepted. This prevents cleanup racing an active copy or publish.

Normal Gate-6C Evidence creation holds that same boundary through the pre-publication SQLite guard, final-path existence guard, publication, transactional recheck, and transaction completion as defined in §4.4. This is application-level single-process serialization only; it does not exclude arbitrary external processes or out-of-contract direct manipulation.

If cleanup cannot safely enumerate or delete a confirmed orphan, return/surface `ORPHAN_CLEANUP_FAILED`. New Evidence persistence may be held in a degraded/unavailable state until reconciliation is safe; ordinary domain work must still be able to proceed because Evidence is optional.

Unknown files that do not match the managed-object grammar must not be silently deleted merely because they are in or near the Evidence root. Surface them for diagnosis unless they are inside the dedicated `.incoming` namespace and satisfy its strict staging grammar.

## 11. Restart reconciliation

No sidecar JSON, manifest, index, browser storage, or in-memory map becomes authoritative.

Reconciliation uses only:

```text
committed SQLite Evidence rows
+
managed app-private Evidence directory
```

Under the Evidence maintenance lock:

1. Read the committed Evidence `(evidence_id, storage_ref, content_hash, file_size, ...)` set from SQLite and group exact canonical references by `storage_ref`.
2. Validate each `storage_ref` grammar before any filesystem resolution.
3. Detect duplicate committed references **before orphan deletion**: any exact canonical `storage_ref` referenced by `>1` committed Evidence row is `STORAGE_REF_CONFLICT`; retain every committed row and the referenced managed file, do not choose one row, and never classify/delete that file as an orphan.
4. Enumerate `.incoming` and final managed objects.
5. Classify non-duplicate reference states:
   - exactly one committed row + existing final file → valid reference (subject to stat/integrity checks);
   - `.incoming` object → incomplete temporary object → auto-clean;
   - final managed object with zero committed rows → confirmed orphan → auto-clean;
   - exactly one committed row + missing final file → integrity problem → retain row and surface `BROKEN_STORAGE_REFERENCE`;
   - exactly one committed row + verified hash mismatch → integrity problem → retain row/file and surface `HASH_MISMATCH`.
6. Only after reconciliation completes may new Evidence writes begin.

A full content hash of every object is not required on every startup. When hash verification is requested, it must be streaming and mismatch must be surfaced rather than repaired silently.

Duplicate committed references are a deterministic integrity problem, not a filesystem-cleanup opportunity. Reconciliation must never “repair” them by deleting rows or by deleting the shared/referenced managed file.

## 12. Retention and deletion

The existing schema makes Evidence rows no-delete in v1. Gate 6C must not introduce a normal “delete evidence” operation that would contradict that contract.

Consequences:

- a committed Evidence binary is retained for as long as its committed Evidence row exists;
- visit finalization does not delete Evidence files;
- later attachment remains allowed because the existing logical model says Evidence may be attached at record time or later;
- `Evidence.note` may be updated under the existing schema; binary content, `storage_ref`, hash, ownership, filename, MIME, size, capture/device metadata, and recorded audit metadata remain immutable;
- orphan-file deletion is maintenance of **uncommitted** filesystem residue, not deletion of Evidence;
- uninstall removes app-private `Directory.Data` files according to Capacitor documentation; this is application lifecycle removal, not a domain Evidence delete operation.

Archival, selective purge, legal retention periods, backup/export, cross-device restore, cloud retention, and a future user-visible delete workflow are **DEFERRED BEYOND GATE 6C** unless separately authorized. They must not be invented by an adapter.

## 13. Owner validation

All six existing owner kinds are preserved; no new owner kind is introduced.

Responsibility is layered:

1. **Application preflight:** reject an unknown `owner_kind` as `OWNER_INVALID`; query the selected owner table and return `OWNER_NOT_FOUND` when the requested row does not exist. A read-only early preflight may occur before copying to avoid waste.
2. **Pre-publication storage-reference guard:** while holding the Evidence maintenance/write serialization boundary, perform the read-only candidate-`storage_ref` lookup and final-path nonexistence check required by §4.3 before final publication.
3. **Transactional application validation:** after final file publication, re-check owner existence and candidate-`storage_ref` cardinality inside the same `BEGIN IMMEDIATE` that performs the Evidence INSERT.
4. **Database hard floor:** `trg_evidence_bi` remains unchanged and must reject any INSERT whose declared owner does not exist. Application code maps the trigger failure to the meaningful owner error where possible.

No application preflight weakens, bypasses, replaces, or duplicates the trigger with a looser rule.

Gate 6C-A intentionally does **not** require the owner Visit to be `PREPARATION`; the existing model allows Evidence at record time or later, and no authoritative repository contract currently establishes a PREPARATION-only Evidence insertion rule.

## 14. Retrieval contract

Later retrieval is:

```text
Evidence.storage_ref
→ EvidenceStorage.resolve(storage_ref)
→ validated app-private physical URI/handle
```

Rules:

- `resolve` parses only the canonical logical namespace and prevents traversal/out-of-root resolution;
- a transient acquisition URI is never required after successful commit;
- `resolve` must verify the final object exists before returning a usable handle;
- a missing object returns `BROKEN_STORAGE_REFERENCE` and does not mutate SQLite;
- optional/explicit integrity verification compares the streamed digest with `content_hash`; mismatch returns `HASH_MISMATCH` and preserves both metadata and file;
- MIME metadata is supplied as descriptive metadata to later viewers/sharing layers but is not trusted as proof of content safety.

## 15. Permissions, denial, cancellation, source loss

The runtime-neutral acquisition layer maps these conditions without creating Evidence metadata:

- Camera cancelled → `USER_CANCELLED`;
- gallery/media selection cancelled → `USER_CANCELLED`;
- generic file picker cancelled → `USER_CANCELLED`;
- Camera permission/access denied → `PERMISSION_DENIED`;
- picker/provider access denied → `PERMISSION_DENIED`;
- selected source disappears or grant is lost before durable copy completes → `SOURCE_UNAVAILABLE`;
- source cannot provide a byte representation supported by Gate 6C → `UNSUPPORTED_SOURCE`.

All are safe no-op/error outcomes with no committed Evidence row. If a staging file was created before source loss, it is incomplete `.incoming` work and is cleaned under §10.

Because Evidence is optional, none of these outcomes invalidates, rolls back, or corrupts an already valid owner domain record, and inability to capture Evidence must not block creation/recording of a Finding.

## 16. Large-file handling

Gate 6C establishes a **bounded-memory requirement**, not an arbitrary permanent file-size number.

Mandatory semantics:

- source copy must support streaming/chunked/native byte transfer;
- hashing must be incremental because SHA-256 is required for new Gate-6C Evidence;
- no implementation may require a whole large binary to make a mandatory Base64 round trip through JavaScript memory;
- metadata such as exact final size should come from the final staged/published object, not from an untrusted size hint;
- low-storage/write-shortage conditions fail before the SQLite Evidence row is committed.

Official Capacitor Filesystem v8 documents `readFileInChunks(...)`, but its binary write/append examples and APIs still use encoded data, and the documentation does not establish that `Filesystem.copy(...)` can copy arbitrary Android `content://` sources into `Directory.Data` with the required bounded-memory and failure semantics.

> **REQUIRES EXECUTABLE SPIKE IN 6C-C:** verify source→app-private streaming/copy for Camera/gallery/generic `content://` sources, memory behavior, large-file behavior, and interruption behavior. A narrow native adapter is permitted behind `EvidenceStorage` if necessary; it is not adopted by 6C-A.

No numeric v1 maximum file size is adopted here.

If a future hard limit is proposed, the exact number is a **PROPOSED PROJECT DECISION — OWNER APPROVAL REQUIRED**. `FILE_TOO_LARGE` remains a reserved taxonomy code and is emitted only after such a limit is adopted.

## 17. Android Camera and process-death recovery

Current official Capacitor v8 Camera documentation establishes the following technical facts:

- the API introduced in 8.1.0 uses `takePhoto()` and `chooseFromGallery()`;
- legacy `getPhoto()` / `pickImages()` are deprecated by the current v8 migration guidance;
- on Android the Camera API launches a separate Activity;
- Capacitor recommends handling `App.appRestoredResult` because Android may terminate the app while an external Activity is running;
- the new Camera APIs expose structured native error codes that adapters can map into runtime-neutral outcomes.

Gate 6C-C therefore uses the **current API strategy** as a technical implementation baseline: `takePhoto()` for new Camera photos and `chooseFromGallery()` for gallery/media selection. It must not build new code on the deprecated legacy APIs.

The restored-result rule is mandatory:

```text
App.appRestoredResult Camera result
→ normalize to EvidenceSource
→ re-enter the same owner-confirmation/acquisition orchestration
→ allocate candidate UUID/storage_ref
→ durable .incoming copy/hash as needed
→ pre-publish SQLite storage_ref preflight
→ verify final managed path absent
→ publish final object with no-overwrite semantics
→ BEGIN IMMEDIATE
→ owner revalidation + storage_ref cardinality recheck + Evidence INSERT
→ COMMIT
```

A restored Camera result must never bypass durable copy, hashing policy, owner validation, either `storage_ref` guard, final-path nonexistence verification, or SQLite ordering.

If process death erased volatile owner-selection context, the restored source MUST NOT be auto-attached to a guessed owner. The application must reconstruct the relevant durable domain state from SQLite and require/recover an unambiguous owner selection before commit. If ownership cannot be established unambiguously, the source remains uncommitted and no Evidence row is created. Gate 6C does not add a sidecar authority to remember owner intent.

The practical preservation lifetime of restored source access, and the exact listener/adapter sequencing relative to startup reconciliation, require physical/executable verification in 6C-C/6C-D.

## 18. Generic file import

`PRJ-04` requires photos **and files**. Camera/gallery support alone is therefore insufficient.

Gate 6C-B must expose a generic runtime-neutral file-source operation. On Android, the source may be a `content://` or file URI, but the URI is acquisition-only and must be copied immediately into managed app-private Evidence storage before commit.

Android's official Storage Access Framework documents `ACTION_OPEN_DOCUMENT` as the system mechanism for user selection of documents/files and represents selected documents as `content://` URIs that can be opened through `ContentResolver`. This is a suitable native implementation candidate.

No third-party file-picker plugin is adopted by 6C-A.

> **REQUIRES EXECUTABLE SPIKE IN 6C-C:** choose and prove the Android generic-file acquisition adapter. A narrow custom Capacitor Android plugin around the Storage Access Framework is an acceptable candidate if no verified official Capacitor API satisfies the required generic-file and process-restoration contract. This candidate must be kept behind `EvidenceSourceAcquisition`; it must not leak Android/Capacitor types into runtime-neutral orchestration.

Persistable external URI permission is not storage authority. The goal is to obtain enough access to complete the app-private copy; the committed Evidence must remain retrievable without the original external URI.

## 19. Error/result taxonomy

Gate 6C-B should use a compact Evidence-specific result taxonomy and map it into the existing typed Application-Core error style (`E_*`) rather than inventing inconsistent untyped exceptions.

| Runtime-neutral code | Semantics | DB row? |
|---|---|---|
| `USER_CANCELLED` | user cancelled acquisition | no |
| `PERMISSION_DENIED` | Camera/gallery/provider access denied | no |
| `SOURCE_UNAVAILABLE` | selected source disappeared/cannot be reopened before durable copy | no |
| `UNSUPPORTED_SOURCE` | source cannot supply supported bytes/semantics | no |
| `FILE_TOO_LARGE` | reserved; only active if a size limit is later owner-approved | no |
| `STORAGE_WRITE_FAILED` | stage/stat/publish durable storage failed | no |
| `HASH_FAILED` | required SHA-256 could not be completed | no |
| `OWNER_NOT_FOUND` | valid owner kind but referenced owner row absent | no |
| `OWNER_INVALID` | owner kind/owner reference shape invalid | no |
| `SQLITE_FAILED` | SQLite transaction/insert/commit failed and no more specific mapped domain error applies | no or uncertain until re-read |
| `STORAGE_REF_CONFLICT` | exact canonical `storage_ref` exposes duplicate committed references, mismatching uncertain-attempt metadata, or unexpected post-publish transactional state drift | existing row(s)/referenced file retained |
| `BROKEN_STORAGE_REFERENCE` | committed Evidence points to missing/malformed/unresolvable managed file | row retained |
| `HASH_MISMATCH` | verified final bytes do not match stored digest | row/file retained |
| `ORPHAN_CLEANUP_FAILED` | confirmed orphan/incoming cleanup or safe enumeration failed | no domain mutation |

An ordinary NEW-attempt pre-publication collision with one pre-existing committed row is not silently accepted and need not become a user-visible integrity error: no final object is published under that reference, the candidate is abandoned, and a fresh UUID/`storage_ref` is allocated under §4.3. Likewise, if SQLite reports zero rows but the final managed path already exists, the new attempt does not overwrite it; it abandons the candidate and leaves the object to reconciliation.

`STORAGE_REF_CONFLICT` is reserved narrowly for mismatching uncertain-attempt state, duplicate committed references, unexpected post-publish transactional state drift, or equivalent integrity conditions. Gate 6C-B may materialize it as `E_EVIDENCE_STORAGE_REF_CONFLICT` in the existing typed Application-Core convention.

Other codes may likewise be materialized as names such as `E_EVIDENCE_STORAGE_WRITE_FAILED`; the precise TypeScript names are implementation detail. Cancellation is an expected operation outcome, not a domain-corruption exception.

Platform-specific Camera/Android error codes are mapped at the adapter boundary and are not exposed as business semantics.

## 20. Security boundaries

Gate 6C implementation MUST enforce:

- committed Evidence storage is app-private;
- imported/source filenames never control physical paths;
- `storage_ref` is parsed against a closed grammar and can never escape the managed root;
- imported files are data only; they are never executed or interpreted as executable code;
- MIME metadata is descriptive and may be incorrect; it is not trusted security proof;
- source URI strings and file contents are not logged as routine diagnostics;
- real Evidence, real inspection photos/files, personal/sensitive operational data, production databases, secrets, API keys, and device identifiers are never committed to GitHub;
- no public Gallery/Documents copy is created merely for committed Evidence storage;
- later view/share/export must be a separate explicit capability and must not change SQLite ownership authority.

## 21. Decision matrix

| Topic | Classification | Gate 6C-A disposition |
|---|---|---|
| binaries outside SQLite | **A — ALREADY GOVERNING / NO NEW OWNER DECISION** | preserved exactly |
| SQLite metadata/domain ownership authority | **A — ALREADY GOVERNING / NO NEW OWNER DECISION** | filesystem never becomes ownership authority |
| six owner kinds + `trg_evidence_bi` hard floor | **A — ALREADY GOVERNING / NO NEW OWNER DECISION** | unchanged |
| Evidence optional; capture failure must not block Finding | **A — ALREADY GOVERNING / NO NEW OWNER DECISION** | unchanged |
| Evidence metadata immutable except note; Evidence no-delete | **A — ALREADY GOVERNING / NO NEW OWNER DECISION** | unchanged |
| attach Evidence at record time or later | **A — ALREADY GOVERNING / NO NEW OWNER DECISION** | no PREPARATION-only rule invented |
| durable-file-first → SQLite-row ordering | **A — ALREADY GOVERNING / NO NEW OWNER DECISION** | preserved exactly |
| app-private committed Evidence storage | **A — ALREADY GOVERNING / NO NEW OWNER DECISION** | public Gallery/Documents not storage authority |
| transient source URI is not `storage_ref` | **B — DERIVED TECHNICAL CONSEQUENCE** | required by durable managed-storage contract |
| one canonical committed `storage_ref` → at most one committed Evidence row | **B — DERIVED TECHNICAL CONSEQUENCE** | Gate-6C application-level invariant; current schema has no `UNIQUE(storage_ref)` |
| pre-publish SQLite candidate collision preflight | **B — DERIVED TECHNICAL CONSEQUENCE** | mandatory before final publication; committed reference is never reused to publish a new file |
| pre-publish final-path nonexistence/no-overwrite guard | **B — DERIVED TECHNICAL CONSEQUENCE** | existing final object is never overwritten/truncated/reused; candidate is abandoned and reconciliation owns cleanup |
| post-publish `BEGIN IMMEDIATE` cardinality recheck | **B — DERIVED TECHNICAL CONSEQUENCE** | remains mandatory final state-drift guard immediately before INSERT |
| shared single-process Evidence create/reconciliation serialization | **B — DERIVED TECHNICAL CONSEQUENCE** | protects in-contract same-process operations only; no claim against arbitrary external manipulation |
| staging/final state distinction and startup reconciliation | **B — DERIVED TECHNICAL CONSEQUENCE** | `.incoming` incomplete; final unreferenced objects cleanable after DB proof |
| missing committed file behavior | **B — DERIVED TECHNICAL CONSEQUENCE** | retain DB row; surface `BROKEN_STORAGE_REFERENCE`; new attempt must not fill its path |
| bounded-memory/streaming requirement | **B — DERIVED TECHNICAL CONSEQUENCE** | no mandatory whole-file Base64 path |
| restored Camera result uses same pipeline | **B — DERIVED TECHNICAL CONSEQUENCE** | no bypass of pre-publish guards/copy/hash/owner/SQLite ordering |
| current Camera API (`takePhoto` / `chooseFromGallery`) | **B — DERIVED TECHNICAL IMPLEMENTATION DECISION** | preferred for 6C-C; legacy APIs not used for new implementation |
| Android app-private location / `Directory.Data` | **B — DERIVED TECHNICAL IMPLEMENTATION DECISION** | preferred candidate; verify in 6C-C, not a DIRECT source rule |
| exact `storage_ref = evidence/v1/objects/<uuid>.<ext>` grammar | **C — OWNER-APPROVED PROJECT DECISION** | **ADOPTED 2026-09-10** |
| exact UUID-v4 object token scheme | **C — OWNER-APPROVED PROJECT DECISION** | **ADOPTED 2026-09-10** — canonical lowercase UUID v4 |
| SHA-256 required for newly committed Gate-6C Evidence | **C — OWNER-APPROVED PROJECT DECISION** | **ADOPTED 2026-09-10** — `sha256:<64 lowercase hex>`; nullable historical rows preserved |
| numeric maximum v1 file size | **D — DEFERRED BEYOND GATE 6C unless separately approved** | no arbitrary number adopted; `FILE_TOO_LARGE` reserved |
| generic Android file-picker implementation | **D — implementation selection deferred to 6C-C spike** | SAF/custom narrow Capacitor plugin is candidate; no third-party plugin adopted |
| proof of Filesystem `copy(content://...)` bounded-memory behavior | **D — REQUIRES EXECUTABLE SPIKE IN 6C-C** | documentation is insufficient to claim it |
| proof of atomic/complete-object `rename` publication | **D — REQUIRES EXECUTABLE SPIKE IN 6C-C** | documentation exposes rename but does not promise atomicity/no-replace semantics |
| normal committed Evidence deletion/purge/archive policy | **D — DEFERRED BEYOND GATE 6C** | no v1 delete operation |
| backup/export/cloud/sync retention | **D — DEFERRED BEYOND GATE 6C** | no server/cloud authority introduced |

## 22. Gate 6C internal execution decomposition

This is an internal execution decomposition only; it does not replace the adopted product Roadmap.

### 6C-A — Evidence Storage Contract & Failure Model

**Entry:** Gate 6B CLOSED/MERGED; Gate 6C separately authorized for design.

**Work:** this contract, current official platform research, decision classification, failure/reconciliation model.

**Exit:** independent review confirms repository authority preserved; the three category-C decisions are owner-approved; contract/state changes are merged. No executable Evidence implementation is required for 6C-A exit.

### 6C-B — Runtime-neutral Evidence orchestration + host regressions

**Entry:** 6C-A contract merged and category-C owner decisions resolved.

**Work:** runtime-neutral source/storage ports and orchestration only; fake/in-memory test adapters; application-level one-row-per-canonical-`storage_ref` invariant; shared single-process Evidence maintenance/write serialization; read-only pre-publication SQLite collision preflight; final-path nonexistence/no-overwrite guard; mandatory transactional recheck; host regression coverage for pre-publish 0/1/>1 cardinality, pre-existing final-path collision, missing-file historical-row collision prevention, unexpected post-publish transactional conflict, uncertain-COMMIT 0/1-match/1-mismatch/>1 convergence, cancellation, stage/publish failure, SQLite failures, duplicate-reference restart reconciliation, orphan reconciliation, missing references, and bounded-memory contract seams.

**Exit:** focused host suite passes; closed Gate 5A→5L / 6B contracts are not weakened; no Android-specific type leaks into runtime-neutral core; no schema-level `UNIQUE(storage_ref)` is assumed.

### 6C-C — Android Camera/File + durable EvidenceStorage adapters

**Entry:** 6C-B reviewed/accepted.

**Work:** install only justified official dependencies; implement Camera/gallery adapter; implement/choose generic Android file acquisition; implement app-private EvidenceStorage; handle `appRestoredResult`; execute required spikes for `content://` copy/streaming and complete-object publication/no-overwrite semantics; Android/emulator integration checks as appropriate.

**Exit:** all `REQUIRES EXECUTABLE SPIKE IN 6C-C` questions have concrete evidence; adapter behavior satisfies 6C-A; no schema/core weakening; host + Android CI checks pass.

### 6C-D — Physical Android Evidence qualification + Gate closure

**Entry:** 6C-C implementation reviewed with green CI.

**Work:** real-device qualification covering Camera, gallery/media, generic file, cancel/deny, source loss, process death/restored Camera result, restart reconciliation, orphan cleanup, missing-file diagnosis, large-file bounded-memory behavior, low-storage/write failures, and retrieval after restart.

**Exit:** physical evidence is independently reviewed; unresolved contradictions corrected narrowly; owner authorizes merge/closure; only then may Gate 6C become CLOSED and Gate 6D become next.

Gate 6D is not started by any 6C sub-stage.

## 23. Current official technology research

Consulted current official documentation (Capacitor documentation reports v8 at the time of this design):

- Capacitor Camera v8: `https://capacitorjs.com/docs/apis/camera`
- Capacitor App v8: `https://capacitorjs.com/docs/apis/app`
- Capacitor Filesystem v8: `https://capacitorjs.com/docs/apis/filesystem`
- Android Storage Access Framework / documents: `https://developer.android.com/training/data-storage/shared/documents-files`
- Android `ACTION_OPEN_DOCUMENT`: `https://developer.android.com/reference/android/content/Intent#ACTION_OPEN_DOCUMENT`

Verified points used by this contract:

- Camera v8.1.0 introduced `takePhoto()` / `chooseFromGallery()` and deprecated `getPhoto()` / `pickImages()` in the current v8 migration guide.
- Android Camera uses an external Activity and official Capacitor guidance requires handling `appRestoredResult` for OS process death.
- Camera's Android photo/gallery path can avoid using public Gallery as committed storage; `saveToGallery` defaults false in the new Camera API.
- Filesystem `Directory.Data` is application file storage on Android and is deleted on uninstall.
- Filesystem Android permission methods are required for `Documents` / `ExternalStorage`, not `Data`.
- Filesystem supports reading Android `content://` paths when used as full paths and exposes `readFileInChunks`, `rename`, `copy`, `stat`, `readdir`, and `getUri`.
- Official documentation does **not** establish that `copy` accepts every required `content://` source with the required bounded-memory semantics, nor does it promise atomicity or no-replace behavior for `rename`; those claims are deliberately deferred to executable spikes.
- Android's official Storage Access Framework provides `ACTION_OPEN_DOCUMENT` for user-selected generic files and returns document URIs suitable for stream access.

## 24. 6C-A owner-approved decisions and stop rule

The Project Owner explicitly approved the three category-C project decisions on `2026-09-10`:

1. canonical committed `storage_ref`: `evidence/v1/objects/<uuid-v4>.<safe-extension>`, with staging `evidence/v1/.incoming/<uuid-v4>.part`;
2. canonical lowercase UUID v4 as the v1 object-token convention;
3. mandatory SHA-256 for every newly committed Gate-6C Evidence object, stored as `sha256:<64 lowercase hexadecimal characters>`, while historical/pre-Gate-6C `content_hash = NULL` rows remain valid.

These three choices are now **OWNER_APPROVED / ADOPTED PROJECT decisions** and are no longer pending.

No numeric permanent file-size limit is approved or proposed by this decision.

No third-party generic picker is selected.

No claim is made that Capacitor Filesystem `copy(content://...)` or `rename(...)` already proves the required large-file/atomic-publication/no-replace semantics.

**STOP CONDITION:** 6C-B must not begin from this design branch. It begins only under a separate scoped authorization after 6C-A independent review and merge of the reviewed 6C-A contract/state changes.
