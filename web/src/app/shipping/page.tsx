import Link from "next/link";
import { Suspense } from "react";
import { query } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { dayRoutes, unassigned } from "@/lib/shipping-core";
import { shippingAlerts } from "@/lib/alerts-core";
import { ActionForm } from "@/components/action-form";
import { Loading } from "@/components/loading";
import { NoAccess } from "@/components/no-access";
import { assignDeliveryAction, planDayAction } from "./actions";

const panel = "rounded-xl border border-line bg-surface p-4";
const field = "rounded-lg border border-line bg-surface px-3 py-2 text-foreground";
const nf = new Intl.NumberFormat("he-IL", { maximumFractionDigits: 3 });
const dayFmt = new Intl.DateTimeFormat("he-IL", { timeZone: "UTC", weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" });
const isDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

export default function ShippingPage({ searchParams }: PageProps<"/shipping">) {
  return (
    <Suspense fallback={<Loading />}>
      <Shipping searchParams={searchParams} />
    </Suspense>
  );
}

async function Shipping({ searchParams }: { searchParams: PageProps<"/shipping">["searchParams"] }) {
  const { allowed } = await requirePermission("shipping.manage");
  if (!allowed) return <NoAccess />;
  const sp = await searchParams;
  const [dates] = await query<{ today: string; tomorrow: string }>("select (now() at time zone 'Asia/Jerusalem')::date::text as today, ((now() at time zone 'Asia/Jerusalem')::date + 1)::text as tomorrow");
  const date = isDate(sp.date) ? sp.date : dates.today;
  const routes = await dayRoutes(query, date);
  const waiting = await unassigned(query, date);
  const alerts = await shippingAlerts(query, dates.today);
  const urgent = alerts.filter((a) => a.severity === "high").length;
  const allRoutes = await query<{ id: number; name: string }>("select id, name from routes where active order by name");
  const nav = "rounded-lg border border-line px-4 py-2";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-2xl font-bold">מערך השילוח</h1>
        <div className="flex flex-wrap gap-2">
          <Link id="alerts-link" href="/shipping/alerts" data-open={alerts.length} className={`${nav} ${urgent > 0 ? "border-2 border-foreground font-medium" : ""}`}>
            התראות וחריגים{alerts.length > 0 ? ` · ${alerts.length}` : ""}
            {urgent > 0 ? ` (${urgent} דחופות)` : ""}
          </Link>
          <Link id="routes-link" href="/shipping/routes" className={nav}>
            ניהול קווים
          </Link>
          <Link id="drivers-link" href="/shipping/drivers" className={nav}>
            נהגים ורכבים
          </Link>
        </div>
      </div>
      <p className="text-lg">
        אספקה ביום {dayFmt.format(new Date(date))}
        {date === dates.today ? " · היום" : date === dates.tomorrow ? " · מחר" : ""}
      </p>

      <section className={panel}>
        <form action="/shipping" className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm text-muted">
            תאריך אספקה
            <input id="shipping-date" name="date" type="date" defaultValue={date} className={field} />
          </label>
          <button className={nav}>הצג</button>
          <Link href={`/shipping?date=${dates.today}`} className={nav}>
            היום
          </Link>
          <Link href={`/shipping?date=${dates.tomorrow}`} className={nav}>
            מחר
          </Link>
        </form>
        <div className="mt-3 border-t border-line pt-3" id="plan-day">
          <ActionForm action={planDayAction} submit="שבץ אספקות לקווים" pendingLabel="משבץ…">
            <input type="hidden" name="date" value={date} />
            <span className="max-w-xl pb-2 text-sm text-muted">כל אספקה שלכתובת שלה יש קו קבוע משובצת לקו, לפי סדר החלוקה הקבוע. אפשר להריץ שוב: מה שכבר שובץ או שונה ידנית נשאר במקומו.</span>
          </ActionForm>
        </div>
      </section>

      {routes.length === 0 ? (
        <section className={panel}>
          <p className="text-muted">{allRoutes.length === 0 ? "עוד לא הוגדרו קווים. מתחילים ב״ניהול קווים״." : "עוד לא שובצו אספקות לקווים בתאריך הזה."}</p>
        </section>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
          {routes.map((r) => (
            <Link key={r.id} href={`/shipping/day/${r.id}`} data-route-card={r.name} className={`${panel} flex flex-col gap-1.5 hover:border-accent`}>
              <span className="font-display text-lg font-bold">{r.name}</span>
              <span data-driver>{r.driver ?? <b>לא נבחר נהג</b>}</span>
              <span className="text-sm text-muted">
                {r.vehicle ? `רכב ${r.vehicle}` : "ללא רכב"}
                {r.driverPhone ? ` · ${r.driverPhone}` : ""}
              </span>
              <span className="tabular-nums" data-counts>
                {r.stops} עצירות · {r.deliveries} אספקות · {nf.format(r.units)} יח׳
              </span>
              <span className="text-sm tabular-nums" data-progress>
                {r.mode === "loading" ? "טעינה" : "הפצה"} · הועמסו {r.loaded}/{r.deliveries}
                {r.mode === "unloading" ? ` · נמסרו ${r.delivered}/${r.deliveries}` : ""}
              </span>
              <progress value={r.mode === "loading" ? r.loaded : r.delivered} max={Math.max(1, r.deliveries)} className="h-2 w-full" aria-label="התקדמות" />
            </Link>
          ))}
        </div>
      )}

      <section className={panel} id="unassigned">
        <h2 className="mb-1 font-display text-base font-bold">
          אספקות שלא שובצו <span className="font-sans text-sm font-normal text-muted">· {waiting.length}</span>
        </h2>
        {waiting.length === 0 ? (
          <p className="text-muted">כל האספקות של התאריך משובצות לקווים.</p>
        ) : allRoutes.length === 0 ? (
          <p className="text-muted">יש {waiting.length} אספקות בתאריך הזה. כדי לשבץ אותן צריך קודם להגדיר קווים.</p>
        ) : (
          <>
            <p className="mb-3 text-sm text-muted">לכתובת של האספקות האלה אין קו קבוע. בוחרים קו, ואם מסמנים ״קבוע״ הכתובת תשובץ לקו הזה לבד גם בימים הבאים.</p>
            <ul className="flex flex-col gap-2">
              {waiting.map((d) => (
                <li key={d.id} data-unassigned={d.orderNumber} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line px-3 py-2">
                  <span>
                    <Link href={`/orders/${d.orderId}`} className="font-medium text-accent underline-offset-2 hover:underline">
                      {d.orderNumber}
                    </Link>{" "}
                    · {d.customer}
                    <span className="text-sm text-muted">
                      {" "}
                      · {d.address ?? "אין כתובת אספקה"}
                      {d.window ? ` · ${d.window}` : ""} · {nf.format(d.units)} יח׳
                    </span>
                  </span>
                  <ActionForm action={assignDeliveryAction} submit="שבץ" primary={false} className="flex flex-wrap items-center gap-2">
                    <input type="hidden" name="delivery_id" value={d.id} />
                    <select name="route_id" required defaultValue="" aria-label="קו" className={field}>
                      <option value="">בחירת קו</option>
                      {allRoutes.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name}
                        </option>
                      ))}
                    </select>
                    {d.addressId ? (
                      <label className="flex items-center gap-1.5 text-sm">
                        <input type="checkbox" name="permanent" defaultChecked className="size-5" />
                        קבוע
                      </label>
                    ) : null}
                  </ActionForm>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}
