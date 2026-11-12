import Link from "next/link";
import { Suspense } from "react";
import { query } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { WEEKDAYS } from "@/lib/standing-core";
import { ActionForm } from "@/components/action-form";
import { Loading } from "@/components/loading";
import { NoAccess } from "@/components/no-access";
import { closedDayAction, generateAction, removeClosedDayAction } from "./actions";

type Row = { id: string; customer: string; valid_from: string; valid_to: string | null; paused_until: string | null; days: { weekday: number; units: number }[]; last_generated: string | null; ended: boolean; paused: boolean };

const panel = "rounded-xl border border-line bg-surface p-4";
const field = "rounded-lg border border-line bg-surface px-3 py-2 text-foreground";
const label = "flex flex-col gap-1 text-sm text-muted";
const dateFmt = new Intl.DateTimeFormat("he-IL", { timeZone: "UTC", day: "2-digit", month: "2-digit", year: "numeric" });
const d = (iso: string | null) => (iso ? dateFmt.format(new Date(iso)) : "");

export default function StandingPage() {
  return (
    <Suspense fallback={<Loading />}>
      <StandingList />
    </Suspense>
  );
}

async function StandingList() {
  const { user, allowed } = await requirePermission("orders.view");
  if (!allowed) return <NoAccess />;
  const mayEdit = can(user.role, "orders.edit");
  const [dates] = await query<{ today: string; week: string }>("select (now() at time zone 'Asia/Jerusalem')::date::text as today, ((now() at time zone 'Asia/Jerusalem')::date + 7)::text as week");
  const rows = await query<Row>(
    `select s.id::text, c.name as customer, s.valid_from::text, s.valid_to::text, s.paused_until::text,
            coalesce((select json_agg(json_build_object('weekday', x.weekday, 'units', x.units) order by x.weekday)
                      from (select weekday, sum(quantity)::float as units from standing_order_lines where standing_order_id = s.id group by weekday) x), '[]'::json) as days,
            (select max(day)::text from standing_order_days where standing_order_id = s.id and generated_order_id is not null) as last_generated,
            coalesce(s.valid_to < $1::date, false) as ended,
            coalesce(s.paused_until >= $1::date, false) as paused
     from standing_orders s join customers c on c.id = s.customer_id
     order by coalesce(s.valid_to < $1::date, false), c.name`,
    [dates.today],
  );
  const closed = await query<{ day: string; reason: string }>("select day::text, reason from closed_days where day >= $1::date order by day", [dates.today]);
  const customers = mayEdit ? await query<{ id: string; name: string }>("select id::text, name from customers where active order by name") : [];

  return (
    <div className="flex flex-col gap-4">
      <h1 className="font-display text-2xl font-bold">הזמנות קבועות</h1>

      {mayEdit ? (
        <section className={panel}>
          <h2 className="mb-1 font-display text-base font-bold">יצירת הזמנות מההזמנות הקבועות</h2>
          <p className="mb-3 text-sm text-muted">יוצר הזמנה מאושרת לכל לקוח ולכל יום בטווח. אפשר להריץ שוב בלי חשש: יום שכבר נוצרה לו הזמנה לא ייווצר פעמיים.</p>
          <ActionForm action={generateAction} submit="צור הזמנות" pendingLabel="יוצר…">
            <label className={label}>
              מתאריך
              <input id="gen-from" name="from" type="date" required defaultValue={dates.today} min={dates.today} className={field} />
            </label>
            <label className={label}>
              עד תאריך
              <input id="gen-to" name="to" type="date" required defaultValue={dates.week} className={field} />
            </label>
          </ActionForm>
        </section>
      ) : null}

      <section className={panel}>
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <h2 className="font-display text-base font-bold">{rows.length} הזמנות קבועות</h2>
          {mayEdit && customers.length > 0 ? (
            <form action="/standing/new" className="flex flex-wrap items-end gap-3">
              <label className={label}>
                הזמנה קבועה חדשה ללקוח
                <select id="standing-customer" name="customer" required defaultValue="" className={`${field} max-w-xs`}>
                  <option value="">בחירה</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <button className="rounded-lg bg-accent px-4 py-2 font-medium text-surface">המשך</button>
            </form>
          ) : null}
        </div>
        {rows.length === 0 ? (
          <p className="text-muted">עוד לא הוגדרו הזמנות קבועות.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse tabular-nums">
              <thead>
                <tr className="border-b border-line text-xs text-muted">
                  <th className="px-2 py-1.5 text-start font-medium">לקוח</th>
                  <th className="px-2 py-1.5 text-start font-medium">יחידות לפי יום</th>
                  <th className="px-2 py-1.5 text-start font-medium">תוקף</th>
                  <th className="px-2 py-1.5 text-start font-medium">מצב</th>
                  <th className="px-2 py-1.5 text-start font-medium">נוצרו הזמנות עד</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={`border-b border-line last:border-0 ${r.ended ? "text-muted" : ""}`}>
                    <td className="px-2 py-2">
                      <Link href={`/standing/${r.id}`} className="font-medium text-accent underline-offset-2 hover:underline">
                        {r.customer}
                      </Link>
                    </td>
                    <td className="px-2 py-2 text-sm">{r.days.map((x) => `${WEEKDAYS[x.weekday]} ${x.units.toLocaleString("he-IL")}`).join(" · ")}</td>
                    <td className="px-2 py-2 text-sm">
                      מ-{d(r.valid_from)}
                      {r.valid_to ? ` עד ${d(r.valid_to)}` : ""}
                    </td>
                    <td className="px-2 py-2 text-sm">{r.ended ? "הסתיימה" : r.paused ? `מושהית עד ${d(r.paused_until)}` : "פעילה"}</td>
                    <td className="px-2 py-2 text-sm">{d(r.last_generated) || "עוד לא נוצרו"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className={panel}>
        <h2 className="mb-1 font-display text-base font-bold">ימים שהמפעל סגור</h2>
        <p className="mb-3 text-sm text-muted">חגים וימים ללא חלוקה. ביום סגור לא נוצרות הזמנות מההזמנות הקבועות, לאף לקוח.</p>
        {closed.length > 0 ? (
          <ul className="mb-3 flex flex-col gap-1.5" data-closed-days>
            {closed.map((c) => (
              <li key={c.day} className="flex flex-wrap items-center gap-3">
                <span>
                  {d(c.day)} · {c.reason}
                </span>
                {mayEdit ? (
                  <form action={removeClosedDayAction}>
                    <input type="hidden" name="day" value={c.day} />
                    <button className="rounded-lg border border-line px-3 py-1 text-sm">הסר</button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mb-3 text-muted">לא הוגדרו ימים סגורים.</p>
        )}
        {mayEdit ? (
          <ActionForm action={closedDayAction} submit="הוסף יום סגור" primary={false}>
            <label className={label}>
              תאריך
              <input id="closed-day" name="day" type="date" required min={dates.today} className={field} />
            </label>
            <label className={label}>
              סיבה
              <input id="closed-reason" name="reason" required placeholder="למשל: חנוכה" className={field} />
            </label>
          </ActionForm>
        ) : null}
      </section>
    </div>
  );
}
