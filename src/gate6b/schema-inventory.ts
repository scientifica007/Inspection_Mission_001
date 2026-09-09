import type { SqlAdapter } from "../bootstrap/adapter.ts";

export type SchemaObjectType = "table" | "trigger" | "view" | "index";

export interface SchemaInventory {
  table: string[];
  trigger: string[];
  view: string[];
  index: string[];
}

function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n\r]*/g, "");
}

function namesOf(sql: string, expression: RegExp): string[] {
  return Array.from(stripSqlComments(sql).matchAll(expression), (m) => m[1]).sort();
}

export function expectedInventoryFromCanonicalSchema(sql: string): SchemaInventory {
  return {
    table: namesOf(sql, /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/gi),
    trigger: namesOf(sql, /\bCREATE\s+TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/gi),
    view: namesOf(sql, /\bCREATE\s+VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/gi),
    index: namesOf(sql, /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/gi),
  };
}

export async function actualInventory(db: SqlAdapter): Promise<SchemaInventory> {
  const rows = await db.query(
    `SELECT type, name FROM sqlite_master
      WHERE type IN ('table','trigger','view','index')
        AND name NOT LIKE 'sqlite_%'
      ORDER BY type, name`,
  );
  const out: SchemaInventory = { table: [], trigger: [], view: [], index: [] };
  for (const row of rows) {
    const type = String(row.type) as SchemaObjectType;
    if (type in out) out[type].push(String(row.name));
  }
  for (const key of Object.keys(out) as SchemaObjectType[]) out[key].sort();
  return out;
}

export function inventoryDiff(expected: SchemaInventory, actual: SchemaInventory): {
  equal: boolean;
  missing: Record<SchemaObjectType, string[]>;
  unexpected: Record<SchemaObjectType, string[]>;
} {
  const missing = { table: [], trigger: [], view: [], index: [] } as Record<SchemaObjectType, string[]>;
  const unexpected = { table: [], trigger: [], view: [], index: [] } as Record<SchemaObjectType, string[]>;
  let equal = true;
  for (const key of Object.keys(expected) as SchemaObjectType[]) {
    const want = new Set(expected[key]);
    const got = new Set(actual[key]);
    missing[key] = expected[key].filter((name) => !got.has(name));
    unexpected[key] = actual[key].filter((name) => !want.has(name));
    if (missing[key].length > 0 || unexpected[key].length > 0) equal = false;
  }
  return { equal, missing, unexpected };
}

export function canonicalInventoryCountIsAdopted(inventory: SchemaInventory): boolean {
  return inventory.table.length === 15 && inventory.trigger.length === 44 && inventory.view.length === 1 && inventory.index.length === 24;
}
