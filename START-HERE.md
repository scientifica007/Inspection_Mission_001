# START HERE — Inspection_Mission_001

هذا الملف هو **نقطة الدخول الإلزامية** لأي إنسان أو ذكاء اصطناعي يستلم المشروع من الصفر.

## 1) السلطة الحاكمة

- المستودع الرسمي: `scientifica007/Inspection_Mission_001`
- الفرع الحاكم: `main`
- الحالة الحية في GitHub `main` هي الذاكرة الرسمية المستمرة للمشروع.
- لا تُستخدم ذاكرة ChatGPT، أو ملخصات المحادثات، أو Prompt خارجي، أو فرع قديم، بوصفها مرجعًا رسميًا للحالة.
- قبل أي قرار جوهري: **Fresh Read من `main` الحالي**.

إذا تعارض أي تلخيص خارجي مع ملفات `main` الحية، فـ`main` هو المرجع. إذا تعارض ملف مختصر داخل المستودع مع artifact تنفيذي أو `CURRENT-STATE` أحدث، حقق التعارض ولا تفترض أن الملخص الأقدم هو الحاكم.

## 2) ابدأ بهذه القراءة، بهذا الترتيب

1. `START-HERE.md` — هذا الملف.
2. `docs/project/CURRENT-STATE.md` — الحالة البشرية المختصرة للمشروع.
3. `docs/project/CURRENT-STATE.json` — الحالة نفسها بصيغة machine-readable.
4. `docs/project/WORKFLOW.md` — طريقة إدارة Gates والمراجعة والدمج.
5. `docs/project/TEST-BASELINES.md` — baselines الاختبارات الحاكمة.
6. `docs/project/ENGINEERING-DECISIONS-AND-INCIDENTS.md` — السجل الدائم للقرارات الهندسية والحوادث والأخطاء والتصحيحات المهمة.
7. `docs/architecture/PRODUCT-ROADMAP-v1.md` — ترتيب مراحل المنتج بعد Application Core.
8. `docs/architecture/PRODUCT-ARCHITECTURE-v1.md` — المعمارية المعتمدة للمنتج.
9. `docs/architecture/DEVICE-ADAPTER-CONTRACT-v1.md` — عقد الـdevice/native SQLite adapter الذي أغلقته Gate 6B.
10. عند مراجعة تاريخ Gate 6B أو adapter/device proof: `docs/architecture/GATE6B-ANDROID-RUNTIME-PROOF-v1.md` و`docs/architecture/GATE6B-ANDROID-SCHEMA-EXECUTION-CORRECTION-v1.md` و`docs/architecture/GATE6B-Q12-COMPETING-WRITER-PROOF-v1.md`.
11. عند مراجعة Evidence/Gate 6C: `docs/architecture/GATE6C-EVIDENCE-STORAGE-CONTRACT-v1.md` و`docs/architecture/GATE6C-C-ANDROID-EVIDENCE-QUALIFICATION-v1.md` و`docs/architecture/GATE6C-D-PHYSICAL-EVIDENCE-QUALIFICATION-v1.md`.

ثم اقرأ الملفات المعيارية الخاصة بالمهمة التي تعمل عليها فقط.

## 3) خريطة السلطة داخل المستودع

| المسار | دوره | ملاحظات |
|---|---|---|
| `sources/` | النصوص الرسمية المرجعية | لا تعدّل النصوص عند الاشتقاق |
| `docs/requirements/` | كتالوج المتطلبات ومحاور التفتيش | يحافظ على DIRECT / DERIVED / PROJECT |
| `docs/checklists/` | تصميم قوائم التحقق والانطباق | مرجع محتوى وقواعد checklist |
| `docs/data-model/` | النموذج المنطقي وEntity Catalog | مرجع الكيانات والعلاقات |
| `docs/schema/` | المخطط الفيزيائي والقيود | `schema.sql` هو المخطط التنفيذي الحاكم |
| `docs/application/` | عقود Application Core والمعاملات والتعافي | يفسر semantics للخدمات المغلقة |
| `docs/architecture/` | معمارية المنتج وRoadmap وعقود/أدلة Gates المعمارية | الحاكم لتسلسل المنتج والعقود الهندسية |
| `docs/project/` | الحالة، handoff، workflow، test baselines، سجل القرارات والحوادث | الذاكرة التشغيلية المختصرة القابلة للتسليم |
| `bootstrap/` | bootstrap artifact canonical | تعريفات checklist المرجعية المحملة |
| `src/bootstrap/` | bootstrap/runtime seam | يتضمن `SqlAdapter` المحايد للـruntime |
| `src/application/` | Application Core التنفيذي | لا يُعاد تصميمه بلا contradiction تنفيذي ملموس |
| `tests/` | regression authority | لا تُضعف baselines السابقة |

## 4) قواعد التتبع

يحافظ المشروع دائمًا على الفصل التالي:

- `DIRECT` = وارد صراحةً في مصدر رسمي.
- `DERIVED` = أثر تنفيذي مشتق من متطلب رسمي.
- `PROJECT` = قرار/مطلب صريح من مالك المشروع، وليس من المصادر الرسمية.

لا تنسب متطلبًا أو قرارًا `PROJECT` إلى مصدر رسمي.

## 5) الحالة التنفيذية الحالية

راجع `docs/project/CURRENT-STATE.md` و`.json` بدل الاعتماد على هذا القسم وحده.

الخلاصة الحالية:

- Gates 1→5L: مغلقة/معتمدة/مدمجة.
- Gate 6A — Product Runtime Architecture & Delivery Roadmap: **CLOSED / MERGED**.
- Gate 6B — Android Shell + Native SQLite Adapter / Device Runtime Proof: **CLOSED / MERGED** عبر PR #17؛ merge SHA `0905c6111269d62480e7ccadc31786bef29f3c51`.
- Adapter Qualification الفيزيائية على Android الحقيقي عند `87135cfe80ae3de79a34e941828249fc6889139c`: **PASS Q1→Q12**؛ Q12=`PHYSICAL_PASS_REVIEW_ACCEPTED`.
- Gate 6C-A — Evidence Storage Contract: **CLOSED / MERGED**.
- Gate 6C-B — Runtime-neutral Evidence orchestration: **CLOSED / MERGED** عبر PR #21؛ adopted host baseline **85 / 0**.
- Gate 6C-C — Android Camera/File + durable EvidenceStorage adapters: **CLOSED / MERGED**. التنفيذ دُمج عبر PR #23 عند merge SHA `f221b215358f83dce381ac5261a856a7de4e5c98`، ثم أُغلقت حالة المشروع توثيقيًا عبر PR #24.
- Gate 6C-C final reviewed head: `9de6c69eef90c490319c02eac48d236482597210`؛ exact-final-SHA qualification run: `34531511138` — SUCCESS.
- Gate 6C ككل: **IN_PROGRESS**.
- **Gate 6C-D: OPEN / IN_PROGRESS**؛ `gate6c_d_started=true`. الحالة الحالية المعتمدة: Q01 = `NO_PASS / BLOCKED_ON_CURRENT_PHYSICAL_ENVIRONMENT`; Q05 = `NOT_APPLICABLE_UNDER_CURRENT_PRODUCTION_MANIFEST`; Q02/Q03/Q04/Q06/Q07/Q08/Q09/Q10/Q11/Q12/Q13 لها physical PASS وفق التمييزات الموثقة في عقد Gate 6C-D و`CURRENT-STATE`. Q12 يثبت `REAL_DEVICE_WRITE_FAILURE` فقط و`enospcProven=false`; literal `REAL_DEVICE_ENOSPC` يبقى `DOCUMENTED_RESIDUAL_GAP / NON_BLOCKING_OWNER_WAIVER`. هذا لا يغلق Gate 6C-D.
- Gate 6D: **NOT_STARTED**.
- `field_usable_v1=false`.

لا تعتبر أي SHA مضمن هنا HEAD الحالي تلقائيًا؛ Fresh Read لـ`main` يبقى إلزاميًا.

## 6) ما لا يجوز استنتاجه من المستودع

GitHub هو ذاكرة **الهندسة والقرارات والعقود**، وليس مخزن البيانات التشغيلية الحقيقية.

لا يُفترض وجود صور تفتيش حقيقية أو Evidence تشغيلية أو بيانات شخصية/حساسة أو قواعد SQLite إنتاجية أو أسرار/API keys هنا.

## 7) قاعدة Fresh Read قبل العمل

قبل أي Gate أو تعديل جوهري:

1. اقرأ HEAD الحي لـ`main`.
2. اقرأ `CURRENT-STATE.md` و`CURRENT-STATE.json`.
3. اقرأ `WORKFLOW.md` و`TEST-BASELINES.md`.
4. راجع `ENGINEERING-DECISIONS-AND-INCIDENTS.md` للحوادث/القرارات السابقة التي قد تمنع تكرار خطأ أو إعادة فتح قرار محسوم.
5. اقرأ الـRoadmap والعقد الخاص بالـGate الحالية/التالية.
6. اقرأ فقط العقود والملفات المغلقة ذات الصلة المباشرة.
7. إذا ظهر تعارض بين وثيقة مختصرة وartifact تنفيذي حاكم، لا تخمّن: حقق التعارض وبلّغ عنه.

## 8) قاعدة Gates المغلقة

لا تُفتح Gate مغلقة لمجرد التحسين أو إعادة التصميم.

يُسمح بتصحيح ضيق داخل Gate مغلقة فقط إذا ظهر **contradiction تنفيذي ملموس وقابل للتكرار** مع عقد معتمد. عندئذ يُوثق السبب، يبقى التصحيح في أضيق نطاق، تعاد regressions المتأثرة، ولا تتحول المراجعة إلى redesign عام.

كل contradiction أو incident مهم وكل قرار معماري/تشغيلي يترتب عليه قيد مستقبلي يجب أن يُسجل أو يُربط في `docs/project/ENGINEERING-DECISIONS-AND-INCIDENTS.md`.

## 9) كيف تستلم المشروع عمليًا

```text
Fresh Read main
→ START-HERE
→ CURRENT-STATE
→ WORKFLOW
→ TEST-BASELINES
→ ENGINEERING-DECISIONS-AND-INCIDENTS
→ PRODUCT-ROADMAP
→ gate-specific contracts
→ scoped work only
```

الحالة الحالية هي **Gate 6C-D — OPEN / IN_PROGRESS**. نتائج Q02→Q13 الحالية موثقة في `CURRENT-STATE` مع الاستثناءات/التصنيفات الدقيقة لـQ05 وQ12؛ Q01 يبقى بلا PASS ومحجوبًا في البيئة الفيزيائية الحالية. Gate 6C-D وGate 6C لم تُغلقا، Gate 6D لم يبدأ، و`field_usable_v1=false`. راجع عقد Gate 6C-D و`CURRENT-STATE` قبل أي قرار إغلاق.
