// Gate 5B — narrow database seam (runtime-neutral, no node:* imports).
//
// The seam follows Gate-5A D1 / correction 1: Promise-returning conceptual
// methods (beginImmediate / execute / query / commit / rollback) with an
// affected-row count normalized across adapters.  node:sqlite is ONLY ever
// used behind this seam in development/test adapter code (dev/*); runtime
// domain logic (src/bootstrap/*, and later the Gate-5C services) depends
// solely on this interface and never on node:* APIs.

export type SqlValue = string | number | bigint | null;

export interface SqlResult {
    /** affected-row count normalized to number (changes == 1 contracts) */
    changes: number;
    /** last insert rowid when the statement inserted a row, else null */
    lastInsertRowid: number | null;
}

export interface SqlRow {
    [column: string]: SqlValue;
}

export interface SqlAdapter {
    /** explicit BEGIN IMMEDIATE — never implicit per-statement transactions */
    beginImmediate(): Promise<void>;
    commit(): Promise<void>;
    rollback(): Promise<void>;
    /** parameterized statement execution */
    run(sql: string, params?: readonly SqlValue[]): Promise<SqlResult>;
    /** parameterized read returning rows */
    query(sql: string, params?: readonly SqlValue[]): Promise<SqlRow[]>;
}
