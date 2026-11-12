import Link from "next/link";
import { Suspense } from "react";
import { query } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { DELIVERY_STATUSES, STATUS_LABEL } from "@/lib/orders-core";
import { LiveRefresh } from "@/components/live-refresh";
import { Loading } from "@/components/loading";
import { NoAccess } from "@/components/no-access";

type Row = { delivery_id: string; order_id: string; number: number; customer: string; delivery_date: string; window: string | null; status: string; lines: number; units: number; total: number; source: string; address: string | null };

const money = new Intl.NumberFormat("he-IL", { style: "currency", currency: "ILS" });
const dayFmt = new Intl.DateTimeFormat("he-IL", { timeZone: "UTC", weekday: "short", day: "2-digit", month: "2-digit" });
const field = "rounded-lg border border-line bg-surface px-3 py-2 text-foreground";
const label = "flex flex-col gap-1 text-sm text-muted";
const isDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

export default function OrdersPage({ searchParams }: PageProps<"/orders">) {
  return (
    <>
      <LiveRefresh />
      <Suspense fallback={<Loading />}>
        <OrdersContent searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function OrdersContent({ searchParams }: { searchParams: PageProps<"/orders">["searchParams"] }) {
  const { user, allowed } = await requirePermission("orders.view");
  if (!allowed) return <NoAccess />;
  const sp = await searchParams;
  const [dates] = await query<{ today: string; plus14: string }>("select (now() at time zone 'Asia/Jerusalem')::date::text as today, ((now() at time zone 'Asia/Jerusalem')::date + 14)::text as plus14");
  const from = isDate(sp.from) ? sp.from : dates.today;
  const to = isDate(sp.to) ? sp.to : dates.plus14;
  const status = DELIVERY_STATUSES.includes(sp.status as (typeof DELIVERY_STATUSES)[number]) ? (sp.status as string) : "";
  const q = typeof sp.q === "string" ? sp.q.trim() : "";
  const showPrices = can(user.role, "prices.view");

  const rows = await query<Row>(
    `select d.id::text as delivery_id, o.id::text as order_id, o.number, c.name as customer, d.delivery_date::text,
            nullif(concat_ws('–', to_char(d.window_from, 'HH24:MI'), to_char(d.window_to, 'HH24:MI')), '') as window,
            d.status::text, o.source::text, d.address_snapshot as address,
            (select count(*)::int from delivery_lines l where l.delivery_id = d.id) as lines,
            coalesce((select sum(l.quantity) from delivery_lines l where l.delivery_id = d.id), 0)::float as units,
            coalesce((select sum(round(l.quantity * l.unit_price * (1 - l.discount_pct / 100), 2)) from delivery_lines l where l.delivery_id = d.id), 0)::float as total
     from deliveries d join orders o on o.id = d.order_id join customers c on c.id = o.customer_id
     where d.delivery_date between $1::date and $2::date
       and ($3 = '' or d.status::text = $3)
       and ($4 = '' or c.name ilike '%' || $4 || '%' or o.number::text = $4
            or exists (select 1 from delivery_lines l join products p on p.sku = l.sku where l.delivery_id = d.id and (p.name ilike '%' || $4 || '%' or l.sku = $4)))
     order by d.delivery_date, d.window_from nulls last, o.number
     limit 500`,
    [from, to, status, q],
  );
  const byDay = new Map<string, Row[]>();
  for (const r of rows) byDay.set(r.delivery_date, [...(byDay.get(r.delivery_date) ?? []), r]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-2xl font-bold">הזמנות</h1>
        <div className="flex flex-wrap items-center gap-2">
          <Link id="calendar-link" href={`/orders/calendar?month=${from.slice(0, 7)}`} className="rounded-lg border border-line px-4 py-2">
            לוח שנה
          </Link>
          {can(user.role, "orders.edit") ? (
            <Link id="new-order-link" href="/orders/new" className="rounded-lg bg-accent px-4 py-2 font-medium text-surface">
              הזמנה חדשה
            </Link>
          ) : null}
        </div>
      </div>

      <section className="rounded-xl border border-line bg-surface p-4">
        <form action="/orders" className="flex flex-wrap items-end gap-3">
          <label className={label}>
            אספקה מתאריך
            <input id="orders-from" name="from" type="date" defaultValue={from} className={field} />
          </label>
          <label className={label}>
            עד תאריך
            <input id="orders-to" name="to" type="date" defaultValue={to} className={field} />
          </label>
          <label className={label}>
            מצב
            <select id="orders-status" name="status" defaultValue={status} className={field}>
              <option value="">כל המצבים</option>
              {DELIVERY_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </label>
          <label className={label}>
            לקוח, מוצר, מק״ט או מספר הזמנה
            <input id="orders-q" name="q" defaultValue={q} className={field} />
          </label>
          <button className="rounded-lg border border-line px-4 py-2">סנן</button>
        </form>
      </section>

      {rows.length === 0 ? (
        <section className="rounded-xl border border-line bg-surface p-4">
          <p className="text-muted">אין אספקות בטווח התאריכים ובסינון שנבחרו.</p>
        </section>
      ) : (
        [...byDay.entries()].map(([day, list]) => (
          <section key={day} data-day={day} className="rounded-xl border border-line bg-surface p-4">
            <h2 className="mb-2 font-display text-base font-bold">
              {dayFmt.format(new Date(day))}
              {day === dates.today ? " · היום" : ""}
              <span className="font-sans text-sm font-normal text-muted">
                {" "}
                · {list.length} אספקות · {list.reduce((s, r) => s + r.units, 0).toLocaleString("he-IL")} יחידות
              </span>
            </h2>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse tabular-nums">
                <thead>
                  <tr className="border-b border-line text-xs text-muted">
                    <th className="px-2 py-1.5 text-start font-medium">שעה</th>
                    <th className="px-2 py-1.5 text-start font-medium">הזמנה</th>
                    <th className="px-2 py-1.5 text-start font-medium">לקוח</th>
                    <th className="px-2 py-1.5 text-start font-medium">כתובת</th>
                    <th className="px-2 py-1.5 text-end font-medium">פריטים</th>
                    <th className="px-2 py-1.5 text-end font-medium">יחידות</th>
                    {showPrices ? <th className="px-2 py-1.5 text-end font-medium">לפני מע״מ</th> : null}
                    <th className="px-2 py-1.5 text-start font-medium">מצב</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((r) => (
                    <tr key={r.delivery_id} className="border-b border-line last:border-0">
                      <td className="px-2 py-2" dir="ltr">
                        {r.window ?? ""}
                      </td>
                      <td className="px-2 py-2">
                        <Link href={`/orders/${r.order_id}`} className="font-medium text-accent underline-offset-2 hover:underline">
                          {r.number}
                        </Link>
                      </td>
                      <td className="px-2 py-2">{r.customer}</td>
                      <td className="px-2 py-2 text-sm">{r.address ?? <span className="text-muted">לא נבחרה</span>}</td>
                      <td className="px-2 py-2 text-end">{r.lines}</td>
                      <td className="px-2 py-2 text-end">{r.units.toLocaleString("he-IL")}</td>
                      {showPrices ? <td className="px-2 py-2 text-end">{money.format(r.total)}</td> : null}
                      <td className="px-2 py-2">
                        <span className="rounded-full bg-sunken px-2.5 py-0.5 text-sm">{STATUS_LABEL[r.status] ?? r.status}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))
      )}
      {rows.length === 500 ? <p className="text-sm text-muted">מוצגות 500 האספקות הראשונות. צמצום טווח התאריכים יציג את השאר.</p> : null}
    </div>
  );
}
