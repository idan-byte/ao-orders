import Link from "next/link";
import { Suspense } from "react";
import { query } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { progressLabel, workRoutes } from "@/lib/loading-core";
import { LiveRefresh } from "@/components/live-refresh";
import { Loading } from "@/components/loading";
import { NoAccess } from "@/components/no-access";

const dayFmt = new Intl.DateTimeFormat("he-IL", { timeZone: "UTC", weekday: "long", day: "2-digit", month: "2-digit" });

// The working list for whoever loads and delivers: a driver sees their own routes, a loading manager and a
// shipping manager see all of them. Today and tomorrow, because loading often happens the evening before.
export default function DrivePage() {
  return (
    <>
      <LiveRefresh />
      <Suspense fallback={<Loading />}>
        <Drive />
      </Suspense>
    </>
  );
}

async function Drive() {
  const { user, allowed } = await requirePermission("shipping.ship");
  if (!allowed) return <NoAccess />;
  const [dates] = await query<{ today: string; tomorrow: string }>("select (now() at time zone 'Asia/Jerusalem')::date::text as today, ((now() at time zone 'Asia/Jerusalem')::date + 1)::text as tomorrow");
  const all = can(user.role, "shipping.manage") || user.role === "loading_manager";
  const routes = await workRoutes(query, user, [dates.today, dates.tomorrow], all);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <h1 className="font-display text-2xl font-bold">טעינה והפצה</h1>
      {routes.length === 0 ? (
        <section className="rounded-xl border border-line bg-surface p-4">
          <p>{all ? "אין קווים משובצים להיום ולמחר." : "לא שובצת לקו להיום או למחר."}</p>
          {!all ? <p className="mt-1 text-sm text-muted">הקו מופיע כאן כשמנהל השילוח משבץ אותך כנהג, לפי מספר הטלפון שאיתו נכנסת.</p> : null}
        </section>
      ) : null}
      {[dates.today, dates.tomorrow].map((date) => {
        const list = routes.filter((r) => r.date === date);
        if (list.length === 0) return null;
        return (
          <section key={date} className="flex flex-col gap-2">
            <h2 className="font-display text-base font-bold">
              {date === dates.today ? "היום" : "מחר"} · {dayFmt.format(new Date(date))}
            </h2>
            {list.map((r) => {
              const loading = r.mode === "loading";
              const done = loading ? r.loaded : r.delivered;
              return (
                <Link key={r.id} href={`/drive/${r.id}`} data-work-route={r.name} className="flex flex-col gap-1.5 rounded-xl border border-line bg-surface p-4 hover:border-accent">
                  <span className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-display text-xl font-bold">{r.name}</span>
                    <span data-mode className="rounded-full bg-sunken px-3 py-1 text-sm font-medium">
                      {loading ? "טעינה" : "הפצה"} · {progressLabel(done, r.total)}
                    </span>
                  </span>
                  <span className="text-muted">
                    {r.driver ?? "לא נבחר נהג"}
                    {r.vehicle ? ` · רכב ${r.vehicle}` : ""} · {r.stops} עצירות
                  </span>
                  <span className="tabular-nums" data-progress>
                    {loading ? "הועמסו" : "נמסרו"} {done} מתוך {r.total}
                  </span>
                  <progress value={done} max={Math.max(1, r.total)} className="h-2 w-full" aria-label="התקדמות" />
                </Link>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}
