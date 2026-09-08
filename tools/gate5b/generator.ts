// Gate 5B — deterministic checklist-v1 generator (runtime-neutral TS).
//
// The single canonical source of the committed bootstrap artifact:
//   bootstrap/v1/checklist-v1.json
//
// Inputs (canonical authorities, unchanged from Gate-5A D5):
//   * docs/checklists/FIELD-CHECKLIST-v1.md          (the 24 items verbatim)
//   * docs/checklists/APPLICABILITY-RULES-v1.md      (§7 canonical payloads)
// Editorial semantics (allowed-value value_code + semantic_class) come ONLY
// from tools/gate5b/editorial.ts explicit tables — never inferred from Arabic.
//
// Determinism: this module is a pure function of (checklistText,
// applicabilityText, input sha-256 hashes, generator identity, git commit).
// Two runs on identical inputs produce byte-identical artifacts.

import type {
    AllowedValueRecord,
    BootstrapArtifact,
    DefinitionRecord,
    EditorialValueMapping,
} from "../../src/bootstrap/artifact.ts";
import { canonicalJson } from "../../src/bootstrap/artifact.ts";
import {
    QUESTION_OVERRIDES,
    SCHEDULE_ITEM_CODES,
    SCHEDULE_OVERALL_LABELS,
    VALUE_EDITORIAL,
    VALUE_EDITORIAL_BY_LABEL,
} from "./editorial.ts";

export const GENERATOR_NAME = "gate5b-checklist-generator";
export const GENERATOR_VERSION = "1.0.0";
export const ARTIFACT_NAME = "checklist-v1.json";
export const ARTIFACT_SCHEMA_VERSION = 1;

export const INPUT_FIELD_CHECKLIST_PATH = "docs/checklists/FIELD-CHECKLIST-v1.md";
export const INPUT_APPLICABILITY_PATH = "docs/checklists/APPLICABILITY-RULES-v1.md";

export interface GenerateOptions {
    checklistText: string;
    applicabilityText: string;
    fieldChecklistSha256: string;
    applicabilitySha256: string;
    generatingGitCommit: string | null;
}

function fail(message: string): never {
    throw new Error(`gate5b generator: ${message}`);
}

// ---------------------------------------------------------------------------
// FIELD-CHECKLIST parsing (structural; only ASCII codes and «» delimiters)
// ---------------------------------------------------------------------------

interface RawItem {
    code: string;
    lines: string[];
}

function extractItemBlocks(text: string): RawItem[] {
    const lines = text.split(/\r?\n/);
    const items: RawItem[] = [];
    let current: RawItem | null = null;
    for (const line of lines) {
        const heading = /^###\s+(CHK-\d{3})\s+—/.exec(line);
        if (heading) {
            if (current) items.push(current);
            current = { code: heading[1], lines: [] };
            continue;
        }
        if (current && (/^#{1,3}\s/.test(line))) {
            items.push(current);
            current = null;
            continue;
        }
        if (current) current.lines.push(line);
    }
    if (current) items.push(current);
    items.sort((a, b) => a.code.localeCompare(b.code, "en", { numeric: true }));
    return items;
}

function bulletKeyValue(line: string): { key: string; value: string } | null {
    const m = /^\s*-\s*\*\*(.+?):\*\*\s*(.*)$/.exec(line);
    if (!m) return null;
    return { key: m[1].trim(), value: m[2].trim() };
}

function collectBullets(lines: string[]): Map<string, string> {
    const out = new Map<string, string>();
    for (const line of lines) {
        const kv = bulletKeyValue(line);
        if (kv && !out.has(kv.key)) out.set(kv.key, kv.value);
    }
    return out;
}

function refsFromLine(value: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const re = /(?:REQ|DER|PRJ)-\d+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(value)) !== null) {
        if (!seen.has(m[0])) {
            seen.add(m[0]);
            out.push(m[0]);
        }
    }
    if (out.length === 0) fail(`requirement reference line carries no REQ/DER/PRJ token: ${value}`);
    return out;
}

function questionFromLine(value: string, code: string): string {
    const trimmed = value.trim();
    if (trimmed.startsWith("«") && trimmed.endsWith("»")) {
        return trimmed.slice(1, -1);
    }
    // CHK-012 procedure sentence is not wrapped in «»; editorial override must match.
    const override = QUESTION_OVERRIDES.get(code);
    if (override === undefined) {
        fail(`${code}: question line is not wrapped in «» and no editorial override exists`);
    }
    const withoutEmphasis = trimmed.replace(/\*\*/g, "");
    if (withoutEmphasis !== override) {
        fail(
            `${code}: editorial question override drifted from FIELD-CHECKLIST\n` +
                `  source   : ${withoutEmphasis}\n  override : ${override}`,
        );
    }
    return override;
}

