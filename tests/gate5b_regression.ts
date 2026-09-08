// Gate 5B — automated regression for the bootstrap/reference-data strategy.
//
// Run (repository root; Node.js >= 22 is the adopted development/test host,
// Gate-5A D1 — node:sqlite + native TypeScript type stripping):
//   Node 22.x:   node --experimental-strip-types tests/gate5b_regression.ts
//   Node 24.x:   node tests/gate5b_regression.ts
//                (also works with the --experimental-strip-types form above;
//                 both invocations execute the identical script)
// Exit: 0 on success, 1 when any assertion fails.
//
// Coverage (requirement F, Gate 5B):
//   1  deterministic regeneration equals the committed artifact
//      (regeneration reuses the artifact's recorded generating_git_commit —
//      a provenance environment fact, NOT the current HEAD — so byte-equality
//      survives the later commit of this very artifact)
//   2  exactly 24 item codes (CHK-001..CHK-024, each once)
//   3  P0 manifest is exactly CHK-001..CHK-020 (P1 CHK-021..CHK-024 excluded)
//   4  one correct definition/version per item
//   5  allowed-value / value_code / semantic_class / order integrity
//   6  applicability payload equality with the authoritative rules doc
//   7  successful bootstrap into a fresh schema.sql SQLite DB
//   8  idempotent second load (converges / no-ops)
//   9  one ACTIVE definition per code after loading
//   10 deliberate generator/source and DB drift is detected
//   11 manifest P0 set compared in BOTH directions against loaded ACTIVE+P0
//   12 manifest-structure preflight rejects malformed artifacts with E_CONFIG
//      BEFORE any database row is inserted
//
// Plus loader-contract checks: one transaction per logical item (a fault at
// item N leaves items 1..N-1 committed; a rerun converges), explicit
// E_BOOTSTRAP_CONFLICT / E_BOOTSTRAP_DRIFT / E_NO_ACTIVE_DEFINITION /
// E_CONFIG errors, applicability payload preserved byte-canonically, and
// immutable content is never silently overwritten.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

import type { SqlAdapter, SqlRow, SqlValue } from "../src/bootstrap/adapter.ts";
import { openFreshDb } from "../dev/node-sqlite-adapter.ts";
import { BootstrapError, ERR } from "../src/bootstrap/errors.ts";
import { BootstrapLoader } from "../src/bootstrap/loader.ts";
import { assertP0SetsEqual, compareP0Sets, loadActiveP0Codes, verifyLoadedActiveP0 } from "../src/bootstrap/manifest.ts";
import { artifactFileText, canonicalJson, compareArtifactTexts, parseArtifact } from "../src/bootstrap/artifact.ts";
import { generateChecklistArtifact, artifactText, GENERATOR_VERSION, GENERATOR_NAME } from "../tools/gate5b/generator.ts";
import { resolveProvenanceCommit } from "../tools/gate5b/provenance.ts";
import { VALUE_EDITORIAL_BY_LABEL } from "../tools/gate5b/editorial.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_SQL = readFileSync(join(ROOT, "docs", "schema", "schema.sql"), "utf8");
const FIELD_MD = readFileSync(join(ROOT, "docs", "checklists", "FIELD-CHECKLIST-v1.md"), "utf8");
const APPLICABILITY_MD = readFileSync(join(ROOT, "docs", "checklists", "APPLICABILITY-RULES-v1.md"), "utf8");
const ARTIFACT_PATH = join(ROOT, "bootstrap", "v1", "checklist-v1.json");
const COMMITTED_ARTIFACT_TEXT = readFileSync(ARTIFACT_PATH, "utf8");
const COMMITTED = parseArtifact(COMMITTED_ARTIFACT_TEXT);

/** The generation-time Git HEAD recorded inside the committed artifact. */
const RECORDED_COMMIT = COMMITTED.provenance.generating_git_commit;

function sha256(text: string): string {
    return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

function gitAvailable(): boolean {
    const res = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: ROOT, encoding: "utf8" });
    return res.status === 0;
}

