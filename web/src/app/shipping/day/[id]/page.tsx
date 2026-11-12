import Link from "next/link";
import { Suspense } from "react";
import { query } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { STATUS_LABEL } from "@/lib/orders-core";
import { routeDeliveries, type PlanDelivery } from "@/lib/shipping-core";
import { ActionForm } from "@/components/action-form";
import { Loading } from "@/components/loading";
import { NoAccess } from "@/components/no-access";
import { PrintButton } from "@/components/print-button";
import { assignDeliveryAction, dailyDriverAction, moveStopAction } from "../../actions";

const panel = "rounded-xl border border-line bg-surface p-4";
const field = "rounded-lg border border-line bg-surface px-3 py-2 text-foreground";
const nf = new Intl.NumberFormat("he-IL", { maximumFractionDigits: 3 });
const dayFmt = new Intl.DateTimeFormat("he-IL", { timeZone: "UTC", weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" });

export default function DailyRoutePage({ params, searchParams }: PageProps<"/shipping/day/[id]">) {
  return (
    <Suspense fallback={<Loading />}>
      <DailyRoute params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function DailyRoute({ params, searchParams }: Pick<PageProps<"/shipping/day/[id]">, "params" | "searchParams">) {
  const { allowed } = await requirePermission("shipping.manage");
  if (!allowed) return <NoAccess />;
  const { id } = await params;
  const loadingOrder = (await searchParams).order === "loading";
  const [route] = /^[0-9a-f-]{36}$/i.test(id)
    ? await query<{ id: string; route_id: number; route_date: string; name: string; driver_id: number | null; driver: string | null; phone: string | null; vehicle: string | null }>(
        `select dr.id::text, dr.route_id, dr.route_date::text, r.name, dr.driver_id, d.name as driver, d.phone, v.registration as vehicle
         from daily_routes dr join routes r on r.id = dr.route_id left join drivers d on d.id = dr.driver_id left join vehicles v on v.id = dr.vehicle_id where dr.id = $1`,
        [id],
      )
    : [];
  if (!route) {
    return (
      <div className="flex flex-col items-start gap-3">
        <h1 className="font-display text-2xl font-bold">הקו לא נמצא</h1>
        <Link href="/shipping" className="rounded-lg border border-line px-3 py-1.5 text-sm">
          חזרה למערך השילוח
        </Link>
      </div>
    );
  }
  const deliveries = await routeDeliveries(query, id);
  const drivers = await query<{ id: number; name: string; vehicle: string | null }>("select d.id, d.name, v.registration as vehicle from drivers d left join vehicles v on v.id = d.vehicle_id where d.active or d.id = $1 order by d.name", [route.driver_id]);
  const otherRoutes = await query<{ id: number; name: string }>("select id, name from routes where active and id <> $1 order by name", [route.route_id]);
  const stops = new Map<number, PlanDelivery[]>();
  for (const d of deliveries) stops.set(d.stopOrder ?? 0, [...(stops.get(d.stopOrder ?? 0) ?? []), d]);
  const ordered = [...stops.entries()].sort((a, b) => (loadingOrder ? b[0] - a[0] : a[0] - b[0]));
  const last = Math.max(0, ...stops.keys());
  const tab = (active: boolean) => `rounded-full border px-3 py-1 text-sm ${active ? "border-accent bg-accent text-surface" : "border-line"}`;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-2xl font-bold">פרטי קו · {route.name}</h1>
        <div className="no-print flex flex-wrap items-center gap-2">
          <PrintButton />
          <Link id="work-link" href={`/drive/${id}`} className="rounded-lg border border-line px-3 py-1.5 text-sm">
            מסך טעינה והפצה
          </Link>
          <Link href={`/shipping?date=${route.route_date}`} className="rounded-lg border border-line px-3 py-1.5 text-sm">
            חזרה למערך השילוח
          </Link>
        </div>
      </div>
      <p className="text-lg" id="route-summary">
        {dayFmt.format(new Date(route.route_date))} · {route.driver ?? "לא נבחר נהג"}
        {route.vehicle ? ` · רכב ${route.vehicle}` : ""}
        {route.phone ? (
          <>
            {" · "}
            <a href={`tel:${route.phone}`} dir="ltr" className="text-accent underline-offset-2 hover:underline">
              {route.phone}
            </a>
          </>
        ) : null}{" "}
        · {stops.size} עצירות · {deliveries.length} אספקות · {nf.format(deliveries.reduce((s, d) => s + d.units, 0))} יח׳
      </p>

      <section className={`${panel} no-print`} id="daily-driver">
        <ActionForm action={dailyDriverAction} submit="שמור" primary={false}>
          <input type="hidden" name="daily_route_id" value={id} />
          <label className="flex flex-col gap-1 text-sm text-muted">
            הנהג ביום הזה (הקו הקבוע לא משתנה)
            <select name="driver_id" defaultValue={route.driver_id ?? ""} className={field}>
              <option value="">לא נבחר</option>
              {drivers.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                  {d.vehicle ? ` · ${d.vehicle}` : ""}
                </option>
              ))}
            </select>
          </label>
        </ActionForm>
      </section>

      <div className="no-print flex flex-wrap items-center gap-2">
        <Link href={`/shipping/day/${id}`} aria-current={!loadingOrder ? "page" : undefined} className={tab(!loadingOrder)}>
          סדר פריקה
        </Link>
        <Link href={`/shipping/day/${id}?order=loading`} aria-current={loadingOrder ? "page" : undefined} className={tab(loadingOrder)}>
          סדר טעינה
        </Link>
        <span className="text-sm text-muted">{loadingOrder ? "העצירה האחרונה נטענת ראשונה, כדי שתהיה הראשונה לצאת מהרכב." : "הסדר שבו הנהג מחלק."}</span>
      </div>

      {ordered.length === 0 ? (
        <section className={panel}>
          <p className="text-muted">אין אספקות בקו הזה ביום הזה.</p>
        </section>
      ) : (
        <ol className="flex flex-col gap-2" data-order={loadingOrder ? "loading" : "delivery"}>
          {ordered.map(([stop, list]) => (
            <li key={stop} data-stop={stop} className={`${panel} flex flex-wrap items-start justify-between gap-3`}>
              <div className="flex min-w-0 items-start gap-3">
                <span className="font-display text-2xl font-bold tabular-nums">{stop}</span>
                <div className="min-w-0">
                  <div className="font-medium" data-stop-customer>
                    {list[0].customer}
                  </div>
                  <div className="text-sm text-muted">{list[0].address ?? "אין כתובת אספקה"}</div>
                  <ul className="mt-1.5 flex flex-col gap-1.5">
                    {list.map((d) => (
                      <li key={d.id} data-delivery={d.orderNumber} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                        <span>
                          <Link href={`/orders/${d.orderId}`} className="text-accent underline-offset-2 hover:underline">
                            הזמנה {d.orderNumber}
                          </Link>
                          {d.window ? ` · ${d.window}` : ""} · {nf.format(d.units)} יח׳ · {STATUS_LABEL[d.status] ?? d.status}
                          {d.notes ? <b> · {d.notes}</b> : null}
                        </span>
                        <span className="no-print">
                          <ActionForm action={assignDeliveryAction} submit="העבר" primary={false} className="flex flex-wrap items-center gap-2">
                            <input type="hidden" name="delivery_id" value={d.id} />
                            <select name="route_id" required defaultValue="" aria-label={`העברת הזמנה ${d.orderNumber}`} className="rounded-lg border border-line bg-surface px-2 py-1.5 text-foreground">
                              <option value="">העברה…</option>
                              {otherRoutes.map((r) => (
                                <option key={r.id} value={r.id}>
                                  לקו {r.name}
                                </option>
                              ))}
                              <option value="none">הסר מהקו</option>
                            </select>
                          </ActionForm>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
              <form action={moveStopAction} className="no-print flex gap-2">
                <input type="hidden" name="daily_route_id" value={id} />
                <input type="hidden" name="stop" value={stop} />
                <button name="direction" value="up" disabled={stop <= 1} aria-label={`הקדם את עצירה ${stop}`} className="rounded-lg border border-line px-3 py-2 disabled:opacity-40">
                  הקדם
                </button>
                <button name="direction" value="down" disabled={stop >= last} aria-label={`אחר את עצירה ${stop}`} className="rounded-lg border border-line px-3 py-2 disabled:opacity-40">
                  אחר
                </button>
              </form>
            </li>
          ))}
        </ol>
      )}
      <p className="no-print text-sm text-muted">שינוי הסדר או העברה כאן חלים על היום הזה בלבד. את הסדר הקבוע של הקו משנים ב״ניהול קווים״.</p>
    </div>
  );
}
