# Gate 6B — Android Canonical Schema Execution Correction v1

> **Gate status:** `CLOSED / MERGED`
>
> **Implementation branch:** `implementation/gate6b-android-runtime-proof-v1`
>
> **Reviewed branch head:** `04dcf001e5494c38258c7112619ea1d508af694c`
>
> **PR / merge:** `#17` / `0905c6111269d62480e7ccadc31786bef29f3c51`
>
> **Physical failing build SHA:** `5a642ac73ddaac1df5a49840e2ea4c4c49aae6dc`
>
> **Corrected physical build SHA:** `89d405d6254108ce735125638ccdb2fb2e67c568`
>
> **Final physical qualification target:** `87135cfe80ae3de79a34e941828249fc6889139c`
>
> **Classification:** device-found correction inside Gate 6B; not a new Gate or closed-Gate reopen.

## 1. Physical failure that triggered the correction

A real Android phone ran **Run Adapter Qualification** against `5a642ac...` with package `com.scientifica.inspection.gate6bproof`, Capacitor `8.5.1`, plugin `@capacitor-community/sqlite@8.1.1`, actual SQLite engine `3.53.3`, schema SHA `c9c8682ec721b5c24ef3950c49f5a5c402f053d99aa88c617dfd7fe8a7c19ba7`, bootstrap SHA `d43fe2b928116c71ab9b53653d71f832086e8cb01ba817ecac0a17562d3404fd`.

Q1-Q7/Q10/Q11 PASS, Q12 BLOCKED, Q8 FAIL, Q9 not reached, overall FAIL. Exact Q8 error:

```text
Execute: not an error (code 0)
```

This remains preserved as physical-device evidence for the defective build.

## 2. Confirmed root cause

The pinned plugin release commit is `3f3f71606c8f292a3d6d841937bcfc5b5c45aeb5`.

On Android, `SQLiteDBConnection.execute()` input is processed by `UtilsSQLite.getStatementsArray()`, which splits on literal `;\n` and has only limited trigger repair. Multi-statement `CREATE TRIGGER ... BEGIN ... END` bodies such as `trg_mission_bu`, `trg_subject_bu`, `trg_visit_bu`, `trg_def_bi` are therefore fragmented. The plugin's later `Database.execute()` path is otherwise appropriate DDL execution because each resulting command goes to native `_db.execSQL(...)`.

The regression also demonstrated that the split occurs before comment cleanup, so raw `;\n` inside comments can create unwanted fragments.

## 3. Correction technique

The canonical authority remains exactly `docs/schema/schema.sql`; it was not edited.

The Gate-6B loader consumes exact canonical bytes, lexically segments complete SQLite statements, preserves complete trigger units including CASE expressions, transports each statement separately through `execute(..., false)`, neutralizes the plugin delimiter only in safe SQL regions, preserves quoted text/transaction semantics, and never creates a second schema authority.

`run()`/`executeSet()` were investigated but rejected for canonical DDL because Android routes their non-INSERT path through prepared update/delete execution rather than the plugin's DDL `execSQL` path.

## 4. Host regression

`tests/gate6b_schema_execution_regression.ts` baseline: **8 / 0**. It reproduces the actual v8.1.1 failure mode against exact canonical schema, proves exact SHA unchanged, proves all 44 triggers remain complete, executes corrected statements independently with SQLite, compares exact object-name sets and stored trigger bodies, and requires compact statement-index/object diagnostics.

Adopted result remains 15 tables / 44 triggers / 1 view / 24 explicit indexes.

## 5. Corrected physical device result

The replacement build `89d405d6254108ce735125638ccdb2fb2e67c568` was executed on a real Android phone. Adapter Qualification result was `BLOCKED` only because Q12 remained BLOCKED at that time. Q1-Q11 all PASS.

Q8 corrected device evidence: 15 tables, 44 triggers, 1 view, 24 explicit indexes, `integrity_check=ok`.

Q9 was reached and PASS: first load 24 definitions, second load 24 no-ops, P0=20, P1=4, allowed_values=48.

Thus the canonical-schema transport correction had direct physical-device confirmation on `89d405d...` before Gate 6B closure.

## 6. Subsequent physical evidence on `89d405d...`

Application-Core device proof: PASS, including Q8/Q9, existing T0/T1/T2/OBS-1/T7/T9/currentVisitState flow, T11 finalization, post-finalization mutation rejection and zero-write delta 0. State hash `9d7ab85b68ded94d02fc63e55d765f40f25f1d041e42a506ed7cb3b6cd52f405`.

Final clean restart sequence used a real Android Force Stop and no reset/uninstall/clear-data between phases:

- Phase A `2026-09-09T20:38:14.309Z`: `DEVICE_PROOF_READY`, visit=1, Q8/Q9/CORE_FLOW PASS, total_changes 121→121, same state hash;
- Phase B `2026-09-09T20:41:35.702Z`: PASS, Q8 reopen PASS, visit=1 rediscovered from SQLite markers, total_changes 0→0, identical state hash.

External Force Stop screenshots are retained by the owner and are intentionally not committed to GitHub.

An earlier negative-control Phase B after `Reset Synthetic Proof DB` failed because the durable database had been deleted; it remains negative evidence, not a defect.

## 7. Relationship to Q12 and final closure

The schema correction remained physically confirmed while Q12 continued through later diagnostic stages. Historical Q12 BLOCKED results on `89d405d...`, `c3cc890...`, and `7ebe780...` remain historical and are not rewritten.

The final physical Adapter Qualification on `87135cfe80ae3de79a34e941828249fc6889139c` passed Q1→Q12, including genuine independent-writer Q12. Application-Core/restart evidence from `89d405d...` remained accepted by demonstrated non-drift with **`same_binary=false`**.

Gate 6B subsequently closed via PR #17, reviewed branch head `04dcf001e5494c38258c7112619ea1d508af694c`, merge SHA `0905c6111269d62480e7ccadc31786bef29f3c51`.

Gate 6B is therefore **CLOSED / MERGED**. Gate 6C is **NEXT / NOT_STARTED**; this historical correction record does not start it.
