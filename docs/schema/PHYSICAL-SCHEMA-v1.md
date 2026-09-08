# المخطط الفيزيائي/القابل للتنفيذ (Physical / Executable Data Schema) — v1

> **الإصدار:** v1 · Revision 3 (تصحيح البوابة الرابعة النهائي — إغلاق فجوات الفرض المتبقية: المصدر الأول للاستجابة، تكامل CHK-012 ثنائي الاتجاه، ثبات PK، نزاهة سلاسل إصدارات التعريفات، تقوية Q1).
> **البوابة:** الرابعة — ترجمة النموذج المنطقي المعتمد (البوابة الثالثة) إلى مخطط بيانات فيزيائي قابل للتنفيذ لنسخة المفتش الميداني الأولى.
> **المراجع:** `docs/data-model/DATA-MODEL-v1.md` (القواعد I1..I21) و`ENTITY-CATALOG-v1.md` (عمود «قابلية التغيير» = سلطة التدقيق)، و`docs/requirements/*` و`docs/checklists/*`.
> **التقنية المعتمدة:** **SQLite 3** (مدمج/ملف) — لا تغيير في القرار (مبرراته أدناه).
> **الأعداد المعتمدة الآن:** **15 جدولًا · 44 مُشغِّلًا (trigger) · منظر واحد · 24 فهرسًا صريحًا** — تأكيد بالتنفيذ الفعلي.
> **نتيجة التحقق:** **75 اختبارًا (سلبي/إيجابي) — 0 فشل** على sqlite 3.45 (انظر القسم 9).
> لا واجهات، لا تطبيق، لا توليد تقارير؛ لا تُخزَّن ملفات أدلة ثنائية في المخطط أو في GitHub.

---

## 1) النطاق والأهداف

- المخطط يحفظ **دورة الحياة الكاملة لمعلومة التفتيش** (15 كيانًا) وينفّذ قواعد البوابة الثالثة على مستوى التخزين.
- **الحقائق الميدانية التاريخية لا تُعاد كتابتها**؛ تحيين «تسيير» التصحيحي منفصل عن لقطة المطابقة.
- **الزيارة المثبتة (finalized) غير قابلة للتعديل في v1**؛ إعادة معاينة = زيارة جديدة.
- التعريفات مُرقّمة ومرتبطة بالاستجابة بإصدارها الدقيق؛ **لا خلط إصدارات** لنفس `(visit_id, item_code, سياق)`.
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

> التفاصيل الكاملة لكل عمود ونوع وFK/CHECK في الملف التنفيذي. أبرز عناصر Revision 3:

- **visit**: إضافة **CHECK اقتراني** — `(status='PREPARATION' AND finalized_at IS NULL) OR (status IN ('COMPLETED','COMPLETED_WITH_UNINSPECTED') AND finalized_at IS NOT NULL)`.
- **finding**: عمود `defect_type_other`؛ **corrective_action**: عمودا `action_type_other` و`responsible_role_other`؛ **follow_up**: عمود `actor_role_other`.
- بقية الأعمدة والـ FKs والفهارس كما في Revision 1 (`uq_response_ctx` التعبيري للتفرد، فهارس FK المبررة، فهرس `(owner_kind, owner_ref)`، `(finding_id,event_datetime)`).
- **إضافات Revision 3 (التصحيح النهائي):**
  - **PK لكل جدول ثابت بمُشغِّل مستقل** (لا اعتماد على تأثير FK) — أُغلقت الثغرات المتبقية: `visit.visit_id`، `checklist_item_definition.item_definition_id`، `checklist_response.response_id`، `equipment_reconciliation_row.row_id`، `finding.finding_id`، `evidence.evidence_id` (وبقية الجداول كانت مغطاة).
  - **نزاهة سلاسل الإصدارات**: فهرس جزئي فريد `uq_active_def_per_code` (تعريف `ACTIVE` واحد لكل `item_code`) + مُشغِّل `trg_def_bi` (قبل الإدراج): `supersedes_definition_id` يجب أن يشير لنفس `item_code`، وألا يشير للتعريف نفسه، وأن يكون لإصدار **أسبق** (`version_no` أدنى).
  - **تكامل CHK-012 ثنائي الاتجاه**: مُشغِّل جديد `trg_response_chk012_bu` على جهة الاستجابة — تحويل النتيجة الإجمالية إلى `COMPLIANT` مرفوض إذا وُجد أي سطر فارق؛ وتحويلها إلى أي `overlay_state` (NA/NOT_INSPECTED) مرفوض إذا وُجدت سطور؛ وسطور الإدراج مرفوضة مع **أي** overlay. تعريف «الفارق» الموحَّد: `difference <> 0 OR discrepancy_type IS NOT NULL` (لا فارق صفري مع نوع مُعلَن).
  - **المصدر الأول للاستجابة**: فحص «أول مصدر في `origin_visit_id`» في مساري INSERT وUPDATE **يستثني الصف الحالي** (مكافئ لمنطق AdHocObservation) — ربط أول من زيارة غير زيارة الأصل مرفوض.
  - **Q1**: جميع أعمدة OTHER الرفيقة تُفحص بـ `length(trim(x)) > 0` (نص ذو معنى لا مسافات فقط).

