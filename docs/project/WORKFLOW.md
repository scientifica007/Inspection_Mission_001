# PROJECT WORKFLOW — Inspection_Mission_001

> **الغرض:** توثيق طريقة إدارة المشروع بحيث يستطيع إنسان أو AI جديد مواصلة العمل دون الاعتماد على تاريخ المحادثات.

## 1) القاعدة الحاكمة

كل عمل جوهري يبدأ من **Fresh Read لـGitHub `main`**.

لا تعتمد على:

- ذاكرة ChatGPT؛
- Prompt handoff خارجي؛
- فرع feature قديم؛
- نسخة محلية غير محدثة؛
- تقرير implementation agent وحده دون مراجعة artifact الفعلي عندما تكون المهمة implementation-sensitive.

الـ`main` الحي + artifacts داخله هما المرجع الرسمي.

## 2) دورة العمل القياسية

الـdefault implementation workflow الحالي هو قرار `PROJECT` من مالك المشروع:

**ChatGPT + GitHub + GitHub Actions**

والدورة التشغيلية المعتادة هي:

```text
Fresh Read main
→ Reviewing / Planning AI يحدد exactly one scoped Gate/task
→ create a dedicated GitHub branch
→ Independent ChatGPT Implementation Agent ينفذ داخل النطاق فقط
→ GitHub Actions + focused tests / required regressions
→ implementation report
→ Reviewing / Planning AI يقرأ actual diff/files/CI
→ adversarial review / limited correction if required
→ Project Owner approval
→ PR to main
→ merge
→ Fresh Read main
→ reconcile CURRENT-STATE / baselines / engineering memory
→ mark Gate CLOSED/ADOPTED/MERGED when closure conditions are satisfied
→ only then consider the next Gate
```

لا تتجاوز خطوة review أو remote verification في المهام الحساسة.

عندما تكون الاستقلالية في المراجعة مهمة، يجب أن يكون Reviewing/Planning AI والـIndependent ChatGPT Implementation Agent دورين منفصلين.

يمكن استبدال ChatGPT implementation agent بimplementation agent آخر إذا اقتضت المهمة ذلك؛ القرار الحالي default workflow وليس قيدًا معماريًا دائمًا.

## 3) أدوار العمل

### Project Owner

- يعتمد القرارات المعمارية والمتطلبات PROJECT.
- يوافق على فتح Gate جديدة أو إعادة فتح Gate مغلقة عند وجود سبب تنفيذي ملموس.
- يعتمد تغيير الـdefault tooling/workflow.
- يوافق على PR/main بعد اكتمال التنفيذ والمراجعة.
- ينفذ عادةً Git المحلي الروتيني عندما يكون العمل محليًا: switch/fetch/pull/status/add/commit/push وحذف الفروع المنتهية.

### Reviewing / Planning AI

- يبدأ دائمًا بـFresh Read من `main`.
- يحدد Gate الحالية وحدودها.
- يكتب implementation brief / prompt ضيقًا.
- يحدد required tests/CI evidence.
- يراجع final report وactual files/diff/CI.
- لا يصدر acceptance recommendation من التقرير وحده إذا كانت correctness تعتمد على التنفيذ الفعلي.
- يطلب correction ضيقًا عند الحاجة.
- يتحقق من remote branch بعد push.
- يرفع recommendation للمالك، وينشئ PR/merge فقط عندما يكون مخولًا بذلك.
- يجري Fresh Read نهائية بعد merge.
- يتحقق من أن القرارات والحوادث المهمة التي تؤثر في العمل المستقبلي موثقة في `docs/project/ENGINEERING-DECISIONS-AND-INCIDENTS.md` أو مرتبطة منه إلى سجل أكثر تفصيلًا.

### Independent ChatGPT Implementation Agent — DEFAULT

- ينفذ المهمة المحددة فقط على dedicated GitHub branch.
- يستخدم GitHub وGitHub Actions كمسار التنفيذ/التحقق الافتراضي.
- لا يقرر roadmap جديدة من تلقاء نفسه.
- لا يعيد فتح Gate مغلقة دون contradiction تنفيذي موثق وموافقة المالك.
- لا يبدأ Gate لاحقة.
- يشغّل focused tests وrequired regressions ضمن النطاق.
- يقدّم final implementation report يتضمن branch/SHA/diff/CI.
- يذكر صراحة أي incident أو workaround أو rejected candidate أو assumption تغيّر أثناء التنفيذ إذا كان له أثر مستقبلي.
- يتوقف بعد التسليم للمراجعة ولا يدمج إلى `main` دون owner approval/authorization.

### Alternative implementation / local execution agent

يمكن استبدال الـdefault executor بأي implementation agent آخر عند الحاجة، مع بقاء نفس حدود النطاق والمراجعة والـbranch discipline.