function allowedValuesForItem(code: string, optionsValue: string): AllowedValueRecord[] {
    if (SCHEDULE_ITEM_CODES.has(code)) {
        const labels = SCHEDULE_OVERALL_LABELS.get(code);
        if (labels === undefined) fail(`${code}: SCHEDULE item has no editorial overall-answer labels`);
        return labels.map((label, idx) => {
            const row = VALUE_EDITORIAL_BY_LABEL.get(label);
            if (row === undefined) fail(`${code}: overall answer label "${label}" missing from VALUE_EDITORIAL`);
            return { value_code: row.valueCode, arabic_label: row.label, semantic_class: row.semantic, sort_order: idx + 1, active: true };
        });
    }
    if (!optionsValue.startsWith("أحادي الاختيار: ")) {
        fail(`${code}: expected a single-select options line, got: ${optionsValue}`);
    }
    const tokens = optionsValue.slice("أحادي الاختيار: ".length).split(" / ").map((s) => s.trim());
    if (tokens.length !== 2) {
        fail(`${code}: single-select item must expose exactly two answered options, got ${tokens.length}`);
    }
    return tokens.map((token, idx) => {
        const row = VALUE_EDITORIAL_BY_LABEL.get(token);
        if (row === undefined) {
            fail(`${code}: option label "${token}" is not covered by the explicit VALUE_EDITORIAL table ` +
                "(add an editorial row; semantics are never inferred)");
        }
        return { value_code: row.valueCode, arabic_label: row.label, semantic_class: row.semantic, sort_order: idx + 1, active: true };
    });
}

function parseDefinition(raw: RawItem): DefinitionRecord {
    const { code, lines } = raw;
    const bullets = collectBullets(lines);

    const domain = bullets.get("المحور");
    if (domain === undefined || !/^DOM-\d{2}$/.test(domain)) {
        fail(`${code}: missing/malformed domain bullet`);
    }

    const questionRaw = bullets.get("السؤال الميداني (عبارة إجراء)") ?? bullets.get("السؤال الميداني");
    if (questionRaw === undefined) fail(`${code}: missing question bullet`);
    const question = questionFromLine(questionRaw, code);

    const options = bullets.get("نوع الاستجابة/الخيارات");
    if (options === undefined) fail(`${code}: missing options bullet`);

    const refsLine = bullets.get("مرجع المتطلبات");
    if (refsLine === undefined) fail(`${code}: missing requirement references bullet`);
    const requirementRefs = refsFromLine(refsLine);

    // traceability + priority live on ONE combined bullet:
    // "- **التتبع:** DIRECT · **الأولوية:** P0"
    const traceLine = lines.find((l) => l.trim().startsWith("- **التتبع:**"));
    const traceMatch = traceLine ? /-\s*\*\*التتبع:\*\*\s*(DIRECT|DERIVED|PROJECT)\s*·\s*\*\*الأولوية:\*\*\s*(P[012])/.exec(traceLine) : null;
    if (!traceMatch) {
        fail(`${code}: missing combined traceability/priority bullet`);
    }
    const traceability = traceMatch[1] as DefinitionRecord["traceability"];
    const priority = traceMatch[2] as DefinitionRecord["priority"];

    const note = bullets.get("ملاحظة");
    const evidence = bullets.get("الأدلة");
    const finding = bullets.get("شرط توليد النقص");
    if (note === undefined || evidence === undefined || finding === undefined) {
        fail(`${code}: missing one of ملاحظة / الأدلة / شرط توليد النقص rules`);
    }

    return {
        item_code: code,
        version_no: 1,
        domain_id: domain,
        arabic_question: question,
        response_model: SCHEDULE_ITEM_CODES.has(code) ? "SCHEDULE" : "SINGLE_VALUE",
        priority: priority as DefinitionRecord["priority"],
        traceability: traceability as DefinitionRecord["traceability"],
        requirement_refs: requirementRefs,
        note_rule: note,
        evidence_rule: evidence,
        finding_rule: finding,
        applicability_rule: {}, // filled from APPLICABILITY-RULES below
        allowed_values: allowedValuesForItem(code, options),
    };
}

// ---------------------------------------------------------------------------
// APPLICABILITY-RULES §7 payload extraction
// ---------------------------------------------------------------------------