function gitHead(): string | null {
    if (!gitAvailable()) return null;
    const res = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" });
    if (res.status !== 0) return null;
    const sha = (res.stdout ?? "").trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

/** git cat-file style: does <sha> resolve to a commit object? */
function gitResolvesToCommit(sha: string): boolean {
    const res = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`], { cwd: ROOT, encoding: "utf8" });
    return res.status === 0;
}

/** git merge-base --is-ancestor <sha> HEAD (true when equal or an ancestor). */
function gitIsAncestorOfHead(sha: string): boolean {
    const res = spawnSync("git", ["merge-base", "--is-ancestor", sha, "HEAD"], { cwd: ROOT, encoding: "utf8" });
    return res.status === 0;
}

/**
 * Provenance validation (review correction A):
 *   * null is permitted only when Git information was unavailable;
 *   * otherwise the recorded SHA must be a valid 40-hex string;
 *   * when Git is available the SHA must resolve to a commit and (preferably)
 *     be reachable / an ancestor of the current HEAD.
 * It must NOT equal the current HEAD — the artifact may later be committed by
 * a descendant commit.
 */
function assertProvenanceValid(recorded: string | null): void {
    if (recorded === null) {
        assert(!gitAvailable(), "recorded generating_git_commit is null although Git is available");
        return;
    }
    assert(/^[0-9a-f]{40}$/.test(recorded), `recorded generating_git_commit is not a valid 40-hex SHA: ${recorded}`);
    if (!gitAvailable()) return; // cannot resolve outside a Git checkout
    assert(gitResolvesToCommit(recorded), `recorded generating_git_commit ${recorded} does not resolve to a commit`);
    assert(gitIsAncestorOfHead(recorded), `recorded generating_git_commit ${recorded} is not reachable from HEAD`);
}

/**
 * Deterministic regeneration of the COMMITTED artifact MUST use the artifact's
 * recorded generating_git_commit as the provenance input — never the current
 * HEAD (which may be a later, descendant commit).  With canonical inputs and
 * generator/editorial data unchanged, this regenerates byte-identical text
 * even after the artifact is committed at a different SHA.
 */
function regenerateArtifactText(commit: string | null = RECORDED_COMMIT): string {
    return artifactText(
        generateChecklistArtifact({
            checklistText: FIELD_MD,
            applicabilityText: APPLICABILITY_MD,
            fieldChecklistSha256: sha256(FIELD_MD),
            applicabilitySha256: sha256(APPLICABILITY_MD),
            generatingGitCommit: commit,
        }),
    );
}

function cloneArtifact(): typeof COMMITTED {
    return structuredClone(COMMITTED) as typeof COMMITTED;
}

// ---------------------------------------------------------------------------
// tiny assertion harness
// ---------------------------------------------------------------------------
const failures: string[] = [];
let passed = 0;

async function ok(name: string, fn: () => Promise<void> | void): Promise<void> {
    try {
        await fn();
        passed += 1;
    } catch (e) {
        failures.push(`${name} :: ${e instanceof Error ? e.message : String(e)}`);
    }
}

function assert(cond: unknown, msg: string): asserts cond {
    if (!cond) throw new Error(`assertion failed: ${msg}`);
}

function throwsAsync(codeOf: string, fn: () => Promise<unknown>): Promise<BootstrapError> {
    return fn().then(
        () => {
            throw new Error(`expected ${codeOf} but the operation succeeded`);
        },
        (e: unknown) => {
            if (!(e instanceof BootstrapError)) {
                throw new Error(`expected BootstrapError ${codeOf}, got ${e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e)}`);
            }
            if (e.code !== codeOf) {
                throw new Error(`expected code ${codeOf}, got ${e.code}: ${e.message}`);
            }
            return e;
        },
    );
}

async function dbCounts(db: SqlAdapter): Promise<{ defs: number; values: number; active: number; p0active: number }> {
    const q = async (sql: string): Promise<number> => {
        const rows = await db.query(sql);
        return Number(rows[0].c);
    };
    return {
        defs: await q("SELECT count(*) AS c FROM checklist_item_definition"),
        values: await q("SELECT count(*) AS c FROM checklist_allowed_value"),
        active: await q("SELECT count(*) AS c FROM checklist_item_definition WHERE status = 'ACTIVE'"),
        p0active: await q("SELECT count(*) AS c FROM checklist_item_definition WHERE status = 'ACTIVE' AND priority = 'P0'"),
    };
}

function allCodes(): string[] {
    return Array.from({ length: 24 }, (_, i) => `CHK-${String(i + 1).padStart(3, "0")}`);
}

// ---------------------------------------------------------------------------
// test 1 — deterministic regeneration equals the committed artifact
// ---------------------------------------------------------------------------
async function t1_determinism(): Promise<void> {
    await ok("regeneration with the RECORDED commit byte-equals the committed artifact (independent of current HEAD)", async () => {
        const regenerated = regenerateArtifactText(RECORDED_COMMIT);
        const comparison = compareArtifactTexts(regenerated, COMMITTED_ARTIFACT_TEXT);
        assert(comparison.full === true, "byte-identical regeneration expected (canonical inputs unchanged, recorded commit reused)");
        assert(comparison.semantic === true, "regeneration semantically diverged from the committed artifact");
    });

    await ok("generator is a pure deterministic function of its inputs (two runs, same bytes)", () => {
        const a = regenerateArtifactText(RECORDED_COMMIT);
        const b = regenerateArtifactText(RECORDED_COMMIT);
        assert(a === b, "two generations on identical inputs must be byte-identical");
    });

    await ok("recorded provenance is reproducible and valid (input sha-256 + generator identity + Git facts)", () => {
        const p = COMMITTED.provenance;
        assert(p.generator_name === GENERATOR_NAME, "generator name mismatch");
        assert(p.generator_version === GENERATOR_VERSION, "generator version mismatch");
        assert(p.inputs.length === 2, `expected 2 canonical inputs, got ${p.inputs.length}`);
        assert(p.inputs[0].path === "docs/checklists/FIELD-CHECKLIST-v1.md", "input0 path");
        assert(p.inputs[1].path === "docs/checklists/APPLICABILITY-RULES-v1.md", "input1 path");
        assert(p.inputs[0].sha256 === sha256(FIELD_MD), "field-checklist sha256 does not match the live file");
        assert(p.inputs[1].sha256 === sha256(APPLICABILITY_MD), "applicability sha256 does not match the live file");
        // provenance environment fact: valid shape + resolves + reachable from
        // HEAD — but NEVER required to equal the current HEAD.
        assertProvenanceValid(p.generating_git_commit);
    });

    await ok("simulated descendant commit: recorded SHA != current HEAD is accepted and regeneration still succeeds", async () => {
        const head = gitHead();
        assert(head !== null, "git HEAD unavailable for simulation");
        // HEAD~1 is a real ancestor commit distinct from HEAD in this repo.
        const parentRes = spawnSync("git", ["rev-parse", "HEAD~1"], { cwd: ROOT, encoding: "utf8" });
        assert(parentRes.status === 0, "no parent commit available for simulation");
        const parent = (parentRes.stdout ?? "").trim();
        assert(/^[0-9a-f]{40}$/.test(parent) && parent !== head, "parent must be a valid SHA distinct from HEAD");

        // The recorded SHA differs from the current HEAD, yet the provenance
        // contract still holds: it resolves and is an ancestor of HEAD.
        assertProvenanceValid(parent);

        // An artifact "committed" with that generation SHA regenerates
        // byte-identically when the recorded SHA is reused as the input...
        const simulated = cloneArtifact();
        simulated.provenance.generating_git_commit = parent;
        const simulatedText = artifactFileText(simulated);
        const regenerated = regenerateArtifactText(parent);
        assert(regenerated === simulatedText, "regeneration with the recorded (non-HEAD) SHA must byte-equal the artifact");

        // ...which is exactly why the current HEAD must never be injected into
        // the regenerated candidate (that is the pre-correction behaviour that
        // broke after the Gate-5B commit).
        assert(
            regenerateArtifactText(head) !== simulatedText,
            "regenerating by injecting the CURRENT HEAD must differ from the artifact recorded at the older SHA",
        );
    });

    await ok("shared CLI provenance decision: regeneration reuses the recorded commit; HEAD is used only for first creation or --fresh-provenance", () => {
        const recordedA = RECORDED_COMMIT ?? gitHead() ?? "a".repeat(40);
        const headB = gitHead() ?? "b".repeat(40);
        const other = headB === recordedA ? (recordedA === "a".repeat(40) ? "b".repeat(40) : "a".repeat(40)) : headB;
        // regeneration/verification of an EXISTING artifact: recorded commit is
        // reused even when it differs from the current HEAD
        assert(
            resolveProvenanceCommit({ artifactExists: true, recordedCommit: recordedA, currentHead: other, forceFreshProvenance: false }) === recordedA,
            "existing artifact must reuse its recorded commit, not the current HEAD",
        );
        // a recorded null is reproduced as null (byte-identical provenance)
        assert(
            resolveProvenanceCommit({ artifactExists: true, recordedCommit: null, currentHead: other, forceFreshProvenance: false }) === null,
            "existing artifact recorded null must be reproduced as null",
        );
        // first creation anchors to current HEAD when available, else null
        assert(
            resolveProvenanceCommit({ artifactExists: false, recordedCommit: null, currentHead: headB, forceFreshProvenance: false }) === headB,
            "first creation must anchor to the current HEAD",
        );
        assert(
            resolveProvenanceCommit({ artifactExists: false, recordedCommit: null, currentHead: null, forceFreshProvenance: false }) === null,
            "first creation without Git must record null",
        );
        // explicit fresh provenance is the only path that abandons the recorded anchor
        assert(
            resolveProvenanceCommit({ artifactExists: true, recordedCommit: recordedA, currentHead: other, forceFreshProvenance: true }) === other,
            "--fresh-provenance must explicitly re-anchor to the current HEAD",
        );
        // same-HEAD regeneration still reuses the recorded commit
        assert(
            resolveProvenanceCommit({ artifactExists: true, recordedCommit: recordedA, currentHead: recordedA, forceFreshProvenance: false }) === recordedA,
            "recorded commit reused even when HEAD equals it",
        );
    });

    await ok("real generator CLI (child process on a repo copy): recorded SHA != environment HEAD reproduces byte-identical artifact and does not chase HEAD", async () => {
        // Copy exactly the files the CLI needs into a temp tree OUTSIDE the
        // workspace (no Git there), so the CLI sees NO repository while the
        // copied artifact still records the original SHA — simulating a run
        // after a descendant commit changed the HEAD.  No Git commit is made.
        const tmpRoot = mkdtempSync(join(tmpdir(), "gate5b-cli-"));
        try {
            const cliFiles = [
                "docs/checklists/FIELD-CHECKLIST-v1.md",
                "docs/checklists/APPLICABILITY-RULES-v1.md",
                "tools/gate5b/generate.ts",
                "tools/gate5b/generator.ts",
                "tools/gate5b/provenance.ts",
                "tools/gate5b/editorial.ts",
                "src/bootstrap/artifact.ts",
                "src/bootstrap/errors.ts",
                "bootstrap/v1/checklist-v1.json",
            ];
            for (const rel of cliFiles) {
                const dst = join(tmpRoot, rel);
                mkdirSync(dirname(dst), { recursive: true });
                writeFileSync(dst, readFileSync(join(ROOT, rel)));
            }
            const artifactPathInTmp = join(tmpRoot, "bootstrap", "v1", "checklist-v1.json");
            const originalText = readFileSync(artifactPathInTmp, "utf8");
            const env: NodeJS.ProcessEnv = { ...process.env, GIT_CEILING_DIRECTORIES: tmpRoot };
            delete env.GIT_DIR;
            delete env.GIT_WORK_TREE;

            const runCli = (extraArgs: string[] = []): { status: number; out: string } => {
                const res = spawnSync(process.execPath, [...process.execArgv, join(tmpRoot, "tools", "gate5b", "generate.ts"), ...extraArgs], {
                    cwd: tmpRoot,
                    encoding: "utf8",
                    env,
                });
                return { status: res.status ?? -1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
            };

            // 1) default regeneration: recorded SHA (A) reused although the
            //    environment has NO git HEAD — byte-identical, no rewrite.
            const regen = runCli();
            assert(regen.status === 0, `CLI regeneration failed:\n${regen.out}`);
            assert(regen.out.includes("recorded provenance anchor reused"), `unexpected mode line:\n${regen.out}`);
            const regenText = readFileSync(artifactPathInTmp, "utf8");
            assert(regenText === originalText, "CLI regeneration must be byte-identical and must not chase HEAD");
            assert(parseArtifact(regenText).provenance.generating_git_commit === COMMITTED.provenance.generating_git_commit, "recorded SHA rewritten by default regeneration");

            // 2) run again: still byte-identical (idempotent regeneration).
            const regen2 = runCli();
            assert(regen2.status === 0, `second CLI regeneration failed:\n${regen2.out}`);
            assert(readFileSync(artifactPathInTmp, "utf8") === originalText, "second CLI regeneration drifted");

            // 3) --fresh-provenance is the ONLY path that abandons the anchor:
            //    with no Git available the anchor becomes null (explicit change).
            const fresh = runCli(["--fresh-provenance"]);
            assert(fresh.status === 0, `--fresh-provenance failed:\n${fresh.out}`);
            assert(fresh.out.includes("explicit fresh provenance"), `--fresh-provenance mode not selected:\n${fresh.out}`);
            assert(parseArtifact(readFileSync(artifactPathInTmp, "utf8")).provenance.generating_git_commit === null, "--fresh-provenance must re-anchor");

            // 4) first creation: with no artifact and no Git, the anchor is null.
            rmSync(artifactPathInTmp);
            const first = runCli();
            assert(first.status === 0, `first-creation CLI run failed:\n${first.out}`);
            assert(first.out.includes("first creation"), `unexpected mode line:\n${first.out}`);
            const firstArtifact = parseArtifact(readFileSync(artifactPathInTmp, "utf8"));
            assert(firstArtifact.provenance.generating_git_commit === null, "first creation without Git must record null");
            assert(firstArtifact.definitions.length === 24, "first creation definitions");
        } finally {
            rmSync(tmpRoot, { recursive: true, force: true });
        }
    });
}

// ---------------------------------------------------------------------------
// test 2 — exactly 24 item codes
// ---------------------------------------------------------------------------
async function t2_code_count(): Promise<void> {
    await ok("artifact carries exactly CHK-001..CHK-024, each exactly once", () => {
        const codes = COMMITTED.definitions.map((d) => d.item_code);
        const expected = allCodes();
        assert(codes.length === 24, `definitions count ${codes.length}`);
        assert(JSON.stringify(codes) === JSON.stringify(expected), `codes out of order/duplicated/missing: ${codes.join(",")}`);
        assert(new Set(codes).size === 24, "duplicate item_code present");
        assert(COMMITTED.manifest.expected_total_item_count === 24, "manifest total count");
    });
}

// ---------------------------------------------------------------------------
// test 3 — P0 manifest exactly CHK-001..CHK-020
// ---------------------------------------------------------------------------
async function t3_manifest_p0(): Promise<void> {
    await ok("P0 manifest is exactly CHK-001..CHK-020", () => {
        const expectedP0 = allCodes().slice(0, 20);
        const expectedP1 = allCodes().slice(20, 24);
        assert(
            JSON.stringify(COMMITTED.manifest.expected_p0_item_codes) === JSON.stringify(expectedP0),
            `P0 manifest ${COMMITTED.manifest.expected_p0_item_codes.join(",")}`,
        );
        assert(
            JSON.stringify(COMMITTED.manifest.expected_p1_item_codes) === JSON.stringify(expectedP1),
            `P1 list ${COMMITTED.manifest.expected_p1_item_codes.join(",")}`,
        );
        // P1 codes never leak into the P0 set
        for (const code of expectedP1) {
            assert(!COMMITTED.manifest.expected_p0_item_codes.includes(code), `${code} must not appear in the P0 manifest`);
        }
    });
    await ok("artifact priorities are consistent with the manifest split", () => {
        for (const d of COMMITTED.definitions) {
            if (COMMITTED.manifest.expected_p0_item_codes.includes(d.item_code)) {
                assert(d.priority === "P0", `${d.item_code} in P0 manifest but priority ${d.priority}`);
            } else if (COMMITTED.manifest.expected_p1_item_codes.includes(d.item_code)) {
                assert(d.priority === "P1", `${d.item_code} is a P1 carried code but priority ${d.priority}`);
            } else {
                throw new Error(`${d.item_code} appears in neither manifest list`);
            }
        }
    });
}

// ---------------------------------------------------------------------------
// test 4 — one correct definition/version per item
// ---------------------------------------------------------------------------
async function t4_definition_version(): Promise<void> {
    await ok("each item has exactly one definition entry, version_no = 1, loadable fields sane", () => {
        const seen = new Set<string>();
        for (const d of COMMITTED.definitions) {
            assert(!seen.has(d.item_code), `duplicate ${d.item_code}`);
            seen.add(d.item_code);
            assert(d.version_no === 1, `${d.item_code} version_no ${d.version_no}`);
            assert(/^DOM-\d{2}$/.test(d.domain_id), `${d.item_code} domain ${d.domain_id}`);
            assert(d.arabic_question.length > 0, `${d.item_code} empty question`);
            assert(["SINGLE_VALUE", "SCHEDULE"].includes(d.response_model), `${d.item_code} model ${d.response_model}`);
            assert(d.response_model === "SCHEDULE" ? d.item_code === "CHK-012" : d.item_code !== "CHK-012", `${d.item_code} model mismatch`);
            assert(["P0", "P1", "P2"].includes(d.priority), `${d.item_code} priority`);
            assert(["DIRECT", "DERIVED", "PROJECT"].includes(d.traceability), `${d.item_code} traceability`);
            assert(Array.isArray(d.requirement_refs) && d.requirement_refs.length > 0, `${d.item_code} refs`);
            assert(d.note_rule.length > 0 && d.evidence_rule.length > 0 && d.finding_rule.length > 0, `${d.item_code} rules empty`);
            assert(typeof d.applicability_rule === "object" && d.applicability_rule !== null, `${d.item_code} applicability missing`);
            assert(d.applicability_rule.item_code === d.item_code, `${d.item_code} payload code mismatch`);
        }
        assert(seen.size === 24, `seen ${seen.size}`);
    });
}

// ---------------------------------------------------------------------------
// test 5 — allowed-value / value_code / semantic_class / order integrity
// ---------------------------------------------------------------------------
async function t5_allowed_values(): Promise<void> {
    await ok("allowed-value integrity per definition (pairs, order 1..2, unique codes, editorial semantics)", () => {
        for (const d of COMMITTED.definitions) {
            const values = d.allowed_values;
            assert(values.length === 2, `${d.item_code} allowed values ${values.length} (expected 2 answered options)`);
            const codes = new Set<string>();
            const orders: number[] = [];
            for (let i = 0; i < values.length; i++) {
                const v = values[i];
                assert(v.sort_order === i + 1, `${d.item_code} sort_order ${v.sort_order} at index ${i}`);
                orders.push(v.sort_order);
                assert(!codes.has(v.value_code), `${d.item_code} duplicate value_code ${v.value_code}`);
                codes.add(v.value_code);
                assert(/^[A-Z][A-Z0-9_]*$/.test(v.value_code), `${d.item_code} malformed value_code ${v.value_code}`);
                assert(v.arabic_label.length > 0, `${d.item_code} empty label`);
                assert(["COMPLIANT", "NON_COMPLIANT"].includes(v.semantic_class), `${d.item_code} semantic ${v.semantic_class}`);
                assert(v.active === true, `${d.item_code} value ${v.value_code} must be active`);
                // editorial mapping must be the authority for this label
                const editorial = VALUE_EDITORIAL_BY_LABEL.get(v.arabic_label);
                assert(editorial !== undefined, `${d.item_code} label "${v.arabic_label}" absent from editorial table`);
                assert(editorial.valueCode === v.value_code, `${d.item_code} editorial code mismatch for "${v.arabic_label}"`);
                assert(editorial.semantic === v.semantic_class, `${d.item_code} editorial semantic mismatch for "${v.arabic_label}"`);
            }
            assert(orders.join(",") === "1,2", `${d.item_code} orders ${orders.join(",")}`);
            // a definition exposes one COMPLIANT and one NON_COMPLIANT option
            const classes = values.map((v) => v.semantic_class).sort().join(",");
            assert(classes === "COMPLIANT,NON_COMPLIANT", `${d.item_code} semantic split ${classes}`);
        }
    });
}

// ---------------------------------------------------------------------------
// test 6 — applicability payload equality with the authoritative rules doc
// ---------------------------------------------------------------------------
function extractApplicabilityBlocks(md: string): Map<string, Record<string, unknown>> {
    const map = new Map<string, Record<string, unknown>>();
    let inside = false;
    let buf: string[] = [];
    for (const line of md.split(/\r?\n/)) {
        if (line.trim() === "```json") {
            inside = true;
            buf = [];
            continue;
        }
        if (inside && line.trim() === "```") {
            inside = false;
            const payload = JSON.parse(buf.join("\n")) as Record<string, unknown>;
            map.set(String(payload.item_code), payload);
            continue;
        }
        if (inside) buf.push(line);
    }
    return map;
}

