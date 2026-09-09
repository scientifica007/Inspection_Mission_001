# CURRENT STATE — Inspection_Mission_001

> **الغرض:** لقطة بشرية مختصرة للحالة الحاكمة للمشروع، مخصصة للاستلام والاستمرار من GitHub وحده.
>
> **قاعدة السلطة:** `main` الحي هو المرجع. هذا الملف لا يغني عن Fresh Read للـHEAD الحالي.

## 1) المرجع الحاكم

- Repository: `scientifica007/Inspection_Mission_001`.
- Governing branch: `main`.
- آخر merge منتجي قبل طبقة handoff: `f142791520fd95dda23c5e6a9c1decd0f2602b6f` — Merge Gate 6A product runtime architecture.
- merge تصحيح Gate 5B الضيق: `608314ae62721af44d8ed4f50c1c618ac469fc66` — MERGED / RESOLVED.
- لا تعتبر أي SHA مضمن هنا HEAD الحالي تلقائيًا؛ Fresh Read إلزامي.

## 2) حالة Gates

Gates 1→5L و6A مغلقة/معتمدة كما هو موثق في history. Gate 5B يتضمن التصحيح الضيق المدمج لـ`SqlResult.lastInsertRowid`.

### Gate 6B — Android Shell + Native SQLite Adapter / Device Runtime Proof

الحالة: **`IN_PROGRESS / PARTIAL_PASS_Q12_PENDING`**.

فرع التنفيذ: `implementation/gate6b-android-runtime-proof-v1`.

SQLite candidate: `@capacitor-community/sqlite@8.1.1` — ما تزال **provisional**؛ لم يُغلق Gate 6B ولم يبدأ Gate 6C.

الأدلة الفيزيائية المعتمدة على SHA `89d405d6254108ce735125638ccdb2fb2e67c568` تبقى محفوظة كما هي:

- Q1→Q11: PASS، بما فيها Q8 canonical schema وQ9 canonical bootstrap؛
- Q8: 15 tables / 44 triggers / 1 view / 24 explicit indexes / `integrity_check=ok`؛
- Q9: first load 24 definitions، second load 24 no-ops، P0=20، P1=4، allowed_values=48؛
- Application-Core physical proof: PASS؛
- Gate-5L zero-write measurement: before=121 / after=121 / delta=0؛
- T11 finalization: PASS؛
- reconstructed state hash: `9d7ab85b68ded94d02fc63e55d765f40f25f1d041e42a506ed7cb3b6cd52f405`؛
- clean physical Force Stop restart Phase A→B: PASS مع نفس state hash قبل/بعد restart.

Actual Android SQLite engine في تلك الأدلة: `3.53.3`.

Canonical hashes:

- schema: `c9c8682ec721b5c24ef3950c49f5a5c402f053d99aa88c617dfd7fe8a7c19ba7`؛
- bootstrap: `d43fe2b928116c71ab9b53653d71f832086e8cb01ba817ecac0a17562d3404fd`.

## 3) Q12 physical result على `7ebe780...`

تم تنفيذ **Run Adapter Qualification** على هاتف Android فعلي ضد:

`7ebe780b1caffeb1a9240ff4010e5483e1c70b7b`

النتيجة الفيزيائية: `overallResult=BLOCKED`، مع بقاء Q1→Q11 جميعها PASS. Q8 بقي PASS: 15 tables / 44 triggers / 1 view / 24 indexes / `integrity_check=ok`. Q9 بقي PASS: 24 definitions، second bootstrap 24 no-ops، P0=20، P1=4، allowed_values=48.

Q12 كانت:

```text
Q12_COMPETING_WRITE = BLOCKED
stage=native_open/set_busy_timeout
exceptionClass=android.database.sqlite.SQLiteException
exceptionMessage=unknown error (code 0): Queries can be performed using SQLiteDatabase query or rawQuery methods only.
code=G6B_Q12_NATIVE_OPEN_SET_BUSY_TIMEOUT
nativeStage=set_busy_timeout
```

`samePhysicalFile=false` في هذا التشغيل ليست post-open contradiction. native open توقف قبل `database_list` و`same_file_check`، ولذلك بقي الحقل على القيمة الابتدائية غير المثبتة. differential lock proof لم يُصل إليه التنفيذ.

السبب مثبت الآن: Q12 diagnostic writer كان ينقل `PRAGMA busy_timeout = 0;` عبر `execSQL`. SQLCipher Android رفض هذا النقل لأن الـPRAGMA row-producing ويجب أن يُنفذ عبر query/rawQuery. هذا **Q12 diagnostic-writer transport defect** فقط؛ ليس دليلًا على SQLCipher incompatibility، ولا primary adapter defect، ولا same-file failure، ولا `BEGIN IMMEDIATE` failure، ولا lock-semantics failure.

