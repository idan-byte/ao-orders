import Link from "next/link";
import { Suspense } from "react";
import { query } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { QUOTE_STATUS } from "@/lib/quotes-data";
import { ActionForm } from "@/components/action-form";
import { Loading } from "@/components/loading";
import { NoAccess } from "@/components/no-access";
import { createQuoteAction } from "./actions";

type Row = { id: string; number: number; status: string; customer: string; version: number; total: number; valid_until: string | null; expired: boolean; owner: string | null; created_at: string };

const money = new Intl.NumberFormat("he-IL", { style: "currency", currency: "ILS" });
const dateFmt = new Intl.DateTimeFormat("he-IL", { timeZone: "Asia/Jerusalem", day: "2-digit", month: "2-digit", year: "numeric" });
const d = (iso: string | null) => (iso ? dateFmt.format(new Date(iso)) : "");
const FILTERS = ["all", "draft", "sent", "approved", "rejected"] as const;

export default function QuotesPage({ searchParams }: PageProps<"/quotes">) {
  return (
    <Suspense fallback={<Loading />}>
      <QuotesContent searchParams={searchParams} />
    </Suspense>
  );
}

async function QuotesContent({ searchParams }: { searchParams: PageProps<"/quotes">["searchParams"] }) {
  const { user, allowed } = await requirePermission("quotes.view");
  if (!allowed) return <NoAccess />;
  const sp = await searchParams;
  const status = FILTERS.includes(sp.status as (typeof FILTERS)[number]) ? (sp.status as string) : "all";
  const preselect = typeof sp.customer === "string" ? sp.customer : "";

  const rows = await query<Row>(
    `select qt.id::text, qt.number, qt.status::text, c.name as customer, v.version, v.total::float, qt.valid_until::text,
            qt.status in ('sent', 'follow_up') and coalesce(qt.valid_until < (now() at time zone 'Asia/Jerusalem')::date, false) as expired,
            u.full_name as owner, qt.created_at::text
     from quotes qt
     join customers c on c.id = qt.customer_id
     join quote_versions v on v.quote_id = qt.id and v.version = (select max(version) from quote_versions where quote_id = qt.id)
     left join users u on u.id = qt.owner_id
     where ($1 = 'all' or qt.status::text = $1)
     order by qt.created_at desc limit 200`,
    [status],
  );
  const customers = can(user.role, "quotes.edit") ? await query<{ id: string; name: string }>("select id::text, name from customers where active order by name") : [];

  return (
    <div className="flex flex-col gap-4">
      <h1 className="font-display text-2xl font-bold">הצעות מחיר</h1>

      {can(user.role, "quotes.edit") ? (
        <section className="rounded-xl border border-line bg-surface p-4">
          <h2 className="mb-3 font-display text-base font-bold">הצעה חדשה</h2>
          {customers.length === 0 ? (
            <p className="text-muted">אין עדיין לקוחות. סנכרון מחשבשבת במסך הלקוחות יטען אותם.</p>
          ) : (
            <ActionForm action={createQuoteAction} submit="פתח הצעה" pendingLabel="פותח…">
              <label className="flex flex-col gap-1 text-sm text-muted">
                לקוח
                <select id="new-quote-customer" name="customer_id" required defaultValue={preselect} className="max-w-xs rounded-lg border border-line bg-surface px-3 py-2 text-foreground">
                  <option value="">בחירה</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
            </ActionForm>
          )}
        </section>
      ) : null}

      <section className="rounded-xl border border-line bg-surface p-4">
        <div className="mb-3 flex flex-wrap gap-2">
          {FILTERS.map((f) => (
            <Link
              key={f}
              href={f === "all" ? "/quotes" : `/quotes?status=${f}`}
              aria-current={status === f ? "page" : undefined}
              className={`rounded-full border px-3 py-1 text-sm ${status === f ? "border-accent bg-accent text-surface" : "border-line"}`}
            >
              {f === "all" ? "הכול" : QUOTE_STATUS[f]}
            </Link>
          ))}
        </div>
        {rows.length === 0 ? (
          <p className="text-muted">אין הצעות להצגה.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse tabular-nums">
              <thead>
                <tr className="border-b border-line text-xs text-muted">
                  <th className="px-2 py-1.5 text-start font-medium">מס׳</th>
                  <th className="px-2 py-1.5 text-start font-medium">לקוח</th>
                  <th className="px-2 py-1.5 text-start font-medium">מצב</th>
                  <th className="px-2 py-1.5 text-start font-medium">גרסה</th>
                  <th className="px-2 py-1.5 text-end font-medium">לתשלום</th>
                  <th className="px-2 py-1.5 text-start font-medium">בתוקף עד</th>
                  <th className="px-2 py-1.5 text-start font-medium">אחראי</th>
                  <th className="px-2 py-1.5 text-start font-medium">נפתחה</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-line last:border-0">
                    <td className="px-2 py-2">
                      <Link href={`/quotes/${r.id}`} className="font-medium text-accent underline-offset-2 hover:underline">
                        {r.number}
                      </Link>
                    </td>
                    <td className="px-2 py-2">{r.customer}</td>
                    <td className="px-2 py-2">
                      <span className="rounded-full bg-sunken px-2.5 py-0.5 text-sm">{r.expired ? "נשלחה, פג תוקף" : (QUOTE_STATUS[r.status] ?? r.status)}</span>
                    </td>
                    <td className="px-2 py-2">{r.version}</td>
                    <td className="px-2 py-2 text-end">{money.format(r.total)}</td>
                    <td className="px-2 py-2">{d(r.valid_until)}</td>
                    <td className="px-2 py-2">{r.owner ?? ""}</td>
                    <td className="px-2 py-2">{d(r.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
