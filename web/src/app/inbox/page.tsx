import Link from "next/link";
import { Suspense } from "react";
import { query } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { inboundCounts, KIND_LABEL, listInbound } from "@/lib/inbound-core";
import { intakeStatus } from "@/lib/inbound";
import { ActionForm } from "@/components/action-form";
import { LiveRefresh } from "@/components/live-refresh";
import { Loading } from "@/components/loading";
import { NoAccess } from "@/components/no-access";
import { checkNowAction } from "./actions";

const panel = "rounded-xl border border-line bg-surface p-4";
const small = "rounded-lg border border-line px-3 py-1.5 text-sm";
const stamp = new Intl.DateTimeFormat("he-IL", { timeZone: "Asia/Jerusalem", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const TABS = [
  { key: "new", label: "ממתינות לאישור" },
  { key: "approved", label: "אושרו" },
  { key: "dismissed", label: "נדחו" },
] as const;

// Incoming mail: the recommendations the AI made from requests for a quote and from orders, waiting for a person.
export default function InboxPage({ searchParams }: PageProps<"/inbox">) {
  return (
    <>
      <LiveRefresh />
      <Suspense fallback={<Loading />}>
        <Inbox searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function Inbox({ searchParams }: Pick<PageProps<"/inbox">, "searchParams">) {
  const { allowed } = await requirePermission("leads.view");
  if (!allowed) return <NoAccess />;
  const wanted = (await searchParams).tab;
  const tab = TABS.find((t) => t.key === wanted)?.key ?? "new";
  const rows = await listInbound(query, tab);
  const counts = await inboundCounts(query);
  const status = await intakeStatus();

  return (
    <div className="flex flex-col gap-4">
      <h1 className="font-display text-2xl font-bold">דואר נכנס</h1>
      <p className="text-muted" id="inbox-summary">
        {counts.waiting} המלצות ממתינות לאישור · {counts.other} הודעות סוננו כלא רלוונטיות
      </p>

      <section className={panel} id="inbox-status" data-mail={String(status.mail)} data-ai={String(status.ai)}>
        {status.mail && status.ai ? (
          <p>
            התיבה <span dir="ltr">{status.mailbox}</span> נקראת אוטומטית.
            {status.state?.checkedAt ? ` בדיקה אחרונה: ${stamp.format(new Date(status.state.checkedAt))}.` : " עוד לא נבדקה."}
          </p>
        ) : (
          <p className="font-bold">
            הקליטה האוטומטית כבויה: {[status.mail ? null : "קריאת התיבה לא הופעלה", status.ai ? null : "הסינון ב-AI לא הופעל"].filter(Boolean).join(", ")}. שום מייל לא נקרא ושום תוכן לא נשלח החוצה עד ששניהם מופעלים.
          </p>
        )}
        {status.state?.lastError ? (
          <p className="mt-1 font-bold" id="inbox-error">
            הבדיקה האחרונה נכשלה: <span dir="ltr">{status.state.lastError}</span>
          </p>
        ) : null}
        <p className="mb-2 mt-1 text-sm text-muted">התיבה נקראת בלבד: שום הודעה לא מסומנת כנקראה, לא מועברת ולא נמחקת. מכל הודעה שהיא בקשה להצעת מחיר או הזמנה נוצרת המלצה, והיא הופכת למסמך רק אחרי אישור שלך. הודעה אחרת נרשמת בלי התוכן שלה.</p>
        <ActionForm action={checkNowAction} submit="בדוק דואר עכשיו" pendingLabel="בודק…" primary={false} />
      </section>

      <div className="flex flex-wrap gap-2" id="inbox-tabs">
        {TABS.map((t) => (
          <Link key={t.key} href={`/inbox?tab=${t.key}`} aria-current={t.key === tab ? "page" : undefined} className={`${small} ${t.key === tab ? "bg-sunken font-bold" : ""}`}>
            {t.label}
          </Link>
        ))}
      </div>

      <section className={panel} id="inbox-list">
        {rows.length === 0 ? (
          <p className="text-muted">{tab === "new" ? "אין המלצות שממתינות לאישור." : "אין הודעות ברשימה הזאת."}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {rows.map((r) => (
              <li key={r.id} data-inbound={r.subject} data-kind={r.kind} className="border-b border-line pb-3 last:border-0 last:pb-0">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <Link href={`/inbox/${r.id}`} className="font-medium underline">
                    {r.subject || "(בלי נושא)"}
                  </Link>
                  <span className="text-sm text-muted">{stamp.format(new Date(r.receivedAt))}</span>
                </div>
                <p className="text-sm">
                  <b>{KIND_LABEL[r.kind]}</b> · {r.customer ?? "שולח שאינו מזוהה כלקוח"} · <span dir="ltr">{r.fromEmail}</span> · {r.lines} שורות
                  {r.quoteNumber ? ` · הצעה ${r.quoteNumber}` : ""}
                  {r.orderNumber ? ` · הזמנה ${r.orderNumber}` : ""}
                </p>
                {r.summary ? <p className="text-sm text-muted">{r.summary}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
