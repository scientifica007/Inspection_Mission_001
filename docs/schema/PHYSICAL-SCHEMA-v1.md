# المخطط الفيزيائي/القابل للتنفيذ (Physical / Executable Data Schema) — v1

> **الإصدار:** v1 · Revision 4 (تصحيح بوابة 4A — جسر انطباق قوائم التحقق: العمود `checklist_item_definition.applicability_rule` — بعد Revision 3 الذي أغلق فجوات الفرض المتبقية: المصدر الأول للاستجابة، تكامل CHK-012 ثنائي الاتجاه، ثبات PK، نزاهة سلاسل إصدارات التعريفات، تقوية Q1).
> **البوابة:** الرابعة — ترجمة النموذج المنطقي المعتمد (البوابة الثالثة) إلى مخطط بيانات فيزيائي قابل للتنفيذ لنسخة المفتش الميداني الأولى (وتصحيح بوابة 4A الضيق).
> **المراجع:** `docs/data-model/DATA-MODEL-v1.md` (القواعد I1..I21) و`ENTITY-CATALOG-v1.md` (عمود «قابلية التغيير» = سلطة التدقيق)، و`docs/requirements/*` و`docs/checklists/*` وقاعدة الانطباق الكنسية `docs/checklists/APPLICABILITY-RULES-v1.md` (بوابة 4A).
> **التقنية المعتمدة:** **SQLite 3** (مدمج/ملف) — لا تغيير في القرار (مبرراته أدناه).
> **الأعداد المعتمدة الآن:** **15 جدولًا · 44 مُشغِّلًا (trigger) · منظر واحد · 24 فهرسًا صريحًا** — تأكيد بالتنفيذ الفعلي (دون تغيير عن Revision 3: تصحيح 4A يضيف عمودًا واحدًا وقيود CHECK ويوسّع مُشغِّلًا قائمًا فقط).
> **نتيجة التحقق:** **71 اختبارًا (سلبي/إيجابي) — 0 فشل** على sqlite 3.45.1 (انظر القسم 9؛ قابلة لإعادة التشغيل من الصفر: `python3 tests/gate4a_regression.py`).
> لا واجهات، لا تطبيق، لا توليد تقارير؛ لا تُخزَّن ملفات أدلة ثنائية في المخطط أو في GitHub.

---

## 1) النطاق والأهداف

- المخطط يحفظ **دورة الحياة الكاملة لمعلومة التفتيش** (15 كيانًا) وينفّذ قواعد البوابة الثالثة على مستوى التخزين.
- **الحقائق الميدانية التاريخية لا تُعاد كتابتها**؛ تحيين «تسيير» التصحيحي منفصل عن لقطة المطابقة.
- **الزيارة المثبتة (finalized) غير قابلة للتعديل في v1**؛ إعادة معاينة = زيارة جديدة.
- التعريفات مُرقّمة ومرتبطة بالاستجابة بإصدارها الدقيق؛ **لا خلط إصدارات** لنفس `(visit_id, item_code, سياق)`.
- **قاعدة انطباق كل تعريف مُخزَّنة ومُرقّمة ومربوطة بإصداره الدقيق** (`applicability_rule` — تصحيح بوابة 4A): قاعدة البيانات تحفظ القاعدة فقط وتقييمها تطبيقي، فلا يُرمَّز الانطباق بـ `item_code` في كود بوابة 5 (السلطة الكنسية: `docs/checklists/APPLICABILITY-RULES-v1.md`).
- `result_class` **مشتق** (منظر) وليس مخزونًا.
- **قابلية التغيير لكل عمود** مطابقة لسلطة `ENTITY-CATALOG` (عمود «قابلية التغيير») عبر مُشغِّلات قبل/بعد UPDATE (جدول كامل في القسم 6).
- **سياسة Q1 (OTHER)**: كل قاموس مفتوح يسمح بـ OTHER يتطلب نصًا حرًا إلزاميًا مرافقًا (أعمدة `*_other`/`status_detail`/`discrepancy_desc` + CHECKs).
- Report بيانات تعريفية **P0**؛ توليد DOCX/PDF خارج البوابة.

## 2) تقنية قاعدة البيانات (قرار ثابت)

