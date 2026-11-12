import Link from "next/link";
import { Suspense } from "react";
import { query } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { ALERT_TYPE, recentlyHandled, shippingAlerts, type Severity } from "@/lib/alerts-core";
import { ActionForm } from "@/components/action-form";
import { LiveRefresh } from "@/components/live-refresh";
import { Loading } from "@/components/loading";
import { NoAccess } from "@/components/no-access";
import { resolveAlertAction } from "../actions";

const panel = "rounded-xl border border-line bg-surface p-4";
const dayFmt = new Intl.DateTimeFormat("he-IL", { timeZone: "UTC", weekday: "short", day: "2-digit", month: "2-digit" });
const stamp = new Intl.DateTimeFormat("he-IL", { timeZone: "Asia/Jerusalem", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
// Urgency is said in words and shown by the border; colour is never the only signal.
const SEVERITY: Record<Severity, { label: string; border: string }> = {
  high: { label: "דחוף", border: "border-2 border-foreground" },
  medium: { label: "לטיפול", border: "border border-line" },
  low: { label: "לידיעה", border: "border border-line" },
};

export default function AlertsPage() {
  return (
    <>
      <LiveRefresh />
      <Suspense fallback={<Loading />}>
        <Alerts />
      </Suspense>
    </>
  );
}

async function Alerts() {
  const { allowed } = await requirePermission("shipping.manage");
  if (!allowed) return <NoAccess />;
  const [{ today }] = await query<{ today: string }>("select (now() at time zone 'Asia/Jerusalem')::date::text as today");
  const alerts = await shippingAlerts(query, today);
  const handled = await recentlyHandled(query);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-2xl font-bold">התראות וחריגים</h1>
        <Link href="/shipping" className="rounded-lg border border-line px-3 py-1.5 text-sm">
          חזרה למערך השילוח
        </Link>
      </div>
      <p className="rounded-lg bg-sunken px-3 py-2 text-sm" id="alerts-summary">
        {alerts.length === 0 ? "אין התראות פתוחות." : alerts.length === 1 ? `התראה אחת פתוחה${alerts[0].severity === "high" ? ", דחופה" : ""}.` : `${alerts.length} התראות פתוחות, ${alerts.filter((a) => a.severity === "high").length} מהן דחופות.`} התראה על מצב (אספקה בלי קו, קו בלי נהג) נסגרת מעצמה כשהמצב מתוקן. התראה על משהו שקרה נשארת עד שמסמנים שטופלה.
      </p>

      {alerts.length > 0 ? (
        <ul className="flex flex-col gap-2" data-alerts>
          {alerts.map((a) => (
            <li key={a.key} data-alert={a.type} data-severity={a.severity} className={`rounded-xl bg-surface p-4 ${SEVERITY[a.severity].border}`}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm text-muted">
                    <b className="text-foreground">{SEVERITY[a.severity].label}</b> · {ALERT_TYPE[a.type]}
                    {a.date ? ` · אספקה ${dayFmt.format(new Date(a.date))}` : ""}
                    {a.at ? ` · ${stamp.format(new Date(a.at))}` : ""}
                  </div>
                  <div className="text-lg font-medium">{a.title}</div>
                  {a.detail ? <div className="text-muted">{a.detail}</div> : null}
                </div>
                {a.link ? (
                  <Link href={a.link} className="rounded-lg border border-line px-3 py-1.5 text-sm">
                    פתח
                  </Link>
                ) : null}
              </div>
              {a.eventId !== null ? (
                <div className="mt-3 border-t border-line pt-3">
                  <ActionForm action={resolveAlertAction} submit="סמן שטופל" primary={false}>
                    <input type="hidden" name="event_id" value={a.eventId} />
                    <label className="flex flex-col gap-1 text-sm text-muted">
                      מה נעשה (לא חובה)
                      <input name="note" maxLength={300} className="w-80 max-w-full rounded-lg border border-line bg-surface px-3 py-2 text-foreground" />
                    </label>
                  </ActionForm>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {handled.length > 0 ? (
        <section className={panel}>
          <h2 className="mb-2 font-display text-base font-bold">טופלו לאחרונה</h2>
          <ul className="flex flex-col gap-1.5 text-sm" data-handled>
            {handled.map((h) => (
              <li key={h.id}>
                {h.title} · טופל {stamp.format(new Date(h.resolvedAt))}
                {h.resolvedBy ? ` · ${h.resolvedBy}` : ""}
                {h.resolution ? <b> · {h.resolution}</b> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
