# TEST BASELINES — Inspection_Mission_001

> **الغرض:** آخر regression baselines المعتمدة التي يجب أن تبقى خضراء عند مواصلة المشروع. هذه الأرقام ليست بديلًا عن CI status حي.

## 1) Gate 6B current expectation

Gate 6B لا تعيد كتابة Application Core. أضيفت suites خاصة بالـGate إلى baselines التاريخية:

| Suite | Passed | Failed |
|---|---:|---:|
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

Q12 host suite لا تدّعي lock proof على Android؛ هي تمنع false-positive classification وتثبت سلامة diagnostic transport/source invariants. الـdevice lock proof أصبح موجودًا الآن بصورة مستقلة من تشغيل Android الفعلي المقبول على `87135cfe...`.

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

## 3) أوامر التشغيل المرجعية

```bash
npm run typecheck
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

Android Gate-6B CI additionally يجب أن ينجح في:

- Vite production build؛
- Capacitor Android sync؛
- dependency assertion بأن resolved `net.zetetic:sqlcipher-android` الوحيد هو `4.17.0`؛
- Gradle `assembleDebug`؛
- no-Node/no-Capacitor imports في `src/application` و`src/bootstrap`؛
- no drift في `src/application`, `src/bootstrap`, `docs/schema/schema.sql`, `bootstrap/v1/checklist-v1.json`؛
- `git diff --check`؛
- debug APK upload.

## 4) Q12 adversarial baseline

`tests/gate6b_q12_regression.ts` يثبت أن PASS لا تصدر إلا إذا تحققت كل الشروط: same physical file، same native engine/version، preflight write/readback، primary BEGIN IMMEDIATE، native BUSY/LOCKED أثناء lock، locked marker count=0، release طبيعي، same write succeeds after release، post-release count=1، cleanup complete، native close complete.

ويثبت تحديدًا أن:

- generic native error يبقى BLOCKED؛
- post-open same-file mismatch يبقى FAIL؛
- preflight failure لا يمكن أن PASS؛
- competing write success أثناء lock = FAIL؛
- locked marker visibility = FAIL؛
- post-release write/cardinality failure = FAIL؛
- engine mismatch / unexpected busy policy / cleanup failure لا يمكن أن PASS؛
- `Error.name` و`Error.message` محفوظان، وCapacitor `code` وnative `stage/exceptionClass/exceptionMessage` تُحفظ عند توفرها؛
- native-open failure يظل BLOCKED؛
- BUSY وLOCKED فقط هما during-lock outcomes المقبولان لمسار PASS؛
- Java source يحتوي stages التشخيصية التسع؛
- `LinkageError` يُعالج صراحةً ولا يوجد `catch(Throwable)`؛
- `PRAGMA busy_timeout = 0;` لا يُنقل عبر `execSQL`؛
- busy-timeout setter يستخدم `scalarLong()` → `rawQuery()` ويقرأ الصف المعاد؛
- setter-returned value وreadback مستقل كلاهما ملزمان بقيمة `0`.

## 5) accepted physical Q12 evidence

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

إذًا differential native locking requirement مثبت فيزيائيًا، وليس بواسطة host classifier أو Promise timing.

Q8 في التشغيل نفسه: PASS — 15 tables / 44 triggers / 1 view / 24 indexes / `integrity_check=ok`.

Q9 في التشغيل نفسه: PASS — 24 definitions / second bootstrap 24 no-ops / P0=20 / P1=4 / allowed_values=48.

## 6) historical Q12 evidence remains historical

تشغيل `7ebe780b1caffeb1a9240ff4010e5483e1c70b7b` يبقى Q12=`BLOCKED` عند `native_open/set_busy_timeout` بسبب transport defect المثبت. لا يعاد تصنيفه بعد نجاح `87135cfe...`.

تشغيل `c3cc890...` يبقى BLOCKED عند `native_open` مع diagnostics غير كافية لتحديد السبب في ذلك الوقت. pre-correction Q8 failure وrestart negative control يبقيان محفوظين كذلك.

## 7) evidence reuse decision

Application-Core Proof وfinal real Force Stop/Restart evidence من `89d405d6254108ce735125638ccdb2fb2e67c568` تبقى مقبولة ولا تعاد، لأن المسارات التالية لم تنحرف حتى `87135cfe...`:

- `src/application/**`;
- `src/bootstrap/**`;
- `src/device/capacitor-sqlite-adapter.ts`;
- `docs/schema/schema.sql`;
- `bootstrap/v1/checklist-v1.json`.

هذا evidence reuse based on non-drift؛ **لا** يعني أن APK `89d` وAPK `871` نفس binary.

## 8) canonical hashes

```text
docs/schema/schema.sql
c9c8682ec721b5c24ef3950c49f5a5c402f053d99aa88c617dfd7fe8a7c19ba7

bootstrap/v1/checklist-v1.json
d43fe2b928116c71ab9b53653d71f832086e8cb01ba817ecac0a17562d3404fd
```

## 9) قاعدة عدم الإضعاف والحالة الحالية

لا يجوز حذف test صحيحة أو خفض semantics سابقة لتجاوز failure. أي contradiction حقيقية في Q12 يجب أن تبقى FAIL/BLOCKED وفق contract.

Gate 6B: `IN_PROGRESS / PHYSICAL_QUALIFICATION_PASS_PENDING_PR_MERGE`.

Q12: `PHYSICAL_PASS_REVIEW_ACCEPTED`.

`closure_authorized=false`.

Gate 6C: `NOT_STARTED`.

لا يوجد physical retest جديد مطلوب بموجب evidence المقبولة الحالية.
