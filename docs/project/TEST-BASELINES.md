# TEST BASELINES — Inspection_Mission_001

> **الغرض:** آخر regression baselines المعتمدة التي يجب أن تبقى خضراء عند مواصلة المشروع. هذه الأرقام ليست بديلًا عن CI status حي.

## 1) Adopted baselines

Gate 6B مغلقة/مدمجة ولا تعيد كتابة Application Core. suites الخاصة بها أصبحت جزءًا من baselines التاريخية المعتمدة:

| Suite | Passed | Failed |
|---|---:|---:|
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

Q12 host suite لا تدّعي lock proof على Android؛ الـdevice lock proof هو التشغيل الفيزيائي المقبول على `87135cfe80ae3de79a34e941828249fc6889139c`، وقد أسهم مع بقية evidence المقبولة في إغلاق Gate 6B عبر PR #17 / merge `0905c6111269d62480e7ccadc31786bef29f3c51`.

## 2) ملفات suites الحاكمة

```text
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

Gate 6C-B suite files are now part of the adopted regression surface after PR #21 merged at `7418df4fc03b9b6017cbeb588eb6ae76bd560be2`.

## 3) أوامر التشغيل المرجعية

```bash
npm run typecheck
npm run typecheck:gate6c
npm run gate6c:host
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

Gate 6C is **`IN_PROGRESS`**. Gate 6C-A and Gate 6C-B are **`CLOSED / MERGED`**. Gate 6C-C is **`NEXT / NOT_STARTED`**.

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

**85 / 0 is now the adopted Gate-6C-B regression baseline.**

## 10) قاعدة عدم الإضعاف والحالة الحالية

لا يجوز حذف test صحيحة أو خفض semantics سابقة لتجاوز failure.

Gate 6B: **`CLOSED / MERGED`** عبر PR #17 / merge `0905c6111269d62480e7ccadc31786bef29f3c51`.

Q12: `PHYSICAL_PASS_REVIEW_ACCEPTED`.

`@capacitor-community/sqlite@8.1.1`: `ADOPTED_BY_CLOSED_GATE6B`.

Gate 6C: **`IN_PROGRESS`**.

Gate 6C-A: **`CLOSED / MERGED`**.

Gate 6C-B: **`CLOSED / MERGED`** عبر PR #21 / merge `7418df4fc03b9b6017cbeb588eb6ae76bd560be2`.

Gate 6C-C: **`NEXT / NOT_STARTED`**.

Gate 6C-D / Gate 6D: **`NOT_STARTED`**.
