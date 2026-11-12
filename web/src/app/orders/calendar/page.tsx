import Link from "next/link";
import { Suspense } from "react";
import { query } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { Loading } from "@/components/loading";
import { NoAccess } from "@/components/no-access";

// A month of deliveries at a glance: how many, how many units, and the biggest customers of each day.
// A day opens the regular orders list for that date.
type DayRow = { day: string; deliveries: number; customers: number; units: number; problems: number; unapproved: number };

const WEEKDAYS = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];
const monthFmt = new Intl.DateTimeFormat("he-IL", { timeZone: "UTC", month: "long", year: "numeric" });
const nf = new Intl.NumberFormat("he-IL");
const pad = (n: number) => String(n).padStart(2, "0");
const monthKey = (y: number, m: number) => `${y}-${pad(m)}`; // m is 1..12
const shift = (y: number, m: number, by: number) => {
  const t = y * 12 + (m - 1) + by;
  return monthKey(Math.floor(t / 12), (t % 12) + 1);
};

export default function CalendarPage({ searchParams }: PageProps<"/orders/calendar">) {
  return (
    <Suspense fallback={<Loading />}>
      <Calendar searchParams={searchParams} />
    </Suspense>
  );
}

async function Calendar({ searchParams }: { searchParams: PageProps<"/orders/calendar">["searchParams"] }) {
  const { allowed } = await requirePermission("orders.view");
  if (!allowed) return <NoAccess />;
  const sp = await searchParams;
  const [{ today }] = await query<{ today: string }>("select (now() at time zone 'Asia/Jerusalem')::date::text as today");
  const wanted = typeof sp.month === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(sp.month) ? sp.month : today.slice(0, 7);
  const [y, m] = wanted.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const startWeekday = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const from = `${wanted}-01`;
  const to = `${wanted}-${pad(daysInMonth)}`;

  const rows = await query<DayRow>(
    `select d.delivery_date::text as day,
            count(*) filter (where d.status <> 'cancelled')::int as deliveries,
            count(distinct o.customer_id) filter (where d.status <> 'cancelled')::int as customers,
            coalesce(sum(u.units) filter (where d.status <> 'cancelled'), 0)::float as units,
            count(*) filter (where d.status in ('exception', 'delayed'))::int as problems,
            count(*) filter (where d.status in ('draft', 'pending_approval'))::int as unapproved
     from deliveries d join orders o on o.id = d.order_id
     left join lateral (select sum(l.quantity) as units from delivery_lines l where l.delivery_id = d.id) u on true
     where d.delivery_date between $1::date and $2::date
     group by d.delivery_date`,
    [from, to],
  );
  const top = await query<{ day: string; customer: string }>(
    `select day, customer from (
       select d.delivery_date::text as day, c.name as customer,
              row_number() over (partition by d.delivery_date order by sum(l.quantity) desc, c.name) as rn
       from deliveries d join orders o on o.id = d.order_id join customers c on c.id = o.customer_id join delivery_lines l on l.delivery_id = d.id
       where d.delivery_date between $1::date and $2::date and d.status <> 'cancelled'
       group by d.delivery_date, c.name
     ) x where rn <= 3 order by day, rn`,
    [from, to],
  );
  const closed = new Map((await query<{ day: string; reason: string }>("select day::text, reason from closed_days where day between $1::date and $2::date", [from, to])).map((c) => [c.day, c.reason]));
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const topByDay = new Map<string, string[]>();
  for (const t of top) topByDay.set(t.day, [...(topByDay.get(t.day) ?? []), t.customer]);
  const totals = rows.reduce((s, r) => ({ deliveries: s.deliveries + r.deliveries, units: s.units + r.units }), { deliveries: 0, units: 0 });
  const nav = "rounded-lg border border-line px-3 py-1.5 text-sm";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-2xl font-bold">לוח הזמנות · {monthFmt.format(new Date(Date.UTC(y, m - 1, 1)))}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <Link id="cal-prev" href={`/orders/calendar?month=${shift(y, m, -1)}`} className={nav}>
            החודש הקודם
          </Link>
          {wanted !== today.slice(0, 7) ? (
            <Link id="cal-today" href="/orders/calendar" className={nav}>
              החודש הנוכחי
            </Link>
          ) : null}
          <Link id="cal-next" href={`/orders/calendar?month=${shift(y, m, 1)}`} className={nav}>
            החודש הבא
          </Link>
          <Link id="cal-list" href={`/orders?from=${from}&to=${to}`} className={nav}>
            תצוגת רשימה
          </Link>
        </div>
      </div>
      <p id="cal-summary" className="rounded-lg bg-sunken px-3 py-2 text-sm">
        {totals.deliveries === 0 ? "אין אספקות בחודש הזה." : `${nf.format(totals.deliveries)} אספקות · ${nf.format(totals.units)} יחידות בחודש. אספקות מבוטלות אינן נספרות.`}
      </p>

      <div className="grid grid-cols-1 gap-1.5 md:grid-cols-7">
        {WEEKDAYS.map((w) => (
          <div key={w} className="hidden px-2 text-sm text-muted md:block">
            {w}
          </div>
        ))}
        {Array.from({ length: startWeekday }, (_, i) => (
          <div key={`blank-${i}`} className="hidden md:block" />
        ))}
        {Array.from({ length: daysInMonth }, (_, i) => {
          const day = `${wanted}-${pad(i + 1)}`;
          const r = byDay.get(day);
          const names = topByDay.get(day) ?? [];
          const reason = closed.get(day);
          const empty = !r || r.deliveries === 0;
          return (
            <Link
              key={day}
              href={`/orders?from=${day}&to=${day}`}
              data-cal-day={day}
              className={`flex min-h-12 flex-col gap-1 rounded-xl border bg-surface p-2 md:min-h-32 ${day === today ? "border-accent" : "border-line"} ${empty && !reason ? "max-md:hidden" : ""}`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className={`font-display text-lg font-bold ${day === today ? "text-accent" : ""}`}>
                  {i + 1}
                  <span className="font-sans text-sm font-normal text-muted md:hidden"> · יום {WEEKDAYS[(startWeekday + i) % 7]}</span>
                </span>
                {day === today ? <span className="text-xs text-accent">היום</span> : null}
              </div>
              {reason ? (
                <span data-cal-closed className="rounded bg-sunken px-1.5 py-0.5 text-xs">
                  סגור · {reason}
                </span>
              ) : null}
              {!empty ? (
                <>
                  <span className="text-sm tabular-nums">
                    <b data-cal-deliveries>{nf.format(r.deliveries)}</b> אספקות · <b data-cal-units>{nf.format(r.units)}</b> יח׳
                  </span>
                  {r.problems > 0 ? <span className="text-xs font-medium">{r.problems} בחריגה או בעיכוב</span> : null}
                  {r.unapproved > 0 ? <span className="text-xs text-muted">{r.unapproved} ממתינות לאישור</span> : null}
                  <span className="text-xs text-muted">
                    {names.join(", ")}
                    {r.customers > names.length ? ` ועוד ${r.customers - names.length}` : ""}
                  </span>
                </>
              ) : null}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
