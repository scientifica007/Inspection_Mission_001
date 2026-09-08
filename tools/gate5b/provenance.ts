// Gate 5B — provenance-commit decision for the generator CLI (shared logic).
//
// This is the single decision function the generator CLI (tools/gate5b/
// generate.ts) uses to choose the provenance anchor.  It is exported so the
// regression suite can verify the ACTUAL CLI decision logic directly (review
// A2) without creating Git commits in the workspace.
//
// Contract (Gate-5B review A2):
//   1. Reproducing/verifying an EXISTING committed checklist-v1.json with
//      unchanged canonical inputs MUST reuse that artifact's recorded
//      generating_git_commit.  A descendant commit that changed the current
//      Git HEAD must NOT cause the recorded SHA to be rewritten.
//   2. On FIRST creation of an artifact (no existing artifact available), the
//      current Git HEAD may be used as the original provenance anchor (null
//      when Git is unavailable).
//   3. A fresh provenance anchor (--fresh-provenance in the CLI) is an
//      explicit, intentional behavior only — it is never the default
//      regeneration/verification path.
//
// generating_git_commit therefore stays the provenance anchor observed at the
// ORIGINAL artifact generation; descendant commits do not invalidate it.

export interface ProvenanceCommitInput {
    /** whether bootstrap/v1/checklist-v1.json already exists at this run */
    artifactExists: boolean;
    /** generating_git_commit recorded in the existing artifact (meaningful only when artifactExists) */
    recordedCommit: string | null;
    /** current Git HEAD resolved for this run (null when Git is unavailable) */
    currentHead: string | null;
    /** explicit re-anchor request (--fresh-provenance); never the default */
    forceFreshProvenance: boolean;
}

/**
 * Choose the provenance anchor for a generator run.
 *
 *   artifactExists && !forceFresh  -> recordedCommit  (regeneration/verification;
 *                                      reproduces byte-identical provenance)
 *   artifactExists &&  forceFresh  -> currentHead     (explicit re-anchor)
 *   !artifactExists                -> currentHead     (first-creation anchor;
 *                                      null when Git is unavailable)
 */
export function resolveProvenanceCommit(input: ProvenanceCommitInput): string | null {
    if (input.artifactExists && !input.forceFreshProvenance) {
        return input.recordedCommit;
    }
    return input.currentHead;
}
