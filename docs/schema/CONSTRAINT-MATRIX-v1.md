# مصفوفة القيود (Constraint Matrix) — v1 (Revision 4 — Gate 4A)

> **البوابة الرابعة:** مطابقة قواعد البوابة الثالثة (المعمارية + I1..I21) **وعمود «قابلية التغيير» في `ENTITY-CATALOG-v1.md`** بآليات الفرض الفيزيائي الحالية في `docs/schema/schema.sql` (SQLite 3) — مع تصحيح بوابة 4A: `applicability_rule` على تعريفات البنود.
> **أنواع الفرض:** `CHECK/UNIQUE/FK` · `TRIGGER` · `VIEW` · `APP` (تطبيق/خدمة مجال) · `POLICY` (سياسة v1).
> الملف يعكس **ما ينفّذه `schema.sql` فعلًا** (15 جدولًا · **44 مُشغِّلًا** · منظر واحد · **24 فهرسًا صريحًا** — تحقق تنفيذي **71/0** عبر `tests/gate4a_regression.py`).

## أ) تدقيق قابلية التغيير الشامل (السلطة: ENTITY-CATALOG)

| # | الكيان | الأصل المطبَّق | الفرض |
|---|---|---|---|
| M1 | mission | id/created ثابتة؛ name ثابت بعد الإقفال؛ reference_entry_date ثابت بعد التفعيل؛ سواها متحول | TRIGGER `trg_mission_bu` |
| M2 | institution | id/created ثابتة؛ سواها متحول | TRIGGER `trg_institution_bu` |
| M3 | inspected_subject | institution_id/created ثابتة؛ subject_type ثابت بعد أول استخدام؛ name/location/specialty/active متحول | TRIGGER `trg_subject_bu` |
| M4 | visit | mission/institution/type/date/created ثابتة؛ started_at ثابت بعد التسجيل؛ inspector/status متحولان حتى إقفال ذري | TRIGGER `trg_visit_bi`/`trg_visit_bu` + CHECK |
| M5 | checklist_item_definition | كل الحقول ثابتة ما عدا status (**ومنها `applicability_rule` — بوابة 4A**)؛ effective_from ثابت بعد أول استخدام | TRIGGER `trg_def_bu` + فرض كنسي: CHECKs `applicability_rule` (بنية) + `trg_def_bi` (محتوى تكرارى) |
| M6 | checklist_allowed_value | كل الحقول ثابتة ما عدا active (لا reparent) | TRIGGER `trg_av_bu` |
| M7 | checklist_response | visit/item/subject/recorded ثابتة؛ overlay/answered/note/reason/finding قابلة للتصحيح في PREPARATION | TRIGGER `trg_response_bu` (+bi) |
| M8 | equipment_reconciliation_row | response_id/sort_order ثابتة؛ قيم الملاحظة قابلة للتصحيح في PREPARATION | TRIGGER `trg_recon_bu` |
| M9 | adhoc_observation | observation/visit/recorded ثابتة؛ subject/text/finding قابلة للتصحيح في PREPARATION؛ ثابتة بعد الإقفال | TRIGGER `trg_obs_bu` |
| M10 | finding | كل حقول الإنشاء ثابتة (origin/description/defect(+other)/location/subject/urgency/impact/created)؛ status/status_changed_at متحولان | TRIGGER `trg_finding_bu` |
| M11 | evidence | **كل الحقول ما عدا note** ثابتة (منها storage_ref/content_hash/file_size/captured_at/device_note/recorded) | TRIGGER `trg_evidence_bu` |
| M12 | corrective_action | finding_id/action_type(+other)/created ثابتة؛ RESOLVED ⇐ closed_at+verified_by؛ close/verify ثابتة بعد التعيين | TRIGGER `trg_ca_bu` + CHECK |
| M13 | follow_up | إلحاقي بحت | TRIGGER `trg_fu_bu`/`trg_fu_bd` |
| M14 | external_system_tracking | إلحاقي بحت | TRIGGER `trg_ext_bu`/`trg_ext_bd` |
| M15 | report | scope/snapshot/generation ثابتة؛ title/status متحولان؛ artifacts إلحاقي؛ GENERATED ⇐ ثابت | TRIGGER `trg_report_bu` |

## ب) المبادئ المعمارية المحفوظة (بوابة 3) وأين تُنفَّذ الآن