## 6) تدقيق قابلية التغيير الكامل (مُفعَّل بمُشغِّلات BEFORE UPDATE)

| الكيان | الثابت/المتحول المطبَّق (حسب `ENTITY-CATALOG`) | المُشغِّل |
|---|---|---|
| mission | ثابت: `mission_id`,`created_at/by` · `name` ثابت بعد الإقفال (COMPLETED/ARCHIVED) · `reference_entry_date` ثابت بعد التفعيل · متحول: description/start/end/status | `trg_mission_bu` |
| institution | ثابت: `institution_id`,`created_at/by` · متحول: كل ما عدا ذلك | `trg_institution_bu` |
| inspected_subject | ثابت: `subject_id`,`institution_id`,`created_at/by` · `subject_type`(+other) ثابت بعد أول استخدام · متحول: name/location/specialty/active | `trg_subject_bu` |
| visit | ثابت: `visit_id`,`mission_id`,`institution_id`,`visit_type`,`visit_date`,`created_at/by` · `started_at` ثابت بعد التسجيل · `finalized_at` عند الإقفال فقط · متحول: status (بقواعد)/inspector قبل الإقفال | `trg_visit_bi` + `trg_visit_bu` |
| checklist_item_definition | ثابت: item_code/version_no/supersedes/domain/question/model/priority/traceability/refs/note_rule/evidence_rule/finding_rule · `effective_from` ثابت بعد أول استخدام · متحول: status فقط | `trg_def_bu` |
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
| **تصريحي CHECK/FK/UNIQUE** | رموز القيم، اقتران حالة الزيارة بـ `finalized_at`، حسابات `equipment_reconciliation_row` (`difference=observed−declared`، `≥0`)، XOR الاستجابة، أعمدة OTHER الرفيقة، RESOLVED ⇐ `closed_at`+`verified_by`، `UNIQUE(item_code,version_no)`، `UNIQUE(item_definition_id,value_code)`، فهرس `uq_response_ctx` التعبيري |
| **TRIGGER** | الحصانة بعد الإقفال، إلحاقية `follow_up`/`external_system_tracking`، دورة حياة الزيارة (إقفال ذري)، تدقيق قابلية التغيير الكامل **مع ثبات PK لكل جدول**، نزاهة المصدر (أول مصدر في `origin_visit_id` مستثنيًا الصف الحالي + المؤسسة)، **الحفاظ على آخر مصدر لنقص غير OPEN**، منع الإجراء تحت نقص RESOLVED، قواعد CHK-012 (الجهتان: سطر/استجابة)، نزاهة سلاسل الإصدارات (`trg_def_bi`)، مرجعية مالك الأدلة، حماية الثوابت |
| **VIEW** | `v_response_outcome` = `result_class` مشتق (لا مخزون مستقل) |
| **APP** | إكمال «كل البنود المنطبقة لها استجابة قبل الإقفال» (لا ChecklistSet)، تمثيل انتقالات الحالة بأحداث FollowUp، اختيار إصدار التعريف عند بدء معاينة بند، قاعدة `note_rule` الديناميكية، حكم «نقص قائم يغطي نفس المسألة»، ترتيب «نقص OPEN ← ربط مصدره الأول» ضمن معاملة |

