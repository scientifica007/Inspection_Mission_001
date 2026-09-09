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
→ mark Gate CLOSED/ADOPTED/MERGED
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

### Independent ChatGPT Implementation Agent — DEFAULT

- ينفذ المهمة المحددة فقط على dedicated GitHub branch.
- يستخدم GitHub وGitHub Actions كمسار التنفيذ/التحقق الافتراضي.
- لا يقرر roadmap جديدة من تلقاء نفسه.
- لا يعيد فتح Gate مغلقة دون contradiction تنفيذي موثق وموافقة المالك.
- لا يبدأ Gate لاحقة.
- يشغّل focused tests وrequired regressions ضمن النطاق.
- يقدّم final implementation report يتضمن branch/SHA/diff/CI.
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

لا تعمل مباشرة على `main` في تطوير Gate عادية.

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

Gate 5E contextual AUTO-NA correction مثال معتمد على هذا الاستثناء.

## 6) قواعد التتبع والمصادر

- `DIRECT`: نص رسمي صريح.
- `DERIVED`: أثر تنفيذي مشتق.
- `PROJECT`: قرار مالك المشروع.

ممنوع نسبة `PROJECT` إلى المصادر الرسمية.

ملفات `sources/` لا تُعدل عند اشتقاق requirement أو design.

قرارات أدوات التنفيذ والـdefault workflow تصنّف `PROJECT` ما لم يوجد مصدر رسمي مستقل يقول غير ذلك.

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
- إذا أصبح README أو START-HERE stale، أصلحه قبل تراكم drift.

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

- Gate 6A مغلقة.
- HNT-001/HNT-002 tooling experiment: `CLOSED`.
- Default implementation workflow: `ChatGPT + GitHub + GitHub Actions`.
- Harness/local execution agent: `ON_DEMAND_ONLY`.
- تصحيح Gate 5B الضيق حول `SqlResult.lastInsertRowid` أصبح **MERGED / RESOLVED** في `main` عند merge SHA `608314ae62721af44d8ed4f50c1c618ac469fc66`.
- Gate 6B مستمرة على `implementation/gate6b-android-runtime-proof-v1` وحالتها **`IN_PROGRESS / PHYSICAL_QUALIFICATION_PASS_PENDING_PR_MERGE`**.
- Adapter Qualification حقيقية على Android ضد `87135cfe80ae3de79a34e941828249fc6889139c` أصبحت **PASS** لـQ1→Q12 بعد independent review؛ Q12=`PHYSICAL_PASS_REVIEW_ACCEPTED`.
- Q12 أثبتت `samePhysicalFile=true`, preflight writer success, literal `BEGIN IMMEDIATE`, genuine SQLCipher BUSY/code=5 أثناء القفل، marker absent تحت القفل، ثم نجاح writer بعد release والتنظيف والإغلاق.
- Application-Core Proof وfinal real Force Stop/Restart من `89d405d6254108ce735125638ccdb2fb2e67c568` تبقى accepted evidence بإعادة استخدام مبنية على non-drift في `src/application/**`, `src/bootstrap/**`, primary `CapacitorSqliteAdapter`, canonical schema وcanonical bootstrap حتى `87135cfe...`. هذا لا يعني أن APK البناءين نفس binary.
- `@capacitor-community/sqlite@8.1.1` اجتاز device qualification، لكن final Gate-6B adoption/closure يبقى pending PR / owner approval / merge.
- `closure_authorized=false`.
- لا يُطلب physical retest جديد، ولا Application-Core Proof أو Restart Phase A/B جديد.
- Gate 6C ما تزال **`NOT_STARTED`**؛ لا تبدأ UI ميدانية أو Evidence أو reports قبل إغلاق Gate 6B وفق الـRoadmap الحاكمة.
