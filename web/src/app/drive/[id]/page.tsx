import Link from "next/link";
import { Suspense } from "react";
import { query } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { missingFromRoute, progressLabel, routeAccess } from "@/lib/loading-core";
import { ActionForm } from "@/components/action-form";
import { Loading } from "@/components/loading";
import { NoAccess } from "@/components/no-access";
import { TapAction } from "@/components/tap-action";
import { closeRouteAction, deliveryAction, departAction } from "../actions";

const panel = "rounded-xl border border-line bg-surface p-4";
const nf = new Intl.NumberFormat("he-IL", { maximumFractionDigits: 3 });
const dayFmt = new Intl.DateTimeFormat("he-IL", { timeZone: "UTC", weekday: "long", day: "2-digit", month: "2-digit" });
const todo = "w-full rounded-xl border-2 border-line bg-surface px-4 py-4 text-start text-lg font-medium";
const small = "rounded-lg border border-line px-3 py-1.5 text-sm";

type Row = { id: string; order_id: string; number: number; customer: string; address: string | null; window: string | null; units: number; status: string; loaded: boolean; stop_order: number | null; notes: string | null; phone: string | null };

export default function WorkRoutePage({ params, searchParams }: PageProps<"/drive/[id]">) {
  return (
    <Suspense fallback={<Loading />}>
      <WorkRoute params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function WorkRoute({ params, searchParams }: Pick<PageProps<"/drive/[id]">, "params" | "searchParams">) {
  const { user, allowed } = await requirePermission("shipping.ship");
  if (!allowed) return <NoAccess />;
  const { id } = await params;
  const access = /^[0-9a-f-]{36}$/i.test(id) ? await routeAccess(query, user, id, (p) => can(user.role, p)) : null;
  // A driver asking for someone else's route gets the same answer as for a route that does not exist.
  if (!access?.view) {
    return (
      <div className="flex flex-col items-start gap-3">
        <h1 className="font-display text-2xl font-bold">הקו לא נמצא</h1>
        <Link href="/drive" className={small}>
          חזרה לרשימת הקווים
        </Link>
      </div>
    );
  }
  const [route] = await query<{ route_date: string; name: string; mode: string; driver: string | null; vehicle: string | null; departure_note: string | null }>(
    `select dr.route_date::text, r.name, dr.mode, d.name as driver, v.registration as vehicle, dr.departure_note
     from daily_routes dr join routes r on r.id = dr.route_id left join drivers d on d.id = dr.driver_id left join vehicles v on v.id = dr.vehicle_id where dr.id = $1`,
    [id],
  );
  const rows = await query<Row>(
    `select d.id::text, o.id::text as order_id, o.number, c.name as customer, d.address_snapshot as address,
            nullif(concat_ws('–', to_char(d.window_from, 'HH24:MI'), to_char(d.window_to, 'HH24:MI')), '') as window,
            coalesce((select sum(l.quantity) from delivery_lines l where l.delivery_id = d.id), 0)::float as units,
            d.status::text, d.loaded_at is not null as loaded, d.stop_order, d.shipping_notes as notes,
            (select cc.phone from customer_contacts cc where cc.customer_id = c.id and cc.phone is not null and cc.phone <> '' order by cc.full_name limit 1) as phone
     from deliveries d join orders o on o.id = d.order_id join customers c on c.id = o.customer_id
     where d.daily_route_id = $1 and d.status <> 'cancelled' order by d.stop_order, o.number`,
    [id],
  );
  const loading = route.mode === "loading";
  const missing = loading ? await missingFromRoute(query, id) : [];
  const order = (await searchParams).order;
  const loadingOrder = order === "loading" || (order !== "delivery" && loading);
  const stops = new Map<number, Row[]>();
  for (const r of rows) stops.set(r.stop_order ?? 0, [...(stops.get(r.stop_order ?? 0) ?? []), r]);
  const ordered = [...stops.entries()].sort((a, b) => (loadingOrder ? b[0] - a[0] : a[0] - b[0]));
  const total = rows.length;
  const done = loading ? rows.filter((r) => r.loaded).length : rows.filter((r) => r.status === "delivered").length;
  const tab = (active: boolean) => `rounded-full border px-3 py-1.5 text-sm ${active ? "border-accent bg-accent text-surface" : "border-line"}`;
  const fields = (r: Row, action: string) => ({ daily_route_id: id, delivery_id: r.id, action });

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-2xl font-bold">{route.name}</h1>
        <Link href="/drive" className={small}>
          כל הקווים
        </Link>
      </div>

      <section className={panel} id="route-state" data-mode={route.mode}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="rounded-full bg-accent px-4 py-1.5 font-display text-lg font-bold text-surface">מצב: {loading ? "טעינה" : "הפצה"}</span>
          <span className="text-muted">
            {dayFmt.format(new Date(route.route_date))} · {route.driver ?? "לא נבחר נהג"}
            {route.vehicle ? ` · ${route.vehicle}` : ""}
          </span>
        </div>
        <p className="mt-2 text-lg tabular-nums" id="progress">
          {loading ? "הועמסו" : "נמסרו"} <b>{done}</b> מתוך <b>{total}</b> · {progressLabel(done, total)}
        </p>
        <progress value={done} max={Math.max(1, total)} className="mt-1 h-3 w-full" aria-label="התקדמות" />
        {route.departure_note ? <p className="mt-2 text-sm">הקו יצא בלי כל האספקות: {route.departure_note}</p> : null}
      </section>

      <div className="flex flex-wrap items-center gap-2">
        <Link href={`/drive/${id}?order=loading`} aria-current={loadingOrder ? "page" : undefined} className={tab(loadingOrder)}>
          סדר טעינה
        </Link>
        <Link href={`/drive/${id}?order=delivery`} aria-current={!loadingOrder ? "page" : undefined} className={tab(!loadingOrder)}>
          סדר פריקה
        </Link>
        <span className="text-sm text-muted">{loadingOrder ? "העצירה האחרונה נטענת ראשונה." : "הסדר שבו מחלקים."}</span>
      </div>

      {ordered.length === 0 ? (
        <section className={panel}>
          <p className="text-muted">אין אספקות בקו הזה.</p>
        </section>
      ) : (
        <ol className="flex flex-col gap-3" data-order={loadingOrder ? "loading" : "delivery"}>
          {ordered.map(([stop, list]) => (
            <li key={stop} data-stop={stop} className={panel}>
              <div className="mb-2 flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-3">
                  <span className="font-display text-3xl font-bold tabular-nums">{stop}</span>
                  <div className="min-w-0">
                    <div className="text-lg font-medium" data-stop-customer>
                      {list[0].customer}
                    </div>
                    <div className="text-muted">{list[0].address ?? "אין כתובת אספקה"}</div>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {list[0].phone ? (
                    <a href={`tel:${list[0].phone}`} className={small}>
                      חיוג
                    </a>
                  ) : null}
                  {list[0].address ? (
                    <a data-waze href={`https://waze.com/ul?q=${encodeURIComponent(list[0].address)}&navigate=yes`} target="_blank" rel="noreferrer" className={small}>
                      נווט עם Waze
                    </a>
                  ) : null}
                </div>
              </div>
              <ul className="flex flex-col gap-2">
                {list.map((r) => {
                  const delivered = r.status === "delivered";
                  const marked = loading ? r.loaded : delivered;
                  const detail = `הזמנה ${r.number} · ${nf.format(r.units)} יח׳${r.window ? ` · ${r.window}` : ""}`;
                  return (
                    <li key={r.id} data-delivery={r.number} data-marked={String(marked)} className="flex flex-col gap-1">
                      {marked ? (
                        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border-2 border-accent bg-accent-soft px-4 py-3">
                          <span className="text-lg font-medium">
                            ✓ {loading ? "הועמסה" : "נמסרה"} <span className="text-base font-normal text-muted">· {detail}</span>
                          </span>
                          {access.manage ? (
                            <TapAction action={deliveryAction} fields={fields(r, loading ? "reverse_load" : "reverse_unload")} className={small} confirm={loading ? "לבטל את סימון ההעמסה?" : "לבטל את סימון המסירה?"}>
                              בטל סימון
                            </TapAction>
                          ) : null}
                        </div>
                      ) : loading && access.load ? (
                        <TapAction action={deliveryAction} fields={fields(r, "load")} className={todo}>
                          העמס <span className="text-base font-normal text-muted">· {detail}</span>
                        </TapAction>
                      ) : !loading && access.unload && r.status === "shipped" ? (
                        <TapAction action={deliveryAction} fields={fields(r, "unload")} className={todo}>
                          נמסר <span className="text-base font-normal text-muted">· {detail}</span>
                        </TapAction>
                      ) : (
                        <div className="rounded-xl border-2 border-line px-4 py-3 text-lg">
                          {loading ? "טרם הועמסה" : "טרם נמסרה"} <span className="text-base text-muted">· {detail}</span>
                        </div>
                      )}
                      {r.notes ? <p className="rounded-lg bg-sunken px-3 py-1.5 text-sm font-medium">הערה לשילוח: {r.notes}</p> : null}
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ol>
      )}

      {!loading && access.manage && done < total ? (
        <section className={panel} id="close-route">
          <h2 className="mb-1 font-display text-base font-bold">סגירת הקו בלי למסור הכול</h2>
          <p className="mb-3 text-sm text-muted">כשאספקה חזרה למפעל או לא נמסרה. כל אספקה שלא סומנה כנמסרה תסומן כחריגה עם הסיבה, וההזמנה שלה תחכה להחלטה.</p>
          <ActionForm action={closeRouteAction} submit="סגור את הקו" primary={false}>
            <input type="hidden" name="daily_route_id" value={id} />
            <label className="flex flex-col gap-1 text-sm text-muted">
              למה האספקות לא נמסרו
              <input name="reason" required minLength={3} className="w-72 max-w-full rounded-lg border border-line bg-surface px-3 py-2 text-foreground" />
            </label>
          </ActionForm>
        </section>
      ) : null}

      {loading && access.load ? (
        <section className={panel} id="depart">
          <h2 className="mb-2 font-display text-base font-bold">סיום טעינה</h2>
          {missing.length === 0 ? (
            <ActionForm action={departAction} submit="סיום טעינה ויציאה להפצה" pendingLabel="יוצא…">
              <input type="hidden" name="daily_route_id" value={id} />
              <span className="pb-2 text-sm text-muted">{total === 0 ? "אין אספקות בקו." : "כל האספקות הועמסו."}</span>
            </ActionForm>
          ) : (
            <>
              <p className="mb-2 font-medium" data-missing>
                חסרות {missing.length} אספקות שעוד לא הועמסו:
              </p>
              <ul className="mb-3 flex flex-col gap-1">
                {missing.map((m) => (
                  <li key={m.deliveryId}>
                    עצירה {m.stop} · {m.customer} · הזמנה {m.orderNumber}
                  </li>
                ))}
              </ul>
              {access.manage ? (
                <ActionForm action={departAction} submit="צא להפצה בלי האספקות החסרות" pendingLabel="יוצא…" primary={false}>
                  <input type="hidden" name="daily_route_id" value={id} />
                  <input type="hidden" name="with_missing" value="yes" />
                  <label className="flex flex-col gap-1 text-sm text-muted">
                    סיבה (נרשמת ביומן)
                    <input name="reason" required minLength={3} className="w-72 max-w-full rounded-lg border border-line bg-surface px-3 py-2 text-foreground" />
                  </label>
                </ActionForm>
              ) : (
                <p className="text-sm text-muted">אי אפשר לצאת להפצה עד שהכול הועמס. יציאה בלי אספקות חסרות דורשת אישור של מנהל השילוח.</p>
              )}
              <p className="mt-2 text-sm text-muted">אספקה שנשארת מאחור יורדת מהקו וחוזרת לרשימת ״אספקות שלא שובצו״.</p>
            </>
          )}
        </section>
      ) : null}
    </div>
  );
}