Harness أو أي local execution agent **ليس مكوّنًا روتينيًا افتراضيًا**. يُستخدم **ON_DEMAND_ONLY** عندما تتطلب المهمة فعليًا قدرة محلية/فيزيائية لا توفرها GitHub-hosted CI بكفاءة، مثل:

- physical Android phone؛
- ADB / USB؛
- real local-device lifecycle؛
- hardware-specific reproduction؛
- local filesystem/device behavior unavailable in GitHub-hosted execution.

استخدام local agent عند الحاجة لا يغيّر سلطة `main` ولا يعفي من حفظ الأدلة القابلة للمراجعة في GitHub.

## 4) قاعدة الفروع

لكل Gate أو correction ذات معنى فرع مستقل.

أمثلة النمط:

```text
harness/gate5l-current-visit-state-v1
architecture/gate6a-product-runtime-v1
docs/memory-handoff-hardening-v1
```

لا تعمل مباشرة على `main` في تطوير Gate عادية أو documentation hardening متعمد. إذا وقع write مباشر إلى `main` خطأً، لا تُخفه ولا تعيد كتابة التاريخ: أوقف العمل، أعد tree إلى الحالة المقصودة بأضيق corrective commit، وثّق الحادث إذا كان ذا قيمة تشغيلية، ثم استأنف على branch مستقلة.

قبل العمل على الفرع:

1. تحقق من HEAD الحاكم في `main`.
2. أنشئ الفرع من ذلك الـHEAD.
3. تحقق أن working tree نظيفة قبل بدء التنفيذ، ما لم تكن هناك حالة recovery موثقة.

## 5) قاعدة Gates المغلقة

Gate مغلقة لا تُفتح بسبب:

- تحسين أسلوب؛
- refactor غير ضروري؛
- رغبة في إعادة تصميم؛
- اختلاف تفضيل هندسي.

يمكن إعادة لمس artifact مغلق فقط إذا ظهر:

> **Concrete reproducible executable contradiction**

أي حالة تنفيذية قابلة للإثبات تناقض عقدًا معتمدًا.

عندها:

1. STOP التقدم العادي.
2. وثق reproduction والقاعدة المنتهكة.
3. اطلب/ثبت authorization لإعادة الفتح الضيق.
4. اسمح بتعديل أقل عدد ممكن من الملفات.
5. لا تحول التصحيح إلى redesign.
6. أعد regression suite الخاصة بالـGate وكل baselines الأعلى المتأثرة.
7. اذكر التصحيح صراحة في PR/merge history.
8. أضف/حدّث سجل incident/decision في `ENGINEERING-DECISIONS-AND-INCIDENTS.md` إذا كان التصحيح يؤثر في المعرفة المستقبلية للمشروع.

Gate 5E contextual AUTO-NA correction مثال معتمد على هذا الاستثناء.

## 6) قواعد التتبع والمصادر

- `DIRECT`: نص رسمي صريح.
- `DERIVED`: أثر تنفيذي مشتق.
- `PROJECT`: قرار مالك المشروع.

ممنوع نسبة `PROJECT` إلى المصادر الرسمية.

ملفات `sources/` لا تُعدل عند اشتقاق requirement أو design.

قرارات أدوات التنفيذ والـdefault workflow تصنّف `PROJECT` ما لم يوجد مصدر رسمي مستقل يقول غير ذلك.

### 6A) سجل القرارات والحوادث الهندسية

الملف:

`docs/project/ENGINEERING-DECISIONS-AND-INCIDENTS.md`

هو index دائم للقرارات والحوادث الهندسية ذات القيمة المستقبلية. لا يحل محل العقود أو proof documents أو Git history؛ بل يربطها في سجل واحد قابل للقراءة.

سجّل بندًا عندما يتحقق واحد أو أكثر مما يلي:

- ظهر executable contradiction أو failure مهم؛
- ثبت root cause يجب ألا يُنسى؛
- رُفض candidate/primitive/plugin بعد اختبار أو تحليل؛
- اتُّخذ قرار PROJECT يفرض قيدًا أو compatibility floor أو threat boundary؛
- تغيّر تفسير failure من product defect إلى tooling/CI/qualification defect أو العكس؛
- حدث incident في workflow قد يتكرر؛
- تم تصحيح closed Gate بتفويض ضيق؛
- نتج عن القرار baseline أو guard أو constraint يجب الحفاظ عليه مستقبلًا.

الحد الأدنى لكل سجل:

`ID / date / Gate / type / status / classification / problem-or-decision / evidence / root-cause-or-rationale / decision-or-resolution / consequences / validation / authoritative references`.

إذا لم يكن root cause مثبتًا، اكتب `UNKNOWN/UNESTABLISHED` بدل التخمين. لا تعِد تصنيف evidence تاريخية بعد نجاح لاحق؛ سجل progression صراحة.

## 7) مراجعة implementation-sensitive Gates

عند مراجعة core logic / transaction / reconstruction / persistence:

