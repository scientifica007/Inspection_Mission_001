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
- Gate 6B — Android Shell + Native SQLite Adapter / Device Runtime Proof — **CLOSED / MERGED** عبر PR #17 عند merge SHA `0905c6111269d62480e7ccadc31786bef29f3c51`.
- Gate 6C-A — Evidence Storage Contract — **CLOSED / MERGED**.
- Gate 6C-B — Runtime-neutral Evidence orchestration — **CLOSED / MERGED**.
- Gate 6C-C — Android Camera/File + durable EvidenceStorage adapters — **CLOSED / MERGED**.
- Gate 6C-D — Physical Android Evidence Qualification — **CLOSED**. Q01 now has a reviewed **PHYSICAL PASS on a second real Android device** using the exact same qualification APK; the earlier Q01 owner waiver remains historical but is superseded as the current closure basis.
- Gate 6C — Evidence Storage + Camera/File Pipeline — **CLOSED** after all 6C-A→6C-D substages reached closure disposition.

Gate 5B يتضمن كذلك owner-authorized narrow correction لسلوك `SqlResult.lastInsertRowid` في `NodeSqliteAdapter`، موثقة في `docs/application/GATE5B-LASTINSERTROWID-CORRECTION-v1.md`، وقد أصبحت **MERGED / RESOLVED** دون تغيير عقد `SqlAdapter`.

قاعدة البيانات المحلية الحاكمة للنسخة أحادية المفتش هي SQLite 3، ولا تعتمد الحالة التشغيلية على process memory.

الحالة التفصيلية الحية المختصرة: `docs/project/CURRENT-STATE.md` و`docs/project/CURRENT-STATE.json`.

## معمارية المنتج المعتمدة

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
- `@capacitor-community/sqlite@8.1.1` اجتاز Gate 6B physical qualification وتم اعتماده بواسطة Gate 6B المغلقة؛ لا يغيّر ذلك سلطة `SqlAdapter` أو canonical schema/bootstrap.

## المرحلة التنفيذية الحالية على مستوى المنتج

**Gate 6D — NEXT / NOT_STARTED.**

- Gate 6C-A و6C-B و6C-C و6C-D مغلقة، ولذلك Gate 6C ككل **CLOSED**.
- Q01 current disposition: **PHYSICAL PASS on a second physical Android device** using tested SHA `44a231a8281d1031a40e7105160c919633d32531` and the independently matched installed APK SHA-256 `d18d4eef683707e66c3aacae885d9d7871685f4bd0e869a74efca6bc5aee54f2`. Earlier first-device Q01 failures/blocked attempts remain historical.
- The former Q01 closure waiver remains durable engineering history but is `SUPERSEDED_AS_CURRENT_CLOSURE_BASIS_BY_SUBSEQUENT_Q01_PHYSICAL_PASS`.
- Q05 يبقى `NOT_APPLICABLE_UNDER_CURRENT_PRODUCTION_MANIFEST` وليس PASS.
- Q12 يثبت `REAL_DEVICE_WRITE_FAILURE` فقط مع `enospcProven=false`; literal `REAL_DEVICE_ENOSPC` يبقى `DOCUMENTED_RESIDUAL_GAP / NON_BLOCKING_OWNER_WAIVER` وليس ENOSPC PASS.
- Gate 6D هي **NEXT / NOT_STARTED**؛ `gate6d_started=false`، ولا يوجد implementation بدأ لهذه المرحلة.
- `field_usable_v1=false`.

## Roadmap حتى Field-usable v1

```text
6A  Product Runtime Architecture & Delivery Roadmap       CLOSED
 ↓
6B  Android Shell + Native SQLite Adapter / Device Runtime Proof   CLOSED / MERGED
 ↓
6C  Evidence Storage + Camera/File Pipeline               CLOSED
    6C-A / 6C-B / 6C-C / 6C-D CLOSED
 ↓
6D  Arabic RTL Field UI + End-to-End Visit Workflow       NEXT / NOT_STARTED
 ↓
6E  ExternalSystemTracking application capability         LATER
 ↓
6F  Deterministic Report Model / Snapshot Generation      LATER
 ↓
6G  DOCX + PDF + Artifact Save/Share                      LATER
 ↓
6H  Android Packaging + Field Qualification               LATER
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

GitHub يخزن requirements/schema/code/templates/design/architecture/docs/tests/synthetic fixtures وذاكرة handoff الهندسية، ولا يخزن صور تفتيش حقيقية أو Evidence تشغيلية حقيقية أو بيانات شخصية أو قواعد SQLite إنتاجية أو أسرار/API keys أو device serial numbers.