## 4) busy_timeout transport correction الحالي

التصحيح ضيق على writer B فقط، مع إبقاء semantics Q12 دون تغيير:

- A يبقى existing `CapacitorSqliteAdapter`؛
- B يبقى native writer مستقلًا؛
- لا تعديل في Application Core أو canonical schema/bootstrap أو primary adapter؛
- stage `set_busy_timeout` تستخدم `scalarLong(opened, "PRAGMA busy_timeout = 0;")`، أي `rawQuery` مع stepping/read للصف المعاد؛
- قيمة setter نفسها يجب أن تكون `0` وإلا يفشل native open في `set_busy_timeout`؛
- stage `read_busy_timeout` تقرأ `PRAGMA busy_timeout;` بصورة مستقلة، ويجب أن تكون `0` وإلا يفشل native open في `read_busy_timeout`؛
- stages التسع تبقى منفصلة: `validate_target`, `load_sqlcipher`, `open_database`, `set_busy_timeout`, `read_busy_timeout`, `read_sqlite_version`, `database_list`, `same_file_check`, `probe_table_read`؛
- failure قبل differential lock proof يبقى BLOCKED؛
- post-open `samePhysicalFile=false` يبقى FAIL؛
- BUSY/LOCKED الحقيقيان فقط يمكن أن يؤهلا during-lock step؛
- لا Promise timeout ولا BUSY/LOCKED simulation.

Q12 status بعد هذا التصحيح: **`BUSY_TIMEOUT_TRANSPORT_CORRECTED_PENDING_PHYSICAL_RETEST`**.

## 5) الأدلة التاريخية المحفوظة

- Build `5a642ac73ddaac1df5a49840e2ea4c4c49aae6dc`: Q1-Q7/Q10/Q11 PASS، Q8 FAIL بـ`Execute: not an error (code 0)`، Q9 لم يصل إليها التنفيذ، Q12 BLOCKED. هذا historical evidence للبناء المعيب ولا يُعاد تصنيفه.
- Corrected build `89d405d...`: Q1-Q11 PASS، Application-Core PASS، clean real Force Stop restart PASS، Q12 BLOCKED قبل وجود genuine writer B.
- Build `c3cc890...`: Q1-Q11 PASS، Q12 BLOCKED عند `native_open`، وكانت root cause غير معروفة لأن diagnostics القديمة أسقطت native rejection detail.
- Build `7ebe780...`: Q1-Q11 PASS، Q12 BLOCKED عند `native_open/set_busy_timeout`، والسبب مثبت كـinvalid `execSQL` transport للـrow-producing busy-timeout PRAGMA.
- negative-control سابقة: Phase B بعد `Reset Synthetic Proof DB` فشلت لأن durable DB حُذفت؛ تبقى negative evidence وليست product defect.

## 6) Baselines الحالية

| Suite | Baseline |
|---|---:|
| Gate 6B host adapter contract | 16 / 0 |
| Gate 6B canonical-schema execution | 8 / 0 |
| Gate 6B Q12 diagnostic/classifier | 20 / 0 |
| Gate 5L | 94 / 0 |
| Gate 5K | 82 / 0 |
| Gate 5J | 75 / 0 |
| Gate 5I | 48 / 0 |
| Gate 5H | 66 / 0 |
| Gate 5G | 41 / 0 |
| Gate 5F | 30 / 0 |
| Gate 5E | 79 / 0 |
| Gate 5D | 60 / 0 |
| Gate 5C | 55 / 0 |
| Gate 5B bootstrap/reference-data | 32 / 0 |
| Gate 5B adapter normalization | 6 / 0 |
| Schema | 100 / 0 |

## 7) ثوابت لا تتغير

- SQLite هي local authority؛ process memory ليست authority.
- `src/application/**` و`src/bootstrap/**` تبقيان runtime-neutral.
- canonical schema وcanonical bootstrap لا يُعدلان لتلائم driver.
- diagnostic Q12 writer ليس product architecture.
- Gate 6B تبقى **IN_PROGRESS**، `closure_authorized=false`.
- Gate 6C تبقى **NOT_STARTED**.

## 8) المهمة الفيزيائية التالية الوحيدة

بعد independent review، ثبّت APK الناتج عن busy-timeout transport correction وشغّل فقط:

**Run Adapter Qualification**

لا يُطلب Application-Core Proof ولا Restart Phase A/B في هذه المرحلة.
