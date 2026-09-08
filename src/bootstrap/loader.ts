// Gate 5B — idempotent transactional bootstrap loader (runtime-neutral TS).
//
// Follows the adopted Gate-5A D5 strategy:
//   * one transaction per logical item (BEGIN IMMEDIATE ... COMMIT/ROLLBACK);
//   * an identical reload converges / no-ops (no duplicate ACTIVE rows);
//   * immutable definition-version content is never silently overwritten;
//   * drift / conflict conditions raise explicit typed errors;
//   * the applicability payload is preserved exactly (canonical JSON text);
//   * after the item loop the loader runs the manifest ACTIVE+P0 exact-set
//     verification (both directions, P1 excluded) — the same executable
//     check createVisit (T0) uses in Gate 5C.
//
// The loader never hard-codes CHK codes or Arabic semantics: it only carries
// out the artifact (bootstrap/v1/checklist-v1.json) through the SqlAdapter.

import type { AllowedValueRecord, BootstrapArtifact, DefinitionRecord } from "./artifact.ts";
import { canonicalJson } from "./artifact.ts";
import { BootstrapError, ERR } from "./errors.ts";
import { verifyLoadedActiveP0 } from "./manifest.ts";
import type { SqlAdapter, SqlRow, SqlValue } from "./adapter.ts";

export interface LoadReport {
    /** codes whose v1 ACTIVE definition+values were inserted in this run */
    loaded: string[];
    /** codes already present with byte-identical version-1 content (no-op) */
    alreadyPresent: string[];
    expectedItemCount: number;
    p0ExpectedCount: number;
}

interface ExistingDefinition {
    item_definition_id: number;
    version_no: number;
    status: string;
    domain_id: string;
    arabic_question: string;
    response_model: string;
    priority: string;
    traceability: string;
    requirement_refs: string;
    note_rule: string | null;
    evidence_rule: string | null;
    finding_rule: string | null;
    applicability_rule: string;
}

function rowToExisting(row: SqlRow): ExistingDefinition {
    return {
        item_definition_id: Number(row.item_definition_id),
        version_no: Number(row.version_no),
        status: String(row.status),
        domain_id: String(row.domain_id),
        arabic_question: String(row.arabic_question),
        response_model: String(row.response_model),
        priority: String(row.priority),
        traceability: String(row.traceability),
        requirement_refs: String(row.requirement_refs),
        note_rule: row.note_rule === null ? null : String(row.note_rule),
        evidence_rule: row.evidence_rule === null ? null : String(row.evidence_rule),
        finding_rule: row.finding_rule === null ? null : String(row.finding_rule),
        applicability_rule: String(row.applicability_rule),
    };
}

function defContentEquals(entry: DefinitionRecord, row: ExistingDefinition): boolean {
    const eq = (a: string | null, b: string | null) => (a === null && b === null) || (a !== null && b !== null && a === b);
    return (
        row.version_no === entry.version_no &&
        row.domain_id === entry.domain_id &&
        row.arabic_question === entry.arabic_question &&
        row.response_model === entry.response_model &&
        row.priority === entry.priority &&
        row.traceability === entry.traceability &&
        row.requirement_refs === canonicalJson(entry.requirement_refs) &&
        eq(row.note_rule, entry.note_rule) &&
        eq(row.evidence_rule, entry.evidence_rule) &&
        eq(row.finding_rule, entry.finding_rule) &&
        row.applicability_rule === canonicalJson(entry.applicability_rule)
    );
}

function allowedValuesMatch(expected: readonly AllowedValueRecord[], rows: readonly SqlRow[]): boolean {
    if (rows.length !== expected.length) return false;
    for (let i = 0; i < expected.length; i++) {
        const want = expected[i];
        const got = rows[i];
        if (
            String(got.value_code) !== want.value_code ||
            String(got.arabic_label) !== want.arabic_label ||
            String(got.semantic_class) !== want.semantic_class ||
            Number(got.sort_order) !== want.sort_order ||
            Boolean(got.active) !== want.active
        ) {
            return false;
        }
    }
    return true;
}

function expectString(v: unknown, what: string): string {
    if (typeof v !== "string" || v.length === 0) {
        throw new BootstrapError(ERR.CONFIG, `malformed artifact: ${what} must be a non-empty string`);
    }
    return v;
}

function expectNumber(v: unknown, what: string): number {
    if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
        throw new BootstrapError(ERR.CONFIG, `malformed artifact: ${what} must be a positive integer`);
    }
    return v;
}

export class BootstrapLoader {
    private readonly db: SqlAdapter;
    private readonly artifact: BootstrapArtifact;

    constructor(db: SqlAdapter, artifact: BootstrapArtifact) {
        this.db = db;
        this.artifact = artifact;
    }

