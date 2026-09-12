# TEST BASELINES — Inspection_Mission_001

> **الغرض:** آخر regression baselines المعتمدة التي يجب أن تبقى خضراء عند مواصلة المشروع. هذه الأرقام ليست بديلًا عن CI status حي.

## 1) Adopted baselines

Gate 6B وGate 6C-B وGate 6C-C أُغلقت/دُمجت في نطاقاتها المعتمدة. Gate 6C-D وGate 6C أُغلقتا لاحقًا بقرار Project Owner توثيقي/حوكمي؛ هذا لا يحوّل physical qualification outcomes إلى repeatable host baselines. الـrepeatable host suites التالية أصبحت جزءًا من baselines التاريخية المعتمدة:

| Suite | Passed | Failed |
|---|---:|---:|
| Gate 6C-C device adapter host regression | 14 | 0 |
| Gate 6C-C restored-result host regression | 11 | 0 |
| Gate 6C-C Filesystem rejection guard | 4 | 0 |
| Gate 6C-B Evidence host regression | 85 | 0 |
| Gate 6B host adapter contract | 16 | 0 |
| Gate 6B canonical-schema execution | 8 | 0 |
| Gate 6B Q12 diagnostic/classifier | 20 | 0 |
| Gate 5L | 94 | 0 |
| Gate 5K | 82 | 0 |
| Gate 5J | 75 | 0 |
| Gate 5I | 48 | 0 |
| Gate 5H | 66 | 0 |
| Gate 5G | 41 | 0 |
| Gate 5F | 30 | 0 |
| Gate 5E | 79 | 0 |
| Gate 5D | 60 | 0 |
| Gate 5C | 55 | 0 |
| Gate 5B bootstrap/reference-data | 32 | 0 |
| Gate 5B adapter normalization | 6 | 0 |
| Schema | 100 | 0 |

إجمالي Gate 5B عبر suite الأصلية + suite التصحيح الضيق = **38 / 0**، مع بقاء العدّين منفصلين.

نتائج Gate 6C-C native API24/API35 وfull-integration API24/API35 موثقة أدناه كـqualification evidence، وليست ordinary host regression baselines.

Q12 host suite لا تدّعي lock proof على Android؛ الـdevice lock proof هو التشغيل الفيزيائي المقبول على `87135cfe80ae3de79a34e941828249fc6889139c`، وقد أسهم مع بقية evidence المقبولة في إغلاق Gate 6B عبر PR #17 / merge `0905c6111269d62480e7ccadc31786bef29f3c51`.

## 2) ملفات suites الحاكمة

```text
tests/gate6c_c_device_adapter_regression.ts
tests/gate6c_c_restored_result_regression.ts
tests/gate6c_c_filesystem_candidate_spike.ts
tests/gate6b_adapter_contract.ts
tests/gate6b_schema_execution_regression.ts
tests/gate6b_q12_regression.ts
tests/gate5b_adapter_regression.ts
tests/gate5b_regression.ts
tests/gate5c_regression.ts
tests/gate5d_regression.ts
tests/gate5e_regression.ts
tests/gate5f_regression.ts
tests/gate5g_regression.ts
tests/gate5h_regression.ts
tests/gate5i_regression.ts
tests/gate5j_regression.ts
tests/gate5k_regression.ts
tests/gate5l_regression.ts
tests/gate4a_regression.py
```

Gate 6C-B suite files remain part of the adopted regression surface after PR #21 merged at `7418df4fc03b9b6017cbeb588eb6ae76bd560be2`.

Gate 6C-C repeatable host suites became adopted after PR #23 merged at `f221b215358f83dce381ac5261a856a7de4e5c98`.

## 3) أوامر التشغيل المرجعية