async function t6_applicability_equality(): Promise<void> {
    const canonicalBlocks = extractApplicabilityBlocks(APPLICABILITY_MD);
    await ok("artifact applicability payload equals the §7 authoritative block for every code", () => {
        assert(canonicalBlocks.size === 24, `doc blocks ${canonicalBlocks.size}`);
        for (const d of COMMITTED.definitions) {
            const doc = canonicalBlocks.get(d.item_code);
            assert(doc !== undefined, `${d.item_code} missing in doc`);
            assert(
                canonicalJson(doc) === canonicalJson(d.applicability_rule),
                `${d.item_code} payload differs from doc`,
            );
        }
    });

    await ok("loaded DB applicability_rule text equals the authoritative payload for every code", async () => {
        const db = openFreshDb(SCHEMA_SQL);
        await new BootstrapLoader(db, COMMITTED).load();
        for (const d of COMMITTED.definitions) {
            const rows = await db.query(
                "SELECT applicability_rule FROM checklist_item_definition WHERE item_code = ? AND status = 'ACTIVE'",
                [d.item_code],
            );
            assert(rows.length === 1, `${d.item_code} ACTIVE rows ${rows.length}`);
            const stored = JSON.parse(String(rows[0].applicability_rule)) as Record<string, unknown>;
            const doc = canonicalBlocks.get(d.item_code);
            assert(doc !== undefined, `${d.item_code} doc block missing`);
            assert(
                canonicalJson(stored) === canonicalJson(doc),
                `${d.item_code} DB payload differs from the doc authority`,
            );
        }
    });
}

