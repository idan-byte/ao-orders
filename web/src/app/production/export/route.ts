import { query } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { isIsoDate, resolveDepartment } from "@/lib/production-access";
import { planGrid, PLAN_WIDTHS } from "@/lib/production-export";
import { internalOrigin, printPage } from "@/lib/pdf-render";
import { buildXlsx } from "@/lib/xlsx-write";

// The daily production plan, as CSV (`format=csv`, the default), Excel (`format=xlsx`) or PDF (`format=pdf`).
// The CSV opens in Excel with Hebrew intact (UTF-8 with a byte-order mark). No prices are included.
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return new Response("יש להיכנס למערכת.", { status: 401 });
  if (!can(user.role, "production.view")) return new Response("אין הרשאה.", { status: 403 });

  const url = new URL(request.url);
  const date = url.searchParams.get("date");
  if (!isIsoDate(date)) return new Response("תאריך לא תקין.", { status: 400 });
  const format = url.searchParams.get("format") ?? "csv";
  if (format !== "csv" && format !== "xlsx" && format !== "pdf") return new Response("פורמט לא נתמך.", { status: 400 });
  const { department } = await resolveDepartment(user, url.searchParams.get("dept") ?? undefined);
  if (!department) return new Response("המחלקה לא נמצאה.", { status: 404 });

  const name = `production-${date}-dept-${department.id}`;
  const grid = await planGrid(query, date, department.id, department.name);

  if (format === "xlsx") {
    const file = buildXlsx("תוכנית ייצור", grid, PLAN_WIDTHS);
    return new Response(new Uint8Array(file), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${name}.xlsx"`,
        "Cache-Control": "no-store",
      },
    });
  }

  if (format === "pdf") {
    try {
      const pdf = await printPage({
        path: (key) => `/production/render/${key}`,
        payload: JSON.stringify({ date, departmentId: department.id }),
        origin: internalOrigin(request),
        ready: "article.production-doc",
      });
      return new Response(new Uint8Array(pdf), {
        headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${name}.pdf"`, "Cache-Control": "no-store" },
      });
    } catch (e) {
      console.error("[production pdf]", e);
      return new Response("יצירת ה-PDF נכשלה.", { status: 500 });
    }
  }

  const cell = (v: string | number | null) => {
    const s = v === null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = "﻿" + grid.map((l) => l.map(cell).join(",")).join("\r\n") + "\r\n";
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
