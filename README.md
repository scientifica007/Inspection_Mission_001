# Inspection_Mission_001

مشروع تطبيق ميداني محلي أولًا لدعم مهام التفتيش، وجمع المعاينات والملاحظات والأدلة، ومتابعة النقائص والإجراءات التصحيحية، ثم إنتاج المخرجات والتقارير.

## ابدأ من هنا عند استلام المشروع

إذا كنت إنسانًا أو ذكاءً اصطناعيًا جديدًا على المشروع، ابدأ بـ:

**`START-HERE.md`**

ثم اتبع ترتيب القراءة المحدد فيه. طبقة الذاكرة التشغيلية المختصرة موجودة في:

- `docs/project/CURRENT-STATE.md`
- `docs/project/CURRENT-STATE.json`
- `docs/project/WORKFLOW.md`
- `docs/project/TEST-BASELINES.md`

هذه الملفات مخصصة لجعل المشروع قابلًا للتسليم والاستمرار من GitHub وحده دون الرجوع إلى تاريخ محادثات ChatGPT.

## الذاكرة الرسمية للمشروع

الفرع الحاكم هو `main` في هذا المستودع. قبل أي قرار جوهري يجب إجراء Fresh Read من الحالة الحية في GitHub.

لا تُعد ذاكرة ChatGPT أو ملخصات المحادثات مرجعًا رسميًا للحالة التنفيذية للمشروع.

إذا تعارض أي handoff خارجي مع `main` الحي، فـ`main` هو المرجع.

## المصادر المرجعية الحالية

- `sources/01_field_control_and_equipment_aug_2026.md` — مراسلتان حول تفعيل الرقابة الميدانية على الورشات البيداغوجية وتأمين محيطها، وتحيين التجهيزات البيداغوجية على منصة «تسيير».
- `sources/02_provincial_entry_readiness_committee_2026_2027.md` — إنشاء لجنة ولائية لمتابعة مدى جاهزية المؤسسات التكوينية للدخول التكويني 2026–2027.

## قاعدة التعامل مع المصادر والتتبع

مجلد `sources/` مرجع نصي ولا تُعدّل نصوصه عند اشتقاق متطلبات التطبيق.

يحافظ المشروع على الفصل التالي:

- `DIRECT` — وارد صراحةً في مصدر رسمي.
- `DERIVED` — مشتق تنفيذيًا من متطلب رسمي.
- `PROJECT` — قرار أو مطلب صريح لمالك المشروع، ولا يُنسب إلى المصادر الرسمية.

## الحالة الحالية

تم إغلاق ودمج المراحل الأساسية التالية:

- Gate 1 — Requirements.
- Gate 2 — Checklist Design.
- Gate 3 — Logical Data Model.
- Gate 4 / 4A / 4B — Physical Schema + Applicability + Finding VOIDED lifecycle.
- Gate 5A→5L — Application Core، بما يشمل T0→T11 وOBS-1 و`currentVisitState` لإعادة البناء بعد restart من SQLite وحدها.
- Gate 6A — Product Runtime Architecture & Delivery Roadmap.

Gate 5B يتضمن كذلك owner-authorized narrow correction لسلوك `SqlResult.lastInsertRowid` في `NodeSqliteAdapter`، موثقة في `docs/application/GATE5B-LASTINSERTROWID-CORRECTION-v1.md`، وقد أصبحت **MERGED / RESOLVED** دون تغيير عقد `SqlAdapter`.

قاعدة البيانات المحلية الحاكمة للنسخة أحادية المفتش هي SQLite 3، ولا تعتمد الحالة التشغيلية على process memory.

الحالة التفصيلية الحية المختصرة: `docs/project/CURRENT-STATE.md` و`docs/project/CURRENT-STATE.json`.

## معمارية المنتج المعتمدة

بعد اكتمال Application Core، انتقل المشروع إلى تحويل القلب المنطقي إلى منتج Android ميداني قابل للاستخدام.

وثائق المعمارية والـRoadmap المعتمدة:

- `docs/architecture/PRODUCT-ARCHITECTURE-v1.md`
- `docs/architecture/PRODUCT-ROADMAP-v1.md`
- `docs/architecture/DEVICE-ADAPTER-CONTRACT-v1.md`

القرار المعماري الحالي:

- Android-first.
- Capacitor Web Native shell.
- React + Vite + TypeScript كواجهة ميدانية افتراضية.
- SQLite تبقى السلطة المحلية للبيانات.
- لا server ولا sync مطلوبين للنسخة الميدانية الأولى.
- لا يتم اعتماد SQLite plugin نهائيًا قبل إثبات تطابقه مع عقد الـadapter الحالي على جهاز Android فعلي.

## المرحلة التنفيذية الحالية على مستوى المنتج

**Gate 6B — Android Shell + Native SQLite Adapter / Device Runtime Proof**

الحالة: **IN_PROGRESS / DEVICE_PROOF_PENDING**.

فرع التنفيذ: `implementation/gate6b-android-runtime-proof-v1`.

تم إعداد Android shell وprovisional `@capacitor-community/sqlite@8.1.1` adapter وproof harness وGitHub CI/Android debug build. هذا العمل لا يغلق Gate 6B؛ physical-device proof ما زال مطلوبًا، والمرشح يبقى provisional حتى تنفيذ evidence على Android فعلي ومراجعتها مستقلًا.

هدف Gate 6B هو إثبات أن الـApplication Core الحالية تعمل على Android الحقيقي بنفس semantics المعتمدة، مع:

- `BEGIN IMMEDIATE` فعلي؛
- transaction boundaries صحيحة؛
- rollback و`changes` صحيحين؛
- `foreign_keys=ON`؛
- schema/bootstrap على الجهاز؛
- persistence بعد app/process restart؛
- إعادة بناء الزيارة بواسطة `currentVisitState` من نفس SQLite file.

لا تبدأ UI كاملة أو Evidence أو reports قبل اجتياز هذا runtime proof.

## Roadmap حتى Field-usable v1

```text
6A  Product Runtime Architecture & Delivery Roadmap       CLOSED
 ↓
6B  Android Shell + Native SQLite Adapter / Device Runtime Proof   IN_PROGRESS / DEVICE_PROOF_PENDING
 ↓
6C  Evidence Storage + Camera/File Pipeline
 ↓
6D  Arabic RTL Field UI + End-to-End Visit Workflow
 ↓
6E  ExternalSystemTracking application capability
 ↓
6F  Deterministic Report Model / Snapshot Generation
 ↓
6G  DOCX + PDF + Artifact Save/Share
 ↓
6H  Android Packaging + Field Qualification
 ↓
FIELD-USABLE v1
```

بعد ذلك فقط تُراجع قدرات P1 مثل CSV/XLSX والمؤشرات والتجميع والمزامنة والخادم والواجهات الخارجية.

## Workflow التطوير

طريقة العمل الحاكمة موثقة في `docs/project/WORKFLOW.md`، وتشمل:

```text
Fresh Read main
→ scoped Gate
→ implementation
→ review
→ limited correction if needed
→ APPROVED FOR COMMIT
→ commit/push
→ verify remote
→ PR/merge
→ Fresh Read main
→ close Gate
```

لا تُفتح Gate مغلقة إلا عند وجود contradiction تنفيذي ملموس وقابل للتكرار، وبأضيق correction ممكن.

## Baselines الاختبارات

راجع `docs/project/TEST-BASELINES.md` قبل أي Gate تنفيذية. لا تُضعف regression baseline مغلقة لتسهيل feature جديدة.

## حدود المستودع

GitHub يخزن:

- requirements؛
- schema؛
- code؛
- templates؛
- design/architecture؛
- docs؛
- tests؛
- synthetic fixtures؛
- ذاكرة handoff وتشغيل المشروع.

ولا يخزن:

- صور تفتيش حقيقية؛
- Evidence تشغيلية حقيقية؛
- بيانات شخصية أو حساسة؛
- قواعد SQLite إنتاجية؛
- سجلات تفتيش تشغيلية حقيقية؛
- أسرار أو API keys؛
- device serial numbers.