| # | المبدأ | الفرض | موضع التنفيذ |
|---|---|---|---|
| A1 | 15 كيانًا/جدولًا | POLICY | `schema.sql` |
| A2 | الحقيقة الميدانية لا تُعاد كتابتها | TRIGGER | no-delete `*_bd` + تجميد ما بعد `finalized_at` + `trg_visit_bu` |
| A3 | زيارة مثبتة غير قابلة للتعديل؛ إعادة معاينة = زيارة جديدة | TRIGGER + CHECK | `trg_visit_bi`/`trg_visit_bu` + CHECK الاقتران |
| A4 | تعريفات مُرقّمة وسلسلة إصدار سليمة وACTIVE غير ملتبس + **قاعدة انطباق كنسية لكل إصدار (بوابة 4A)** | UNIQUE + INDEX + TRIGGER + CHECK | `UNIQUE(item_code,version_no)`؛ `uq_active_def_per_code`؛ `trg_def_bi/bu`؛ CHECKs `applicability_rule` + محتوى `trg_def_bi` |
| A5 | استجابة مرتبطة بالإصدار الدقيق (فتُفسَّر تحت قاعدة انطباق إصدارها) | FK + TRIGGER | `item_definition_id` FK؛ `trg_response_bi/bu` |
| A6 | لا خلط إصدارات (visit,item_code,سياق) | UNIQUE + TRIGGER | `uq_response_ctx`؛ `trg_response_bi/bu` |
| A7 | result_class مشتق | VIEW | `v_response_outcome` |
| A8 | origin_visit_id + مصدر أول في الأصل | FK + TRIGGER | `finding.origin_visit_id`؛ `trg_finding_bu`؛ `trg_response_finding_bi/bu`؛ `trg_obs_finding_bi/bu` |
| A9 | مصدرا النقص (استجابة/معاينة) | FK + TRIGGER | `checklist_response.finding_id`؛ `adhoc_observation.finding_id` |
| A10 | استعجال/أثر مطلوبان مستقلان | CHECK (+APP) | `finding.urgency/impact` NOT NULL + CHECK |
| A11 | FollowUp إلحاقي يتبع النقص | FK + TRIGGER | `follow_up.finding_id`؛ `trg_fu_bu/bd` |
| A12 | FollowUp.visit_id سياق اختياري من نفس المؤسسة | TRIGGER | `trg_fu_bi` |
| A13 | status_target يميّز الهدف | CHECK + TRIGGER | CHECKs `follow_up`؛ `trg_fu_bi` |
| A14 | ExternalSystemTracking إلحاقي | TRIGGER | `trg_ext_bu/bd` |
| A15 | EquipmentReconciliationRow = لقطة ملاحظة مع اتساق ثنائي الاتجاه مع الاستجابة | CHECK + TRIGGER | `trg_recon_bi/bu` + `trg_response_chk012_bu`؛ تحيين «تسيير» خارجي |
| A16 | الأدلة metadata فقط | POLICY | جدول `evidence` بلا أعمدة ثنائية + `storage_ref` |
| A17 | Report P0 metadata | POLICY | جدول `report` |

## ج) قواعد النزاهة I1..I21 → الفرض الحالي

| # | القاعدة | الفرض | موضع التنفيذ |
|---|---|---|---|
| I1 | ثبات اللقطة بعد الإقفال | TRIGGER | `trg_visit_bu`, `trg_response_bu`, `trg_recon_bu`, no-delete |
| I2 | مساءلة غير المطابقة | TRIGGER | `trg_response_bi`/`trg_response_bu` |
| I3 | «غير معني» ≠ «لا يُعاين» + حالتا الإقفال | CHECK + TRIGGER | overlay CHECK؛ `visit.status` CHECK؛ `trg_visit_bu` |
| I4 | مصدر النقص وأصل الزيارة | TRIGGER | `trg_finding_bu`، `trg_response_finding_*`، `trg_obs_finding_*`، `trg_fu_bi` |
| I5 | استقلال التصنيف | CHECK | `finding.urgency/impact` |
| I6 | الأدلة اختيارية + metadata | POLICY/TRIGGER | لا إلزام؛ `evidence` |
| I7 | ملكية الإجراء | FK | `corrective_action.finding_id` |
| I8 | FollowUp إلحاقي بمعنًى مزدوج (نقص/إجراء) + status_target | CHECK + TRIGGER + APP | CHECKs + `trg_fu_bi`؛ أحداث الانتقال APP |
| I9 | أحداث خارجية إلحاقية منفصلة | TRIGGER | `trg_ext_bu/bd` |
| I10 | تقييد التاريخ المرجعي | POLICY | `mission.reference_entry_date` |
| I11 | إصدار التعريفات (ثبات/لا إعادة تفسير + predecessor سليم + ACTIVE واحد) — **وإلزام كل تعريف بقاعدة انطباق كنسية (`applicability_rule`) وثباتها مع إصداره** | UNIQUE + INDEX + TRIGGER + CHECK | `trg_def_bi/bu`, `trg_av_bu`, `uq_active_def_per_code`, ربط الاستجابة، CHECKs `applicability_rule` (بنية) + `trg_def_bi` (محتوى: subject_kinds/missing_context/visit_type.allowed) (بوابة 4A) |
| I12 | بنية/حسابات CHK-012 واتساق النتيجة الإجمالية ثنائي الاتجاه | CHECK + TRIGGER | CHECKs الصف؛ `trg_recon_bi/bu` + `trg_response_chk012_bu` |
| I13 | سلامة القيمة واشتقاق result_class | FK + TRIGGER + VIEW | `trg_response_bi/bu`؛ `v_response_outcome` |
| I14 | تفرد الاستجابة | UNIQUE | `uq_response_ctx` |
| I15 | اتساق الإقفال | TRIGGER | `trg_finding_bu`, `trg_ca_bu` |
| I16 | اتساق المؤسسة | TRIGGER | `trg_response_bi/bu`, `trg_obs_bi/bu`, `trg_finding_bi`, `trg_fu_bi` |
| I17 | مرجعية الدليل | TRIGGER | `trg_evidence_bi` |
| I18 | أثر التسجيل | CHECK/POLICY | `recorded_at/by`/`created_at/by` NOT NULL |
| I19 | لا إعادة فتح في v1 | TRIGGER | `trg_visit_bu` |
| I20 | فصل الكيان عن التنفيذ (Report) | POLICY | جدول `report` بلا توليد |
| I21 | إصدار واحد لكل (visit,item_code,سياق) | UNIQUE + TRIGGER | `uq_response_ctx`؛ `trg_response_bi/bu` |

