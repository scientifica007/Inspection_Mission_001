# TEST BASELINES — Inspection_Mission_001

> **الغرض:** آخر regression baselines المعتمدة التي يجب أن تبقى خضراء عند مواصلة المشروع. هذه الأرقام ليست بديلًا عن CI status حي.

## 1) Gate 6B current expectation

Gate 6B لا تعيد كتابة Application Core. أضيفت ثلاث suites خاصة بالـGate إلى baselines التاريخية:

| Suite | Passed | Failed |
|---|---:|---:|
| Gate 6B host adapter contract | 16 | 0 |
| Gate 6B canonical-schema execution | 8 | 0 |
| Gate 6B Q12 classifier/orchestration decision | 13 | 0 |
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

الـQ12 host suite لا تدّعي lock proof على Android. هي تمنع false-positive classification فقط. Q12 PASS لا يمكن إثباتها إلا بتشغيل APK على جهاز Android فعلي.

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

ويثبت تحديدًا أن الحالات التالية لا يمكن أن تتحول إلى PASS:

- generic native error؛
- same-file mismatch؛
- preflight failure؛
- competing write succeeds while A owns lock؛
- locked marker visible؛
- post-release write/cardinality failure؛
- engine mismatch؛
- nonzero/unexpected busy policy؛
- native resource or marker cleanup failure.

## 5) قاعدة عدم الإضعاف

لا يجوز حذف test صحيحة أو خفض semantics سابقة لتجاوز failure. أي contradiction حقيقية في Q12 يجب أن تبقى FAIL/BLOCKED وفق contract، لا أن تُعاد صياغة `BEGIN IMMEDIATE` أو primary adapter لتناسب الاختبار.

Gate 6B تبقى `IN_PROGRESS`; physical evidence السابقة على SHA `89d405d...` محفوظة، وQ12 الجديدة تحتاج physical Adapter Qualification على APK الجديد.
