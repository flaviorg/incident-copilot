import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrate } from "./schema.ts";

const MEMORY_DB = ":memory:";

/** Abre o banco com foreign_keys=ON, busy_timeout=5000 e WAL (fora de :memory:), e aplica o schema. */
export function openDatabase(path: string): DatabaseSync {
  const inMemory = path === MEMORY_DB;
  if (!inMemory) mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  if (!inMemory) db.exec("PRAGMA journal_mode = WAL");
  migrate(db);
  return db;
}