## د) سياسات فيزيائية

| # | السياسة | الفرض | موضع التنفيذ |
|---|---|---|---|
| P1 | لا DELETE (تعطيل ناعم) | TRIGGER | 15 × `*_bd` |
| P2 | الكتابة في الزيارة فقط بحالة PREPARATION | TRIGGER | `trg_response_bi`, `trg_recon_bi`, `trg_obs_bi`, `trg_response_bu`… |
| P3 | إلحاقية follow_up و external_system_tracking | TRIGGER | `trg_fu_bu`, `trg_ext_bu` |
| P4 | FK مفعّلة على كل اتصال | PRAGMA | `PRAGMA foreign_keys=ON` |
| P5 | OTHER ⇐ نص حر إلزامي (Q1) | CHECK | أعمدة `*_other`/`status_detail`/`discrepancy_desc` + CHECKs (جدول في PHYSICAL §3) |
| P6 | فهارس مبررة | INDEX | `uq_response_ctx`, FK indexes, `(owner_kind,owner_ref)`, `(finding_id,event_datetime)` |
| P7 | قاعدة انطباق كل تعريف إلزامية وكنسية ومربوطة بإصداره (بوابة 4A) | CHECK + TRIGGER | `applicability_rule TEXT NOT NULL` + CHECKs (جذر JSON كائن، `rule_schema_version` integer=1 — لا true، `item_code` نص مطابق للصف، `decision_kind` مغلق، `subject_kinds` مصفوفة، `source_ar` نص غير فارغ، `visit_type` كائن عند وجوده) + محتوى `trg_def_bi` (subject_kinds/missing_context/visit_type.allowed) + ثباتها في `trg_def_bu` |

## هـ) الحفاظ على مصادر النقص (نقطة 5 في التصحيح)

- النمط المعتمد: إنشاء النقص **OPEN** ثم ربط مصدره الأول في زيارة الأصل **ضمن معاملة التطبيق** (APP).
- الفيزيائي يضمن: مغادرة OPEN تتطلب مصدرًا مسجلًا (`trg_finding_bu`)؛ الربط الأول خارج زيارة الأصل مرفوض (`trg_response_finding_bi/bu`، `trg_obs_finding_bi/bu`)؛ **بعد مغادرة OPEN لا يجوز حذف/إعادة توزيع آخر مصدر** (الحارس في `trg_response_bu` و`trg_obs_bu`)؛ الربط اللاحق لنفس المؤسسة فقط.
- حالات إعادة التوزيع إلى نقص آخر مع بقاء مصادر كافية: تخضع لنفس قواعد المؤسسة/الأول/المساءلة (APP للتحقق من «نفس المسألة»).

## و) خلاصة القيود غير القابلة للفرض التصريحي (APP-only) — بعد تصحيح بوابة 4A

