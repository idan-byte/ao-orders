import { query } from "@/lib/db";
import { getLogo } from "@/lib/letterheads-core";

// The logo image of a letterhead. Public on purpose: it appears on the quote a customer opens from a link,
// and a logo is not a secret. The address carries a version, so a replaced logo is fetched again.
export async function GET(_request: Request, ctx: RouteContext<"/letterheads/[id]/logo">) {
  const { id } = await ctx.params;
  const logo = /^\d{1,9}$/.test(id) ? await getLogo(query, Number(id)) : null;
  if (!logo) return new Response("not found", { status: 404 });
  return new Response(Buffer.from(logo.bytes), {
    headers: { "content-type": logo.mime, "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" },
  });
}
