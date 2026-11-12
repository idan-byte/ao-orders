import Link from "next/link";
import { Suspense } from "react";
import { query } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { ActionForm } from "@/components/action-form";
import { Loading } from "@/components/loading";
import { NoAccess } from "@/components/no-access";
import { driverActiveAction, saveDriverAction } from "../actions";

const panel = "rounded-xl border border-line bg-surface p-4";
const field = "rounded-lg border border-line bg-surface px-3 py-2 text-foreground";
const label = "flex flex-col gap-1 text-sm text-muted";

export default function DriversPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Drivers />
    </Suspense>
  );
}

function Fields({ d }: { d?: { name: string; phone: string | null; registration: string | null; vehicle_description: string | null } }) {
  return (
    <>
      <label className={label}>
        שם הנהג
        <input name="name" required defaultValue={d?.name ?? ""} className={field} />
      </label>
      <label className={label}>
        טלפון
        <input name="phone" type="tel" dir="ltr" defaultValue={d?.phone ?? ""} className={`${field} w-40 tabular-nums`} />
      </label>
      <label className={label}>
        מספר רכב
        <input name="registration" dir="ltr" defaultValue={d?.registration ?? ""} placeholder="12-345-67" className={`${field} w-36 tabular-nums`} />
      </label>
      <label className={label}>
        תיאור הרכב
        <input name="vehicle_description" defaultValue={d?.vehicle_description ?? ""} placeholder="למשל: משאית קירור" className={field} />
      </label>
    </>
  );
}

async function Drivers() {
  const { allowed } = await requirePermission("shipping.manage");
  if (!allowed) return <NoAccess />;
  const drivers = await query<{ id: number; name: string; phone: string | null; registration: string | null; vehicle_description: string | null; active: boolean; routes: string | null }>(
    `select d.id, d.name, d.phone, v.registration, v.description as vehicle_description, d.active,
            (select string_agg(r.name, ', ' order by r.name) from routes r where r.default_driver_id = d.id and r.active) as routes
     from drivers d left join vehicles v on v.id = d.vehicle_id order by d.active desc, d.name`,
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-2xl font-bold">נהגים ורכבים</h1>
        <div className="flex flex-wrap gap-2">
          <Link href="/shipping/routes" className="rounded-lg border border-line px-3 py-1.5 text-sm">
            ניהול קווים
          </Link>
          <Link href="/shipping" className="rounded-lg border border-line px-3 py-1.5 text-sm">
            חזרה למערך השילוח
          </Link>
        </div>
      </div>
      <p className="rounded-lg bg-sunken px-3 py-2 text-sm">נהג והרכב שלו הם יחידת עבודה אחת: כשבוחרים נהג לקו, הרכב שלו מגיע איתו.</p>

      {drivers.map((d) => (
        <section key={d.id} className={panel} data-driver={d.name} data-active={String(d.active)}>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-display text-base font-bold">
              {d.name}
              <span className="font-sans text-sm font-normal text-muted">
                {d.routes ? ` · נהג קבוע של ${d.routes}` : ""}
                {d.active ? "" : " · לא פעיל"}
              </span>
            </h2>
            <form action={driverActiveAction}>
              <input type="hidden" name="driver_id" value={d.id} />
              <input type="hidden" name="active" value={String(!d.active)} />
              <button className="rounded-lg border border-line px-3 py-1.5 text-sm">{d.active ? "סמן כלא פעיל" : "החזר לפעילות"}</button>
            </form>
          </div>
          <ActionForm action={saveDriverAction} submit="שמור" primary={false}>
            <input type="hidden" name="driver_id" value={d.id} />
            <Fields d={d} />
          </ActionForm>
        </section>
      ))}

      <section className={panel} id="new-driver">
        <h2 className="mb-3 font-display text-base font-bold">נהג חדש</h2>
        <ActionForm action={saveDriverAction} submit="הוסף נהג">
          <Fields />
        </ActionForm>
      </section>
    </div>
  );
}