// ---------------------------------------------------------------------------
// tests 7/8/9 — bootstrap into fresh schema.sql DB, idempotent reload, ACTIVE
// ---------------------------------------------------------------------------
async function freshLoadedDb(): Promise<{ db: SqlAdapter; report: Awaited<ReturnType<BootstrapLoader["load"]>> }> {
    const db = openFreshDb(SCHEMA_SQL);
    const report = await new BootstrapLoader(db, COMMITTED).load();
    return { db, report };
}

async function t789_bootstrap(): Promise<void> {
    let ctx: Awaited<ReturnType<typeof freshLoadedDb>> | null = null;
    await ok("successful bootstrap into a fresh schema.sql SQLite DB", async () => {
        ctx = await freshLoadedDb();
        const counts = await dbCounts(ctx.db);
        assert(counts.defs === 24, `definitions ${counts.defs}`);
        assert(counts.active === 24, `ACTIVE definitions ${counts.active}`);
        assert(counts.values === 48, `allowed values ${counts.values}`);
        assert(counts.p0active === 20, `ACTIVE+P0 ${counts.p0active}`);
        assert(ctx.report.loaded.length === 24, `fresh load inserted ${ctx.report.loaded.length}`);
        assert(ctx.report.alreadyPresent.length === 0, "fresh DB must not no-op");
        const row = await ctx.db.query(
            "SELECT arabic_question, domain_id, priority FROM checklist_item_definition WHERE item_code = 'CHK-001'",
        );
        assert(row[0].arabic_question === COMMITTED.definitions[0].arabic_question, "CHK-001 question mismatch");
    });

    await ok("idempotent second load: converges / no-ops, counts unchanged, one ACTIVE per code", async () => {
        const db = ctx!.db;
        const before = await dbCounts(db);
        const report2 = await new BootstrapLoader(db, COMMITTED).load();
        const after = await dbCounts(db);
        assert(report2.loaded.length === 0, `second load inserted ${report2.loaded.length}`);
        assert(report2.alreadyPresent.length === 24, `second load no-op codes ${report2.alreadyPresent.length}`);
        assert(JSON.stringify(before) === JSON.stringify(after), "DB changed on the second load");
        const dupes = await db.query(
            "SELECT item_code, count(*) AS c FROM checklist_item_definition WHERE status='ACTIVE' GROUP BY item_code HAVING c > 1",
        );
        assert(dupes.length === 0, `duplicate ACTIVE rows: ${JSON.stringify(dupes)}`);
    });

    await ok("one ACTIVE definition per code after loading (all 24 codes, none duplicated)", async () => {
        const db = ctx!.db;
        for (const code of allCodes()) {
            const rows = await db.query(
                "SELECT item_definition_id FROM checklist_item_definition WHERE item_code = ? AND status = 'ACTIVE'",
                [code],
            );
            assert(rows.length === 1, `${code} ACTIVE count ${rows.length}`);
        }
        const total = await dbCounts(db);
        assert(total.defs === 24 && total.active === 24, `totals ${JSON.stringify(total)}`);
    });
}

