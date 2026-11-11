import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { query } from "@/lib/db";
import { importCatalog, importCustomers, importLastPrices, type HashCustomer, type HashLastPrice, type HashProduct } from "@/lib/customers-core";

// The local connector: runs the read-only export script next to the Hashavshevet database, then loads the result.
// When the app moves to the cloud, only this file changes: the export will be pushed over HTTPS instead of read from disk.

// stdin must be closed ("ignore"): PowerShell started from Node otherwise waits on it forever.
function runExport(connection: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, "-ConnectionString", connection, "-OutDir", OUT_DIR], {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("היצוא מחשבשבת לא הסתיים תוך 2 דקות."));
    }, 120_000);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`היצוא מחשבשבת נכשל (קוד ${code}). ${stderr.trim().split("\n")[0] ?? ""}`));
    });
  });
}

const SCRIPT = path.join(process.cwd(), "..", "integrations", "hashavshevet", "export.ps1");
const OUT_DIR = path.join(process.cwd(), ".data", "hashavshevet");

export type SyncSummary = {
  catalog: { created: number; updated: number };
  customers: { created: number; updated: number };
  prices: { created: number; refreshed: number; skipped: number };
};

async function load<T>(name: string): Promise<T[]> {
  return JSON.parse(await readFile(path.join(OUT_DIR, `${name}.json`), "utf8")) as T[];
}

async function record<T>(kind: string, rowsRead: number, work: () => Promise<T>, changed: (r: T) => number): Promise<T> {
  const [runRow] = await query<{ id: string }>("insert into sync_runs (kind, rows_read) values ($1, $2) returning id::text", [kind, rowsRead]);
  try {
    const result = await work();
    await query("update sync_runs set finished_at = now(), rows_changed = $2 where id = $1", [runRow.id, changed(result)]);
    return result;
  } catch (e) {
    await query("update sync_runs set finished_at = now(), error = $2 where id = $1", [runRow.id, e instanceof Error ? e.message : String(e)]);
    throw e;
  }
}

export async function syncFromHashavshevet(): Promise<SyncSummary> {
  const connection = process.env.HASH_SQL_CONNECTION;
  if (!connection) throw new Error("החיבור לחשבשבת אינו מוגדר (HASH_SQL_CONNECTION).");

  await runExport(connection);

  const products = await load<HashProduct>("catalog");
  const customers = await load<HashCustomer>("customers");
  const prices = await load<HashLastPrice>("last_prices");

  // Order matters: prices refer to products and customers.
  const catalog = await record("catalog", products.length, () => importCatalog(query, products), (r) => r.created + r.updated);
  const cust = await record("customers", customers.length, () => importCustomers(query, customers), (r) => r.created + r.updated);
  const pr = await record("last_prices", prices.length, () => importLastPrices(query, prices), (r) => r.created + r.refreshed);
  return { catalog, customers: cust, prices: pr };
}
