# Device Adapter Contract — v1

> **Status:** Gate 6A design contract — no device implementation yet
> **Authoritative base:** GitHub `main` at `bde4359eac5cdb8c9873164fe992bd03b9871a71`
> **Purpose:** define the minimum device/runtime seams that must preserve the closed Application Core semantics.

## 1. Governing rule

The device layer adapts platform services to the existing domain core. It must not reinterpret or weaken domain invariants.

The runtime-neutral core remains independent from Android/Capacitor/plugin-specific APIs.

## 2. SQL adapter contract

The existing authoritative seam is conceptually:

```ts
interface SqlAdapter {
  beginImmediate(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  run(sql: string, params?: readonly SqlValue[]): Promise<SqlResult>;
  query(sql: string, params?: readonly SqlValue[]): Promise<SqlRow[]>;
}
```

with `SqlResult.changes` and `lastInsertRowid` normalized across adapters.

### 2.1 Required semantics

A device implementation MUST:

1. execute parameterized SQL;
2. expose a real explicit `BEGIN IMMEDIATE` boundary;
3. keep all subsequent reads/writes in that same transaction until explicit commit/rollback;
4. never silently commit each statement independently inside an open domain transaction;
5. normalize affected-row cardinality so closed contracts using `changes == 1` remain valid;
6. preserve integer/text/null values without semantic reinterpretation;
7. enable SQLite foreign-key enforcement for every authoritative connection;
8. use the exact adopted schema/bootstrap assets;
9. keep the database durable in app-private persistent storage;
10. make the same database available after process/application restart.

### 2.2 Prohibited adapter behavior

The adapter MUST NOT:

- auto-repair domain rows;
- invent retry semantics that duplicate identity-creating operations;
- convert transaction failures into apparent success;
- hold authoritative business state outside SQLite;
- depend on current ACTIVE definitions to reconstruct historical Visits;
- weaken rollback behavior;
- expose plugin-specific objects to Application Core services.

## 3. Gate-6B qualification matrix

Any candidate SQLite driver/plugin must pass all of the following before permanent adoption:

| Capability | Required proof |
|---|---|
| Schema | exact `schema.sql` executes from a clean DB |
| Bootstrap | canonical bootstrap loads and verifies |
| Foreign keys | invalid FK write is rejected |
| BEGIN IMMEDIATE | competing write is serialized/blocked as expected |
| Multi-statement tx | statements remain in one explicit tx |
| Rollback | injected failure restores pre-operation DB state |
| affected rows | guarded write returns normalized `changes` |
| restart | same DB reconstructs via `currentVisitState` after app kill |
| finalization | T11 semantics remain unchanged |
| zero-write read | Gate-5L read snapshot remains write-free |
| no node dependency | device runtime does not require `node:*` |

Failure of a plugin/driver in this matrix means the candidate is rejected or adapted; it does not justify weakening closed core contracts.

## 4. EvidenceStorage port

Gate 6C should introduce a narrow device-facing storage port conceptually similar to:

```ts
interface EvidenceStorage {
  put(input: EvidenceBinaryInput): Promise<StoredEvidenceFile>;
  exists(storageRef: string): Promise<boolean>;
  open(storageRef: string): Promise<...>;
  listManagedFiles(): Promise<...>;
  removeOrphan(storageRef: string): Promise<void>;
}
```

Exact TypeScript signatures are deferred to Gate 6C. The contract principles are already fixed:

- binary bytes are not stored in SQLite;
- `storage_ref` must resolve inside managed app storage;
- filenames shown to users are metadata and not the authoritative filesystem locator;
- storage references must not allow arbitrary path traversal;
- evidence creation follows durable-file-first then SQLite-metadata ordering;
- orphan cleanup must never delete a file referenced by a durable Evidence row.

## 5. Camera / file import boundary

Camera and picker APIs are device adapters only. They provide a candidate file/stream to the Evidence pipeline; they do not create domain Evidence rows themselves.

Permission denial, user cancellation and device capture failure must be represented as operation outcomes, not as partial Evidence rows.

## 6. Document artifact boundary

Report rendering/saving should use a distinct artifact writer/share seam. Renderer output must be derived from an already constructed deterministic Report Model.

The device layer may:

- persist DOCX/PDF bytes;
- return durable artifact metadata/storage reference;
- invoke Android share/save flows.

It must not independently query operational SQLite tables and invent report content.

## 7. UI boundary

The UI may cache transient presentation state, but no adapter or UI store may become authoritative for:

- Visit scope;
- checklist response disposition;
- Finding/CorrectiveAction state;
- FollowUp history;
- finalization status;
- restart reconstruction.

Those remain SQLite/domain concerns.

## 8. Lifecycle / interruption tests

Device adapter qualification must deliberately test interruption points:

- before transaction begin;
- during a transaction;
- after guarded write but before commit;
- immediately after commit;
- after durable evidence file creation but before Evidence-row commit;
- during report artifact generation/save;
- app background/foreground transitions where the runtime may suspend the WebView.

Expected behavior must always converge to an explainable durable state; no volatile cache may be required for recovery.

## 9. Security and data locality

For single-inspector v1:

- operational DB and Evidence files are device-local/app-private by default;
- no automatic upload/sync is assumed;
- no real evidence or production DB is committed to GitHub;
- future backup/export/sync requires an explicit later contract.

## 10. Next implementation gate

Gate 6B must implement only enough Android shell + native SQLite integration to prove this contract against the existing core.

Evidence, full UI, reports and packaging qualification remain later gates.
