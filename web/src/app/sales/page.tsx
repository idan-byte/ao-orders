import Link from "next/link";
import { Suspense } from "react";
import { query } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { LEAD_SOURCES, LEAD_STAGES, LEAD_STAGE_LABEL, type LeadStage } from "@/lib/crm-core";
import { ActionForm } from "@/components/action-form";
import { TaskList, type TaskRow } from "@/components/crm-blocks";
import { Loading } from "@/components/loading";
import { NoAccess } from "@/components/no-access";
import { createLeadAction } from "./actions";

type Lead = { id: string; display_name: string; summary: string; source: string; stage: LeadStage; quote_number: number | null; quote_total: number | null; lost_reason: string | null; owner: string | null; created_at: string };

const money = new Intl.NumberFormat("he-IL", { style: "currency", currency: "ILS" });
const field = "rounded-lg border border-line bg-surface px-3 py-2 text-foreground";
const label = "flex flex-col gap-1 text-sm text-muted";
const panel = "rounded-xl border border-line bg-surface p-4";

export default function SalesPage({ searchParams }: PageProps<"/sales">) {
  return (
    <Suspense fallback={<Loading />}>
      <SalesContent searchParams={searchParams} />
    </Suspense>
  );
}

async function SalesContent({ searchParams }: { searchParams: PageProps<"/sales">["searchParams"] }) {
  const { user, allowed } = await requirePermission("leads.view");
  if (!allowed) return <NoAccess />;
  const canEdit = can(user.role, "leads.edit");
  const sp = await searchParams;
  const preselect = typeof sp.customer === "string" ? sp.customer : "";

  // Closed leads stay on the board for 30 days, then drop off it. They remain in the customer's history.
  const leads = await query<Lead>(
    `select b.id::text, b.display_name, b.summary, b.source, b.stage, b.quote_number, b.quote_total::float, b.lost_reason, u.full_name as owner, b.created_at::text
     from lead_board b left join users u on u.id = b.owner_id
     where b.stage not in ('won', 'lost') or b.created_at > now() - interval '30 days'
     order by b.created_at desc limit 300`,
  );
  const tasks = await query<TaskRow>(
    `select t.id::text, t.title, t.due_date::text, false as done, t.due_date < (now() at time zone 'Asia/Jerusalem')::date as overdue, u.full_name as who,
            coalesce(c.name, l.contact_name) as context, t.lead_id::text
     from tasks t left join users u on u.id = t.owner_id left join customers c on c.id = t.customer_id left join leads l on l.id = t.lead_id
     where t.done_at is null and t.due_date <= (now() at time zone 'Asia/Jerusalem')::date
     order by t.due_date, t.id limit 50`,
  );
  const [meta] = await query<{ today: string }>("select (now() at time zone 'Asia/Jerusalem')::date::text as today");
  const customers = canEdit ? await query<{ id: string; name: string }>("select id::text, name from customers where active order by name") : [];

  return (
    <div className="flex flex-col gap-4">
      <h1 className="font-display text-2xl font-bold">מכירות</h1>

      <section className={panel}>
        <h2 className="mb-2 font-display text-base font-bold">מעקב להיום · {tasks.length}</h2>
        <TaskList rows={tasks} canEdit={canEdit} empty="אין משימות מעקב להיום." />
      </section>

      {canEdit ? (
        <section className={panel}>
          <h2 className="mb-3 font-display text-base font-bold">פנייה חדשה</h2>
          <ActionForm action={createLeadAction} submit="פתח פנייה" pendingLabel="פותח…">
            <label className={label}>
              לקוח קיים
              <select id="lead-customer" name="customer_id" defaultValue={preselect} className={`${field} max-w-56`}>
                <option value="">פונה חדש, לא לקוח</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label className={label}>
              שם הפונה (אם אינו לקוח)
              <input id="lead-name" name="contact_name" className={field} />
            </label>
            <label className={label}>
              טלפון
              <input id="lead-phone" name="contact_phone" type="tel" dir="ltr" className={`${field} w-36`} />
            </label>
            <label className={label}>
              מקור
              <select id="lead-source" name="source" required defaultValue="טלפון" className={field}>
                {LEAD_SOURCES.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
            <label className={`${label} min-w-0 flex-1`}>
              מה ביקשו
              <input id="lead-summary" name="summary" required className={field} />
            </label>
            <label className={label}>
              לחזור אליהם בתאריך
              <input id="lead-follow-up" name="follow_up" type="date" min={meta.today} className={field} />
            </label>
          </ActionForm>
        </section>
      ) : null}

      <div className="grid auto-cols-[minmax(220px,1fr)] grid-flow-col gap-3 overflow-x-auto pb-1" data-board>
        {LEAD_STAGES.map((stage) => {
          const col = leads.filter((l) => l.stage === stage);
          const sum = col.reduce((s, l) => s + (l.quote_total ?? 0), 0);
          return (
            <section key={stage} data-stage={stage} className="flex min-w-0 flex-col gap-2 rounded-xl bg-sunken p-2.5">
              <h2 className="flex justify-between gap-2 text-sm font-medium text-muted">
                <span>
                  {LEAD_STAGE_LABEL[stage]} · {col.length}
                </span>
                <span className="tabular-nums">{sum > 0 ? money.format(sum) : ""}</span>
              </h2>
              {col.map((l) => (
                <Link key={l.id} href={`/sales/${l.id}`} className="flex flex-col gap-1 rounded-lg border border-line bg-surface p-2.5 text-sm hover:border-accent">
                  <b>{l.display_name}</b>
                  <span>{l.summary}</span>
                  <span className="text-muted">
                    {l.source}
                    {l.owner ? ` · ${l.owner}` : ""}
                    {l.quote_number ? ` · הצעה ${l.quote_number}` : ""}
                    {l.quote_total ? ` · ${money.format(l.quote_total)}` : ""}
                    {l.lost_reason ? ` · ${l.lost_reason}` : ""}
                  </span>
                </Link>
              ))}
            </section>
          );
        })}
      </div>
      <p className="text-sm text-muted">השלב של פנייה נקבע לבד לפי ההצעה שלה: בהכנה, נשלחה, אושרה או נדחתה. פניות שנסגרו יורדות מהלוח אחרי 30 יום ונשארות בהיסטוריית הלקוח.</p>
    </div>
  );
}
