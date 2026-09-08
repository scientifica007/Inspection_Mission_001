// Gate 5C — pure, deterministic, data-driven applicability evaluator
// (runtime-neutral TypeScript, no node:* imports).
//
// Implements the formal contract of APPLICATION-CORE-v1.md §5 and the adopted
// algorithm of docs/checklists/APPLICABILITY-RULES-v1.md §4/§10:
//
//   1. validate rule structure against the FULL canonical grammar of
//      docs/checklists/APPLICABILITY-RULES-v1.md §4.1 (required keys AND the
//      optional text fields note_ar / not_applicable_when_ar; missing_context
//      is structurally validated whenever present); malformed/unknown payload
//      => E_CONFIG (never silently decide — data corruption blocks);
//   2. context.kind must belong to the adopted CONTEXT_KINDS closed set —
//      an unknown kind is a data error => E_CONTEXT (APPLICATION-CORE §5.4),
//      never a silent NOT_APPLICABLE;
//   3. if rule.visit_type exists and the visitType is not allowed
//      => NOT_APPLICABLE;
//   4. if context.kind is not in rule.subject_kinds => NOT_APPLICABLE;
//   5. decision_kind AUTO => APPLICABLE;
//   6. else (HUMAN_CONFIRMATION) => HUMAN_CONFIRMATION(missing_context).
//
// The evaluator NEVER switches on item_code and NEVER reads Arabic prose: the
// payload's keys (subject_kinds / visit_type.allowed / decision_kind /
// missing_context) are the only decision inputs. The rule payload is the
// canonical JSON TEXT stored on the exact pinned item_definition_id
// (checklist_item_definition.applicability_rule). The physical schema
// guarantees the CORE structural grammar at definition-insert time (the
// declarative CHECKs plus trg_def_bi cover rule_schema_version / item_code /
// decision_kind / subject_kinds / source_ar / visit_type.allowed / the
// HUMAN_CONFIRMATION missing_context shape); it does NOT enforce the complete
// §4.1 contract — in particular the optional metadata fields note_ar and
// not_applicable_when_ar (text when present) and the structural shape of
// missing_context when present on a non-HUMAN payload are validated only here.
// The parser below is therefore the authority for the FULL §4.1 grammar
// (APPLICATION-CORE §5.4 E_CONFIG) — it acts as the domain's corruption guard
// and as the unit-level contract for hand-built payloads.

import { APP_ERR, DomainError } from "./errors.ts";

export const CONTEXT_KINDS = [
    "INSTITUTION",
    "WORKSHOP",
    "LAB",
    "CLASSROOM",
    "DORMITORY",
    "CANTEEN",
    "FACILITY",
    "TECHNICAL_NETWORK",
    "OTHER",
] as const;

export type ContextKind = (typeof CONTEXT_KINDS)[number];

export const VISIT_TYPES = ["SURPRISE", "PLANNED"] as const;

export type VisitType = (typeof VISIT_TYPES)[number];

const DECISION_KINDS = ["AUTO", "HUMAN_CONFIRMATION"] as const;

export type DecisionKind = (typeof DECISION_KINDS)[number];

export type ApplicabilityOutcome =
    | { outcome: "NOT_APPLICABLE" }
    | { outcome: "APPLICABLE" }
    | { outcome: "HUMAN_CONFIRMATION"; missingContext: readonly string[] };

