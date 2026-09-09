import { CapacitorSQLite, SQLiteConnection, type SQLiteDBConnection } from "@capacitor-community/sqlite";
import { Capacitor } from "@capacitor/core";
import { CANONICAL_SCHEMA_SQL } from "../gate6b/assets.ts";
import { withCanonicalSchemaExecution } from "../gate6b/canonical-schema-execution.ts";
import { CapacitorSqliteAdapter } from "./capacitor-sqlite-adapter.ts";

export const GATE6B_PROOF_DB_NAME = "inspection_gate6b_runtime_proof_v1";
export const GATE6B_PROBE_DB_NAME = "inspection_gate6b_adapter_probe_v1";

const sqlite = new SQLiteConnection(CapacitorSQLite);

export interface OpenGate6BDatabase {
  connection: SQLiteDBConnection;
  adapter: CapacitorSqliteAdapter;
  sqliteVersion: string;
}

export function assertNativeAndroid(): void {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== "android") {
    throw new Error("Gate 6B native proof requires the Android Capacitor runtime; browser execution is diagnostic-shell only");
  }
}

async function obtainConnection(database: string): Promise<SQLiteDBConnection> {
  await sqlite.checkConnectionsConsistency();
  const existing = await sqlite.isConnection(database, false);
  const connection = existing.result
    ? await sqlite.retrieveConnection(database, false)
    : await sqlite.createConnection(database, false, "no-encryption", 1, false);
  const open = await connection.isDBOpen();
  if (!open.result) await connection.open();
  return connection;
}

export async function openGate6BDatabase(database = GATE6B_PROOF_DB_NAME): Promise<OpenGate6BDatabase> {
  assertNativeAndroid();
  const nativeConnection = await obtainConnection(database);
  const connection = withCanonicalSchemaExecution(nativeConnection, CANONICAL_SCHEMA_SQL);

  // Project contract: set and verify on EVERY authoritative open/reopen.
  await connection.execute("PRAGMA foreign_keys = ON;", false);
  const fkRows = await connection.query("PRAGMA foreign_keys;");
  const foreignKeys = Number(fkRows.values?.[0]?.foreign_keys ?? 0);
  if (foreignKeys !== 1) {
    await connection.close().catch(() => undefined);
    throw new Error(`Gate 6B database open refused: PRAGMA foreign_keys=${foreignKeys}`);
  }

  const versionRows = await connection.query("SELECT sqlite_version() AS sqlite_version;");
  const sqliteVersion = String(versionRows.values?.[0]?.sqlite_version ?? "unknown");
  return { connection, adapter: new CapacitorSqliteAdapter(connection), sqliteVersion };
}

export async function closeGate6BDatabase(database = GATE6B_PROOF_DB_NAME): Promise<void> {
  const existing = await sqlite.isConnection(database, false).catch(() => ({ result: false }));
  if (!existing.result) return;
  const connection = await sqlite.retrieveConnection(database, false);
  const open = await connection.isDBOpen();
  if (open.result) await connection.close();
  await sqlite.closeConnection(database, false);
}

export async function deleteGate6BDatabase(database = GATE6B_PROOF_DB_NAME): Promise<void> {
  await closeGate6BDatabase(database).catch(() => undefined);
  const exists = await sqlite.isDatabase(database);
  if (!exists.result) return;
  const connection = await sqlite.createConnection(database, false, "no-encryption", 1, false);
  try {
    await connection.delete();
  } finally {
    await sqlite.closeConnection(database, false).catch(() => undefined);
  }
}
