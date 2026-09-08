// Gate 5B — explicit editorial mapping tables (reviewable generator data).
//
// Gate-5A D5.5 / requirement C: which Arabic option is NON_COMPLIANT, and the
// stable value_code token for each option, are decided HERE as explicit data.
// The generator NEVER infers COMPLIANT / NON_COMPLIANT from Arabic keyword
// heuristics and never parses Arabic prose at runtime: the table below is the
// only place semantics are attached to option labels, and every option label
// extracted from FIELD-CHECKLIST-v1.md MUST be present in this table (any
// unknown label fails generation loudly).
//
// value_code tokens are stable technical tokens, unique within one item
// definition (schema: UNIQUE(item_definition_id, value_code)); the same
// Arabic meaning reuses the same token across items.

import type { AllowedValueRecord, SemanticClass } from "../../src/bootstrap/artifact.ts";

export interface LabelEditorial {
    label: string;
    valueCode: string;
    semantic: SemanticClass;
}

export const VALUE_EDITORIAL: readonly LabelEditorial[] = [
    // CHK-001 — workshop activation
    { label: "مُفعَّلة", valueCode: "ACTIVE", semantic: "COMPLIANT" },
    { label: "غير مُفعَّلة", valueCode: "INACTIVE", semantic: "NON_COMPLIANT" },
    // CHK-002 — actual exploitation
    { label: "تُستغل فعليًا", valueCode: "USED", semantic: "COMPLIANT" },
    { label: "لا تُستغل", valueCode: "NOT_USED", semantic: "NON_COMPLIANT" },
    // CHK-003 — hygiene compliance
    { label: "ملتزم", valueCode: "COMPLIANT", semantic: "COMPLIANT" },
    { label: "غير ملتزم", valueCode: "NOT_COMPLIANT", semantic: "NON_COMPLIANT" },
    // CHK-004 / CHK-010 / CHK-020 / CHK-023 / CHK-024 — availability
    { label: "متوفرة", valueCode: "AVAILABLE", semantic: "COMPLIANT" },
    { label: "غير متوفرة", valueCode: "NOT_AVAILABLE", semantic: "NON_COMPLIANT" },
    // CHK-005 — electrical faults
    { label: "لا يوجد خلل", valueCode: "NO_FAULT", semantic: "COMPLIANT" },
    { label: "يوجد خلل", valueCode: "FAULT", semantic: "NON_COMPLIANT" },
    // CHK-006 / CHK-007 — supply regularity
    { label: "منتظم", valueCode: "REGULAR", semantic: "COMPLIANT" },
    { label: "غير منتظم (انقطاعات)", valueCode: "IRREGULAR", semantic: "NON_COMPLIANT" },
    // CHK-008 — water leaks (feminine agreement)
    { label: "لا توجد", valueCode: "NONE", semantic: "COMPLIANT" },
    { label: "توجد", valueCode: "PRESENT", semantic: "NON_COMPLIANT" },
    // CHK-009 — structure deterioration (masculine agreement)
    { label: "لا يوجد", valueCode: "NONE", semantic: "COMPLIANT" },
    { label: "يوجد", valueCode: "PRESENT", semantic: "NON_COMPLIANT" },
    // CHK-011 — equipment operability
    { label: "جميعها تعمل", valueCode: "ALL_WORKING", semantic: "COMPLIANT" },
    { label: "توجد أعطال", valueCode: "FAULTS_PRESENT", semantic: "NON_COMPLIANT" },
    // CHK-012 — overall reconciliation result (SCHEDULE overall answer)
    { label: "مطابقة", valueCode: "MATCHED", semantic: "COMPLIANT" },
    { label: "غير مطابقة (فوارق)", valueCode: "MISMATCHED", semantic: "NON_COMPLIANT" },
    // CHK-013..CHK-019 — physical readiness
    { label: "جاهزة", valueCode: "READY", semantic: "COMPLIANT" },
    { label: "غير جاهزة", valueCode: "NOT_READY", semantic: "NON_COMPLIANT" },
    // CHK-021 / CHK-022 — suitability of conditions
    { label: "ملائمة", valueCode: "SUITABLE", semantic: "COMPLIANT" },
    { label: "غير ملائمة", valueCode: "NOT_SUITABLE", semantic: "NON_COMPLIANT" },
];

export const VALUE_EDITORIAL_BY_LABEL: ReadonlyMap<string, LabelEditorial> = new Map(
    VALUE_EDITORIAL.map((row) => [row.label, row]),
);

/**
 * response_model is content decided editorially (CHK-012 is the only SCHEDULE
 * item in v1 — a per-category record with an overall result); every other item
 * must be described as single-select in FIELD-CHECKLIST.  The generator
 * cross-checks that textual expectation instead of inferring it.
 */
export const SCHEDULE_ITEM_CODES: ReadonlySet<string> = new Set(["CHK-012"]);

/**
 * CHK-012 question: the FIELD-CHECKLIST line uses markdown emphasis markers
 * (**الحالة المعاينة**); the canonical question text below is that sentence
 * with the markers removed.  The generator self-checks this against the doc
 * (see generator.ts) so the override can never silently drift from the source.
 */
export const QUESTION_OVERRIDES: ReadonlyMap<string, string> = new Map([
    [
        "CHK-012",
        "المطابقة الميدانية بين التجهيزات المتوفرة فعليًا والإحصائيات المدونة على المنصة الرقمية «تسيير»، " +
            "وتسجيل الحالة المعاينة (الفوارق دون الإجراءات التصحيحية اللاحقة).",
    ],
]);

/**
 * Allowed *answered* values for SCHEDULE items (overall result).  The
 * FIELD-CHECKLIST overall-result line lists «لا يُعاين» too, but that state is
 * the NOT_INSPECTED overlay (never an answered value), so only the answered
 * pair belongs to checklist_allowed_value.  Labels must exist in
 * VALUE_EDITORIAL; order below is the doc display order.
 */
export const SCHEDULE_OVERALL_LABELS: ReadonlyMap<string, readonly string[]> = new Map([
    ["CHK-012", ["مطابقة", "غير مطابقة (فوارق)"]],
]);

/** Build one AllowedValueRecord from editorial data with doc order preserved. */
export function toAllowedValue(editorial: LabelEditorial, sortOrder: number, active = true): AllowedValueRecord {
    return {
        value_code: editorial.valueCode,
        arabic_label: editorial.label,
        semantic_class: editorial.semantic,
        sort_order: sortOrder,
        active,
    };
}
