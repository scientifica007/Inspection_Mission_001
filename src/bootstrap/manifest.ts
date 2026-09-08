// Gate 5B — manifest exact-set verification (runtime-neutral TypeScript).
//
// Implements the Gate-5A §3.5 / T0 contract in data terms:
//   the manifest expected v1 P0 item-code set must equal the loaded DB
//   `ACTIVE` + `priority='P0'` code set, in BOTH directions:
//     * an expected code with no ACTIVE definition
//       => E_NO_ACTIVE_DEFINITION
//     * an unexpected ACTIVE-P0 code not present in the manifest
//       => E_BOOTSTRAP_DRIFT
//   P1 definitions never enter this comparison.
// Application logic never hard-codes CHK codes: the manifest (artifact data)
// is the code-set authority and this module is the executable check that
// createVisit (T0, Gate 5C) and the bootstrap loader both rely on.

import { BootstrapError, ERR } from "./errors.ts";
import type { SqlAdapter } from "./adapter.ts";

export interface P0SetCompare {
    expected: readonly string[];
    loaded: readonly string[];
    missing: string[]; // expected but not loaded-ACTIVE-P0
    unexpected: string[]; // loaded-ACTIVE-P0 but not expected
    equal: boolean;
}

/** Pure set comparison (both directions). Never touches I/O. */
export function compareP0Sets(expected: readonly string[], loaded: readonly string[]): P0SetCompare {
    const expectedSet = new Set(expected);
    const loadedSet = new Set(loaded);
    const missing = expected.filter((code) => !loadedSet.has(code));
    const unexpected = loaded.filter((code) => !expectedSet.has(code));
    return { expected, loaded, missing, unexpected, equal: missing.length === 0 && unexpected.length === 0 };
}

/**
 * Throw the typed manifest error for a non-equal comparison.
 * missing-only => E_NO_ACTIVE_DEFINITION; any unexpected => E_BOOTSTRAP_DRIFT.
 */
export function assertP0SetsEqual(compare: P0SetCompare): void {
    if (compare.equal) return;
    if (compare.missing.length > 0 && compare.unexpected.length === 0) {
        throw new BootstrapError(
            ERR.NO_ACTIVE_DEFINITION,
            `manifest expected P0 item-code(s) have no ACTIVE definition in the loaded DB: ${compare.missing.join(", ")}`,
        );
    }
    const parts: string[] = [];
    if (compare.missing.length > 0) parts.push(`missing ACTIVE: ${compare.missing.join(", ")}`);
    if (compare.unexpected.length > 0) parts.push(`unexpected ACTIVE-P0: ${compare.unexpected.join(", ")}`);
    throw new BootstrapError(ERR.BOOTSTRAP_DRIFT, `manifest vs loaded ACTIVE+P0 set mismatch (${parts.join("; ")})`);
}

/** Read the loaded DB ACTIVE+P0 code set through the adapter. */
export async function loadActiveP0Codes(db: SqlAdapter): Promise<string[]> {
    const rows = await db.query(
        "SELECT item_code FROM checklist_item_definition WHERE status = 'ACTIVE' AND priority = 'P0' ORDER BY item_code",
    );
    return rows.map((r) => String(r.item_code));
}

/** One-shot DB verification against the manifest P0 authority. */
export async function verifyLoadedActiveP0(db: SqlAdapter, expectedP0: readonly string[]): Promise<void> {
    const loaded = await loadActiveP0Codes(db);
    assertP0SetsEqual(compareP0Sets(expectedP0, loaded));
}
