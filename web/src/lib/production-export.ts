import { query } from "./db";
import type { Q } from "./auth-core";
import { planRows, SHIFTS } from "./production-core";
import type { XlsxCell } from "./xlsx-write";

// The daily production plan as one table, shared by the CSV, Excel and PDF exports. No prices are included.
export const PLAN_HEADER = ["תאריך אספקה", "מחלקה", "משמרת", "מק״ט", "מוצר", "סוג", "כמות", "בוצע"];
export const PLAN_WIDTHS = [14, 16, 12, 10, 36, 14, 10, 10];

export async function planGrid(q: Q, date: string, departmentId: number, departmentName: string): Promise<XlsxCell[][]> {
  const rows = await planRows(q, date, departmentId);
  return [
    PLAN_HEADER,
    ...rows.map((r) => [date, departmentName, SHIFTS[r.shift], r.sku, r.product, r.variant, r.quantity, r.producedLines === r.lines ? "כן" : r.producedLines > 0 ? "חלקי" : "לא"]),
  ];
}

/** The department's name, for the PDF page, which has no user session. */
export async function departmentName(id: number): Promise<string | null> {
  const [d] = await query<{ name: string }>("select name from departments where id = $1", [id]);
  return d?.name ?? null;
}
