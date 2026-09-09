# TEST BASELINES — Inspection_Mission_001

> **الغرض:** تعريف آخر regression baselines المعتمدة التي يجب أن تبقى خضراء عند مواصلة المشروع.
>
> هذه الأرقام ليست CI status حيًا. هي **adopted baselines** يجب إعادة تشغيلها عندما يتطلب نطاق Gate ذلك.

## 1) مصدر baseline الحالي

آخر تحقق تنفيذي شامل قبل Gate 6A كان ضمن Gate 5L / PR #12، بعد التصحيح الضيق المعتمد في Gate 5E. ثم أضاف التصحيح الضيق المصرح به من المالك لـGate 5B regression مستقلة لسلامة `SqlResult.lastInsertRowid` في `NodeSqliteAdapter`، مع إعادة تشغيل جميع baselines الأعلى.

Gate 6B أضافت host-side qualification مستقلة للـprovisional Capacitor SQLite adapter mapping ولـcanonical schema inventory parser. هذه suite **لا** تُعد physical-device evidence ولا تستبدل أي domain regression.

النتائج الحاكمة على فرع Gate 6B:

| Suite | Passed | Failed |
|---|---:|---:|
| Gate 6B host adapter contract | 16 | 0 |
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

إجمالي Gate 5B عبر suite الأصلية + suite التصحيح الضيق = **38 / 0**. يبقى العدّ منفصلًا لأن `tests/gate5b_regression.ts` تختبر bootstrap/reference-data بينما `tests/gate5b_adapter_regression.ts` تختبر seam الـNode adapter فقط.

دليل تصحيح Gate 5B محفوظ في:

`docs/application/GATE5B-LASTINSERTROWID-CORRECTION-v1.md`

دليل إعداد Gate 6B في:

`docs/architecture/GATE6B-ANDROID-RUNTIME-PROOF-v1.md`

## 2) ملفات suites الحاكمة

```text
tests/gate6b_adapter_contract.ts
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

## 3) أوامر التشغيل المرجعية على Ubuntu dev/test host

Gate-6B host adapter mapping + Gate-5B seam + Application-core TypeScript suites:

```bash
node --experimental-strip-types tests/gate6b_adapter_contract.ts
node --experimental-strip-types tests/gate5b_adapter_regression.ts
node --experimental-strip-types tests/gate5b_regression.ts
node --experimental-strip-types tests/gate5c_regression.ts
node --experimental-strip-types tests/gate5d_regression.ts
node --experimental-strip-types tests/gate5e_regression.ts
node --experimental-strip-types tests/gate5f_regression.ts
node --experimental-strip-types tests/gate5g_regression.ts
node --experimental-strip-types tests/gate5h_regression.ts
node --experimental-strip-types tests/gate5i_regression.ts
node --experimental-strip-types tests/gate5j_regression.ts
node --experimental-strip-types tests/gate5k_regression.ts
node --experimental-strip-types tests/gate5l_regression.ts
```

Schema suite:

```bash
python3 tests/gate4a_regression.py
```

Gate-6B runtime-layer typecheck:

```bash
npm run typecheck
```

Repository hygiene عند Gate review:

```bash
git diff --check
git status --short
```

ملاحظة: Gate-5B provenance regression داخل `tests/gate5b_regression.ts` تحتاج Git history كافية؛ في GitHub Actions استخدم `fetch-depth: 0`.

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
4. حدّث هذا الملف و`CURRENT-STATE.md/.json` بعد merge أو على feature branch عندما يلزم handoff دقيق أثناء Gate مفتوحة.

## 5) Gate 6B — current regression expectation

Gate 6B تضيف device/native runtime proof، لكنها لا تعيد كتابة Application Core.

الحد الأدنى الحالي:

- Gate-6B host adapter contract **16/0**؛
- physical Android proof يبقى مطلوبًا ولا يمكن استبداله بالـhost suite أو Android build؛
- Gate 5B adapter normalization **6/0** تبقى خضراء؛
- Gate 5B bootstrap/reference-data **32/0** تبقى خضراء؛
- Gate 5C→5L baselines كلها تبقى بلا إضعاف؛
- schema **100/0** تبقى خضراء؛
- Android diagnostic shell يبني debug APK؛
- أي adapter-specific test لا يحل محل domain regression suites.

### ملاحظة typecheck

إدخال full-repository `tsc` في Gate 6B كشف static-inference errors قديمة في بعض ملفات Application Core المغلقة، وهي ليست baseline سابقة للمشروع وتظهر مع TypeScript 5.9.3 وكذلك الإصدار الأحدث الذي جُرّب أولًا. لم تُفتح Gates 5 لمعالجة أداة جديدة.

لذلك Gate 6B تستخدم `tsconfig.gate6b.json` للتحقق الصارم من طبقة الجهاز/الـproof الجديدة والـadapter seam، بينما يحرس Application Core نفسها كامل Gate 5C→5L runtime regressions وVite integration build وstatic no-Node/no-Capacitor import checks. الأمر `typecheck:legacy-full` محفوظ فقط لتشخيص الحالة القديمة ولا يُعامل كbaseline مغلقة.

التفاصيل المعمارية في `docs/architecture/DEVICE-ADAPTER-CONTRACT-v1.md` و`docs/architecture/GATE6B-ANDROID-RUNTIME-PROOF-v1.md`.

## 6) ملاحظة حول العدّ

الأرقام أعلاه baseline adoption وليست هدفًا عدديًا في حد ذاته. يمكن أن يزيد عدد tests عند إضافة تغطية جديدة؛ المطلوب أن يبقى الفشل صفرًا وأن لا تُحذف assertions صحيحة لتخفيض العبء.