**SQLite 3 (embedded, file-based)** — نفس القرار السابق ولم يتغير:
استعمال هاتف/لوحي لمفتش واحد دون خادم وتكامل في v1 (PRJ-01 + قرار الأنظمة الخارجية 2)؛ تنفيذ/تحقق بلا حزم (stdlib `sqlite3`، الإصدار 3.45)؛ قدرات كافية: FK + CHECK + فهارس تعبيرية فريدة + مُشغِّلات + منظر للقيمة المشتقة؛ ملف واحد قابل للنسخ والتصدير للتجميع الولائي لاحقًا.
لا تُستخدم قيود STRICT (توافق واسع)؛ `PRAGMA foreign_keys = ON` في رأس الملف التنفيذي.

## 3) اصطلاحات الترميز

- المعرّفات `INTEGER PRIMARY KEY`؛ المعرفات التجارية `TEXT` (مع `UNIQUE` حيث لزم: `official_code`, `(item_code, version_no)`, `(item_definition_id, value_code)`).
- زمن `TEXT` ISO-8601 UTC `YYYY-MM-DDTHH:MM:SSZ`؛ تواريخ `YYYY-MM-DD`.
- رموز القيم (value-set codes) معتمدة بالـ CHECKs — نفس قاموس Revision 1 (عربية في `arabic_label` وقواميس التطبيق). إضافة رموز/أعمدة رفيقة Q1:

| العمود الرفيق | القاعدة (CHECK) |
|---|---|
| `institution.kind_other` | `kind_code='OTHER'` ⇐ نص غير فارغ |
| `inspected_subject.subject_type_other` | `subject_type='OTHER'` ⇐ نص غير فارغ |
| `finding.defect_type_other` | `defect_type='OTHER'` ⇐ نص غير فارغ |
| `equipment_reconciliation_row.discrepancy_desc` | `discrepancy_type='OTHER'` ⇐ نص غير فارغ |
| `corrective_action.action_type_other` | `action_type='OTHER'` ⇐ نص غير فارغ |
| `corrective_action.responsible_role_other` | `responsible_role='OTHER'` ⇐ نص غير فارغ |
| `follow_up.actor_role_other` | `actor_role='OTHER'` ⇐ نص غير فارغ |
| `external_system_tracking.status_detail` | `status_code='OTHER'` ⇐ نص غير فارغ |

> لا تُضاف هذه الأعمدة ككيانات؛ هي دعم فيزيائي أدنى لقرار Q1.

## 4) خريطة الكيانات ← الجداول (15/15) — دون تغيير

| الكيان المنطقي | الجدول |
|---|---|
| Mission · Institution · InspectedSubject · Visit · ChecklistItemDefinition · ChecklistAllowedValue · ChecklistResponse · EquipmentReconciliationRow · AdHocObservation · Finding · Evidence · CorrectiveAction · FollowUp · ExternalSystemTracking · Report | `mission` · `institution` · `inspected_subject` · `visit` · `checklist_item_definition` · `checklist_allowed_value` · `checklist_response` · `equipment_reconciliation_row` · `adhoc_observation` · `finding` · `evidence` · `corrective_action` · `follow_up` · `external_system_tracking` · `report` |

## 5) مواصفة الجداول (المرجع القاطع: `schema.sql`)

> التفاصيل الكاملة لكل عمود ونوع وFK/CHECK في الملف التنفيذي. أبرز عناصر Revision 3 وأضافات Revision 4 (4A):