    /**
     * Pure structural preflight, run BEFORE the first BEGIN IMMEDIATE / INSERT:
     * a malformed artifact must raise E_CONFIG with zero DB side effects.
     * v1 manifest requirements (review correction B):
     *   P0 list has no duplicates; P1 list has no duplicates; P0 ∩ P1 = ∅;
     *   P0 ∪ P1 == definition item-code set EXACTLY (both directions);
     *   expected_total_item_count == definitions.length;
     *   every P0 manifest code maps to a P0 definition and every P1 manifest
     *   code to a P1 definition; definitions themselves are unique.
     * The post-load ACTIVE+P0 exact-set check stays a separate DB-state check.
     */
    private validateArtifact(): void {
        const defs = this.artifact.definitions;
        if (!Array.isArray(defs) || defs.length === 0) {
            throw new BootstrapError(ERR.CONFIG, "artifact carries no definitions");
        }
        const seen = new Set<string>();
        for (const d of defs) {
            const code = expectString(d.item_code, "definition.item_code");
            if (seen.has(code)) {
                throw new BootstrapError(ERR.CONFIG, `duplicate definition item_code ${code} in artifact`);
            }
            seen.add(code);
            expectNumber(d.version_no, `${code}.version_no`);
            expectString(d.domain_id, `${code}.domain_id`);
            expectString(d.arabic_question, `${code}.arabic_question`);
            expectString(d.response_model, `${code}.response_model`);
            expectString(d.priority, `${code}.priority`);
            expectString(d.traceability, `${code}.traceability`);
            if (!Array.isArray(d.allowed_values) || d.allowed_values.length === 0) {
                throw new BootstrapError(ERR.CONFIG, `${code} carries no allowed values`);
            }
            if (d.applicability_rule === null || typeof d.applicability_rule !== "object") {
                throw new BootstrapError(ERR.CONFIG, `${code} applicability_rule must be a JSON object`);
            }
        }

        const manifest = this.artifact.manifest;
        const p0List = manifest.expected_p0_item_codes;
        const p1List = manifest.expected_p1_item_codes;
        if (!Array.isArray(p0List) || !Array.isArray(p1List)) {
            throw new BootstrapError(ERR.CONFIG, "manifest P0/P1 code lists must be arrays");
        }

        // 1/2. no duplicates within each list
        const p0 = new Set(p0List);
        if (p0.size !== p0List.length) {
            throw new BootstrapError(ERR.CONFIG, "manifest expected_p0_item_codes contains duplicates");
        }
        const p1 = new Set(p1List);
        if (p1.size !== p1List.length) {
            throw new BootstrapError(ERR.CONFIG, "manifest expected_p1_item_codes contains duplicates");
        }

        // 3. no overlap
        const overlap = [...p0].filter((c) => p1.has(c));
        if (overlap.length > 0) {
            throw new BootstrapError(ERR.CONFIG, `manifest P0/P1 sets overlap: ${overlap.join(", ")}`);
        }

        // 4. P0 ∪ P1 == definition item-code set, in BOTH directions
        const defCodes = new Set(defs.map((d) => d.item_code));
        const missingFromManifest = defs.filter((d) => !p0.has(d.item_code) && !p1.has(d.item_code)).map((d) => d.item_code);
        if (missingFromManifest.length > 0) {
            throw new BootstrapError(ERR.CONFIG, `manifest does not list definition(s): ${missingFromManifest.join(", ")}`);
        }
        const manifestOnly = [...p0, ...p1].filter((c) => !defCodes.has(c));
        if (manifestOnly.length > 0) {
            throw new BootstrapError(ERR.CONFIG, `manifest lists code(s) with no definition in the artifact: ${manifestOnly.join(", ")}`);
        }

        // 5. expected_total_item_count must equal the definition count
        if (manifest.expected_total_item_count !== defs.length) {
            throw new BootstrapError(
                ERR.CONFIG,
                `manifest expected_total_item_count ${manifest.expected_total_item_count} != definitions.length ${defs.length}`,
            );
        }

        // 6/7. manifest priority alignment (P0 code -> P0 definition, P1 -> P1)
        const byCode = new Map(defs.map((d) => [d.item_code, d]));
        for (const code of p0List) {
            if (byCode.get(code)?.priority !== "P0") {
                throw new BootstrapError(ERR.CONFIG, `manifest P0 code ${code} does not map to a P0 definition`);
            }
        }
        for (const code of p1List) {
            if (byCode.get(code)?.priority !== "P1") {
                throw new BootstrapError(ERR.CONFIG, `manifest P1 code ${code} does not map to a P1 definition`);
            }
        }
    }

