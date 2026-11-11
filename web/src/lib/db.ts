import { PGlite } from "@electric-sql/pglite";
import { readdir, readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { connection } from "next/server";
import { normalizeMobile } from "@/lib/auth-core";

// Development database: PostgreSQL embedded in the Node process (PGlite), stored under web/.data.
// Production will use a regular PostgreSQL server behind the same query() function.

const DATA_DIR = path.join(process.cwd(), ".data", "pg");
const MIGRATIONS_DIR = path.join(process.cwd(), "..", "db", "migrations");
const SEED_DIR = path.join(process.cwd(), "..", "db", "seed");

type Row = Record<string, unknown>;

const globalForDb = globalThis as unknown as { __aoDb?: Promise<PGlite> };

async function open(): Promise<PGlite> {
  await mkdir(DATA_DIR, { recursive: true });
  const db = new PGlite(DATA_DIR);
  await db.exec("create table if not exists _migrations (name text primary key, applied_at timestamptz not null default now())");
  const applied = new Set((await db.query<{ name: string }>("select name from _migrations")).rows.map((r) => r.name));
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
    await db.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.query("insert into _migrations (name) values ($1)", [file]);
    });
  }
  await seedCatalog(db);
  await bootstrapAdmin(db);
  return db;
}

// An empty system has nobody who could sign in and add users. If AO_BOOTSTRAP_ADMIN_MOBILE is set
// and the users table is empty, that mobile becomes the first system administrator.
async function bootstrapAdmin(db: PGlite) {
  const mobile = normalizeMobile(process.env.AO_BOOTSTRAP_ADMIN_MOBILE ?? "");
  if (!mobile) return;
  const existing = await db.query<{ n: number }>("select count(*)::int as n from users");
  if (existing.rows[0].n > 0) return;
  await db.query("insert into users (mobile, full_name, role) values ($1, $2, 'admin')", [mobile, "מנהל מערכת"]);
}

// Loads the catalog snapshot taken from Hashavshevet. Stands in for the Connector until it is built.
// Only Hashavshevet-owned fields are written; product_ops is created once and never overwritten.
async function seedCatalog(db: PGlite) {
  const file = path.join(SEED_DIR, "catalog.json");
  let items: { sku: string; name: string; g: number; p: number }[];
  try {
    items = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return;
  }
  const deptBySortGroup: Record<number, string | null> = { 500: "כריכים", 600: "מטבח חם", 630: "מגשי אירוח", 650: null };
  const shiftBySortGroup: Record<number, number> = { 500: 1, 600: 2, 630: 2, 650: 2 };
  await db.transaction(async (tx) => {
    for (const name of ["כריכים", "מטבח חם", "מגשי אירוח", "אריזה"]) {
      await tx.query("insert into departments (name) values ($1) on conflict (name) do nothing", [name]);
    }
    for (const it of items) {
      await tx.query(
        `insert into products (sku, name, sort_group, base_price, synced_at) values ($1, $2, $3, $4, now())
         on conflict (sku) do update set name = excluded.name, sort_group = excluded.sort_group, base_price = excluded.base_price, synced_at = now()`,
        [it.sku, it.name, it.g, it.p],
      );
      await tx.query(
        `insert into product_ops (sku, orderable, department_id, default_shift)
         values ($1, true, (select id from departments where name = $2), $3)
         on conflict (sku) do nothing`,
        [it.sku, deptBySortGroup[it.g] ?? null, shiftBySortGroup[it.g] ?? 2],
      );
    }
  });
}

export function getDb(): Promise<PGlite> {
  return (globalForDb.__aoDb ??= open());
}

export async function query<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
  // Database reads always happen at request time, never while prerendering the static shell.
  await connection();
  const db = await getDb();
  return (await db.query<T>(sql, params)).rows;
}