```bash
npm run typecheck
npm run typecheck:gate6c
npm run gate6c:host
npx tsx tests/gate6c_c_device_adapter_regression.ts
npx tsx tests/gate6c_c_restored_result_regression.ts
npx tsx tests/gate6c_c_filesystem_candidate_spike.ts
npm run gate6b:host
npm run gate6b:schema-host
npm run gate6b:q12-host
node tests/gate5b_adapter_regression.ts
node tests/gate5b_regression.ts
node tests/gate5c_regression.ts
node tests/gate5d_regression.ts
node tests/gate5e_regression.ts
node tests/gate5f_regression.ts
node tests/gate5g_regression.ts
node tests/gate5h_regression.ts
node tests/gate5i_regression.ts
node tests/gate5j_regression.ts
node tests/gate5k_regression.ts
node tests/gate5l_regression.ts
python3 tests/gate4a_regression.py
```

Gate-6B CI baseline تشمل كذلك Vite production build، Capacitor Android sync، single resolved `net.zetetic:sqlcipher-android:4.17.0`, Gradle `assembleDebug`, no-Node/no-Capacitor imports في runtime-neutral core، no drift في `src/application`, `src/bootstrap`, canonical schema/bootstrap، و`git diff --check`.

## 4) Q12 adversarial baseline

`tests/gate6b_q12_regression.ts` يثبت أن PASS لا تصدر إلا إذا تحققت كل الشروط: same physical file، same native engine/version، preflight write/readback، primary BEGIN IMMEDIATE، native BUSY/LOCKED أثناء lock، locked marker count=0، release طبيعي، same write succeeds after release، post-release count=1، cleanup complete، native close complete.

ويثبت أن generic native error يبقى BLOCKED، post-open same-file mismatch يبقى FAIL، competing-write success أثناء lock = FAIL، BUSY/LOCKED فقط مقبولان لمسار PASS، busy timeout setter/readback كلاهما صفر، ولا يوجد Promise timing بديل عن native lock outcome.

## 5) Accepted physical Q12 evidence

Adapter Qualification حقيقية على Android عند:

`87135cfe80ae3de79a34e941828249fc6889139c`

External evidence:

`https://drive.google.com/drive/folders/18siSZGeoUtmFsfz5H4ozKsrp3tbpVwkS?usp=drive_link`

أعادت `overallResult=PASS`, Q1→Q11 PASS، وQ12 PASS مع:

```text
samePhysicalFile=true
databaseBasename=inspection_gate6b_adapter_probe_v1SQLite.db
nativeEngine=sqlcipher-android-4.17.0
preflightWrite=SUCCESS
preflightMarkerCount=1
primaryBeginImmediate=true
duringPrimaryLock=BUSY/android.database.sqlite.SQLiteDatabaseLockedException/code=5
busyTimeoutMs=0
lockedMarkerCount=0
primaryRelease=true
postReleaseWrite=SUCCESS
postReleaseMarkerCount=1
cleanupComplete=true
nativeClosed=true
```

Q8: PASS — 15 tables / 44 triggers / 1 view / 24 indexes / `integrity_check=ok`.

Q9: PASS — 24 definitions / second bootstrap 24 no-ops / P0=20 / P1=4 / allowed_values=48.

## 6) Historical evidence remains historical

- `5a642ac...`: pre-correction Q8 failure remains FAIL history.
- `89d405d...`: Q12 BLOCKED history remains BLOCKED؛ Application-Core/restart PASS evidence remains accepted separately.
- `c3cc890...`: Q12 BLOCKED at `native_open` with insufficient diagnostics remains history.
- `7ebe780...`: Q12 BLOCKED at `native_open/set_busy_timeout` due confirmed PRAGMA transport defect remains history.
- restart negative control remains negative evidence, not a product defect.

## 7) Evidence reuse decision

Application-Core Proof وfinal real Force Stop/Restart evidence من `89d405d6254108ce735125638ccdb2fb2e67c568` تبقى مقبولة لأن `src/application/**`, `src/bootstrap/**`, primary `CapacitorSqliteAdapter`, canonical schema وcanonical bootstrap لم تنحرف حتى `87135cfe...`.

