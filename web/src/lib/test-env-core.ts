// Cleaning the test environment: removes every business record from the database, and keeps what the system needs
// to run (people and their sign-in, the product catalogue, settings, letterheads, menus and dish weights, and the
// mapping of meal types). Works only in test mode, never in production. No dependency on Next.js.
import type { Q } from "./auth-core.ts";
import { testMode } from "./mail-test-mode.ts";

export class TestEnvError extends Error {}

/** The exact words a person types to confirm the clean-up. */
export const CONFIRM_WORDS = "נקה סביבת טסט";

/** Records of the business: they are removed. */
export const BUSINESS_TABLES = [
  "customers", "customer_contacts", "customer_addresses", "customer_prices",
  "leads", "activities", "tasks", "quotes", "quote_versions", "quote_lines",
  "orders", "deliveries", "delivery_lines", "delivery_notes", "delivery_note_lines",
  "standing_orders", "standing_order_lines", "standing_order_days",
  "production_plans", "production_changes", "shipping_events", "daily_routes",
  "institutions", "institution_groups", "milgam_imports", "milgam_quantities", "milgam_order_days",
  "delivery_boxes", "milgam_deliveries", "inbound_emails", "inbound_state", "emails", "audit_log",
] as const;

/** Records the system needs to run: they are kept. */
export const KEPT_TABLES = [
  "users", "sessions", "login_codes", "departments", "products", "product_ops", "product_variants", "sync_runs",
  "settings", "letterheads", "comm_channels", "closed_days", "production_lock_times", "vehicles", "drivers", "routes",
  "feeding_programs", "meal_types", "menus", "menu_week_starts", "menu_cells", "menu_cell_items", "menu_phrases", "dishes",
] as const;

export type SwitchUser = { id: string; fullName: string; role: string };

/** The people the test environment can sign in as: active staff (customers have their own portal and are left out). */
export async function switchableUsers(q: Q): Promise<SwitchUser[]> {
  return q<SwitchUser>("select id::text, full_name as \"fullName\", role::text from users where active and role <> 'customer' order by full_name");
}

/** How many records each business table holds, for the confirmation screen. */
export async function businessCounts(q: Q): Promise<{ table: string; rows: number }[]> {
  const out: { table: string; rows: number }[] = [];
  for (const table of BUSINESS_TABLES) {
    const [{ n }] = await q<{ n: number }>(`select count(*)::int as n from ${table}`);
    if (n > 0) out.push({ table, rows: n });
  }
  return out;
}

/**
 * Removes the business records. Must run inside one transaction (a failure then undoes everything). Refused outside test mode, and refused unless the confirmation words are typed exactly.
 * Users keep their sign-in, but lose their link to a customer, which is itself a customer record.
 */
export async function cleanTestEnvironment(q: Q, typed: string): Promise<{ removed: { table: string; rows: number }[] }> {
  if (!testMode()) throw new TestEnvError("הניקוי זמין רק במצב טסט. במערכת הזאת מצב הטסט כבוי, ולכן לא נמחק דבר.");
  if (typed.trim() !== CONFIRM_WORDS) throw new TestEnvError(`כדי לאשר, יש להקליד בדיוק: ${CONFIRM_WORDS}`);
  const before = await businessCounts(q);
  await q("update users set customer_id = null where customer_id is not null");
  // Each table is emptied on its own, and a table that still has records pointing at it is tried again after the
  // others. TRUNCATE is not used: it would also empty the people, because people point at customers.
  // If some table cannot be emptied at all, the error stops the whole clean-up and the caller rolls it back.
  let pending: string[] = [...BUSINESS_TABLES];
  for (let pass = 0; pass < 30 && pending.length > 0; pass++) {
    const stuck: string[] = [];
    for (const table of pending) {
      await q("savepoint clean_one");
      try {
        await q(`delete from ${table}`);
        await q("release savepoint clean_one");
      } catch {
        await q("rollback to savepoint clean_one");
        stuck.push(table);
      }
    }
    if (stuck.length === pending.length) throw new TestEnvError(`לא ניתן לנקות את הטבלאות הבאות, כי יש בהן רשומות שתלויות ברשומות אחרות: ${stuck.join(", ")}. לא נמחק דבר.`);
    pending = stuck;
  }
  return { removed: before };
}