- **visit**: إضافة **CHECK اقتراني** — `(status='PREPARATION' AND finalized_at IS NULL) OR (status IN ('COMPLETED','COMPLETED_WITH_UNINSPECTED') AND finalized_at IS NOT NULL)`.
- **finding**: عمود `defect_type_other`؛ **corrective_action**: عمودا `action_type_other` و`responsible_role_other`؛ **follow_up**: عمود `actor_role_other`.
- بقية الأعمدة والـ FKs والفهارس كما في Revision 1 (`uq_response_ctx` التعبيري للتفرد، فهارس FK المبررة، فهرس `(owner_kind, owner_ref)`، `(finding_id,event_datetime)`).
- **إضافات Revision 3 (التصحيح النهائي):**
  - **PK لكل جدول ثابت بمُشغِّل مستقل** (لا اعتماد على تأثير FK) — أُغلقت الثغرات المتبقية: `visit.visit_id`، `checklist_item_definition.item_definition_id`، `checklist_response.response_id`، `equipment_reconciliation_row.row_id`، `finding.finding_id`، `evidence.evidence_id` (وبقية الجداول كانت مغطاة).
  - **نزاهة سلاسل الإصدارات**: فهرس جزئي فريد `uq_active_def_per_code` (تعريف `ACTIVE` واحد لكل `item_code`) + مُشغِّل `trg_def_bi` (قبل الإدراج): `supersedes_definition_id` يجب أن يشير لنفس `item_code`، وألا يشير للتعريف نفسه، وأن يكون لإصدار **أسبق** (`version_no` أدنى).
  - **تكامل CHK-012 ثنائي الاتجاه**: مُشغِّل جديد `trg_response_chk012_bu` على جهة الاستجابة — تحويل النتيجة الإجمالية إلى `COMPLIANT` مرفوض إذا وُجد أي سطر فارق؛ وتحويلها إلى أي `overlay_state` (NA/NOT_INSPECTED) مرفوض إذا وُجدت سطور؛ وسطور الإدراج مرفوضة مع **أي** overlay. تعريف «الفارق» الموحَّد: `difference <> 0 OR discrepancy_type IS NOT NULL` (لا فارق صفري مع نوع مُعلَن).
  - **المصدر الأول للاستجابة**: فحص «أول مصدر في `origin_visit_id`» في مساري INSERT وUPDATE **يستثني الصف الحالي** (مكافئ لمنطق AdHocObservation) — ربط أول من زيارة غير زيارة الأصل مرفوض.
  - **Q1**: جميع أعمدة OTHER الرفيقة تُفحص بـ `length(trim(x)) > 0` (نص ذو معنى لا مسافات فقط).
- **إضافة Revision 4 (تصحيح بوابة 4A — الانطباق):**
  - **checklist_item_definition**: عمود `applicability_rule TEXT NOT NULL` — قاعدة الانطباق الكنسية (كائن JSON، `rule_schema_version = 1`) **المملوكة للإصدار الدقيق**. التمثيل/الخريطة الكنسية CHK-001..024 في `docs/checklists/APPLICABILITY-RULES-v1.md`.
  - **ثبات القاعدة مع التعريف**: انضم `applicability_rule` إلى قائمة الحقول الثابتة في `trg_def_bu` (تغيير الانطباق يستلزم إصدار تعريف جديدًا — لا إعادة كتابة؛ لا خرق لقاعدة ACTIVE الواحد لكل `item_code`).
  - **فرض القواعد الكنسية (Revision 4 النهائي — نفس البوابة):**
    - **CHECKs تصريحية** للبنية القياسية: جذر JSON صالح وكائن؛ `$.rule_schema_version` نوعه **integer** وقيمته `1` بالضبط (المنطق `true` والنص والغياب مرفوضة عبر حارس CASE)؛ `$.item_code` نص **يساوي** `item_code` الصف تمامًا؛ `$.decision_kind` نص من `AUTO`/`HUMAN_CONFIRMATION`؛ `$.subject_kinds` **مصفوفة**؛ `$.source_ar` نص غير فارغ (مطلوب)؛ `$.visit_type` إن وُجد **كائن** (غيابه مسموح).
    - **محتوى تكرارى داخل `trg_def_bi` (مُشغِّل الإدراج القائم — لا مُشغِّل/جدول/كيان جديد):** `$.subject_kinds` غير فارغة وكل عنصر نص من القائمة المغلقة (`INSTITUTION`/`WORKSHOP`/`LAB`/`CLASSROOM`/`DORMITORY`/`CANTEEN`/`FACILITY`/`TECHNICAL_NETWORK`/`OTHER`)؛ عندما `decision_kind = HUMAN_CONFIRMATION` يجب وجود `$.missing_context` مصفوفة غير فارغة من نصوص غير فارغة؛ `$.visit_type.allowed` (عند وجود visit_type كائن) مصفوفة غير فارغة قيمها `SURPRISE`/`PLANNED` حصرًا.
  - **لا تغيير بنيوي**: لا جدول/مُشغِّل/فهرس/منظر جديد — الأعداد تبقى 15 جدولًا · 44 مُشغِّلًا · منظرًا واحدًا · 24 فهرسًا صريحًا (فرض 4A النهائي يوسّع `trg_def_bi` القائم فقط).