هذا evidence reuse based on non-drift؛ **`same_binary=false`** بين APK `89d` وAPK `871`.

## 8) Canonical hashes

```text
docs/schema/schema.sql
c9c8682ec721b5c24ef3950c49f5a5c402f053d99aa88c617dfd7fe8a7c19ba7

bootstrap/v1/checklist-v1.json
d43fe2b928116c71ab9b53653d71f832086e8cb01ba817ecac0a17562d3404fd
```

## 9) Gate 6C-B adopted baseline and closure evidence

Gate 6C-B provenance:

- branch: `implementation/gate6c-b-evidence-orchestration-v1`;
- governing base: `953610be8815725bb55bbdc62ac2ca375ee4ffa3`;
- initial implementation checkpoint: `64b424670ea4384b7e9d6c01eea952c201a573d7`;
- corrected executable validation SHA: `dadf4d90a10d7348fea0543c1885ecf5b0846578`;
- corrected executable GitHub Actions run: `34483510338` — **SUCCESS**;
- final reviewed head: `ea88fac83d60b99b7d50828915173d3aa14bb5d6`;
- final-head GitHub Actions run: `34484231771` — **SUCCESS**;
- independent PR-review verdict: **`MERGE-READY`**;
- Project Owner explicitly approved merge;
- PR: `#21`;
- merge SHA: `7418df4fc03b9b6017cbeb588eb6ae76bd560be2`;
- Gate-6C-B host regression: **85 / 0**;
- Gate-6C-B typecheck: PASS;
- production build: PASS;
- canonical hash, runtime-neutrality, historical regression, no-drift, dependency-set, synthetic-only, and `git diff --check` guards: PASS.

**85 / 0 remains the adopted Gate-6C-B regression baseline.**

## 10) Gate 6C-C adopted closure evidence

Gate 6C is **`CLOSED`**. Gate 6C-A, Gate 6C-B, Gate 6C-C and Gate 6C-D are **`CLOSED`** in their recorded scopes. Gate 6D is **`NEXT / NOT_STARTED`**.

Gate 6C-C provenance:

- implementation branch: `implementation/gate6c-c-android-evidence-adapters-v1`;
- governing base: `976b48106824f84f0dbbbca82832cbad4e53afb7`;
- final reviewed head: `9de6c69eef90c490319c02eac48d236482597210`;
- final-head qualification run: `34531511138` — **SUCCESS**;
- independent PR-review verdict: **`MERGE_READY`**;
- Project Owner merge approval: **true**;
- PR: `#23`;
- merge SHA: `f221b215358f83dce381ac5261a856a7de4e5c98`;
- evidence classification: **`ADOPTED_BY_CLOSED_GATE6C_C`**;
- closure status: **`CLOSED_MERGED`**.

Adopted repeatable host regression suites:

- `Gate 6C-C device adapter host regression`: **14 / 0** (`tests/gate6c_c_device_adapter_regression.ts`);
- `Gate 6C-C restored-result host regression`: **11 / 0** (`tests/gate6c_c_restored_result_regression.ts`);
- `Gate 6C-C Filesystem rejection guard`: **4 / 0** (`tests/gate6c_c_filesystem_candidate_spike.ts`).

Qualification evidence — explicitly not ordinary host regressions:

- Native Evidence API24: **18 / 0**;
- Native Evidence API35: **18 / 0**;
- Full Evidence integration API24: **2 / 0**;
- Full Evidence integration API35: **2 / 0**.

Final APK provenance:

- Artifact ID: `10173762572`;
- Artifact name: `gate6c-c-final-debug-apk-9de6c69eef90c490319c02eac48d236482597210`;
- actual `app-debug.apk` SHA-256: `da98c8437619a9e93d0d28df5bb1e2b20bf0d2f20120600e0bbbff10a40e9112`;
- GitHub artifact ZIP SHA-256: `2718aa9309b69fad63c8054ef6d941f13c63821991382b83513d72aa1af6dded`.

