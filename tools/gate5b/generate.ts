// Gate 5B — deterministic generator CLI (development/tooling tier only).
//
// Usage (from the repository root; Node.js >= 22 is the adopted development/
// test host — Gate-5A D1):
//   Node 22.x:   node --experimental-strip-types tools/gate5b/generate.ts
//   Node 24.x:   node tools/gate5b/generate.ts
//                (type stripping is on by default; the --experimental-strip-types
//                 form above executes the identical script)
//   Explicit re-anchor (only when truly intended, never for regeneration
//   checks): append --fresh-provenance.
//
// Reads the two canonical authorities, hashes their bytes (SHA-256), decides
// the provenance anchor via resolveProvenanceCommit(), produces the artifact
// via the pure generator, and writes bootstrap/v1/checklist-v1.json with the
// canonical writer (byte-deterministic for identical inputs).
//
// Provenance contract (review corrections A and A2):
//   * generating_git_commit is the provenance anchor observed at the ORIGINAL
//     artifact generation — a Git HEAD, or null when Git was unavailable.  It
//     is an environment fact, NOT an invariant of later repository HEADs: the
//     artifact is expected to be committed later by a DESCENDANT commit.
//   * REGENERATION of an existing bootstrap/v1/checklist-v1.json (the default,
//     and the documented drift/verification workflow) REUSES the recorded
//     generating_git_commit from that artifact.  With unchanged canonical
//     inputs this reproduces byte-identical content and never rewrites the
//     SHA merely because the current HEAD changed.  The decision logic lives
//     in the shared, testable resolveProvenanceCommit() (tools/gate5b/
//     provenance.ts) and is exercised directly by the regression suite.
//   * FIRST creation (no existing artifact) anchors provenance to the current
//     Git HEAD when available (null otherwise).
//   * --fresh-provenance is the ONLY explicit re-anchor path and must not be
//     used for regeneration/verification.
//
// No volatile timestamps, no machine-specific absolute paths, no network.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { generateChecklistArtifact, artifactText } from "./generator.ts";
import { resolveProvenanceCommit } from "./provenance.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function sha256Hex(buffer: Buffer): string {
    return createHash("sha256").update(buffer).digest("hex");
}

function gitHeadSha(cwd: string): string | null {
    const res = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" });
    if (res.status !== 0) return null; // Git unavailable -> null anchor is permitted
    const sha = (res.stdout ?? "").trim();
    if (!/^[0-9a-f]{40}$/.test(sha)) {
        throw new Error("gate5b generator: git HEAD is not a valid 40-hex SHA");
    }
    return sha;
}

const fieldPath = "docs/checklists/FIELD-CHECKLIST-v1.md";
const applicabilityPath = "docs/checklists/APPLICABILITY-RULES-v1.md";
const outDir = join(ROOT, "bootstrap", "v1");
const outFile = join(outDir, "checklist-v1.json");

/** generating_git_commit recorded in the existing artifact (null when absent). */
function recordedCommitOfExisting(): string | null {
    let text: string;
    try {
        text = readFileSync(outFile, "utf8");
    } catch {
        return null; // race: file disappeared between existsSync and read
    }
    try {
        const obj = JSON.parse(text) as { provenance?: { generating_git_commit?: string | null } };
        return obj.provenance?.generating_git_commit ?? null;
    } catch {
        throw new Error(
            `gate5b generator: existing artifact ${outFile} is not valid JSON; refusing to overwrite a corrupt ` +
                "artifact. Repair/remove it, or re-anchor explicitly with --fresh-provenance.",
        );
    }
}

const artifactExists = existsSync(outFile);
const forceFreshProvenance = process.argv.includes("--fresh-provenance");
const recordedCommit = artifactExists ? recordedCommitOfExisting() : null;

const generatingGitCommit = resolveProvenanceCommit({
    artifactExists,
    recordedCommit,
    currentHead: gitHeadSha(ROOT),
    forceFreshProvenance,
});

const fieldBuffer = readFileSync(join(ROOT, fieldPath));
const applicabilityBuffer = readFileSync(join(ROOT, applicabilityPath));

const artifact = generateChecklistArtifact({
    checklistText: fieldBuffer.toString("utf8"),
    applicabilityText: applicabilityBuffer.toString("utf8"),
    fieldChecklistSha256: sha256Hex(fieldBuffer),
    applicabilitySha256: sha256Hex(applicabilityBuffer),
    generatingGitCommit,
});

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
const previousText = artifactExists ? (() => { try { return readFileSync(outFile, "utf8"); } catch { return null; } })() : null;
const nextText = artifactText(artifact);
writeFileSync(outFile, nextText, "utf8");

const { definitions, manifest } = artifact;
const mode = !artifactExists
    ? "first creation (anchor = current HEAD)"
    : forceFreshProvenance
      ? "explicit fresh provenance (--fresh-provenance; anchor = current HEAD)"
      : "regeneration of existing artifact (recorded provenance anchor reused)";
console.log(`mode               : ${mode}`);
console.log(`wrote ${outFile}`);
console.log(`definitions        : ${definitions.length}`);
console.log(`p0 manifest set    : ${manifest.expected_p0_item_codes.join(", ")}`);
console.log(`p1 carried set     : ${manifest.expected_p1_item_codes.join(", ")}`);
console.log(`generating commit  : ${artifact.provenance.generating_git_commit ?? "(none)"}`);
console.log(`field sha256       : ${artifact.provenance.inputs[0].sha256}`);
console.log(`applicability sha256: ${artifact.provenance.inputs[1].sha256}`);
console.log(
    previousText === null ? "content            : wrote new artifact" :
    previousText === nextText ? "content            : byte-identical to the existing artifact (no rewrite)" :
    "content            : canonical inputs changed — artifact regenerated (provenance anchor preserved)",
);