// ---------------------------------------------------------------------------
// test 10 — deliberate drift is detected (generator/source + DB + loader)
// ---------------------------------------------------------------------------
async function t10_drift(): Promise<void> {
    await ok("source drift: a modified FIELD-CHECKLIST regenerates a different artifact (detection)", async () => {
        const tampered = FIELD_MD.replace("«هل [الورشة/الفضاء] ملتزمة بمعايير النظافة المطلوبة؟»", "«هل [الورشة/الفضاء] ملتزمة بمعايير النظافة المطلوبة وبمعايير إضافية؟»");
        assert(tampered !== FIELD_MD, "tamper did not apply");
        const driftedText = artifactText(
            generateChecklistArtifact({
                checklistText: tampered,
                applicabilityText: APPLICABILITY_MD,
                fieldChecklistSha256: sha256(tampered),
                applicabilitySha256: sha256(APPLICABILITY_MD),
                generatingGitCommit: RECORDED_COMMIT,
            }),
        );
        const comparison = compareArtifactTexts(driftedText, COMMITTED_ARTIFACT_TEXT);
        assert(comparison.semantic === false, "source drift was not detected");
        const drifted = parseArtifact(driftedText);
        const chk003 = drifted.definitions.find((d) => d.item_code === "CHK-003");
        assert(chk003!.arabic_question.includes("معايير إضافية"), "drifted question not reflected");
    });

    await ok("loader drift: mutated artifact content for an ACTIVE code raises E_BOOTSTRAP_DRIFT and overwrites nothing", async () => {
        const ctx = await freshLoadedDb();
        const mutated = cloneArtifact();
        const target = mutated.definitions.find((d) => d.item_code === "CHK-003")!;
        target.arabic_question = target.arabic_question + " (drifted)";
        const err = await throwsAsync(ERR.BOOTSTRAP_DRIFT, () => new BootstrapLoader(ctx.db, mutated).load());
        assert(/CHK-003/.test(err.message), `message should name CHK-003: ${err.message}`);
        const row = await ctx.db.query(
            "SELECT arabic_question FROM checklist_item_definition WHERE item_code = 'CHK-003' AND status = 'ACTIVE'",
        );
        assert(String(row[0].arabic_question) === COMMITTED.definitions[2].arabic_question, "immutable content was overwritten");
    });

    await ok("loader drift: mutated allowed-value metadata raises E_BOOTSTRAP_DRIFT", async () => {
        const ctx = await freshLoadedDb();
        const mutated = cloneArtifact();
        const chk001 = mutated.definitions.find((d) => d.item_code === "CHK-001")!;
        chk001.allowed_values[0].sort_order = 9;
        const err = await throwsAsync(ERR.BOOTSTRAP_DRIFT, () => new BootstrapLoader(ctx.db, mutated).load());
        assert(/CHK-001/.test(err.message), err.message);
    });

    await ok("DB drift: an expected P0 code without an ACTIVE definition raises E_NO_ACTIVE_DEFINITION", async () => {
        const ctx = await freshLoadedDb();
        await ctx.db.run("UPDATE checklist_item_definition SET status = 'ARCHIVED' WHERE item_code = 'CHK-005' AND status = 'ACTIVE'");
        const err = await throwsAsync(ERR.NO_ACTIVE_DEFINITION, () =>
            verifyLoadedActiveP0(ctx.db, COMMITTED.manifest.expected_p0_item_codes),
        );
        assert(err.message.includes("CHK-005"), `missing code not named: ${err.message}`);
    });

    await ok("DB drift: an unexpected ACTIVE-P0 code raises E_BOOTSTRAP_DRIFT", async () => {
        const ctx = await freshLoadedDb();
        const payload = JSON.stringify(cloneArtifact().definitions[0].applicability_rule).replace("CHK-001", "CHK-099");
        await ctx.db.run(
            `INSERT INTO checklist_item_definition
               (item_code, version_no, domain_id, arabic_question, response_model, priority,
                traceability, requirement_refs, note_rule, evidence_rule, finding_rule, applicability_rule, status)
             VALUES ('CHK-099', 1, 'DOM-02', 'extra?', 'SINGLE_VALUE', 'P0', 'DIRECT', '["REQ-000"]',
                     'x', 'x', 'x', ?, 'ACTIVE')`,
            [payload],
        );
        const err = await throwsAsync(ERR.BOOTSTRAP_DRIFT, () =>
            verifyLoadedActiveP0(ctx.db, COMMITTED.manifest.expected_p0_item_codes),
        );
        assert(err.message.includes("CHK-099"), `unexpected code not named: ${err.message}`);
    });

    await ok("loader conflict: an ACTIVE definition of a DIFFERENT version raises E_BOOTSTRAP_CONFLICT", async () => {
        const ctx = await freshLoadedDb();
        const src = cloneArtifact().definitions.find((d) => d.item_code === "CHK-007")!;
        // release ACTIVE v2 superseding the ACTIVE v1
        const oldId = Number(
            (await ctx.db.query("SELECT item_definition_id FROM checklist_item_definition WHERE item_code='CHK-007' AND status='ACTIVE'"))[0]
                .item_definition_id,
        );
        const payload = JSON.stringify(src.applicability_rule);
        await ctx.db.beginImmediate();
        // supersede v1 FIRST, then insert ACTIVE v2 (one ACTIVE per code at any instant)
        await ctx.db.run("UPDATE checklist_item_definition SET status = 'SUPERSEDED' WHERE item_definition_id = ?", [oldId]);
        await ctx.db.run(
            `INSERT INTO checklist_item_definition
               (item_code, version_no, supersedes_definition_id, domain_id, arabic_question, response_model, priority,
                traceability, requirement_refs, note_rule, evidence_rule, finding_rule, applicability_rule, status)
             VALUES ('CHK-007', 2, ?, 'DOM-04', ?, 'SINGLE_VALUE', 'P0', 'DIRECT', '["REQ-004"]', ?, ?, ?, ?, 'ACTIVE')`,
            [oldId, src.arabic_question, src.note_rule, src.evidence_rule, src.finding_rule, payload],
        );
        await ctx.db.commit();
        const err = await throwsAsync(ERR.BOOTSTRAP_CONFLICT, () => new BootstrapLoader(ctx.db, COMMITTED).load());
        assert(/CHK-007/.test(err.message), err.message);
    });

    await ok("one transaction per logical item: a fault at item 5 leaves 1..4 committed; rerun converges", async () => {
        const inner = openFreshDb(SCHEMA_SQL);
        const faulting = new FaultAdapter(inner, (sql, params) =>
            sql.includes("INSERT INTO checklist_item_definition") && params[0] === "CHK-005",
        );
        let threw = false;
        try {
            await new BootstrapLoader(faulting, COMMITTED).load();
        } catch (e) {
            threw = true;
            assert(!(e instanceof BootstrapError), `unexpected typed error: ${e instanceof Error ? e.message : e}`);
        }
        assert(threw, "fault adapter did not fail the load");
        const partial = await dbCounts(inner);
        assert(partial.defs === 4 && partial.active === 4 && partial.values === 8, `partial state ${JSON.stringify(partial)}`);
        // rerun on the healthy adapter converges to the full canonical set
        const report2 = await new BootstrapLoader(inner, COMMITTED).load();
        const full = await dbCounts(inner);
        assert(full.defs === 24 && full.active === 24 && full.values === 48, `post-converge ${JSON.stringify(full)}`);
        assert(report2.loaded.length === 20 && report2.alreadyPresent.length === 4, "converge report");
    });

    await ok("E_CONFIG on a structurally invalid artifact (no definitions)", async () => {
        const ctx = await freshLoadedDb();
        const bad = cloneArtifact();
        bad.definitions = [];
        await throwsAsync(ERR.CONFIG, () => new BootstrapLoader(ctx.db, bad).load());
    });
}