The APK SHA-256 and GitHub artifact ZIP SHA-256 are separate provenance values and must not be conflated.

## 11) قاعدة عدم الإضعاف والحالة الحالية

لا يجوز حذف test صحيحة أو خفض semantics سابقة لتجاوز failure.

Gate 6B: **`CLOSED / MERGED`** عبر PR #17 / merge `0905c6111269d62480e7ccadc31786bef29f3c51`.

Q12: `PHYSICAL_PASS_REVIEW_ACCEPTED`.

`@capacitor-community/sqlite@8.1.1`: `ADOPTED_BY_CLOSED_GATE6B`.

Gate 6C: **`CLOSED`**.

Gate 6C-A: **`CLOSED / MERGED`**.

Gate 6C-B: **`CLOSED / MERGED`** عبر PR #21 / merge `7418df4fc03b9b6017cbeb588eb6ae76bd560be2`.

Gate 6C-C: **`CLOSED / MERGED`** عبر PR #23 / merge `f221b215358f83dce381ac5261a856a7de4e5c98`.

Gate 6C-D: **`CLOSED`** by Project Owner decision dated 2026-09-12. Closure is `OWNER_AUTHORIZED_WITH_Q01_DOCUMENTED_NON_BLOCKING_RESIDUAL_RISK`; it is not an all-scenarios physical-PASS claim.

Gate 6D: **`NEXT / NOT_STARTED`**; `gate6d_started=false`.

`field_usable_v1=false`.

## 12) Gate 6C-D physical qualification evidence — not host baselines

These are physical qualification outcomes, not repeatable host regression baseline counts. Historical FAIL/BLOCKED attempts remain historical.

- Q01: `NO_PASS / BLOCKED_ON_CURRENT_PHYSICAL_ENVIRONMENT`; `physical_pass_claimed=false`; no established product defect or impossibility; current physical-event root cause remains `UNKNOWN / UNESTABLISHED`. Project Owner accepts it as `DOCUMENTED_NON_BLOCKING_PHYSICAL_QUALIFICATION_RESIDUAL_RISK / OWNER_WAIVER_FOR_GATE6C_D_CLOSURE`. The waiver does not establish correctness of the uninterrupted normal-Camera-return path and does not convert Q01 to PASS. Requalify Q01 if a suitable non-blocked physical environment/device becomes available or if Camera acquisition behavior/material implementation changes; that trigger does not automatically reopen Gate 6C-D.
- Q02: PHYSICAL PASS.
- Q03: PHYSICAL PASS.
- Q04: PHYSICAL PASS.
- Q05: `NOT_APPLICABLE_UNDER_CURRENT_PRODUCTION_MANIFEST` by Project Owner disposition; not a physical PASS.
- Q06: PHYSICAL PASS — `E_EVIDENCE_SOURCE_UNAVAILABLE`, rows `1 → 1`, zero Evidence-row delta.
- Q07: PHYSICAL PASS.
- Q08: STRICT PHYSICAL PASS after explicit force-stop/relaunch and reconciliation.
- Q09: PHYSICAL PASS — orphan removal behavior accepted.
- Q10: PHYSICAL PASS — broken storage reference retained/fails closed.
- Q11: PHYSICAL PASS — 40 MiB / `41943040` bytes, hash `MATCH`, resolve `RESOLVED`.
- Q12: PHYSICAL PASS for `REAL_DEVICE_WRITE_FAILURE` only; `enospcProven=false`, rows `1 → 1`, zero Evidence-row delta.
- Q13: STRICT PHYSICAL PASS after an independent explicit force-stop/relaunch.
- Literal `REAL_DEVICE_ENOSPC`: `DOCUMENTED_RESIDUAL_GAP / NON_BLOCKING_OWNER_WAIVER`; it is not an ENOSPC PASS.

Gate 6C-D is `CLOSED` by owner-authorized closure disposition; Gate 6C is `CLOSED`; Gate 6D is `NEXT / NOT_STARTED`; `field_usable_v1=false`.
