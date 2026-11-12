import { ACTIVITY_KINDS, type ActivityKind } from "@/lib/crm-core";
import { ActionForm } from "@/components/action-form";
import { addActivityAction, addTaskAction, completeTaskAction } from "@/app/sales/actions";

export type ActivityRow = { id: string; kind: string; body: string; created_at: string; who: string | null };
export type TaskRow = { id: string; title: string; due_date: string; done: boolean; overdue: boolean; who: string | null; context?: string | null; lead_id?: string | null };

const field = "rounded-lg border border-line bg-surface px-3 py-2 text-foreground";
const label = "flex flex-col gap-1 text-sm text-muted";
const dateTime = new Intl.DateTimeFormat("he-IL", { timeZone: "Asia/Jerusalem", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
const dateOnly = new Intl.DateTimeFormat("he-IL", { timeZone: "Asia/Jerusalem", day: "2-digit", month: "2-digit", year: "numeric" });

/** The log of everything that happened with a customer or a lead, newest first, with a form to add an entry. */
export function Timeline({ rows, target, canEdit }: { rows: ActivityRow[]; target: { leadId?: string; customerId?: string }; canEdit: boolean }) {
  return (
    <div className="flex flex-col gap-3">
      {canEdit ? (
        <ActionForm action={addActivityAction} submit="רשום" primary={false}>
          {target.leadId ? <input type="hidden" name="lead_id" value={target.leadId} /> : null}
          {target.customerId ? <input type="hidden" name="customer_id" value={target.customerId} /> : null}
          <label className={label}>
            סוג
            <select id="activity-kind" name="kind" defaultValue="call" className={field}>
              {(Object.keys(ACTIVITY_KINDS) as ActivityKind[])
                .filter((k) => k !== "system")
                .map((k) => (
                  <option key={k} value={k}>
                    {ACTIVITY_KINDS[k]}
                  </option>
                ))}
            </select>
          </label>
          <label className={`${label} min-w-0 flex-1`}>
            מה היה
            <input id="activity-body" name="body" required className={field} />
          </label>
        </ActionForm>
      ) : null}
      {rows.length === 0 ? (
        <p className="text-muted">עוד לא נרשמה פעילות.</p>
      ) : (
        <ul className="flex flex-col gap-2" data-timeline>
          {rows.map((a) => (
            <li key={a.id} className="flex flex-wrap items-baseline gap-x-2">
              <span className="rounded-full bg-sunken px-2 py-0.5 text-xs">{ACTIVITY_KINDS[a.kind as ActivityKind] ?? a.kind}</span>
              <span>{a.body}</span>
              <span className="text-sm text-muted">
                {dateTime.format(new Date(a.created_at))}
                {a.who ? ` · ${a.who}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function TaskList({ rows, canEdit, empty }: { rows: TaskRow[]; canEdit: boolean; empty: string }) {
  if (rows.length === 0) return <p className="text-muted">{empty}</p>;
  return (
    <ul className="flex flex-col gap-2" data-tasks>
      {rows.map((t) => (
        <li key={t.id} className={`flex flex-wrap items-center gap-x-3 gap-y-1 ${t.done ? "text-muted line-through" : ""}`}>
          <span>{t.title}</span>
          {t.context ? <span className="text-sm text-muted">{t.context}</span> : null}
          <span className={`text-sm ${t.overdue && !t.done ? "font-medium" : "text-muted"}`}>
            {t.overdue && !t.done ? "באיחור · " : ""}
            {dateOnly.format(new Date(t.due_date))}
            {t.who ? ` · ${t.who}` : ""}
          </span>
          {canEdit && !t.done ? (
            <form action={completeTaskAction}>
              <input type="hidden" name="task_id" value={t.id} />
              <button className="rounded-lg border border-line px-3 py-1 text-sm text-foreground">בוצע</button>
            </form>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export function TaskForm({ target, today }: { target: { leadId?: string; customerId?: string }; today: string }) {
  return (
    <ActionForm action={addTaskAction} submit="הוסף משימה" primary={false}>
      {target.leadId ? <input type="hidden" name="lead_id" value={target.leadId} /> : null}
      {target.customerId ? <input type="hidden" name="customer_id" value={target.customerId} /> : null}
      <label className={`${label} min-w-0 flex-1`}>
        מה צריך לעשות
        <input id="task-title" name="title" required className={field} />
      </label>
      <label className={label}>
        עד תאריך
        <input id="task-due" name="due_date" type="date" required defaultValue={today} className={field} />
      </label>
    </ActionForm>
  );
}
