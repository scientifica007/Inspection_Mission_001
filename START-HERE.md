# START HERE — Inspection_Mission_001

هذا الملف هو **نقطة الدخول الإلزامية** لأي إنسان أو ذكاء اصطناعي يستلم المشروع من الصفر.

## 1) السلطة الحاكمة

- المستودع الرسمي: `scientifica007/Inspection_Mission_001`
- الفرع الحاكم: `main`
- الحالة الحية في GitHub `main` هي الذاكرة الرسمية المستمرة للمشروع.
- لا تُستخدم ذاكرة ChatGPT، أو ملخصات المحادثات، أو Prompt خارجي، أو فرع قديم، بوصفها مرجعًا رسميًا للحالة.
- قبل أي قرار جوهري: **Fresh Read من `main` الحالي**.

إذا تعارض أي تلخيص خارجي مع ملفات `main` الحية، فـ`main` هو المرجع.

## 2) ابدأ بهذه القراءة، بهذا الترتيب

1. `START-HERE.md` — هذا الملف.
2. `docs/project/CURRENT-STATE.md` — الحالة البشرية المختصرة للمشروع.
3. `docs/project/CURRENT-STATE.json` — الحالة نفسها بصيغة machine-readable.
4. `docs/project/WORKFLOW.md` — طريقة إدارة Gates والمراجعة والدمج.
5. `docs/project/TEST-BASELINES.md` — baselines الاختبارات الحاكمة.
6. `docs/architecture/PRODUCT-ROADMAP-v1.md` — ترتيب مراحل المنتج بعد Application Core.
7. `docs/architecture/PRODUCT-ARCHITECTURE-v1.md` — المعمارية المعتمدة للمنتج.
8. `docs/architecture/DEVICE-ADAPTER-CONTRACT-v1.md` — عقد Gate 6B للـdevice/native SQLite adapter.
9. عند العمل على Gate 6B: `docs/architecture/GATE6B-ANDROID-RUNTIME-PROOF-v1.md` و`docs/architecture/GATE6B-Q12-COMPETING-WRITER-PROOF-v1.md`.

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
| `docs/architecture/` | معمارية المنتج وRoadmap بعد Gate 5L | الحاكم للمرحلة الحالية |
| `docs/project/` | حالة المشروع، handoff، workflow، test baselines | ذاكرة تشغيلية مختصرة قابلة للتسليم |
| `bootstrap/` | bootstrap artifact canonical | تعريفات checklist المرجعية المحملة |
| `src/bootstrap/` | bootstrap/runtime seam | يتضمن `SqlAdapter` المحايد للـruntime |
| `src/application/` | Application Core التنفيذي | لا يُعاد تصميمه بلا contradiction تنفيذي ملموس |
| `tests/` | regression authority | لا تُضعف baselines السابقة |

## 4) قواعد التتبع

يحافظ المشروع دائمًا على الفصل التالي:

- `DIRECT` = وارد صراحةً في مصدر رسمي.
- `DERIVED` = أثر تنفيذي مشتق من متطلب رسمي.
- `PROJECT` = قرار/مطلب صريح من مالك المشروع، وليس من المصادر الرسمية.

لا تنسب متطلبًا `PROJECT` إلى مصدر رسمي.

## 5) الحالة التنفيذية الحالية

راجع `docs/project/CURRENT-STATE.md` و`.json` بدل الاعتماد على هذا القسم وحده.

الخلاصة الحالية:

- Gates 1→5L: مغلقة/معتمدة/مدمجة.
- Gate 6A — Product Runtime Architecture & Delivery Roadmap: مغلقة/معتمدة/مدمجة.
- **Gate 6B — Android Shell + Native SQLite Adapter / Device Runtime Proof: `IN_PROGRESS / PHYSICAL_QUALIFICATION_PASS_PENDING_PR_MERGE`.**
- Adapter Qualification الفيزيائية على Android الحقيقي عند SHA `87135cfe80ae3de79a34e941828249fc6889139c`: **PASS** لـQ1→Q12، وQ12 status هي **`PHYSICAL_PASS_REVIEW_ACCEPTED`**.
- أدلة Application-Core و`currentVisitState` zero-write وT11 وreal Force Stop/Restart من SHA `89d405d6254108ce735125638ccdb2fb2e67c568` تبقى **مقبولة بإعادة استخدام evidence مبنية على non-drift** للمسارات ذات الصلة حتى `87135cfe...`؛ لا يعني ذلك أن APK البناءين binary متطابقتان.
- `@capacitor-community/sqlite@8.1.1`: **device qualification = PASS**؛ الاعتماد النهائي وإغلاق Gate 6B ما يزالان pending PR / owner approval / merge.
- `closure_authorized=false`.
- Gate 6C: **NOT_STARTED**.
- Field-usable v1: **غير مكتملة بعد**.

لا تبدأ Gate لاحقة قبل إغلاق الحالية وفق `docs/project/WORKFLOW.md`.

## 6) ما لا يجوز استنتاجه من المستودع

GitHub هو ذاكرة **الهندسة والقرارات والعقود**، وليس مخزن البيانات التشغيلية الحقيقية.

لا يُفترض وجود ما يلي هنا:

- صور تفتيش حقيقية؛
- Evidence تشغيلية حقيقية؛
- بيانات شخصية أو حساسة؛
- قواعد SQLite إنتاجية؛
- سجلات زيارات أو مؤسسات حقيقية؛
- أسرار أو مفاتيح API.

غياب هذه البيانات مقصود وليس نقصًا في ذاكرة المشروع الهندسية.

## 7) قاعدة Fresh Read قبل العمل

قبل أي Gate أو تعديل جوهري:

1. اقرأ HEAD الحي لـ`main`.
2. اقرأ `CURRENT-STATE.md` و`CURRENT-STATE.json`.
3. اقرأ الـRoadmap والعقد الخاص بالـGate الحالية/التالية.
4. اقرأ فقط العقود والملفات المغلقة ذات الصلة المباشرة.
5. إذا ظهر تعارض بين وثيقة مختصرة وartifact تنفيذي حاكم، لا تخمّن: حقق التعارض وبلّغ عنه.

## 8) قاعدة Gates المغلقة

لا تُفتح Gate مغلقة لمجرد التحسين أو إعادة التصميم.

يُسمح بتصحيح ضيق داخل Gate مغلقة فقط إذا ظهر **contradiction تنفيذي ملموس وقابل للتكرار** مع عقد معتمد. عندئذ يُوثق السبب، يبقى التصحيح في أضيق نطاق، تعاد regressions المتأثرة، ولا تتحول المراجعة إلى redesign عام.

## 9) كيف تستلم المشروع عمليًا

```text
Fresh Read main
→ START-HERE
→ CURRENT-STATE
→ WORKFLOW
→ TEST-BASELINES
→ PRODUCT-ROADMAP
→ gate-specific contracts
→ scoped work only
```

لا تطلب من المالك إعادة سرد تاريخ المشروع ما دامت هذه الملفات والـartifacts الحية تكفي.