    private async insertDefinition(entry: DefinitionRecord): Promise<number> {
        const def = await this.db.run(
            `INSERT INTO checklist_item_definition
               (item_code, version_no, domain_id, arabic_question, response_model, priority,
                traceability, requirement_refs, note_rule, evidence_rule, finding_rule,
                applicability_rule, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE')`,
            [
                entry.item_code,
                entry.version_no,
                entry.domain_id,
                entry.arabic_question,
                entry.response_model,
                entry.priority,
                entry.traceability,
                canonicalJson(entry.requirement_refs),
                entry.note_rule,
                entry.evidence_rule,
                entry.finding_rule,
                canonicalJson(entry.applicability_rule),
            ] as readonly SqlValue[],
        );
        const defId = def.lastInsertRowid;
        if (defId === null) {
            throw new BootstrapError(ERR.CONFIG, `definition insert for ${entry.item_code} returned no rowid`);
        }
        for (const av of entry.allowed_values) {
            await this.db.run(
                `INSERT INTO checklist_allowed_value
                   (item_definition_id, value_code, arabic_label, semantic_class, sort_order, active)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [defId, av.value_code, av.arabic_label, av.semantic_class, av.sort_order, av.active ? 1 : 0] as readonly SqlValue[],
            );
        }
        return defId;
    }

    private async readAllowedValues(defId: number): Promise<SqlRow[]> {
        return this.db.query(
            `SELECT value_code, arabic_label, semantic_class, sort_order, active
               FROM checklist_allowed_value
              WHERE item_definition_id = ?
              ORDER BY sort_order, value_code`,
            [defId],
        );
    }

    /**
     * One logical item == one transaction. An ACTIVE definition whose content
     * is byte-identical to the artifact version is a no-op; any difference at
     * the same version is drift (never overwritten); an ACTIVE definition of a
     * different version (or only historical rows) is a conflict.
     */
    private async loadOneItem(entry: DefinitionRecord): Promise<"loaded" | "noop"> {
        await this.db.beginImmediate();
        try {
            const rows = await this.db.query(
                `SELECT item_definition_id, version_no, status, domain_id, arabic_question,
                        response_model, priority, traceability, requirement_refs,
                        note_rule, evidence_rule, finding_rule, applicability_rule
                   FROM checklist_item_definition
                  WHERE item_code = ?
                  ORDER BY version_no DESC`,
                [entry.item_code],
            );
            if (rows.length === 0) {
                await this.insertDefinition(entry);
                await this.db.commit();
                return "loaded";
            }
            const existing = rows.map(rowToExisting);
            const actives = existing.filter((r) => r.status === "ACTIVE");
            if (actives.length === 0) {
                throw new BootstrapError(
                    ERR.BOOTSTRAP_CONFLICT,
                    `${entry.item_code}: no ACTIVE definition in the loaded DB ` +
                        `(only ${existing.map((r) => `${r.status} v${r.version_no}`).join(", ")}); ` +
                        "bootstrap refuses to resurrect historical versions or to overwrite immutable content",
                );
            }
            const active = actives[0]; // uq_active_def_per_code guarantees a single ACTIVE
            if (active.version_no !== entry.version_no) {
                throw new BootstrapError(
                    ERR.BOOTSTRAP_CONFLICT,
                    `${entry.item_code}: loaded DB has ACTIVE version ${active.version_no} but the artifact ` +
                        `carries version ${entry.version_no}; a definition change requires a NEW artifact version, ` +
                        "never an overwrite of immutable definition-version content",
                );
            }
            if (!defContentEquals(entry, active)) {
                throw new BootstrapError(
                    ERR.BOOTSTRAP_DRIFT,
                    `${entry.item_code}: loaded ACTIVE v${entry.version_no} definition content differs from the ` +
                        "canonical artifact (question/refs/rules/applicability payload); refusing to overwrite immutable content",
                );
            }
            const avRows = await this.readAllowedValues(active.item_definition_id);
            if (!allowedValuesMatch(entry.allowed_values, avRows)) {
                throw new BootstrapError(
                    ERR.BOOTSTRAP_DRIFT,
                    `${entry.item_code}: allowed-value set of the loaded ACTIVE v${entry.version_no} differs from ` +
                        "the canonical artifact; refusing to repair immutable allowed-value metadata silently",
                );
            }
            await this.db.commit();
            return "noop";
        } catch (e) {
            try {
                await this.db.rollback();
            } catch {
                // rollback must not mask the original failure
            }
            throw e;
        }
    }

    async load(): Promise<LoadReport> {
        this.validateArtifact();
        const report: LoadReport = {
            loaded: [],
            alreadyPresent: [],
            expectedItemCount: this.artifact.definitions.length,
            p0ExpectedCount: this.artifact.manifest.expected_p0_item_codes.length,
        };
        for (const entry of this.artifact.definitions) {
            const outcome = await this.loadOneItem(entry);
            if (outcome === "loaded") report.loaded.push(entry.item_code);
            else report.alreadyPresent.push(entry.item_code);
        }
        // Post-load manifest verification — expected P0 set ⇔ DB ACTIVE+P0 set
        // (both directions, P1 excluded). Failures raise the T0-style errors.
        await verifyLoadedActiveP0(this.db, this.artifact.manifest.expected_p0_item_codes);
        return report;
    }
}
