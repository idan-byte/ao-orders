import { query } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

// The current value of the change counter. It says only that something changed, never what:
// a screen that sees a new value reloads its own data under its own permissions.
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return new Response(null, { status: 401 });
  const [row] = await query<{ v: string }>("select last_value::text as v from live_version");
  return Response.json({ v: row.v }, { headers: { "cache-control": "no-store" } });
}