## 8) قيود تتطلب منطق تطبيق/خدمة (APP-only) — بعد التصحيح

1. **«كل بند منطبق له استجابة قبل الإقفال»**: قاعدة **تطبيقية** (الفيزيائي لا يعرف «البنود المنطبقة» دون ChecklistSet — ممنوع إنشاؤه بالتصميم المعتمد). قاعدة البيانات تضمن فقط عدم وجود استجابات بعد الإقفال وأن حالتي الإقفال متناسقتان مع NOT_INSPECTED/أسبابه.
2. **تمثيل كل انتقال حالة (Finding/CorrectiveAction) بحدث FollowUp** مع `status_target`/`status_after` في نفس معاملة التطبيق — الفيزيائي يضمن سلامة الصف اللاحق وإلحاقيته فقط.
3. **اختيار إصدار التعريف النشط للسياق عند بدء الزيارة** — APP (قاعدة البيانات تضمن الآن **عدم غموض ACTIVE لكل `item_code`** عبر الفهرس الجزئي الفريد `uq_active_def_per_code`؛ ثم يضمن الفيزيائي الثبات/عدم الخلط/الربط الدقيق).
4. **قاعدة ملاحظة البند الشرطية** (`note_rule`) — ديناميكية حسب التعريف.
5. **حكم ربط استجابة غير مطابقة بنقص قائم «يغطي نفس المسألة»** — الفيزيائي يضمن المؤسسة والمصدر الأول فقط.
6. **ترتيب إنشاء النقص (`OPEN`) ثم ربط مصدره الأول في زيارة الأصل** ضمن معاملة واحدة — الفيزيائي: مغادرة `OPEN` مستحيلة بلا مصدر، وأول ربط خارج زيارة الأصل مرفوض.

## 9) التحقق التنفيذي (Regression — Revision 3)

- تنفيذ `schema.sql` من الصفر في ذاكرة SQLite 3.45.1: **15 جدولًا · 44 مُشغِّلًا · منظر واحد · 24 فهرسًا صريحًا**.
- **75 حالة (سلبي/إيجابي) — 0 فشل**، تشمل (إضافةً إلى كل حالات Revision 2 المحتفَظ بها):
  - **المصدر الأول للاستجابة**: ربط أول استجابة لنقص من زيارة غير `origin_visit_id` مرفوض في مساري INSERT وUPDATE؛ والمصدر الأول من زيارة الأصل مقبول.
  - **CHK-012 ثنائي الاتجاه**: تحويل الأصل إلى `COMPLIANT` مع سطر فارق (بما فيه فارق نوعي بفارق كمي صفري) مرفوض؛ تحويل الأصل إلى `NOT_INSPECTED`/`NA` مع وجود سطور مرفوض؛ إدراج سطور تحت أي overlay مرفوض؛ سطر بفارق كمي 0 مع `discrepancy_type` تحت COMPLIANT مرفوض.
  - **ثبات PK**: 6 اختبارات PK (visit/definition/response/row/finding/evidence).
  - **سلاسل الإصدارات**: إحالة عبر item_code مختلف مرفوضة، الإحالة الذاتية مرفوضة، إصدار أسبق يشير لإصدار لاحق مرفوض، تعريفان ACTIVE لنفس item_code مرفوضان، «أرشفة القديم ثم تفعيل الجديد» مقبول.
  - استبقاء كل حالات Revision 2 (دورة حياة الزيارة، القابلية للتغيير، المؤسسة، آخر مصدر، الإجراءات، الأدلة، خلط الإصدارات، FollowUp...).

---

> **حالة الملف:** مخطط فيزيائي قابل للتنفيذ — بوابة رابعة (Revision 3). لا SQL migrations على قاعدة حية، لا واجهات، لا توليد تقارير، لا ملفات أدلة ثنائية، لا بيانات حساسة. لم تُعدَّل ملفات معتمدة خارج `docs/schema/`.