export interface ParsedApplicabilityRule {
    ruleSchemaVersion: number;
    itemCode: string;
    decisionKind: DecisionKind;
    subjectKinds: readonly ContextKind[];
    sourceAr: string;
    /** absent rule.visit_type => null (no visit-type restriction) */
    visitTypeAllowed: readonly VisitType[] | null;
    missingContext: readonly string[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

function config(what: string): DomainError {
    return new DomainError(APP_ERR.CONFIG, `applicability_rule: ${what}`);
}

function asText(v: unknown, what: string, opts: { blank: "forbid" | "allow" } = { blank: "forbid" }): string {
    if (typeof v !== "string") throw config(`${what} must be JSON text`);
    if (opts.blank === "forbid" && v.trim().length === 0) throw config(`${what} must not be blank`);
    return v;
}

function asArray(v: unknown, what: string): unknown[] {
    if (!Array.isArray(v)) throw config(`${what} must be a JSON array`);
    return v;
}

/**
 * Parse + structurally validate a canonical applicability payload (JSON text
 * as stored in checklist_item_definition.applicability_rule). Any violation of
 * the APPLICABILITY-RULES §4.1 grammar raises E_CONFIG.
 */
export function parseApplicabilityRule(payloadText: string): ParsedApplicabilityRule {
    if (typeof payloadText !== "string" || payloadText.trim().length === 0) {
        throw config("payload must be non-empty JSON text");
    }
    let root: unknown;
    try {
        root = JSON.parse(payloadText);
    } catch {
        throw config("payload is not valid JSON");
    }
    if (!isPlainObject(root)) throw config("payload must be a JSON object at its root");

    // $.rule_schema_version — canonical grammar version, exactly integer 1
    if (root.rule_schema_version !== 1) {
        throw config("rule_schema_version must be the integer 1");
    }

    // $.item_code — non-blank text (schema additionally ties it to the row code)
    const itemCode = asText(root.item_code, "item_code");

    // $.decision_kind — closed set AUTO | HUMAN_CONFIRMATION
    if (typeof root.decision_kind !== "string" || !(DECISION_KINDS as readonly string[]).includes(root.decision_kind)) {
        throw config(`decision_kind must be one of ${DECISION_KINDS.join(" | ")}`);
    }
    const decisionKind = root.decision_kind as DecisionKind;

    // $.subject_kinds — non-empty array whose members are context-kind tokens
    const subjectKinds = asArray(root.subject_kinds, "subject_kinds");
    if (subjectKinds.length === 0) throw config("subject_kinds must not be empty");
    const kinds: ContextKind[] = [];
    for (const member of subjectKinds) {
        if (typeof member !== "string" || !(CONTEXT_KINDS as readonly string[]).includes(member)) {
            throw config(`every subject_kinds member must be text from the closed set ${CONTEXT_KINDS.join("|")}`);
        }
        kinds.push(member as ContextKind);
    }

    // $.source_ar — mandatory non-blank text
    const sourceAr = asText(root.source_ar, "source_ar");

    // $.not_applicable_when_ar / $.note_ar — optional metadata text (rule
    // grammar §4.1): absent is allowed; when present the value must be JSON
    // text (any other JSON type => E_CONFIG). Their Arabic content is
    // metadata ONLY and never enters the decision below.
    if (root.not_applicable_when_ar !== undefined) {
        asText(root.not_applicable_when_ar, "not_applicable_when_ar", { blank: "allow" });
    }
    if (root.note_ar !== undefined) {
        asText(root.note_ar, "note_ar", { blank: "allow" });
    }

    // $.visit_type (optional): when present it must be an object carrying a
    // non-empty .allowed array of SURPRISE/PLANNED text.
    let visitTypeAllowed: readonly VisitType[] | null = null;
    if (root.visit_type !== undefined) {
        if (!isPlainObject(root.visit_type)) throw config("visit_type must be a JSON object when present");
        const allowed = asArray(root.visit_type.allowed, "visit_type.allowed");
        if (allowed.length === 0) throw config("visit_type.allowed must not be empty");
        const allowedTypes: VisitType[] = [];
        for (const member of allowed) {
            if (typeof member !== "string" || !(VISIT_TYPES as readonly string[]).includes(member)) {
                throw config(`every visit_type.allowed member must be SURPRISE or PLANNED`);
            }
            allowedTypes.push(member as VisitType);
        }
        visitTypeAllowed = allowedTypes;
    }

    // $.missing_context — when the decision cannot be made automatically
    // (HUMAN_CONFIRMATION) it is mandatory as a non-empty array of non-blank
    // text (§4.1). If it is present on any other decision kind it stays
    // NON-decision-bearing but must not be accepted in malformed shape: it is
    // still structurally validated as an array of JSON text.
    let missingContext: readonly string[] = [];
    if (decisionKind === "HUMAN_CONFIRMATION") {
        const mc = asArray(root.missing_context, "missing_context");
        if (mc.length === 0) throw config("HUMAN_CONFIRMATION requires a non-empty missing_context array");
        const ctx: string[] = [];
        for (const member of mc) {
            ctx.push(asText(member, "every missing_context member"));
        }
        missingContext = ctx;
    } else if (root.missing_context !== undefined) {
        const mc = asArray(root.missing_context, "missing_context");
        for (const member of mc) {
            if (typeof member !== "string") throw config("every missing_context member must be JSON text");
        }
    }

    return { ruleSchemaVersion: 1, itemCode, decisionKind, subjectKinds: kinds, sourceAr, visitTypeAllowed, missingContext };
}

/**
 * The pure evaluator (APPLICATION-CORE §5.3). Never switches on item_code and
 * never infers a decision from Arabic prose.
 *
 * @param rule        canonical applicability payload JSON text (pinned version)
 * @param contextKind INSTITUTION (institution context) or
 *                    inspected_subject.subject_type (subject context)
 * @param visitType   visit.visit_type: SURPRISE | PLANNED
 */
export function evaluateApplicability(rule: string, contextKind: ContextKind, visitType: VisitType): ApplicabilityOutcome {
    const parsed = parseApplicabilityRule(rule);

    // runtime guard (APPLICATION-CORE §5.4 E_CONTEXT), independent of the
    // TypeScript typing: the context kind must belong to the adopted closed
    // set (CONTEXT_KINDS). An unknown kind is a data error, never a silent
    // NOT_APPLICABLE — the kind gate below only decides membership of a KNOWN
    // kind inside rule.subject_kinds.
    if (!(CONTEXT_KINDS as readonly string[]).includes(contextKind)) {
        throw new DomainError(APP_ERR.CONTEXT, `evaluateApplicability: unknown context kind '${contextKind}' (E_CONTEXT)`);
    }

    // step 2 — visit-type restriction (absent rule.visit_type => no restriction)
    if (parsed.visitTypeAllowed !== null && !parsed.visitTypeAllowed.includes(visitType)) {
        return { outcome: "NOT_APPLICABLE" };
    }

    // step 3 — subject-kind gate
    if (!parsed.subjectKinds.includes(contextKind)) {
        return { outcome: "NOT_APPLICABLE" };
    }

    // step 4/5 — decision kind
    if (parsed.decisionKind === "AUTO") return { outcome: "APPLICABLE" };
    return { outcome: "HUMAN_CONFIRMATION", missingContext: [...parsed.missingContext] };
}

/**
 * Physical overlay a materialized scope cell receives for an outcome
 * (APPLICATION-CORE §3.2 / T0 / T1):
 *   NOT_APPLICABLE     => NA ("غير معني")
 *   APPLICABLE         => pending NOT_INSPECTED (reason NULL, unanswered)
 *   HUMAN_CONFIRMATION => the SAME true-pending NOT_INSPECTED state as
 *                         APPLICABLE (B1: unresolved HUMAN decision; the
 *                         explicit inspector decision is never inferred and no
 *                         durable standalone APPLICABLE-pending state exists).
 */
export function overlayStateForOutcome(outcome: ApplicabilityOutcome): "NA" | "NOT_INSPECTED" {
    if (outcome.outcome === "NOT_APPLICABLE") return "NA";
    return "NOT_INSPECTED";
}
