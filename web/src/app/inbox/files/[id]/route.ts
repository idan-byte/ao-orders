import { query } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { inboundFile } from "@/lib/inbound-core";

// Downloads a file that came with a message. It is always sent as a download, never shown in the page, because
// its kind was written by the sender.
export async function GET(_request: Request, ctx: RouteContext<"/inbox/files/[id]">) {
  const user = await getCurrentUser();
  if (!user) return new Response("יש להיכנס למערכת.", { status: 401 });
  if (!can(user.role, "leads.view")) return new Response("אין הרשאה.", { status: 403 });
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response("הקובץ לא נמצא.", { status: 404 });
  const file = await inboundFile(query, id);
  if (!file) return new Response("הקובץ לא נמצא.", { status: 404 });
  return new Response(new Uint8Array(file.data), {
    headers: {
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    },
  });
}
