// Gate 5B — canonical bootstrap artifact model + deterministic JSON writer
// (runtime-neutral TypeScript, no node:* imports).
//
// The committed artifact (bootstrap/v1/checklist-v1.json) is produced with the
// canonical writer below: object keys sorted recursively, arrays in their
// semantic order, Arabic emitted verbatim (never \u-escaped), two-space
// indentation, one trailing newline.  Any two generations from identical
// inputs therefore produce byte-identical files.

export type SemanticClass = "COMPLIANT" | "NON_COMPLIANT";
export type Traceability = "DIRECT" | "DERIVED" | "PROJECT";
export type Priority = "P0" | "P1" | "P2";
export type ResponseModel = "SINGLE_VALUE" | "SCHEDULE";

export interface AllowedValueRecord {
    /** stable technical token, unique within one item definition */
    value_code: string;
    /** verbatim Arabic option label from FIELD-CHECKLIST-v1.md */
    arabic_label: string;
    /** editorial semantic class (never inferred from Arabic) */
    semantic_class: SemanticClass;
    /** 1-based display order inside the definition */
    sort_order: number;
    /** active state (schema default 1) */
    active: boolean;
}

export interface DefinitionRecord {
    item_code: string;
    version_no: number;
    domain_id: string;
    /** verbatim Arabic field question / procedure statement */
    arabic_question: string;
    response_model: ResponseModel;
    priority: Priority;
    traceability: Traceability;
    /** ref tokens in FIELD-CHECKLIST order of appearance (REQ/DER/PRJ) */
    requirement_refs: string[];
    /** verbatim Arabic «ملاحظة» clause (reference metadata only) */
    note_rule: string;
    /** verbatim Arabic «الأدلة» clause (reference metadata only) */
    evidence_rule: string;
    /** verbatim Arabic «شرط توليد النقص» clause (reference metadata only) */
    finding_rule: string;
    /** canonical applicability payload object (APPLICABILITY-RULES §7) */
    applicability_rule: Record<string, unknown>;
    allowed_values: AllowedValueRecord[];
}

export interface EditorialValueMapping {
    arabic_label: string;
    value_code: string;
    semantic_class: SemanticClass;
}

export interface ManifestSection {
    /** code-set authority for createVisit: exact expected v1 P0 set */
    expected_p0_item_codes: string[];
    /** P1 codes carried in the artifact but excluded from the P0 manifest */
    expected_p1_item_codes: string[];
    expected_total_item_count: number;
    policy: string;
}

export interface ProvenanceInput {
    path: string;
    sha256: string;
}

export interface ProvenanceSection {
    artifact_name: string;
    artifact_schema_version: number;
    generator_name: string;
    generator_version: string;
    /** generating Git commit SHA when available (environment fact) */
    generating_git_commit: string | null;
    inputs: ProvenanceInput[];
    semantics_note: string;
}

export interface BootstrapArtifact {
    artifact_name: string;
    artifact_schema_version: number;
    manifest: ManifestSection;
    provenance: ProvenanceSection;
    editorial: { value_mapping: EditorialValueMapping[] };
    definitions: DefinitionRecord[];
}

// ---------------------------------------------------------------------------
// deterministic canonical JSON writer
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

function sortDeep(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(sortDeep);
    }
    if (isPlainObject(value)) {
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(value).sort()) {
            out[key] = sortDeep(value[key]);
        }
        return out;
    }
    return value;
}

/** Canonical JSON text WITHOUT trailing newline (arrays keep their order). */
export function canonicalJson(value: unknown): string {
    return JSON.stringify(sortDeep(value), null, 2);
}

/** Canonical artifact file text WITH a single trailing newline. */
export function artifactFileText(artifact: BootstrapArtifact): string {
    return canonicalJson(artifact) + "\n";
}

export function parseArtifact(text: string): BootstrapArtifact {
    return JSON.parse(text) as BootstrapArtifact;
}

/**
 * Deep-compare two canonical artifact texts.
 * `full` is byte equality; `semantic` ignores only provenance.generating_git_commit
 * (an environment fact by definition — everything else, including the input
 * SHA-256 hashes, must match exactly).
 *
 * generating_git_commit records the Git HEAD observed at generation time; the
 * artifact is expected to be committed later by a DESCENDANT commit, so the
 * recorded SHA is intentionally allowed to differ from any later HEAD.
 * Regeneration comparisons reuse the recorded SHA as the provenance input
 * (never the live HEAD), which keeps `full` byte-equality stable across
 * commits as long as the canonical inputs are unchanged.
 */
export function compareArtifactTexts(a: string, b: string): { full: boolean; semantic: boolean } {
    const full = a === b;
    const pa = parseArtifact(a);
    const pb = parseArtifact(b);
    pa.provenance.generating_git_commit = null;
    pb.provenance.generating_git_commit = null;
    const semantic = canonicalJson(pa) === canonicalJson(pb);
    return { full, semantic };
}
