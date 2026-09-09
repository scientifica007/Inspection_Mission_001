# Inspection_Mission_001

مشروع تطبيق ميداني محلي أولًا لدعم مهام التفتيش، وجمع المعاينات والملاحظات والأدلة، ومتابعة النقائص والإجراءات التصحيحية، ثم إنتاج المخرجات والتقارير.

## الذاكرة الرسمية للمشروع

الفرع الحاكم هو `main` في هذا المستودع. قبل أي قرار جوهري يجب إجراء Fresh Read من الحالة الحية في GitHub.

لا تُعد ذاكرة ChatGPT أو ملخصات المحادثات مرجعًا رسميًا للحالة التنفيذية للمشروع.

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

قاعدة البيانات المحلية الحاكمة للنسخة أحادية المفتش هي SQLite 3، ولا تعتمد الحالة التشغيلية على process memory.

## مرحلة المنتج الحالية — Gate 6A

بعد اكتمال Application Core، انتقل المشروع إلى مرحلة تحويل القلب المنطقي إلى منتج Android ميداني قابل للاستخدام.

وثائق المعمارية والـRoadmap المعتمدة لهذه المرحلة:

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

## الخطوة التنفيذية التالية

**Gate 6B — Android Shell + Native SQLite Adapter / Device Runtime Proof**

الهدف هو إثبات أن الـApplication Core الحالية تعمل على Android الحقيقي بنفس semantics المعتمدة، مع:

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
6A  Product Runtime Architecture & Delivery Roadmap
 ↓
6B  Android Shell + Native SQLite Adapter / Device Runtime Proof
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

## حدود المستودع

GitHub يخزن:

- requirements؛
- schema؛
- code؛
- templates؛
- design/architecture؛
- docs؛
- tests؛
- synthetic fixtures.

ولا يخزن:

- صور تفتيش حقيقية؛
- Evidence تشغيلية حقيقية؛
- بيانات شخصية أو حساسة؛
- قواعد SQLite إنتاجية؛
- سجلات تفتيش تشغيلية حقيقية.