1. **تقييم قاعدة الانطباق وإكمال المعاينة**: قاعدة البيانات تخزّن/تُرقّم/تحفظ قاعدة انطباق كل تعريف (`applicability_rule`) **وتقييمها تطبيقي** — يقرأ التطبيق قاعدة **الإصدار الدقيق المختار** ويقيّمها ضد سياق الزيارة (نوع الزيارة/الموضوع/المهمة/المؤسسة — السلطة: `docs/checklists/APPLICABILITY-RULES-v1.md`) ويُنتج `NOT_APPLICABLE`(NA)/`APPLICABLE`(إجابة أو لا يُعاين)/`HUMAN_CONFIRMATION`(قرار المفتش)؛ ثم «كل بند منطبق له استجابة قبل الإقفال» — APP (لا ChecklistSet بالتصميم، والفيزيائي لا يقيّم الانطباق).
2. **أحداث الانتقال**: كل انتقال حالة (Finding/CorrectiveAction) يُمثَّل بحدث FollowUp (`status_target`/`status_after`) — APP ضمن معاملة (الفيزيائي يضمن إلحاقية وسلامة الصف).
3. **اختيار إصدار التعريف النشط للسياق عند بدء الزيارة** — APP؛ قاعدة البيانات تضمن **عدم غموض ACTIVE لكل `item_code`** (فهرس جزئي فريد `uq_active_def_per_code`) ثم الثبات/عدم الخلط/الربط الدقيق.
4. **قاعدة ملاحظة البند الشرطية** (`note_rule`) — APP/طبقة تحقق (تعريفية ديناميكية).
5. **ربط غير المطابقة بنقص قائم «يغطي نفس المسألة»** — حكم APP (الفيزيائي يضمن المؤسسة + أول مصدر + الحفاظ على آخر مصدر).
6. **ترتيب النقص OPEN ← ربط المصدر الأول** ضمن معاملة — APP (قيود الفيزيائي داعمة كما في «هـ»).
7. **مصادقة الملفات/`content_hash` الفيزيائية** ومدى الاحتفاظ — بوابة تخزين لاحقة (قرار Q5).

## ز) التحقق التنفيذي (Regression — Revision 4 / Gate 4A)

- تنفيذ `schema.sql` من الصفر (SQLite 3.45.1 في الذاكرة وعلى ملف مؤقت): **15 جدولًا · 44 مُشغِّلًا · منظر `v_response_outcome` · 24 فهرسًا صريحًا** (بدون تغيير).
- **71 حالة — 0 فشل** عبر `tests/gate4a_regression.py`، وتشمل استبقاءً ممثَّلًا لحالات Revision 2/3 (إقفال بلا `finalized_at`، PREPARATION مع `finalized_at`، COMPLETED مع NOT_INSPECTED، أسبابهما، عدم إعادة الفتح، تغيير مؤسسة/تاريخ/مهمة الزيارة، تغيير نوع موضوع مستخدم، تعديل قواعد تعريف، إعادة توزيع ChecklistAllowedValue، موضوعات عبر المؤسسات، آخر مصدر لنقص غير OPEN، إجراء تحت نقص RESOLVED، RESOLVED بلا `verified_by`، metadata الأدلة، خلط إصدارات، update على follow_up وexternal_system_tracking، no-delete، المصدر الأول، CHK-012 ثنائي الاتجاه، سلاسل الإصدارات، ACTIVE الواحد، منظر النتيجة المشتق) **بالإضافة إلى حالات بوابة 4A**:
  - **تعريف `ACTIVE` (وأي تعريف) لا يمكن أن يخلو من `applicability_rule`** (NOT NULL)؛ وجذر JSON غير صالح/غير كائن مرفوض.
  - **`applicability_rule` لا يمكن تعديله على تعريف قائم** (ثبات إصدار التعريف عبر `trg_def_bu`) — تغيير الانطباق يستلزم إصدار تعريف جديدًا.
  - **إصدار جديد قد يحمل قاعدة انطباق مختلفة** بينما يبقى تعريف الإصدار الأسبق دون مساس.
  - **الاستجابة التاريخية تبقى مربوطة بإصدار تعريفها الأصلي** (لا إعادة ربط بإصدار أحدث) — ولا خلط إصدارات لنفس (زيارة، بند، سياق) — فتُفسَّر تحت قاعدة انطباق إصدارها.
  - **بنية الـ 15 جدولًا غير متغيرة** + **كل حمولات الانطباق الكنسية الـ 24** (CHK-001..CHK-024 في `docs/checklists/APPLICABILITY-RULES-v1.md`) تُقبلها قواعد المخطط عند التحميل.
  - **الفرز الكنسي النهائي (20 رفضًا):** `item_code` JSON ≠ صف `item_code`؛ `decision_kind` غير معروف؛ `subject_kinds` غير مصفوفة/فارغة/عنصر غير معروف/عنصر غير نصي؛ `HUMAN_CONFIRMATION` بلا `missing_context`/فارغة/عضو فارغ/عضو غير نصي؛ `rule_schema_version` منطقي `true` أو مفقود؛ `source_ar` فارغة أو مفقودة؛ `item_code` مفقود؛ `visit_type.allowed` قيمة خاطئة/فارغة/بنوع خاطئ؛ `visit_type` بلا `.allowed` أو غير كائن.
