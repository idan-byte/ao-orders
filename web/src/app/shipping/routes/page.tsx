import Link from "next/link";
import { Suspense } from "react";
import { query } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { ActionForm } from "@/components/action-form";
import { Loading } from "@/components/loading";
import { NoAccess } from "@/components/no-access";
import { addressCommandAction, addressRouteAction, routeActiveAction, saveRouteAction } from "../actions";

const panel = "rounded-xl border border-line bg-surface p-4";
const field = "rounded-lg border border-line bg-surface px-3 py-2 text-foreground";
const label = "flex flex-col gap-1 text-sm text-muted";

export default function RoutesPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Routes />
    </Suspense>
  );
}

async function Routes() {
  const { allowed } = await requirePermission("shipping.manage");
  if (!allowed) return <NoAccess />;
  const routes = await query<{ id: number; name: string; description: string | null; default_driver_id: number | null; active: boolean }>("select id, name, description, default_driver_id, active from routes order by active desc, name");
  const drivers = await query<{ id: number; name: string }>("select id, name from drivers where active order by name");
  const stops = await query<{ id: string; route_id: number; route_order: number; customer: string; address: string }>(
    `select a.id::text, a.route_id, a.route_order, c.name as customer, concat_ws(', ', a.street, a.city) as address
     from customer_addresses a join customers c on c.id = a.customer_id where a.route_id is not null order by a.route_id, a.route_order`,
  );
  const free = await query<{ id: string; customer: string; address: string }>(
    `select a.id::text, c.name as customer, concat_ws(', ', a.street, a.city) as address
     from customer_addresses a join customers c on c.id = a.customer_id where a.route_id is null and c.active order by c.name, a.street`,
  );
  const driverSelect = (selected: number | null) => (
    <label className={label}>
      נהג קבוע
      <select name="driver_id" defaultValue={selected ?? ""} className={field}>
        <option value="">ללא</option>
        {drivers.map((d) => (
          <option key={d.id} value={d.id}>
            {d.name}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-2xl font-bold">ניהול קווים</h1>
        <div className="flex flex-wrap gap-2">
          <Link href="/shipping/drivers" className="rounded-lg border border-line px-3 py-1.5 text-sm">
            נהגים ורכבים
          </Link>
          <Link href="/shipping" className="rounded-lg border border-line px-3 py-1.5 text-sm">
            חזרה למערך השילוח
          </Link>
        </div>
      </div>
      <p className="rounded-lg bg-sunken px-3 py-2 text-sm">
        קו הוא מסלול חלוקה קבוע, ואינו תלוי בנהג של יום מסוים. לכל כתובת אספקה יש קו קבוע ומקום בסדר החלוקה. שינוי כאן חל על השיבוץ של הימים הבאים; ימים שכבר שובצו אינם משתנים.
        {free.length > 0 ? ` ${free.length} כתובות עדיין בלי קו.` : ""}
      </p>

      {routes.map((r) => {
        const list = stops.filter((s) => s.route_id === r.id);
        return (
          <section key={r.id} className={panel} data-route={r.name} data-active={String(r.active)}>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <h2 className="font-display text-base font-bold">
                {r.name}
                <span className="font-sans text-sm font-normal text-muted">
                  {" "}
                  · {list.length} כתובות{r.active ? "" : " · לא פעיל"}
                </span>
              </h2>
              <form action={routeActiveAction}>
                <input type="hidden" name="route_id" value={r.id} />
                <input type="hidden" name="active" value={String(!r.active)} />
                <button className="rounded-lg border border-line px-3 py-1.5 text-sm">{r.active ? "הפסק להשתמש בקו" : "החזר לשימוש"}</button>
              </form>
            </div>
            <ActionForm action={saveRouteAction} submit="שמור" primary={false}>
              <input type="hidden" name="route_id" value={r.id} />
              <label className={label}>
                שם הקו
                <input name="name" required defaultValue={r.name} className={field} />
              </label>
              {driverSelect(r.default_driver_id)}
              <label className={label}>
                הערה
                <input name="description" defaultValue={r.description ?? ""} className={`${field} w-72`} />
              </label>
            </ActionForm>

            <h3 className="mb-1.5 mt-4 text-sm font-medium">סדר החלוקה הקבוע</h3>
            {list.length === 0 ? (
              <p className="text-muted">עוד אין כתובות בקו.</p>
            ) : (
              <ol className="flex flex-col gap-1.5" data-route-stops>
                {list.map((s, i) => (
                  <li key={s.id} data-address={s.customer} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line px-3 py-1.5">
                    <span>
                      <b className="tabular-nums">{s.route_order}.</b> {s.customer} <span className="text-sm text-muted">· {s.address}</span>
                    </span>
                    <form action={addressCommandAction} className="flex gap-2">
                      <input type="hidden" name="address_id" value={s.id} />
                      <button name="command" value="up" disabled={i === 0} className="rounded-lg border border-line px-2.5 py-1 text-sm disabled:opacity-40">
                        הקדם
                      </button>
                      <button name="command" value="down" disabled={i === list.length - 1} className="rounded-lg border border-line px-2.5 py-1 text-sm disabled:opacity-40">
                        אחר
                      </button>
                      <button name="command" value="remove" className="rounded-lg border border-line px-2.5 py-1 text-sm">
                        הסר מהקו
                      </button>
                    </form>
                  </li>
                ))}
              </ol>
            )}
            {r.active && free.length > 0 ? (
              <div className="mt-3">
                <ActionForm action={addressRouteAction} submit="הוסף לקו" primary={false}>
                  <input type="hidden" name="route_id" value={r.id} />
                  <label className={label}>
                    הוספת כתובת (בסוף הסדר)
                    <select name="address_id" required defaultValue="" className={`${field} max-w-md`}>
                      <option value="">בחירת לקוח וכתובת</option>
                      {free.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.customer} · {a.address}
                        </option>
                      ))}
                    </select>
                  </label>
                </ActionForm>
              </div>
            ) : null}
          </section>
        );
      })}

      <section className={panel} id="new-route">
        <h2 className="mb-3 font-display text-base font-bold">קו חדש</h2>
        <ActionForm action={saveRouteAction} submit="הוסף קו">
          <label className={label}>
            שם הקו
            <input name="name" required placeholder="למשל: ירושלים 1" className={field} />
          </label>
          {driverSelect(null)}
          <label className={label}>
            הערה
            <input name="description" className={`${field} w-72`} />
          </label>
        </ActionForm>
      </section>
    </div>
  );
}
