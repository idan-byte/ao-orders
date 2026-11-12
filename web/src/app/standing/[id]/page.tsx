import Link from "next/link";
import { Suspense } from "react";
import { query } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { addressesOf } from "@/lib/orders-data";
import { STATUS_LABEL } from "@/lib/orders-core";
import { WEEKDAYS } from "@/lib/standing-core";
import { ActionForm } from "@/components/action-form";
import { Loading } from "@/components/loading";
import { NoAccess } from "@/components/no-access";
import { StandingEditor, type StandingRow } from "@/components/standing-editor";
import { pauseAction, restoreDayAction, saveStandingAction, skipDayAction } from "../actions";

const panel = "rounded-xl border border-line bg-surface p-4";
const field = "rounded-lg border border-line bg-surface px-3 py-2 text-foreground";
const label = "flex flex-col gap-1 text-sm text-muted";
const dateFmt = new Intl.DateTimeFormat("he-IL", { timeZone: "UTC", weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" });
const d = (iso: string | null) => (iso ? dateFmt.format(new Date(iso)) : "");

export default function StandingOrderPage({ params }: PageProps<"/standing/[id]">) {
  return (
    <Suspense fallback={<Loading />}>
      <StandingOrder params={params} />
    </Suspense>
  );
}

async function StandingOrder({ params }: { params: PageProps<"/standing/[id]">["params"] }) {
  const { user, allowed } = await requirePermission("orders.view");
  if (!allowed) return <NoAccess />;
  const { id } = await params;
  const [so] = /^[0-9a-f-]{36}$/i.test(id)
    ? await query<{ id: string; customer_id: string; customer: string; address_id: string | null; window_from: string | null; window_to: string | null; valid_from: string; valid_to: string | null; paused_until: string | null; notes: string | null; shipping_notes: string | null; today: string; paused: boolean }>(
        `select s.id::text, s.customer_id::text, c.name as customer, s.address_id::text, to_char(s.window_from, 'HH24:MI') as window_from, to_char(s.window_to, 'HH24:MI') as window_to,
                s.valid_from::text, s.valid_to::text, s.paused_until::text, s.notes, s.shipping_notes, (now() at time zone 'Asia/Jerusalem')::date::text as today,
                coalesce(s.paused_until >= (now() at time zone 'Asia/Jerusalem')::date, false) as paused
         from standing_orders s join customers c on c.id = s.customer_id where s.id = $1`,
        [id],
      )
    : [];
  if (!so) {
    return (
      <div className="flex flex-col items-start gap-3">
        <h1 className="font-display text-2xl font-bold">ההזמנה הקבועה לא נמצאה</h1>
        <Link href="/standing" className="rounded-lg border border-line px-3 py-1.5 text-sm">
          חזרה להזמנות הקבועות
        </Link>
      </div>
    );
  }
  const mayEdit = can(user.role, "orders.edit");
  const lines = await query<{ weekday: number; sku: string; name: string; quantity: number }>("select l.weekday, l.sku, p.name, l.quantity::float from standing_order_lines l join products p on p.sku = l.sku where l.standing_order_id = $1 order by l.id", [id]);
  const skipped = await query<{ day: string; reason: string | null }>("select day::text, reason from standing_order_days where standing_order_id = $1 and skipped and day >= $2::date order by day", [id, so.today]);
  const generated = await query<{ day: string; order_id: string; number: number; status: string }>(
    `select sd.day::text, o.id::text as order_id, o.number, st.status
     from standing_order_days sd join orders o on o.id = sd.generated_order_id join order_status st on st.order_id = o.id
     where sd.standing_order_id = $1 order by sd.day desc limit 14`,
    [id],
  );

  const bySku = new Map<string, StandingRow>();
  for (const l of lines) {
    const row = bySku.get(l.sku) ?? { key: l.sku, sku: l.sku, qty: ["", "", "", "", "", ""] };
    if (l.weekday < 6) row.qty[l.weekday] = String(l.quantity);
    bySku.set(l.sku, row);
  }
  const products = mayEdit ? await query<{ sku: string; name: string }>("select p.sku, p.name from products p join product_ops o on o.sku = p.sku where o.orderable or p.sku in (select sku from standing_order_lines where standing_order_id = $1) order by p.name", [id]) : [];
  const addresses = mayEdit ? await addressesOf(so.customer_id) : [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-2xl font-bold">הזמנה קבועה · {so.customer}</h1>
        <div className="flex items-center gap-2">
          <span id="standing-state" className="rounded-full bg-sunken px-3 py-1 text-sm">
            {so.valid_to && so.valid_to < so.today ? "הסתיימה" : so.paused ? `מושהית עד ${d(so.paused_until)}` : "פעילה"}
          </span>
          <Link href="/standing" className="rounded-lg border border-line px-3 py-1.5 text-sm">
            חזרה להזמנות הקבועות
          </Link>
        </div>
      </div>

      {mayEdit ? (
        <StandingEditor
          key={id}
          action={saveStandingAction}
          products={products}
          addresses={addresses}
          initial={{ standingId: id, customerId: so.customer_id, rows: [...bySku.values()], addressId: so.address_id ?? "", windowFrom: so.window_from ?? "", windowTo: so.window_to ?? "", validFrom: so.valid_from, validTo: so.valid_to ?? "", productionNotes: so.notes ?? "", shippingNotes: so.shipping_notes ?? "" }}
        />
      ) : (
        <section className={panel}>
          <ul className="flex flex-col gap-1">
            {lines.map((l, i) => (
              <li key={i}>
                יום {WEEKDAYS[l.weekday]} · {l.name} · {l.quantity.toLocaleString("he-IL")}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className={panel}>
        <h2 className="mb-1 font-display text-base font-bold">דילוג על יום בודד</h2>
        <p className="mb-3 text-sm text-muted">יום שהלקוח לא מקבל בו אספקה (טיול, יום עיון). התבנית השבועית אינה משתנה.</p>
        {skipped.length > 0 ? (
          <ul className="mb-3 flex flex-col gap-1.5" data-skipped>
            {skipped.map((s) => (
              <li key={s.day} className="flex flex-wrap items-center gap-3">
                <span>
                  {d(s.day)}
                  {s.reason ? ` · ${s.reason}` : ""}
                </span>
                {mayEdit ? (
                  <form action={restoreDayAction}>
                    <input type="hidden" name="standing_id" value={id} />
                    <input type="hidden" name="day" value={s.day} />
                    <button className="rounded-lg border border-line px-3 py-1 text-sm">בטל דילוג</button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        {mayEdit ? (
          <ActionForm action={skipDayAction} submit="דלג על היום" primary={false}>
            <input type="hidden" name="standing_id" value={id} />
            <label className={label}>
              תאריך
              <input id="skip-day" name="day" type="date" required min={so.today} className={field} />
            </label>
            <label className={label}>
              סיבה
              <input id="skip-reason" name="reason" placeholder="למשל: טיול שנתי" className={field} />
            </label>
          </ActionForm>
        ) : null}
      </section>

      {mayEdit ? (
        <section className={panel}>
          <h2 className="mb-1 font-display text-base font-bold">השהיה</h2>
          <p className="mb-3 text-sm text-muted">לחופשה ארוכה: לא ייווצרו הזמנות עד התאריך שנבחר, כולל אותו יום.</p>
          <div className="flex flex-wrap items-end gap-3">
            <ActionForm action={pauseAction} submit="השהה" primary={false}>
              <input type="hidden" name="standing_id" value={id} />
              <label className={label}>
                להשהות עד תאריך
                <input id="pause-until" name="until" type="date" required min={so.today} defaultValue={so.paused ? (so.paused_until ?? "") : ""} className={field} />
              </label>
            </ActionForm>
            {so.paused ? (
              <ActionForm action={pauseAction} submit="בטל השהיה" primary={false}>
                <input type="hidden" name="standing_id" value={id} />
                <input type="hidden" name="until" value="" />
              </ActionForm>
            ) : null}
          </div>
        </section>
      ) : null}

      <section className={panel}>
        <h2 className="mb-2 font-display text-base font-bold">הזמנות שנוצרו</h2>
        {generated.length === 0 ? (
          <p className="text-muted">עוד לא נוצרו הזמנות מההזמנה הקבועה הזו.</p>
        ) : (
          <ul className="flex flex-col gap-1.5" data-generated>
            {generated.map((g) => (
              <li key={g.day}>
                {d(g.day)} ·{" "}
                <Link href={`/orders/${g.order_id}`} className="text-accent underline-offset-2 hover:underline">
                  הזמנה {g.number}
                </Link>{" "}
                · {STATUS_LABEL[g.status] ?? g.status}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
