import { query } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { internalOrigin, renderQuotePdf } from "@/lib/quote-pdf";

// Downloads one version of a quote as a PDF. `v` picks the version; without it, the latest one.
export async function GET(request: Request, ctx: RouteContext<"/quotes/[id]/pdf">) {
  const user = await getCurrentUser();
  if (!user) return new Response("יש להיכנס למערכת.", { status: 401 });
  if (!can(user.role, "quotes.view")) return new Response("אין הרשאה.", { status: 403 });
  const { id } = await ctx.params;
  const wanted = new URL(request.url).searchParams.get("v");
  if (!/^[0-9a-f-]{36}$/i.test(id) || (wanted !== null && !/^\d{1,4}$/.test(wanted))) return new Response("ההצעה לא נמצאה.", { status: 404 });
  const [v] = await query<{ id: string; version: number; number: number }>(
    `select v.id::text, v.version, qt.number from quote_versions v join quotes qt on qt.id = v.quote_id
     where v.quote_id = $1 and ($2::int is null or v.version = $2::int) order by v.version desc limit 1`,
    [id, wanted === null ? null : Number(wanted)],
  );
  if (!v) return new Response("ההצעה לא נמצאה.", { status: 404 });
  try {
    const pdf = await renderQuotePdf(v.id, internalOrigin(request));
    return new Response(new Uint8Array(pdf), {
      headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="quote-${v.number}-v${v.version}.pdf"`, "cache-control": "no-store" },
    });
  } catch (e) {
    console.error("[quote pdf]", e);
    return new Response("יצירת ה-PDF נכשלה. אפשר להשתמש בתצוגה להדפסה.", { status: 500 });
  }
}
