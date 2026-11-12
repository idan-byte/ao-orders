import Link from "next/link";
import { Suspense } from "react";
import QRCode from "qrcode";
import { query } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { expandLabels, formatScanCode, routeLabels, scanPayload } from "@/lib/loading-core";
import { ActionForm } from "@/components/action-form";
import { Loading } from "@/components/loading";
import { NoAccess } from "@/components/no-access";
import { PrintButton } from "@/components/print-button";
import { packageCountAction } from "../../../actions";

const nf = new Intl.NumberFormat("he-IL", { maximumFractionDigits: 3 });
const dayFmt = new Intl.DateTimeFormat("he-IL", { timeZone: "UTC", weekday: "short", day: "2-digit", month: "2-digit" });
const small = "rounded-lg border border-line px-3 py-1.5 text-sm";
const tab = (active: boolean) => `rounded-full border px-3 py-1 text-sm ${active ? "border-accent bg-accent text-surface" : "border-line"}`;

// The labels of one daily route: one for every delivery, with the QR that the loading and delivery screen scans.
export default function LabelsPage({ params, searchParams }: PageProps<"/shipping/day/[id]/labels">) {
  return (
    <Suspense fallback={<Loading />}>
      <Labels params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function Labels({ params, searchParams }: Pick<PageProps<"/shipping/day/[id]/labels">, "params" | "searchParams">) {
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
  // Two ways to print: a sheet of A4 with two labels to a row, or one label to a page for a 102x150 mm label printer.
  const single = (await searchParams).format === "label";
  const deliveries = await routeLabels(query, id);
  const labels = expandLabels(deliveries);
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
      {single ? <style>{"@media print { @page { size: 102mm 150mm; margin: 0; } }"}</style> : null}
      <div className="no-print flex flex-wrap items-center gap-2" id="label-format">
        <span className="text-sm text-muted">גודל:</span>
        <Link href={`/shipping/day/${id}/labels`} aria-current={!single ? "page" : undefined} className={tab(!single)}>
          דף A4
        </Link>
        <Link href={`/shipping/day/${id}/labels?format=label`} aria-current={single ? "page" : undefined} className={tab(single)}>
          מדבקה 102×150 מ״מ
        </Link>
      </div>
      {deliveries.length > 0 ? (
        <section className="no-print rounded-xl border border-line bg-surface p-4" id="packages">
          <h2 className="font-display text-base font-bold">כמה אריזות בכל אספקה</h2>
          <p className="mb-3 mt-1 text-sm text-muted">לכל אריזה מודפסת מדבקה משלה. כל המדבקות של אספקה נושאות אותו קוד, וסריקה של אחת מהן מסמנת את כל האספקה.</p>
          <ul className="flex flex-col gap-2">
            {deliveries.map((l) => (
              <li key={l.deliveryId} data-packages={l.orderNumber} className="flex flex-wrap items-center justify-between gap-3">
                <span>
                  עצירה {l.stop ?? "–"} · {l.customer} · הזמנה {l.orderNumber}
                </span>
                <ActionForm action={packageCountAction} submit="שמור" primary={false} className="flex items-center gap-2">
                  <input type="hidden" name="delivery_id" value={l.deliveryId} />
                  <input name="packages" type="number" min={1} max={99} required defaultValue={l.packages} aria-label="מספר אריזות" className="w-20 rounded-lg border border-line bg-surface px-3 py-2 text-foreground" />
                </ActionForm>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <p className="no-print text-sm text-muted" id="labels-summary">
        {labels.length} מדבקות ל-{deliveries.length} אספקות, בסדר הטעינה (העצירה האחרונה ראשונה). את ה-QR סורקים במסך ״טעינה והפצה״: בזמן הטעינה הוא מסמן שהאספקה הועמסה, ואחרי היציאה הוא מסמן שנמסרה.
      </p>
      {labels.length === 0 ? <p className="text-muted">אין אספקות בקו הזה.</p> : null}
      <ul className={single ? "label-sheet label-single" : "label-sheet"}>
        {labels.map((l, i) => (
          <li key={`${l.deliveryId}-${l.index}`} className="label" data-label={l.orderNumber} data-code={l.code} data-package={l.index}>
            <div className="label-qr" dangerouslySetInnerHTML={{ __html: codes[i] }} />
            <div className="label-text">
              <div className="label-route">
                {route.name} · {date}
              </div>
              <div className="label-stop">עצירה {l.stop ?? "–"}</div>
              {l.packages > 1 ? (
                <div className="label-package">
                  אריזה {l.index} מתוך {l.packages}
                </div>
              ) : null}
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
