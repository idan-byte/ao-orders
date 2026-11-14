import { Suspense } from "react";
import { connection } from "next/server";
import { query } from "@/lib/db";
import { takeRenderKey } from "@/lib/pdf-render";
import { departmentName, planGrid } from "@/lib/production-export";
import { isIsoDate } from "@/lib/production-access";

// Opened only by the server's own headless browser while it prints the production plan to PDF.
// The key in the address is random and exists only while the file is being made, so this page needs no login.
export default function ProductionRenderPage({ params }: PageProps<"/production/render/[key]">) {
  return (
    <Suspense fallback={null}>
      <Render params={params} />
    </Suspense>
  );
}

async function Render({ params }: { params: PageProps<"/production/render/[key]">["params"] }) {
  await connection();
  const { key } = await params;
  const payload = takeRenderKey(key);
  let parsed: { date?: unknown; departmentId?: unknown } | null = null;
  try {
    parsed = payload ? JSON.parse(payload) : null;
  } catch {
    parsed = null;
  }
  if (!parsed || !isIsoDate(parsed.date) || typeof parsed.departmentId !== "number") return <p>הקישור אינו בתוקף.</p>;
  const name = await departmentName(parsed.departmentId);
  if (!name) return <p>המחלקה לא נמצאה.</p>;
  const grid = await planGrid(query, parsed.date, parsed.departmentId, name);
  const [head, ...body] = grid;
  const title = `תוכנית ייצור · ${name} · ${parsed.date}`;

  return (
    <article className="production-doc" dir="rtl" style={{ padding: "4mm" }}>
      <h1 style={{ fontSize: "18px", fontWeight: 700, marginBottom: "8px" }}>{title}</h1>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={i} style={{ border: "1px solid #999", padding: "4px", background: "#eee", textAlign: "right" }}>
                {String(h)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, r) => (
            <tr key={r}>
              {row.map((v, i) => (
                <td key={i} style={{ border: "1px solid #999", padding: "4px", textAlign: "right" }}>
                  {v === null ? "" : String(v)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {body.length === 0 ? <p style={{ marginTop: "12px" }}>אין שורות ביום הזה.</p> : null}
    </article>
  );
}
