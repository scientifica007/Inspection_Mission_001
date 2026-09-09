# PROJECT WORKFLOW — Inspection_Mission_001

> **الغرض:** توثيق طريقة إدارة المشروع بحيث يستطيع إنسان أو AI جديد مواصلة العمل دون الاعتماد على تاريخ المحادثات.

## 1) القاعدة الحاكمة

كل عمل جوهري يبدأ من **Fresh Read لـGitHub `main`**.

لا تعتمد على:

- ذاكرة ChatGPT؛
- Prompt handoff خارجي؛
- فرع feature قديم؛
- نسخة محلية غير محدثة؛
- تقرير Harness وحده دون مراجعة artifact الفعلي عندما تكون المهمة implementation-sensitive.

الـ`main` الحي + artifacts داخله هما المرجع الرسمي.

## 2) دورة العمل القياسية

```text
Fresh Read main
→ identify exactly one scoped Gate/task
→ create a dedicated branch
→ implementation/design inside that scope only
→ run focused tests
→ adversarial review
→ limited correction if required
→ APPROVED FOR COMMIT
→ commit/push
→ verify remote branch/head/diff
→ PR to main
→ merge
→ Fresh Read main
→ mark Gate CLOSED/ADOPTED/MERGED
→ only then consider the next Gate
```

لا تتجاوز خطوة review أو remote verification في المهام الحساسة.

## 3) أدوار العمل

### Project Owner

- يعتمد القرارات المعمارية والمتطلبات PROJECT.
- يوافق على فتح Gate جديدة أو إعادة فتح Gate مغلقة عند وجود سبب تنفيذي ملموس.
- ينفذ عادةً Git المحلي الروتيني عندما يكون العمل محليًا: switch/fetch/pull/status/add/commit/push وحذف الفروع المنتهية.

### Reviewing AI / Maintainer

- يبدأ دائمًا بـFresh Read من `main`.
- يحدد Gate الحالية وحدودها.
- يكتب implementation brief / Harness prompt ضيقًا.
- يراجع final report وactual files/diff عند الحاجة.
- لا يصدر `APPROVED FOR COMMIT` من التقرير وحده إذا كانت correctness تعتمد على التنفيذ الفعلي.
- يتحقق من remote branch بعد push.
- ينشئ PR/merge عندما يكون مخولًا بذلك.
- يجري Fresh Read نهائية بعد merge.

### Harness / Implementation Agent

- ينفذ المهمة المحددة فقط.
- لا يقرر roadmap جديدة من تلقاء نفسه.
- لا يعيد فتح Gate مغلقة دون contradiction تنفيذي موثق وموافقة المالك.
- لا يبدأ Gate لاحقة.
- لا ينفذ Git operations الروتينية إلا إذا طُلب منه صراحةً.
- يتوقف بعد التقرير النهائي للمراجعة.

يمكن استبدال Harness بأي implementation agent آخر، لكن نفس الحدود تنطبق.

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

إذا كانت correction comment-only محددة الموضع بعد مراجعة تنفيذية مكتملة، يكفي focused regression + diff check ما لم يظهر سبب جديد.

## 8) قواعد الاختبارات

- Baselines الحالية موثقة في `docs/project/TEST-BASELINES.md`.
- لا تُضعف test سابقة لتسهيل Gate جديدة.
- أي baseline جديدة يجب أن تكون additive أو مفسرة بقرار owner-authorized واضح.
- schema regression تبقى جزءًا من cross-cutting verification عند التعديلات القريبة من DB semantics.

## 9) Remote verification قبل merge

بعد push:

1. تحقق أن remote feature branch يشير إلى commit المتوقع.
2. تحقق أنه ahead/behind من `main` كما هو متوقع.
3. راجع changed files؛ لا ملفات زائدة.
4. ثبّت expected head SHA عند merge إذا كانت الأداة تدعم ذلك.
5. بعد merge اقرأ `main` الحي وتحقق من merge commit.

لا تعتبر `git push` وحدها إغلاقًا للـGate.

## 10) بعد merge

- مزامن النسخة المحلية مع `main`.
- تحقق من HEAD/status.
- يمكن حذف feature branch محليًا وبعيدًا بعد التأكد من الدمج.
- حدّث `CURRENT-STATE` عندما يتغير: آخر Gate مغلقة، Gate التالية، baselines أو roadmap.
- إذا أصبح README أو START-HERE stale، أصلحه قبل تراكم drift.

## 11) حدود البيانات الحساسة

GitHub ليس storage للتشغيل الميداني الحقيقي.

لا ترفع:

- صور تفتيش حقيقية؛
- Evidence فعلية؛
- بيانات شخصية أو حساسة؛
- production databases؛
- أسرار أو API keys.

استخدم فقط synthetic fixtures في tests.

## 12) المرحلة الحالية

عند كتابة هذا الملف:

- Gate 6A مغلقة.
- Gate 6B هي التالية و`NOT_STARTED`.
- لا تبدأ Gate 6C أو UI أو Evidence أو reports قبل اجتياز Gate 6B وفق الـRoadmap الحاكمة، إلا إذا غيّر المالك الـRoadmap بقرار صريح موثق.
