# Gate 5B — `lastInsertRowid` Normalization Correction v1

> **Status:** OWNER-AUTHORIZED NARROW CLOSED-GATE CORRECTION — implementation complete on correction branch; pending independent review/PR/merge.
>
> **Classification:** `PROJECT` authorization applied to a concrete `DERIVED` runtime contradiction with the already adopted Gate-5B `SqlAdapter` contract.
>
> **Governing repository:** `scientifica007/Inspection_Mission_001`
>
> **Governing live `main` base:** `25cd1ed248b3962a9fefc6cc1c1115bf27961551`
>
> **Correction branch:** `correction/gate5b-lastinsertrowid-normalization-v1`

## 1. Owner authorization and narrow scope

The project owner authorized reopening Gate 5B only far enough to resolve one executable contradiction:

- the existing runtime-neutral `SqlResult` contract requires `lastInsertRowid` to be the inserted row identity when the executed statement inserted a row, otherwise `null`;
- the Node development/test adapter was forwarding `node:sqlite`'s connection-level `lastInsertRowid` value for every `StatementSync.run()` result;
- after a prior INSERT, later UPDATE/DELETE/no-op INSERT statements could therefore expose a stale numeric rowid.

This correction does **not** authorize changing the contract to match `node:sqlite`, redesigning `SqlAdapter`, changing domain services, changing schema/bootstrap semantics, or starting Gate 6B.

## 2. Authoritative existing contract

`src/bootstrap/adapter.ts` remains unchanged. Its adopted semantics are:

```ts
interface SqlResult {
    changes: number;
    // last insert rowid when the statement inserted a row, else null
    lastInsertRowid: number | null;
}
```

The correction changes the Node development/test implementation to conform to that contract; it does not change the contract.

## 3. Executable reproduction before correction

A temporary review-only GitHub Actions probe used Node `v22.23.2` and the real, unmodified `NodeSqliteAdapter` from governing `main`. Before running the probe it verified that these files were byte-identical to base `25cd1ed...`:

- `dev/node-sqlite-adapter.ts`
- `src/bootstrap/adapter.ts`
- `tests/gate5b_regression.ts`

Preserved pre-correction runs:

- run `34359042757`, tested commit `5d88533f7c4a79f2b0a96c18cc5e56f56725ed7e` — SUCCESS (probe workflow only differed from `main`);
- run `34359244908`, tested commit `978d31126ca32f4ce977aa3dbccd7176eb4d9d85` — SUCCESS, with expanded SQL-shape inventory.

Exact observed values:

```text
INSERT1                  {"changes":1,"lastInsertRowid":1}
UPDATE                   {"changes":1,"lastInsertRowid":1}
ZERO_UPDATE              {"changes":0,"lastInsertRowid":1}
DELETE                   {"changes":1,"lastInsertRowid":1}
INSERT2                  {"changes":1,"lastInsertRowid":1}
INSERT_OR_IGNORE_NOOP    {"changes":0,"lastInsertRowid":1}
```

The first INSERT is correct. UPDATE, zero-match UPDATE, DELETE, and the ignored INSERT all expose stale connection state and violate the adopted `SqlResult` contract.

The second INSERT reuses rowid `1` in this synthetic table because the first row was deleted and the table did not use `AUTOINCREMENT`; that is valid SQLite behavior and is not part of the defect.

## 4. Root cause

`node:sqlite` reports `StatementSync.run().lastInsertRowid` from SQLite's connection-level last-insert-rowid state. That state is not reset by UPDATE or DELETE and is not evidence that the current statement inserted a row.

The previous adapter normalized the numeric type but did not normalize the **meaning** of the field. It therefore leaked a prior INSERT's rowid through later non-insert `SqlResult` objects.

## 5. Repository SQL-shape audit

Before choosing the implementation technique, the correction inventoried every runtime `SqlAdapter.run(...)` call site and every production consumer of `lastInsertRowid` under `src/bootstrap` and `src/application`.

### 5.1 Identity consumers

Production `lastInsertRowid` consumers occur only after identity-creating INSERTs, including:

- bootstrap definition creation;
- Visit creation;
- inspected-subject creation;
- Finding creation in initial disposition/corrections/observation accounting;
- CorrectiveAction creation;
- AdHocObservation creation.

No production consumer relies on stale rowid behavior from UPDATE or DELETE.

### 5.2 Authoritative INSERT shapes

The runtime audit found top-level plain `INSERT INTO ...` statements in:

- `src/bootstrap/loader.ts`;
- `src/application/initial-disposition.ts`;
- `src/application/corrective-action-status.ts`;
- `src/application/corrective-action-create.ts`;
- `src/application/visit-scope.ts`;
- `src/application/corrections.ts`;
- `src/application/observation-create.ts`;
- `src/application/observation-finding.ts`;
- `src/application/finding-status.ts`.

The audit found **no authoritative runtime use** of:

- `INSERT OR IGNORE`;
- `INSERT ... ON CONFLICT ...`;
- `REPLACE`;
- `WITH ... INSERT`;
- SQL comments before an identity-producing INSERT.

Runtime non-insert writes are ordinary top-level UPDATE/DELETE statements. The dynamic correction SQL at `src/application/corrections.ts` is built from UPDATE shapes, not from hidden INSERT variants.

The review-only regression nevertheless includes `INSERT OR IGNORE` as an adversarial no-op case because it is a narrow way to prove that `changes === 0` prevents stale identity leakage.

## 6. Minimal implementation technique

`dev/node-sqlite-adapter.ts` now:

1. prepares the statement exactly as before;
2. executes it exactly as before;
3. preserves the existing `changes` normalization unchanged;
4. uses the prepared statement's `sourceSQL` to recognize the audited top-level `INSERT` shape (`/^\s*INSERT\b/i`);
5. exposes a numeric `lastInsertRowid` only when the statement is such an INSERT **and** `changes > 0`;
6. returns `lastInsertRowid: null` otherwise.

This is intentionally **not** a general SQL parser. It is the smallest implementation that is correct for every authoritative `run(...)` SQL shape currently present in the repository. If a future Gate introduces CTE-wrapped INSERTs, UPSERT update branches, or another identity-producing SQL form, that new SQL shape must be reviewed deliberately rather than silently relying on this v1 classifier.

The `changes > 0` gate is necessary because SQLite can leave the previous connection rowid visible when an INSERT form performs no insertion, as demonstrated by the `INSERT OR IGNORE` reproduction.

## 7. Regression coverage

A focused seam regression was added as:

`tests/gate5b_adapter_regression.ts`

It is separate from `tests/gate5b_regression.ts` because the latter is the large bootstrap/reference-data authority while this correction tests the Node Gate-5B adapter seam itself. Keeping the seam regression separate avoids mixing adapter mechanics into bootstrap artifact tests and preserves the existing Gate-5B bootstrap count.

The new suite uses the real `NodeSqliteAdapter` and proves:

1. INSERT returns `changes === 1` and a numeric rowid that identifies the inserted row;
2. a following successful UPDATE returns `lastInsertRowid === null`;
3. zero-match UPDATE returns `changes === 0` and `lastInsertRowid === null`;
4. DELETE returns `lastInsertRowid === null`;
5. a later INSERT after UPDATE/DELETE still returns its own usable identity;
6. `INSERT OR IGNORE` with no insertion returns `changes === 0` and `lastInsertRowid === null`.

Against the pre-correction adapter, cases 2, 3, 4, and 6 reproduce the defect.

## 8. GitHub Actions validation after correction

Temporary review-only workflow run:

- run `34359830705`;
- tested commit: `6a4b1dddf8426bb1a2a43520d5c41f7b3be4a363`;
- Node: `v22.23.2`;
- Python: `3.12.14`;
- conclusion: **SUCCESS**.

Observed results:

| Suite | Result |
|---|---:|
| Gate 5B adapter normalization | **6 / 0** |
| Gate 5B bootstrap/reference data | **32 / 0** |
| Gate 5C | **55 / 0** |
| Gate 5D | **60 / 0** |
| Gate 5E | **79 / 0** |
| Gate 5F | **30 / 0** |
| Gate 5G | **41 / 0** |
| Gate 5H | **66 / 0** |
| Gate 5I | **48 / 0** |
| Gate 5J | **75 / 0** |
| Gate 5K | **82 / 0** |
| Gate 5L | **94 / 0** |
| Schema | **100 / 0** |

The same run re-audited runtime INSERT shapes, ran `git diff --check` against the governing base, rejected unexpected correction paths, and verified no diff in:

- `src/bootstrap/adapter.ts`;
- `docs/schema/schema.sql`;
- `bootstrap/`;
- `src/application/`.

## 9. Adversarial self-review

The correction specifically attempted to disprove itself:

- **Can UPDATE leak an old INSERT rowid?** No; focused regression case 2 returns `null`.
- **Can zero-match UPDATE leak it?** No; case 3 returns `changes=0`, `lastInsertRowid=null`.
- **Can DELETE leak it?** No; case 4 returns `null`.
- **Can a zero-change INSERT form leak it?** No; `INSERT OR IGNORE` case 6 returns `changes=0`, `lastInsertRowid=null`.
- **Does the fix suppress ordinary valid INSERT identities?** No; cases 1 and 5 return numeric identities that are verified against durable rows.
- **Does leading whitespace in the repository's template-string style break INSERT recognition?** No; case 1 deliberately uses leading whitespace/newline before `INSERT` and passes.
- **Does the fix change affected-row normalization?** No; the existing `changes` conversion is unchanged, and all focused/higher-Gate guarded-write suites remain green.
- **Does it alter explicit transaction behavior?** No transaction method changed; Gates 5C→5L all remain green.
- **Does any production consumer rely on stale non-insert rowids?** The runtime audit found no such consumer; identity consumers follow INSERT statements.
- **Did any higher Gate baseline change unexpectedly?** No; every Gate 5C→5L count is unchanged with zero failures.
- **Could an unreviewed complex future UPSERT shape require different semantics?** Yes. Such shapes are absent from current authoritative runtime code; supporting them would require a future scoped review rather than broadening this correction into a SQL parser.

## 10. Contract/domain/schema boundary

This correction made no semantic change to `SqlAdapter` or `SqlResult`.

It made no change to:

- `src/bootstrap/adapter.ts`;
- `src/application/**`;
- `docs/schema/schema.sql`;
- bootstrap artifacts/generator/editorial data;
- Gate 5C→5L implementations;
- `docs/architecture/DEVICE-ADAPTER-CONTRACT-v1.md`;
- Android/Capacitor/plugin code.

No HNT-001 experimental qualification implementation or HNT-002 reproducer was incorporated.

## 11. Gate state

Gate 5B remains historically **CLOSED**, with this explicit owner-authorized narrow correction record attached to it.

The pre-Gate-6B `lastInsertRowid` contradiction is **RESOLVED by this correction**, subject to the normal independent review/owner approval/PR-to-main path.

Gate 6B remains the next product Gate and remains:

**NOT_STARTED**

This correction does not start Gate 6B.