class FaultAdapter implements SqlAdapter {
    private readonly inner: SqlAdapter;
    private readonly shouldFail: (sql: string, params: readonly SqlValue[]) => boolean;

    constructor(inner: SqlAdapter, shouldFail: (sql: string, params: readonly SqlValue[]) => boolean) {
        this.inner = inner;
        this.shouldFail = shouldFail;
    }

    async beginImmediate(): Promise<void> {
        return this.inner.beginImmediate();
    }
    async commit(): Promise<void> {
        return this.inner.commit();
    }
    async rollback(): Promise<void> {
        return this.inner.rollback();
    }
    async run(sql: string, params: readonly SqlValue[] = []): Promise<Awaited<ReturnType<SqlAdapter["run"]>>> {
        if (this.shouldFail(sql, params)) throw new Error("injected adapter fault");
        return this.inner.run(sql, params);
    }
    async query(sql: string, params: readonly SqlValue[] = []): Promise<SqlRow[]> {
        return this.inner.query(sql, params);
    }
}

// ---------------------------------------------------------------------------
// test 12 — manifest-structure preflight (review correction B)
// Malformed manifest/definition structure must raise E_CONFIG BEFORE any
// database row is inserted (fresh schema.sql DB stays at zero bootstrap rows).
// ---------------------------------------------------------------------------
async function t12_manifest_preflight(): Promise<void> {
    const cases: Array<[string, (a: typeof COMMITTED) => void]> = [
        [
            "extra P1 manifest code (CHK-999) rejected with E_CONFIG before any DB row",
            (a) => {
                a.manifest.expected_p1_item_codes.push("CHK-999");
            },
        ],
        [
            "duplicate P0 manifest code rejected with E_CONFIG before any DB row",
            (a) => {
                a.manifest.expected_p0_item_codes.push("CHK-001");
            },
        ],
        [
            "incorrect expected_total_item_count rejected with E_CONFIG before any DB row",
            (a) => {
                a.manifest.expected_total_item_count = 999;
            },
        ],
        [
            "manifest/definition priority mismatch rejected with E_CONFIG before any DB row",
            (a) => {
                const chk001 = a.definitions.find((d) => d.item_code === "CHK-001")!;
                chk001.priority = "P1"; // manifest P0 expects P0
            },
        ],
        [
            "manifest-only P0 code (CHK-999) rejected with E_CONFIG before any DB row",
            (a) => {
                a.manifest.expected_p0_item_codes.push("CHK-999");
            },
        ],
        [
            "definition missing from the manifest rejected with E_CONFIG before any DB row",
            (a) => {
                a.definitions = a.definitions.filter((d) => d.item_code !== "CHK-001");
            },
        ],
    ];

    for (const [label, mutate] of cases) {
        await ok(label, async () => {
            const db = openFreshDb(SCHEMA_SQL);
            const mutated = cloneArtifact();
            mutate(mutated);
            const err = await throwsAsync(ERR.CONFIG, () => new BootstrapLoader(db, mutated).load());
            assert(err.message.length > 0, "E_CONFIG raised without a message");
            const counts = await dbCounts(db);
            assert(counts.defs === 0, `preflight must precede any DB write (definitions=${counts.defs})`);
            assert(counts.values === 0, `preflight must precede any DB write (values=${counts.values})`);
        });
    }
}