## 6) تدقيق قابلية التغيير الكامل (مُفعَّل بمُشغِّلات BEFORE UPDATE)

| الكيان | الثابت/المتحول المطبَّق (حسب `ENTITY-CATALOG`) | المُشغِّل |
|---|---|---|
| mission | ثابت: `mission_id`,`created_at/by` · `name` ثابت بعد الإقفال (COMPLETED/ARCHIVED) · `reference_entry_date` ثابت بعد التفعيل · متحول: description/start/end/status | `trg_mission_bu` |
| institution | ثابت: `institution_id`,`created_at/by` · متحول: كل ما عدا ذلك | `trg_institution_bu` |
| inspected_subject | ثابت: `subject_id`,`institution_id`,`created_at/by` · `subject_type`(+other) ثابت بعد أول استخدام · متحول: name/location/specialty/active | `trg_subject_bu` |
| visit | ثابت: `visit_id`,`mission_id`,`institution_id`,`visit_type`,`visit_date`,`created_at/by` · `started_at` ثابت بعد التسجيل · `finalized_at` عند الإقفال فقط · متحول: status (بقواعد)/inspector قبل الإقفال | `trg_visit_bi` + `trg_visit_bu` |
| checklist_item_definition | ثابت: item_code/version_no/supersedes/domain/question/model/priority/traceability/refs/note_rule/evidence_rule/finding_rule/**applicability_rule (بوابة 4A)** · `effective_from` ثابت بعد أول استخدام · متحول: status فقط | `trg_def_bu` |
| checklist_allowed_value | ثابت: allowed_value_id/item_definition_id/value_code/arabic_label/semantic_class/sort_order · متحول: active فقط | `trg_av_bu` |
| checklist_response | ثابت: response_id/visit_id/item_definition_id/subject_id/recorded_at/by · متحول حتى الإقفال (في PREPARATION): overlay/answered/note/reason/finding — ثم ثابت بعد الإقفال | `trg_response_bi`, `trg_response_bu`, `trg_response_finding_bi/bu` |
| equipment_reconciliation_row | ثابت: row_id/response_id/sort_order · observation قابلة للتصحيح في PREPARATION ثم ثابتة | `trg_recon_bi`, `trg_recon_bu` |
| adhoc_observation | ثابت: observation_id/visit_id/recorded_at/by · متحول حتى الإقفال: subject/text/finding | `trg_obs_bi`, `trg_obs_bu`, `trg_obs_finding_bi/bu` |
| finding | ثابت (بعد التسجيل): origin/description/defect_type(+other)/location/subject/urgency/impact/created · متحول: status/status_changed_at | `trg_finding_bi`, `trg_finding_bu` |
| evidence | ثابت: كل الحقول **ما عدا note** (owner_kind/owner_ref/storage_ref/content_hash/file_name/mime_type/file_size/captured_at/device_note/recorded_at/by) · متحول: note | `trg_evidence_bi`, `trg_evidence_bu` |
| corrective_action | ثابت: action_id/finding_id/action_type(+other)/created · متحول حتى الإقفال: description/responsible_role(+other)/responsible_name/due_date/status · closed_at/verified_by/verification_note ثابتة بعد تعيينها | `trg_ca_bi`, `trg_ca_bu` |
| follow_up | إلحاقي بحت (لا UPDATE/DELETE) | `trg_fu_bu`, `trg_fu_bd`, `trg_fu_bi` |
| external_system_tracking | إلحاقي بحت (لا UPDATE/DELETE) | `trg_ext_bu`, `trg_ext_bd` |
| report | ثابت: scope/snapshot/generation · متحول: title/status · artifacts إلحاقي · بعد GENERATED كل شيء ثابت | `trg_report_bu` |

+ 15 مُشغِّلات no-delete `*_bd` (سياسة: لا DELETE في v1، تعطيل ناعم).

## 7) استراتيجيات الفرض المتميزة (declarative / trigger / view / app)

| الفئة | العناصر |
|---|---|
| **تصريحي CHECK/FK/UNIQUE** | رموز القيم، اقتران حالة الزيارة بـ `finalized_at`، حسابات `equipment_reconciliation_row` (`difference=observed−declared`، `≥0`)، XOR الاستجابة، أعمدة OTHER الرفيقة، RESOLVED ⇐ `closed_at`+`verified_by`، `UNIQUE(item_code,version_no)`، `UNIQUE(item_definition_id,value_code)`، فهرس `uq_response_ctx` التعبيري، **قواعد `applicability_rule` الكنسية (بوابة 4A النهائية):** NOT NULL + جذر JSON صالح/كائن + `rule_schema_version` integer=1 (لا true) + `item_code` نص مطابق للصف + `decision_kind` مغلق + `subject_kinds` مصفوفة + `source_ar` نص غير فارغ + `visit_type` كائن عند وجوده |
| **TRIGGER** | الحصانة بعد الإقفال، إلحاقية `follow_up`/`external_system_tracking`، دورة حياة الزيارة (إقفال ذري)، تدقيق قابلية التغيير الكامل **مع ثبات PK لكل جدول**، نزاهة المصدر (أول مصدر في `origin_visit_id` مستثنيًا الصف الحالي + المؤسسة)، **الحفاظ على آخر مصدر لنقص غير OPEN**، منع الإجراء تحت نقص RESOLVED، قواعد CHK-012 (الجهتان: سطر/استجابة)، نزاهة سلاسل الإصدارات (`trg_def_bi`)، مرجعية مالك الأدلة، حماية الثوابت **ومنها ثبات `applicability_rule` (`trg_def_bu`) + محتوى القاعدة التكراري داخل `trg_def_bi` (subject_kinds/missing_context/visit_type.allowed عبر json_each)** |
| **VIEW** | `v_response_outcome` = `result_class` مشتق (لا مخزون مستقل) |
| **APP** | **تقييم قاعدة الانطباق** (`applicability_rule`) للتعريف المختار ضد سياق الزيارة → NA/منطبق/تأكيد مفتش (بوابة 5)، إكمال «كل البنود المنطبقة لها استجابة قبل الإقفال» (لا ChecklistSet)، تمثيل انتقالات الحالة بأحداث FollowUp، اختيار إصدار التعريف عند بدء معاينة بند، قاعدة `note_rule` الديناميكية، حكم «نقص قائم يغطي نفس المسألة»، ترتيب «نقص OPEN ← ربط مصدره الأول» ضمن معاملة |

## 8) قيود تتطلب منطق تطبيق/خدمة (APP-only) — بعد التصحيح (4A)

1. **«كل بند منطبق له استجابة قبل الإقفال»**: قاعدة **تطبيقية** — قاعدة البيانات **لا تقيّم** الانطباق ولا تعرف «البنود المنطبقة» (لا ChecklistSet — ممنوع بالتصميم المعتمد)؛ غير أنها تخزّن/تُرقّم الآن قاعدة انطباق كل تعريف (`applicability_rule`) فيقرؤها التطبيق من **الإصدار الدقيق المختار** بدل ترميز الانطباق بـ `item_code` في الكود، ثم يقيّمها ضد سياق الزيارة ويضمن قبل الإقفال أن كل بند P0/سياق ناتجه `APPLICABLE` له استجابة (و`NOT_APPLICABLE` يُسجَّل «غير معني»). قاعدة البيانات تضمن فقط عدم وجود استجابات بعد الإقفال وأن حالتي الإقفال متناسقتان مع NOT_INSPECTED/أسبابه.
2. **تمثيل كل انتقال حالة (Finding/CorrectiveAction) بحدث FollowUp** مع `status_target`/`status_after` في نفس معاملة التطبيق — الفيزيائي يضمن سلامة الصف اللاحق وإلحاقيته فقط.
3. **اختيار إصدار التعريف النشط للسياق عند بدء الزيارة** — APP (قاعدة البيانات تضمن الآن **عدم غموض ACTIVE لكل `item_code`** عبر الفهرس الجزئي الفريد `uq_active_def_per_code`؛ ثم يضمن الفيزيائي الثبات/عدم الخلط/الربط الدقيق).
4. **قاعدة ملاحظة البند الشرطية** (`note_rule`) — ديناميكية حسب التعريف.
5. **حكم ربط استجابة غير مطابقة بنقص قائم «يغطي نفس المسألة»** — الفيزيائي يضمن المؤسسة والمصدر الأول فقط.
6. **ترتيب إنشاء النقص (`OPEN`) ثم ربط مصدره الأول في زيارة الأصل** ضمن معاملة واحدة — الفيزيائي: مغادرة `OPEN` مستحيلة بلا مصدر، وأول ربط خارج زيارة الأصل مرفوض.

## 9) التحقق التنفيذي (Regression — Revision 4 / Gate 4A)

- تنفيذ `schema.sql` من الصفر (في الذاكرة وعلى ملف مؤقت — sqlite 3.45.1): **15 جدولًا · 44 مُشغِّلًا · منظر واحد · 24 فهرسًا صريحًا** (بدون تغيير عن Revision 3).
- **71 حالة (سلبي/إيجابي) — 0 فشل** عبر `tests/gate4a_regression.py` (قابلة لإعادة التشغيل من الصفر)، تشمل:
  - **حالات بوابة 4A الجديدة:**
    - تعريف `ACTIVE` (وأي تعريف) لا يمكن أن يخلو من `applicability_rule` (NOT NULL)؛ وقيم JSON غير صالحة/غير كائن مرفوضة.
    - `applicability_rule` لا يمكن تعديله على تعريف قائم (ثبات إصدار التعريف) — تغيير القاعدة يستلزم إصدارًا جديدًا.
    - إصدار جديد قد يحمل قاعدة انطباق مختلفة، وإصدار التعريف السابق تبقى قاعدته دون مساس.
    - الاستجابة التاريخية تبقى مربوطة بإصدار تعريفها الأصلي (لا إعادة ربط بإصدار أحدث)، فلا تُعاد قراءتها تحت قاعدة لاحقة، ولا خلط إصدارات لنفس السياق.
    - بنية الـ 15 جدولًا غير متغيرة + كل حمولات `APPLICABILITY-RULES-v1.md` الـ 24 (CHK-001..CHK-024) تُقبلها قواعد المخطط عند التحميل.
  - **حالات الفرز الكنسي النهائي (بوابة 4A — نفس البوابة):** رفض 20 حمولة غير كنسية: `item_code` JSON مخالف لصف `item_code`؛ `decision_kind` غير معروف؛ `subject_kinds` بنوع خاطئ/فارغة/عنصر غير معروف/عنصر غير نصي؛ `HUMAN_CONFIRMATION` بلا `missing_context` أو بمصفوفة فارغة أو عضو فارغ أو غير نصي؛ `rule_schema_version` منطقي `true` أو مفقود؛ `source_ar` فارغة أو مفقودة؛ `item_code` مفقود؛ `visit_type.allowed` بقيمة خاطئة/فارغة/بنوع خاطئ أو `visit_type` بلا `.allowed` أو غير كائن.
  - **استبقاء حالات Revision 3 الممثَّلة (إعادة تأكيد لا انحدار):** دورة حياة الزيارة وإقفالها الذري وحالتا الإقفال وشروط أسباب «لا يُعاين»، عدم إعادة الفتح، القابلية للتغيير الكاملة (تعريف/قيمة/استجابة/موضوع/نقص/إجراء/دليل/تقرير)، لا-DELETE، إلحاقية follow_up وexternal_system_tracking، XOR الاستجابة ومساءلة غير المطابقة وملكية القيمة لنفس الإصدار، تفرد الاستجابة، خلط الإصدارات، تكامل CHK-012 ثنائي الاتجاه وحسابات السطور، سلاسل إصدارات التعريفات (`trg_def_bi`) وواحد ACTIVE لكل `item_code`، المصدر الأول في `origin_visit_id`، قيود النقص/الإجراء/المتابعة، منظر `v_response_outcome` المشتق.

---

> **حالة الملف:** مخطط فيزيائي قابل للتنفيذ — بوابة رابعة (Revision 4: تصحيح بوابة 4A — عمود `applicability_rule` بلا أي تغيير بنيوي). لا SQL migrations على قاعدة حية، لا واجهات، لا توليد تقارير، لا ملفات أدلة ثنائية، لا بيانات حساسة. لم تُعدَّل ملفات البوابتين الأولى والثانية المعتمدة (`README.md`، `sources/`، `docs/requirements/`، `docs/checklists/FIELD-CHECKLIST-v1.md` و`CHECKLIST-MODEL-v1.md`)؛ التغييرات حصرًا في `docs/schema/` (هذا الملف و`schema.sql` و`CONSTRAINT-MATRIX-v1.md`)، و`docs/data-model/`، و`docs/checklists/APPLICABILITY-RULES-v1.md` (جديد)، و`tests/gate4a_regression.py` (جديد).
