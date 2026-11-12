import Link from "next/link";
import { Suspense } from "react";
import QRCode from "qrcode";
import { query } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { formatScanCode, routeLabels, scanPayload } from "@/lib/loading-core";
import { Loading } from "@/components/loading";
import { NoAccess } from "@/components/no-access";
import { PrintButton } from "@/components/print-button";

const nf = new Intl.NumberFormat("he-IL", { maximumFractionDigits: 3 });
const dayFmt = new Intl.DateTimeFormat("he-IL", { timeZone: "UTC", weekday: "short", day: "2-digit", month: "2-digit" });
const small = "rounded-lg border border-line px-3 py-1.5 text-sm";

// The labels of one daily route: one for every delivery, with the QR that the loading and delivery screen scans.
export default function LabelsPage({ params }: PageProps<"/shipping/day/[id]/labels">) {
  return (
    <Suspense fallback={<Loading />}>
      <Labels params={params} />
    </Suspense>
  );
}

async function Labels({ params }: Pick<PageProps<"/shipping/day/[id]/labels">, "params">) {
  const { allowed } = await requirePermission("shipping.manage");
  if (!allowed) return <NoAccess />;
  const { id } = await params;
  const [route] = /^[0-9a-f-]{36}$/i.test(id)
    ? await query<{ name: string; route_date: string }>("select r.name, dr.route_date::text from daily_routes dr join routes r on r.id = dr.route_id where dr.id = $1", [id])
    : [];
  if (!route) {
    return (
      <div className="flex flex-col items-start gap-3">
        <h1 className="font-display text-2xl font-bold">הקו לא נמצא</h1>
        <Link href="/shipping" className={small}>
          חזרה למערך השילוח
        </Link>
      </div>
    );
  }
  const labels = await routeLabels(query, id);
  // The QR is drawn on the server as plain SVG, so printing needs nothing from the network.
  const codes = await Promise.all(labels.map((l) => QRCode.toString(scanPayload(l.code), { type: "svg", errorCorrectionLevel: "M", margin: 2 })));
  const date = dayFmt.format(new Date(route.route_date));

  return (
    <div className="flex flex-col gap-4">
      <div className="no-print flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-2xl font-bold">מדבקות · {route.name}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <PrintButton />
          <Link href={`/shipping/day/${id}`} className={small}>
            חזרה לפרטי הקו
          </Link>
        </div>
      </div>
      <p className="no-print text-sm text-muted" id="labels-summary">
        {labels.length} מדבקות, אחת לכל אספקה, בסדר הטעינה (העצירה האחרונה ראשונה). את ה-QR סורקים במסך ״טעינה והפצה״: בזמן הטעינה הוא מסמן שהאספקה הועמסה, ואחרי היציאה הוא מסמן שנמסרה.
      </p>
      {labels.length === 0 ? <p className="text-muted">אין אספקות בקו הזה.</p> : null}
      <ul className="label-sheet">
        {labels.map((l, i) => (
          <li key={l.deliveryId} className="label" data-label={l.orderNumber} data-code={l.code}>
            <div className="label-qr" dangerouslySetInnerHTML={{ __html: codes[i] }} />
            <div className="label-text">
              <div className="label-route">
                {route.name} · {date}
              </div>
              <div className="label-stop">עצירה {l.stop ?? "–"}</div>
              <div className="label-customer">{l.customer}</div>
              {l.address ? <div className="label-line">{l.address}</div> : null}
              <div className="label-line">
                הזמנה {l.orderNumber} · {nf.format(l.units)} יח׳{l.window ? ` · ${l.window}` : ""}
              </div>
              {l.notes ? <div className="label-line label-note">{l.notes}</div> : null}
              <div className="label-code" dir="ltr">
                {formatScanCode(l.code)}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
