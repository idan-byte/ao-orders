import Link from "next/link";
import { Suspense } from "react";
import { query } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { pendingForRoute, routeMap } from "@/lib/geo-core";
import { geocoderEnabled } from "@/lib/geo";
import { ActionForm } from "@/components/action-form";
import { Loading } from "@/components/loading";
import { NoAccess } from "@/components/no-access";
import { RouteMap } from "@/components/route-map";
import { clearLocationAction, locateAddressesAction, placeAddressAction } from "../../../actions";

const dayFmt = new Intl.DateTimeFormat("he-IL", { timeZone: "UTC", weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" });

export default function RouteMapPage({ params }: PageProps<"/shipping/day/[id]/map">) {
  return (
    <Suspense fallback={<Loading />}>
      <Content params={params} />
    </Suspense>
  );
}

async function Content({ params }: Pick<PageProps<"/shipping/day/[id]/map">, "params">) {
  const { allowed } = await requirePermission("shipping.manage");
  if (!allowed) return <NoAccess />;
  const { id } = await params;
  const [route] = /^[0-9a-f-]{36}$/i.test(id)
    ? await query<{ route_date: string; name: string; driver: string | null }>(
        "select dr.route_date::text, r.name, d.name as driver from daily_routes dr join routes r on r.id = dr.route_id left join drivers d on d.id = dr.driver_id where dr.id = $1",
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
  const stops = await routeMap(query, id);
  const waiting = (await pendingForRoute(query, id)).length;
  const onMap = stops.filter((s) => s.point).length;
  const searchOn = geocoderEnabled();

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-2xl font-bold">מפת הקו · {route.name}</h1>
        <Link href={`/shipping/day/${id}`} className="rounded-lg border border-line px-3 py-1.5 text-sm">
          חזרה לפרטי הקו
        </Link>
      </div>
      <p className="text-lg" id="map-summary">
        {dayFmt.format(new Date(route.route_date))} · {route.driver ?? "לא נבחר נהג"} · {stops.length} עצירות, {onMap} מהן על המפה
      </p>

      {stops.length === 0 ? (
        <section className="rounded-xl border border-line bg-surface p-4">
          <p className="text-muted">אין אספקות בקו הזה ביום הזה.</p>
        </section>
      ) : (
        <>
          {waiting > 0 ? (
            <section className="rounded-xl border border-line bg-surface p-4" id="locate">
              {searchOn ? (
                <ActionForm action={locateAddressesAction} submit={`אתר ${waiting} כתובות`} pendingLabel="מאתר… כשנייה לכל כתובת" primary={false}>
                  <input type="hidden" name="daily_route_id" value={id} />
                  <p className="min-w-0 flex-1 text-sm text-muted">
                    {waiting} כתובות בקו עוד לא אותרו. האיתור שולח לשירות של OpenStreetMap את הרחוב והעיר בלבד, בלי שם הלקוח. כתובת שלא תאותר אפשר למקם ידנית.
                  </p>
                </ActionForm>
              ) : (
                <p className="text-sm text-muted">{waiting} כתובות בקו עוד לא על המפה. איתור הכתובות כבוי בהגדרות השרת, ולכן ממקמים אותן ידנית.</p>
              )}
            </section>
          ) : null}
          <RouteMap stops={stops} placeAction={placeAddressAction} clearAction={clearLocationAction} />
        </>
      )}
    </div>
  );
}
