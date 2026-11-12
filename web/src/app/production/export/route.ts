import { query } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { planRows, SHIFTS } from "@/lib/production-core";
import { isIsoDate, resolveDepartment } from "@/lib/production-access";

// The daily production plan as a CSV file that Excel opens directly (UTF-8 with a byte-order mark, so Hebrew shows correctly).
// No prices are included.
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return new Response("יש להיכנס למערכת.", { status: 401 });
  if (!can(user.role, "production.view")) return new Response("אין הרשאה.", { status: 403 });

  const url = new URL(request.url);
  const date = url.searchParams.get("date");
  if (!isIsoDate(date)) return new Response("תאריך לא תקין.", { status: 400 });
  const { department } = await resolveDepartment(user, url.searchParams.get("dept") ?? undefined);
  if (!department) return new Response("המחלקה לא נמצאה.", { status: 404 });

  const rows = await planRows(query, date, department.id);
  const cell = (v: string | number | null) => {
    const s = v === null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [
    ["תאריך אספקה", "מחלקה", "משמרת", "מק״ט", "מוצר", "סוג", "כמות", "בוצע"],
    ...rows.map((r) => [date, department.name, SHIFTS[r.shift], r.sku, r.product, r.variant, r.quantity, r.producedLines === r.lines ? "כן" : r.producedLines > 0 ? "חלקי" : "לא"]),
  ];
  const csv = "﻿" + lines.map((l) => l.map(cell).join(",")).join("\r\n") + "\r\n";
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="production-${date}-dept-${department.id}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