// ---------------------------------------------------------------------------
// test 11 — manifest P0 set compared in BOTH directions
// ---------------------------------------------------------------------------
async function t11_manifest_both_directions(): Promise<void> {
    await ok("loaded ACTIVE+P0 set equals the manifest P0 set in both directions", async () => {
        const ctx = await freshLoadedDb();
        const rows = await ctx.db.query(
            "SELECT item_code FROM checklist_item_definition WHERE status = 'ACTIVE' AND priority = 'P0' ORDER BY item_code",
        );
        const loaded = rows.map((r) => String(r.item_code));
        const expected = COMMITTED.manifest.expected_p0_item_codes;
        assert(loaded.length === expected.length, `sizes ${loaded.length} vs ${expected.length}`);
        // direction 1: every expected code is present and ACTIVE+P0 in the DB
        for (const code of expected) {
            assert(loaded.includes(code), `direction1: expected ${code} missing from loaded`);
        }
        // direction 2: every loaded ACTIVE+P0 code is expected by the manifest
        for (const code of loaded) {
            assert(expected.includes(code), `direction2: unexpected loaded ${code}`);
        }
        const compare = compareP0Sets(expected, loaded);
        assert(compare.equal === true, `compare ${JSON.stringify(compare)}`);
        assert(compare.missing.length === 0 && compare.unexpected.length === 0, "no drift components");
        assertP0SetsEqual(compare); // must not throw
        const loadedViaFn = await loadActiveP0Codes(ctx.db);
        assert(JSON.stringify(loadedViaFn) === JSON.stringify(loaded), "loadActiveP0Codes mismatch");
    });

    await ok("both-direction failure classification (missing vs unexpected is distinguished)", async () => {
        // missing-only => missing reported, unexpected empty
        const onlyMissing = compareP0Sets(["CHK-001", "CHK-002", "CHK-003"], ["CHK-001", "CHK-003"]);
        assert(JSON.stringify(onlyMissing.missing) === JSON.stringify(["CHK-002"]), "missing set");
        assert(onlyMissing.unexpected.length === 0, "unexpected must be empty");
        // unexpected-only => unexpected reported, missing empty
        const onlyUnexpected = compareP0Sets(["CHK-001", "CHK-002"], ["CHK-001", "CHK-002", "CHK-099"]);
        assert(onlyUnexpected.missing.length === 0, "missing must be empty");
        assert(JSON.stringify(onlyUnexpected.unexpected) === JSON.stringify(["CHK-099"]), "unexpected set");
        // both directions empty when sets are equal
        assert(compareP0Sets(["A"], ["A"]).equal === true, "equal sets");
    });
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------
const SUITES: Array<[string, () => Promise<void>]> = [
    ["G5B-1 deterministic regeneration equals the committed artifact", t1_determinism],
    ["G5B-2 exactly 24 item codes", t2_code_count],
    ["G5B-3 P0 manifest exactly CHK-001..CHK-020", t3_manifest_p0],
    ["G5B-4 one correct definition/version per item", t4_definition_version],
    ["G5B-5 allowed-value/value_code/semantic_class/order integrity", t5_allowed_values],
    ["G5B-6 applicability payload equality with the authoritative rules doc", t6_applicability_equality],
    ["G5B-7/8/9 bootstrap into fresh schema.sql DB + idempotent reload + one ACTIVE per code", t789_bootstrap],
    ["G5B-10 deliberate generator/source + DB drift is detected", t10_drift],
    ["G5B-11 manifest P0 set compared in both directions against loaded ACTIVE+P0", t11_manifest_both_directions],
    ["G5B-12 manifest-structure preflight (E_CONFIG before any DB row)", t12_manifest_preflight],
];

async function main(): Promise<void> {
    for (const [label, fn] of SUITES) {
        const before = passed;
        const failBefore = failures.length;
        await fn();
        const status = failures.length === failBefore ? "PASS" : "FAIL";
        console.log(
            `[${status}] ${label} — ${passed - before} passed` +
                (failures.length > failBefore ? `, ${failures.length - failBefore} failed` : ""),
        );
    }
    console.log(`\nTOTAL: ${passed} passed, ${failures.length} failed`);
    for (const f of failures) console.log(`  FAIL ${f}`);
    if (failures.length > 0) {
        console.log("\nRESULT: FAILURE");
        process.exitCode = 1;
    } else {
        console.log("RESULT: SUCCESS (0 failures)");
        process.exitCode = 0;
    }
}

await main();
