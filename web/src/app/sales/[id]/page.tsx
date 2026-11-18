import Link from "next/link";
import { Suspense } from "react";
import { query } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { LEAD_STAGE_LABEL, type LeadStage } from "@/lib/crm-core";
import { leadTone } from "@/lib/status-tone";
import { StatusPill } from "@/components/status-pill";
import { channelText, type ChannelKind } from "@/lib/comm-core";
import { ActionForm } from "@/components/action-form";
import { TaskForm, TaskList, Timeline, type ActivityRow, type TaskRow } from "@/components/crm-blocks";
import { Loading } from "@/components/loading";
import { NoAccess } from "@/components/no-access";
import { createQuoteAction } from "@/app/quotes/actions";
import { closeLeadAction, convertLeadAction, followUpAction } from "../actions";

const panel = "rounded-xl border border-line bg-surface p-4";
const field = "rounded-lg border border-line bg-surface px-3 py-2 text-foreground";
const REASONS = ["לא רלוונטי", "מחיר", "מועד האספקה", "בחרו בספק אחר", "לא חזרו אלינו", "אחר"];
const money = new Intl.NumberFormat("he-IL", { style: "currency", currency: "ILS" });

export default function LeadPage({ params }: PageProps<"/sales/[id]">) {
  return (
    <Suspense fallback={<Loading />}>
      <LeadContent params={params} />
    </Suspense>
  );
}

async function LeadContent({ params }: { params: PageProps<"/sales/[id]">["params"] }) {
  const { user, allowed } = await requirePermission("leads.view");
  if (!allowed) return <NoAccess />;
  const { id } = await params;
  const [lead] = /^[0-9a-f-]{36}$/i.test(id)
    ? await query<{ id: string; customer_id: string | null; display_name: string; contact_phone: string | null; source: string; summary: string; stage: LeadStage; quote_id: string | null; quote_number: number | null; quote_total: number | null; lost_reason: string | null; owner: string | null; today: string }>(
        `select b.id::text, b.customer_id::text, b.display_name, b.contact_phone, b.source, b.summary, b.stage, b.quote_id::text, b.quote_number, b.quote_total::float, b.lost_reason,
                u.full_name as owner, (now() at time zone 'Asia/Jerusalem')::date::text as today
         from lead_board b left join users u on u.id = b.owner_id where b.id = $1`,
        [id],
      )
    : [];
  const [channel] = lead ? await query<{ kind: ChannelKind; address: string; label: string | null }>("select c.kind, c.address, c.label from leads l join comm_channels c on c.id = l.channel_id where l.id = $1", [id]) : [];
  if (!lead) {
    return (
      <div className="flex flex-col gap-2">
        <h1 className="font-display text-2xl font-bold">הפנייה לא נמצאה</h1>
        <Link href="/sales" className="text-accent underline">
          חזרה למכירות
        </Link>
      </div>
    );
  }
  const canEdit = can(user.role, "leads.edit");
  const open = lead.stage !== "won" && lead.stage !== "lost";
  const activities = await query<ActivityRow>(
    "select a.id::text, a.kind, a.body, a.created_at::text, u.full_name as who from activities a left join users u on u.id = a.user_id where a.lead_id = $1 order by a.created_at desc, a.id desc limit 100",
    [id],
  );
  const tasks = await query<TaskRow>(
    `select t.id::text, t.title, t.due_date::text, t.done_at is not null as done, t.due_date < (now() at time zone 'Asia/Jerusalem')::date as overdue, u.full_name as who
     from tasks t left join users u on u.id = t.owner_id where t.lead_id = $1 order by t.done_at is not null, t.due_date`,
    [id],
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-2xl font-bold">{lead.display_name}</h1>
        <div className="flex items-center gap-2">
          <StatusPill id="lead-stage" tone={leadTone(lead.stage)} className="px-3 py-1">
            {LEAD_STAGE_LABEL[lead.stage]}
          </StatusPill>
          <Link href="/sales" className="rounded-lg border border-line px-3 py-1.5 text-sm">
            חזרה למכירות
          </Link>
        </div>
      </div>

      <section className={panel}>
        <p>{lead.summary}</p>
        <p className="mt-1 text-sm text-muted">
          מקור: {lead.source}
          {channel ? <span id="lead-channel-text"> · התקבל ב: {channelText(channel)}</span> : null}
          {lead.owner ? ` · אחראי: ${lead.owner}` : ""}
          {lead.contact_phone ? (
            <>
              {" · "}
              <span dir="ltr">{lead.contact_phone}</span>
            </>
          ) : null}
          {lead.lost_reason ? ` · סיבת הסגירה: ${lead.lost_reason}` : ""}
        </p>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          {lead.customer_id ? (
            <Link href={`/customers/${lead.customer_id}`} className="rounded-lg border border-line px-4 py-2">
              כרטיס הלקוח
            </Link>
          ) : null}
          {lead.quote_id ? (
            <Link id="lead-quote-link" href={`/quotes/${lead.quote_id}`} className="rounded-lg border border-line px-4 py-2">
              הצעה {lead.quote_number}
              {lead.quote_total ? ` · ${money.format(lead.quote_total)}` : ""}
            </Link>
          ) : null}
          {canEdit && open && !lead.customer_id ? (
            <ActionForm action={convertLeadAction} submit="פתח כרטיס לקוח מהפנייה" pendingLabel="פותח…">
              <input type="hidden" name="lead_id" value={id} />
            </ActionForm>
          ) : null}
          {can(user.role, "quotes.edit") && open && lead.customer_id && !lead.quote_id ? (
            <ActionForm action={createQuoteAction} submit="פתח הצעת מחיר" pendingLabel="פותח…">
              <input type="hidden" name="customer_id" value={lead.customer_id} />
              <input type="hidden" name="lead_id" value={id} />
            </ActionForm>
          ) : null}
          {canEdit && open && (lead.stage === "new" || lead.stage === "sent" || lead.stage === "follow_up") ? (
            <form action={followUpAction}>
              <input type="hidden" name="lead_id" value={id} />
              <input type="hidden" name="on" value={lead.stage === "follow_up" ? "false" : "true"} />
              <button className="rounded-lg border border-line px-4 py-2">{lead.stage === "follow_up" ? "הסר סימון מעקב" : "סמן במעקב"}</button>
            </form>
          ) : null}
        </div>
        {canEdit && open ? (
          <div className="mt-4 border-t border-line pt-3">
            <h2 className="mb-2 text-sm font-medium">הפנייה לא תתקדם</h2>
            <ActionForm action={closeLeadAction} submit="סגור פנייה" primary={false}>
              <input type="hidden" name="lead_id" value={id} />
              <label className="flex flex-col gap-1 text-sm text-muted">
                סיבה
                <select id="lead-close-reason" name="reason" required defaultValue="" className={field}>
                  <option value="">בחירה</option>
                  {REASONS.map((r) => (
                    <option key={r}>{r}</option>
                  ))}
                </select>
              </label>
            </ActionForm>
          </div>
        ) : null}
      </section>

      <section className={panel}>
        <h2 className="mb-2 font-display text-base font-bold">משימות מעקב</h2>
        <div className="flex flex-col gap-3">
          <TaskList rows={tasks} canEdit={canEdit} empty="אין משימות לפנייה הזו." />
          {canEdit && open ? <TaskForm target={{ leadId: id }} today={lead.today} /> : null}
        </div>
      </section>

      <section className={panel}>
        <h2 className="mb-2 font-display text-base font-bold">יומן פעילות</h2>
        <Timeline rows={activities} target={{ leadId: id }} canEdit={canEdit} />
      </section>
    </div>
  );
}
