# TEST BASELINES — Inspection_Mission_001

> **الغرض:** تعريف آخر regression baselines المعتمدة التي يجب أن تبقى خضراء عند مواصلة المشروع.
>
> هذه الأرقام ليست CI status حيًا. هي **adopted baselines** يجب إعادة تشغيلها عندما يتطلب نطاق Gate ذلك.

## 1) مصدر baseline الحالي

آخر تحقق تنفيذي شامل قبل Gate 6A كان ضمن Gate 5L / PR #12، بعد التصحيح الضيق المعتمد في Gate 5E.

PR #12 سجل النتائج التالية قبل push/merge:

| Suite | Passed | Failed |
|---|---:|---:|
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
| Gate 5B | 32 | 0 |
| Schema | 100 | 0 |

Gate 6A غيّرت documentation/architecture فقط، ولم تغيّر source code أو tests أو schema، لذلك هذه هي baselines الحاكمة عند بدء Gate 6B.

## 2) ملفات suites الحاكمة

```text
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

## 3) أوامر التشغيل المرجعية على Ubuntu dev/test host

Application-core TypeScript suites:

```bash
node --experimental-strip-types tests/gate5l_regression.ts
node --experimental-strip-types tests/gate5k_regression.ts
node --experimental-strip-types tests/gate5j_regression.ts
node --experimental-strip-types tests/gate5i_regression.ts
node --experimental-strip-types tests/gate5h_regression.ts
node --experimental-strip-types tests/gate5g_regression.ts
node --experimental-strip-types tests/gate5f_regression.ts
node --experimental-strip-types tests/gate5e_regression.ts
node --experimental-strip-types tests/gate5d_regression.ts
node --experimental-strip-types tests/gate5c_regression.ts
node --experimental-strip-types tests/gate5b_regression.ts
```

Schema suite:

```bash
python3 tests/gate4a_regression.py
```

Repository hygiene عند Gate review:

```bash
git diff --check
git status --short
```

## 4) قاعدة عدم الإضعاف

Gate جديدة لا يجوز أن:

- تحذف test سابقة لتجاوز failure؛
- تخفض عدد الحالات المقبولة بلا قرار موثق؛
- تغير expected semantics لGate مغلقة لمجرد convenience؛
- تتجاهل regression failure بوصفه "غير متعلق" دون تحليل فعلي.

إذا تغيّر baseline بسبب owner-authorized correction أو Gate جديدة:

1. وثق السبب.
2. اذكر suites المتغيرة.
3. احتفظ بكل tests القديمة التي ما تزال صحيحة.
4. حدّث هذا الملف و`CURRENT-STATE.md/.json` بعد merge.

## 5) Gate 6B — minimum regression expectation

Gate 6B ستضيف device/native runtime proof، لكنها لا ينبغي أن تعيد كتابة Application Core.

الحد الأدنى المتوقع عند اعتمادها:

- focused Gate-6B adapter/device suite جديدة؛
- proof على Android حقيقي للـtransaction/persistence semantics؛
- Gate 5L baseline **94/0** على dev/test host تبقى خضراء؛
- كل Application Core baselines أعلاه لا تضعف؛
- schema **100/0** تبقى خضراء؛
- أي adapter-specific test لا يحل محل domain regression suites.

التفاصيل المعمارية في `docs/architecture/DEVICE-ADAPTER-CONTRACT-v1.md`.

## 6) ملاحظة حول العدّ

الأرقام أعلاه baseline adoption وليست هدفًا عدديًا في حد ذاته. يمكن أن يزيد عدد tests عند إضافة تغطية جديدة؛ المطلوب أن يبقى الفشل صفرًا وأن لا تُحذف assertions صحيحة لتخفيض العبء.