- لا تعتمد على report agent وحده.
- افحص actual diff أو الملفات/ZIP.
- تحقق من transaction boundaries.
- تحقق من no-write/read-only claims فعليًا.
- تحقق من عدم وجود lookup إلى authority غير معتمدة.
- أعد تشغيل focused suite، ويفضل baselines المرتبطة.
- افحص `git diff --check`.
- تأكد من أن status لا يحتوي ملفات غير متوقعة.
- افحص GitHub Actions الفعلية عندما تكون جزءًا من acceptance evidence.

إذا كانت correction comment-only محددة الموضع بعد مراجعة تنفيذية مكتملة، يكفي focused regression + diff check ما لم يظهر سبب جديد.

## 8) قواعد الاختبارات

- Baselines الحالية موثقة في `docs/project/TEST-BASELINES.md`.
- لا تُضعف test سابقة لتسهيل Gate جديدة.
- أي baseline جديدة يجب أن تكون additive أو مفسرة بقرار owner-authorized واضح.
- schema regression تبقى جزءًا من cross-cutting verification عند التعديلات القريبة من DB semantics.
- GitHub Actions هي CI الافتراضية، لكنها لا تستبدل physical-device proof عندما يكون ذلك جزءًا من عقد Gate.

## 9) Remote verification قبل merge

بعد push:

1. تحقق أن remote feature branch يشير إلى commit المتوقع.
2. تحقق أنه ahead/behind من `main` كما هو متوقع.
3. راجع changed files؛ لا ملفات زائدة.
4. راجع required GitHub Actions/statuses.
5. ثبّت expected head SHA عند merge إذا كانت الأداة تدعم ذلك.
6. بعد merge اقرأ `main` الحي وتحقق من merge commit.

لا تعتبر `git push` وحدها إغلاقًا للـGate.

## 10) بعد merge

- مزامن النسخة المحلية مع `main`.
- تحقق من HEAD/status.
- يمكن حذف feature branch محليًا وبعيدًا بعد التأكد من الدمج، ما لم يكن الفرع محفوظًا كexperiment evidence بقرار صريح.
- حدّث `CURRENT-STATE` عندما يتغير: آخر Gate مغلقة، Gate التالية، baselines، roadmap أو default workflow.
- حدّث `ENGINEERING-DECISIONS-AND-INCIDENTS.md` عندما يُغلق incident أو يُعتمد قرار ذو أثر مستقبلي.
- إذا أصبح README أو START-HERE أو WORKFLOW stale، أصلحه قبل تراكم drift.

## 11) حدود البيانات الحساسة

GitHub ليس storage للتشغيل الميداني الحقيقي.

لا ترفع:

- صور تفتيش حقيقية؛
- Evidence فعلية؛
- بيانات شخصية أو حساسة؛
- production databases؛
- أسرار أو API keys؛
- device serial numbers.

استخدم فقط synthetic fixtures في tests/proof artifacts.

## 12) المرحلة الحالية

- Gates 1→5L مغلقة؛ وتصحيح Gate 5B الضيق حول `SqlResult.lastInsertRowid` **MERGED / RESOLVED** عند `608314ae62721af44d8ed4f50c1c618ac469fc66`.
- Gate 6A **CLOSED / MERGED**.
- Gate 6B **CLOSED / MERGED** عبر PR #17؛ reviewed head `04dcf001e5494c38258c7112619ea1d508af694c`؛ merge SHA `0905c6111269d62480e7ccadc31786bef29f3c51`.
- Adapter Qualification الفيزيائية على `87135cfe80ae3de79a34e941828249fc6889139c` **PASS Q1→Q12**؛ Q12=`PHYSICAL_PASS_REVIEW_ACCEPTED`.
- Gate 6C-A **CLOSED / MERGED**.
- Gate 6C-B **CLOSED / MERGED** عبر PR #21؛ adopted host baseline **85 / 0**.
- Gate 6C-C **CLOSED / MERGED**: final reviewed head `9de6c69eef90c490319c02eac48d236482597210`؛ exact-final-SHA qualification run `34531511138` SUCCESS؛ implementation merge عبر PR #23 عند `f221b215358f83dce381ac5261a856a7de4e5c98`؛ post-merge closure reconciliation عبر PR #24.
- Gate 6C ككل **IN_PROGRESS**.
- **Gate 6C-D = NEXT / NOT_STARTED**؛ `gate6c_d_started=false`.
- Gate 6D = **NOT_STARTED**؛ `field_usable_v1=false`.
- HNT-001/HNT-002 tooling experiment: `CLOSED`.
- Default implementation workflow: `ChatGPT + GitHub + GitHub Actions`؛ Harness/local execution agent: `ON_DEMAND_ONLY`.

لا تعتبر أي SHA مضمن هنا HEAD الحالي تلقائيًا؛ Fresh Read من `main` يبقى الحاكم.
