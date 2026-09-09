import type { SQLiteDBConnection } from "@capacitor-community/sqlite";
import type { SqlAdapter, SqlResult, SqlRow, SqlValue } from "../bootstrap/adapter.ts";

function isTopLevelInsert(sql: string): boolean {
  return /^\s*INSERT\b/i.test(sql);
}

function pluginValue(value: SqlValue): string | number | null {
  if (typeof value === "bigint") {
    const n = Number(value);
    if (!Number.isSafeInteger(n)) {
      throw new Error("CapacitorSqliteAdapter: bigint parameter exceeds JavaScript safe-integer range");
    }
    return n;
  }
  return value;
}

function normalizeChanges(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error(`CapacitorSqliteAdapter: invalid affected-row count '${String(value)}'`);
  }
  return n;
}

function normalizeRow(row: Record<string, unknown>): SqlRow {
  const out: SqlRow = {};
  for (const [key, value] of Object.entries(row)) {
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
      out[key] = value;
      continue;
    }
    throw new Error(`CapacitorSqliteAdapter: unsupported SQLite row value for column '${key}'`);
  }
  return out;
}

/**
 * Gate 6B provisional native adapter for @capacitor-community/sqlite.
 *
 * Transaction ownership is deliberately NOT delegated to the plugin helper.
 * The adapter issues literal BEGIN IMMEDIATE / COMMIT / ROLLBACK via execute()
 * with transaction=false. Every run() likewise passes transaction=false, so
 * an Application-Core transaction remains the sole transaction boundary.
 */
export class CapacitorSqliteAdapter implements SqlAdapter {
  constructor(private readonly connection: SQLiteDBConnection) {}

  async beginImmediate(): Promise<void> {
    await this.connection.execute("BEGIN IMMEDIATE;", false);
  }

  async commit(): Promise<void> {
    await this.connection.execute("COMMIT;", false);
  }

  async rollback(): Promise<void> {
    await this.connection.execute("ROLLBACK;", false);
  }

  async run(sql: string, params: readonly SqlValue[] = []): Promise<SqlResult> {
    const result = await this.connection.run(sql, params.map(pluginValue), false, "no");
    const changes = normalizeChanges(result.changes?.changes ?? 0);
    const rawLastId = result.changes?.lastId;
    const inserted = isTopLevelInsert(sql) && changes > 0;
    const lastInsertRowid = inserted && typeof rawLastId === "number" && Number.isSafeInteger(rawLastId)
      ? rawLastId
      : null;
    return { changes, lastInsertRowid };
  }

  async query(sql: string, params: readonly SqlValue[] = []): Promise<SqlRow[]> {
    const result = await this.connection.query(sql, params.map(pluginValue));
    return (result.values ?? []).map((row) => normalizeRow(row as Record<string, unknown>));
  }
}
