import Link from "next/link";
import { Suspense } from "react";
import { query } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { ActionForm } from "@/components/action-form";
import { Loading } from "@/components/loading";
import { NoAccess } from "@/components/no-access";
import { syncAction } from "./actions";

type Row = { id: string; name: string; tax_id: string | null; hash_city: string | null; hash_phone: string | null; last_document_date: string | null; pending: number; agreed: number };

const PAGE_SIZE = 100;
const dateFmt = new Intl.DateTimeFormat("he-IL", { timeZone: "Asia/Jerusalem", day: "2-digit", month: "2-digit", year: "numeric" });

export default function CustomersPage({ searchParams }: PageProps<"/customers">) {
  return (
    <Suspense fallback={<Loading />}>
      <CustomersContent searchParams={searchParams} />
    </Suspense>
  );
}

async function CustomersContent({ searchParams }: { searchParams: PageProps<"/customers">["searchParams"] }) {
  const { user, allowed } = await requirePermission("customers.view");
  if (!allowed) return <NoAccess />;

  const sp = await searchParams;
  const q = (Array.isArray(sp.q) ? sp.q[0] : sp.q)?.trim() ?? "";
  const onlyPending = sp.pending === "1";
  const showPrices = can(user.role, "prices.view");

  const rows = await query<Row>(
    `select c.id::text, c.name, c.tax_id, c.hash_city, c.hash_phone, c.last_document_date::text,
            (select count(*)::int from customer_prices p where p.customer_id = c.id and p.approved_at is null) as pending,
            (select count(distinct p.sku)::int from customer_prices p where p.customer_id = c.id and p.approved_at is not null) as agreed
     from customers c
     where c.active
       and ($1 = '' or c.name ilike '%' || $1 || '%' or c.tax_id like $1 || '%' or c.hash_account_key = $1 or replace(coalesce(c.hash_phone, ''), '-', '') like '%' || replace($1, '-', '') || '%')
       and (not $2::boolean or exists (select 1 from customer_prices p where p.customer_id = c.id and p.approved_at is null))
     order by c.last_document_date desc nulls last, c.name
     limit ${PAGE_SIZE + 1}`,
    [q, onlyPending],
  );
  const [totals] = await query<{ customers: number; pending: number; last_sync: string | null }>(
    `select (select count(*)::int from customers where active) as customers,
            (select count(*)::int from customer_prices where approved_at is null) as pending,
            (select max(finished_at)::text from sync_runs where kind = 'customers' and error is null) as last_sync`,
  );
  const shown = rows.slice(0, PAGE_SIZE);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-2xl font-bold">לקוחות</h1>
        <span className="rounded-lg bg-sunken px-3 py-1.5 text-sm text-muted">
          {totals.customers.toLocaleString("he-IL")} לקוחות
          {showPrices ? ` · ${totals.pending.toLocaleString("he-IL")} מחירים ממתינים לבדיקה` : ""}
          {totals.last_sync ? ` · סנכרון אחרון ${dateFmt.format(new Date(totals.last_sync))}` : " · עוד לא בוצע סנכרון"}
        </span>
      </div>

      {can(user.role, "sync.run") ? (
        <section className="rounded-xl border border-line bg-surface p-4">
          <h2 className="mb-1 font-display text-base font-bold">סנכרון מחשבשבת</h2>
          <p className="mb-3 text-sm text-muted">
            קורא מחשבשבת מוצרים, לקוחות ומחיר אחרון לכל לקוח ומוצר. הקריאה היא לקריאה בלבד. נתונים שהוזנו כאן (כתובות אספקה, אנשי קשר, מחירים שאושרו) אינם נדרסים.
          </p>
          <ActionForm action={syncAction} submit="סנכרן עכשיו" pendingLabel="מסנכרן…" primary={false} />
        </section>
      ) : null}

      <section className="rounded-xl border border-line bg-surface p-4">
        <form className="mb-3 flex flex-wrap items-end gap-3" action="/customers">
          <label className="flex flex-col gap-1 text-sm text-muted">
            חיפוש לפי שם, ח.פ., טלפון או מפתח חשבון
            <input id="customer-search" name="q" defaultValue={q} className="rounded-lg border border-line bg-surface px-3 py-2 text-foreground" />
          </label>
          {showPrices ? (
            <label className="flex items-center gap-2 py-2 text-sm">
              <input id="customer-pending" type="checkbox" name="pending" value="1" defaultChecked={onlyPending} className="size-5" />
              רק לקוחות עם מחירים לבדיקה
            </label>
          ) : null}
          <button className="rounded-lg border border-line px-4 py-2">חפש</button>
        </form>
        {shown.length === 0 ? (
          <p className="text-muted">{totals.customers === 0 ? "אין עדיין לקוחות. סנכרון מחשבשבת יטען אותם." : "לא נמצאו לקוחות שמתאימים לחיפוש."}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse tabular-nums">
              <thead>
                <tr className="border-b border-line text-xs text-muted">
                  <th className="px-2 py-1.5 text-start font-medium">לקוח</th>
                  <th className="px-2 py-1.5 text-start font-medium">ח.פ.</th>
                  <th className="px-2 py-1.5 text-start font-medium">עיר</th>
                  <th className="px-2 py-1.5 text-start font-medium">טלפון</th>
                  <th className="px-2 py-1.5 text-start font-medium">מסמך אחרון</th>
                  {showPrices ? <th className="px-2 py-1.5 text-start font-medium">מחירי הסכם</th> : null}
                </tr>
              </thead>
              <tbody>
                {shown.map((c) => (
                  <tr key={c.id} className="border-b border-line last:border-0">
                    <td className="px-2 py-2">
                      <Link href={`/customers/${c.id}`} className="font-medium text-accent underline-offset-2 hover:underline">
                        {c.name}
                      </Link>
                    </td>
                    <td className="px-2 py-2">{c.tax_id ?? ""}</td>
                    <td className="px-2 py-2">{c.hash_city ?? ""}</td>
                    <td className="px-2 py-2" dir="ltr">
                      {c.hash_phone ?? ""}
                    </td>
                    <td className="px-2 py-2">{c.last_document_date ? dateFmt.format(new Date(c.last_document_date)) : ""}</td>
                    {showPrices ? (
                      <td className="px-2 py-2">
                        {c.agreed > 0 ? `${c.agreed} מאושרים` : ""}
                        {c.agreed > 0 && c.pending > 0 ? " · " : ""}
                        {c.pending > 0 ? <span className="rounded-full bg-sunken px-2 py-0.5 text-sm">{c.pending} לבדיקה</span> : null}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {rows.length > PAGE_SIZE ? <p className="mt-3 text-sm text-muted">מוצגים {PAGE_SIZE} הלקוחות הראשונים. חיפוש יצמצם את הרשימה.</p> : null}
      </section>
    </div>
  );
}