function extractApplicabilityPayloads(text: string): Map<string, Record<string, unknown>> {
    const map = new Map<string, Record<string, unknown>>();
    let inside = false;
    let buf: string[] = [];
    for (const line of text.split(/\r?\n/)) {
        if (line.trim() === "```json") {
            inside = true;
            buf = [];
            continue;
        }
        if (inside && line.trim() === "```") {
            inside = false;
            const payload = JSON.parse(buf.join("\n")) as Record<string, unknown>;
            const code = payload.item_code;
            if (typeof code !== "string" || map.has(code)) {
                fail(`APPLICABILITY-RULES contains a duplicate/invalid payload for ${String(code)}`);
            }
            map.set(code, payload);
            continue;
        }
        if (inside) buf.push(line);
    }
    if (map.size === 0) fail("no canonical applicability payloads found in APPLICABILITY-RULES");
    return map;
}

// ---------------------------------------------------------------------------
// artifact assembly
// ---------------------------------------------------------------------------

export function generateChecklistArtifact(opts: GenerateOptions): BootstrapArtifact {
    const rawItems = extractItemBlocks(opts.checklistText);
    if (rawItems.length === 0) fail("no CHK items parsed from FIELD-CHECKLIST");

    const applicability = extractApplicabilityPayloads(opts.applicabilityText);
    const definitions: DefinitionRecord[] = rawItems.map((raw) => {
        const def = parseDefinition(raw);
        const payload = applicability.get(def.item_code);
        if (payload === undefined) {
            fail(`${def.item_code}: no canonical applicability payload in APPLICABILITY-RULES`);
        }
        if (payload.item_code !== def.item_code) {
            fail(`${def.item_code}: applicability payload item_code mismatch`);
        }
        def.applicability_rule = payload;
        return def;
    });

    const p0 = definitions.filter((d) => d.priority === "P0").map((d) => d.item_code);
    const p1 = definitions.filter((d) => d.priority === "P1").map((d) => d.item_code);

    const valueMapping: EditorialValueMapping[] = [...VALUE_EDITORIAL]
        .map((row) => ({ arabic_label: row.label, value_code: row.valueCode, semantic_class: row.semantic }))
        .sort((a, b) => (a.arabic_label < b.arabic_label ? -1 : a.arabic_label > b.arabic_label ? 1 : 0));

    const artifact: BootstrapArtifact = {
        artifact_name: ARTIFACT_NAME,
        artifact_schema_version: ARTIFACT_SCHEMA_VERSION,
        manifest: {
            expected_p0_item_codes: p0,
            expected_p1_item_codes: p1,
            expected_total_item_count: definitions.length,
            policy:
                "createVisit (T0) compares expected_p0_item_codes exactly, in BOTH directions, against the " +
                "loaded DB ACTIVE+priority='P0' item-code set; an expected code without an ACTIVE definition => " +
                "E_NO_ACTIVE_DEFINITION / E_BOOTSTRAP_DRIFT; an unexpected ACTIVE-P0 code => E_BOOTSTRAP_DRIFT; " +
                "P1 definitions (expected_p1_item_codes) never enter that comparison.",
        },
        provenance: {
            artifact_name: ARTIFACT_NAME,
            artifact_schema_version: ARTIFACT_SCHEMA_VERSION,
            generator_name: GENERATOR_NAME,
            generator_version: GENERATOR_VERSION,
            generating_git_commit: opts.generatingGitCommit,
            inputs: [
                {
                    path: INPUT_FIELD_CHECKLIST_PATH,
                    sha256: opts.fieldChecklistSha256,
                },
                {
                    path: INPUT_APPLICABILITY_PATH,
                    sha256: opts.applicabilitySha256,
                },
            ],
            semantics_note:
                "Arabic prose is never parsed for executable semantics. Allowed-value value_code and " +
                "semantic_class are decided by the explicit editorial mapping tables in tools/gate5b/editorial.ts " +
                "(requirement C); note/evidence/finding rules are verbatim reference metadata; the only " +
                "machine-evaluated payloads are applicability_rule (copied verbatim from APPLICABILITY-RULES-v1.md " +
                "§7) and semantic_class (APPLICATION-CORE §7, Gate-5A D4). " +
                "generating_git_commit is an environment fact resolved at generation time and is excluded from " +
                "semantic-equality comparisons (see compareArtifactTexts).",
        },
        editorial: { value_mapping: valueMapping },
        definitions,
    };

    // final consistency guard
    const codes = definitions.map((d) => d.item_code);
    for (const code of codes) {
        if (VALUE_EDITORIAL_BY_LABEL.size === 0) fail("empty editorial table");
        if (typeof code !== "string") fail("non-string item code");
    }
    return artifact;
}

/** Canonical file text of a generated artifact (used by CLI and tests). */
export function artifactText(artifact: BootstrapArtifact): string {
    return canonicalJson(artifact) + "\n";
}
