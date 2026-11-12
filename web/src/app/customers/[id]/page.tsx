import Link from "next/link";
import { Suspense } from "react";
import { query } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { isSuspiciousPrice } from "@/lib/customers-core";
import { ActionForm } from "@/components/action-form";
import { Loading } from "@/components/loading";
import { NoAccess } from "@/components/no-access";
import { TaskForm, TaskList, Timeline, type ActivityRow, type TaskRow } from "@/components/crm-blocks";
import { addAddressAction, addContactAction, approveAllPricesAction, approvePriceAction, removePriceAction, setPriceAction } from "../actions";

type Customer = {
  id: string; name: string; tax_id: string | null; hash_account_key: string | null; hash_phone: string | null; hash_address: string | null;
  hash_city: string | null; last_document_date: string | null; fixed_discount_pct: string; vat_exempt: boolean; notes: string | null; today: string;
};
type PriceRow = { id: string; sku: string; product: string; price: string; base_price: string; valid_from: string; source: string; source_note: string | null; approved: boolean; current: boolean };

const money = new Intl.NumberFormat("he-IL", { style: "currency", currency: "ILS" });
const dateFmt = new Intl.DateTimeFormat("he-IL", { timeZone: "Asia/Jerusalem", day: "2-digit", month: "2-digit", year: "numeric" });
const d = (iso: string | null) => (iso ? dateFmt.format(new Date(iso)) : "");
const field = "rounded-lg border border-line bg-surface px-3 py-2 text-foreground";
const label = "flex flex-col gap-1 text-sm text-muted";
const panel = "rounded-xl border border-line bg-surface p-4";
const th = "px-2 py-1.5 text-start font-medium";
const small = "rounded-lg border border-line px-3 py-1 text-sm text-foreground";

export default function CustomerPage({ params }: PageProps<"/customers/[id]">) {
  return (
    <Suspense fallback={<Loading />}>
      <CustomerContent params={params} />
    </Suspense>
  );
}

async function CustomerContent({ params }: { params: PageProps<"/customers/[id]">["params"] }) {
  const { user, allowed } = await requirePermission("customers.view");
  if (!allowed) return <NoAccess />;
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return <NotFound />;

  const [c] = await query<Customer>(
    `select id::text, name, tax_id, hash_account_key, hash_phone, hash_address, hash_city, last_document_date::text,
            fixed_discount_pct::text, vat_exempt, notes, (now() at time zone 'Asia/Jerusalem')::date::text as today
     from customers where id = $1`,
    [id],
  );
  if (!c) return <NotFound />;

  const canEdit = can(user.role, "customers.edit");
  const showPrices = can(user.role, "prices.view");
  const canEditPrices = can(user.role, "prices.edit");

  const addresses = await query<{ id: string; label: string | null; street: string; city: string | null; delivery_area: string | null; is_default: boolean }>(
    "select id::text, label, street, city, delivery_area, is_default from customer_addresses where customer_id = $1 order by is_default desc, street",
    [id],
  );
  const contacts = await query<{ id: string; full_name: string; role_label: string | null; phone: string | null; email: string | null }>(
    "select id::text, full_name, role_label, phone, email from customer_contacts where customer_id = $1 order by full_name",
    [id],
  );
  const prices = showPrices
    ? await query<PriceRow>(
        `select p.id::text, p.sku, pr.name as product, p.price::text, pr.base_price::text, p.valid_from::text, p.source, p.source_note,
                p.approved_at is not null as approved,
                p.approved_at is not null and p.id = (
                  select p2.id from customer_prices p2
                  where p2.customer_id = p.customer_id and p2.sku = p.sku and p2.approved_at is not null and p2.valid_from <= $2::date
                    and (p2.valid_to is null or p2.valid_to >= $2::date)
                  order by p2.valid_from desc, p2.id desc limit 1) as current
         from customer_prices p join products pr on pr.sku = p.sku
         where p.customer_id = $1
         order by pr.name, p.valid_from desc`,
        [id, c.today],
      )
    : [];
  const products = canEditPrices
    ? await query<{ sku: string; name: string }>("select p.sku, p.name from products p join product_ops o on o.sku = p.sku where o.orderable order by p.name")
    : [];
  const canCrm = can(user.role, "leads.edit");
  const activities = can(user.role, "leads.view")
    ? await query<ActivityRow>(
        "select a.id::text, a.kind, a.body, a.created_at::text, u.full_name as who from activities a left join users u on u.id = a.user_id where a.customer_id = $1 order by a.created_at desc, a.id desc limit 100",
        [id],
      )
    : null;
  const tasks = activities
    ? await query<TaskRow>(
        `select t.id::text, t.title, t.due_date::text, false as done, t.due_date < $2::date as overdue, u.full_name as who
         from tasks t left join users u on u.id = t.owner_id where t.customer_id = $1 and t.done_at is null order by t.due_date`,
        [id, c.today],
      )
    : [];
  const [summary] = await query<{ quotes: number; open_quotes: number; orders: number; ordered: number }>(
    `select (select count(*)::int from quotes where customer_id = $1) as quotes,
            (select count(*)::int from quotes where customer_id = $1 and status in ('draft', 'sent', 'follow_up')) as open_quotes,
            (select count(*)::int from orders where customer_id = $1) as orders,
            coalesce((select sum(l.quantity * l.unit_price * (1 - l.discount_pct / 100)) from delivery_lines l join deliveries d on d.id = l.delivery_id join orders o on o.id = d.order_id where o.customer_id = $1), 0)::float as ordered`,
    [id],
  );
  const pending = prices.filter((p) => !p.approved);
  const approved = prices.filter((p) => p.approved);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-2xl font-bold">{c.name}</h1>
        <Link href="/customers" className="rounded-lg border border-line px-3 py-1.5 text-sm">
          חזרה לרשימת הלקוחות
        </Link>
      </div>

      <section className={panel}>
        <h2 className="mb-2 font-display text-base font-bold">פרטים מחשבשבת</h2>
        <dl className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3 text-sm">
          <Item k="ח.פ." v={c.tax_id} />
          <Item k="מפתח חשבון" v={c.hash_account_key} />
          <Item k="טלפון" v={c.hash_phone} ltr />
          <Item k="כתובת" v={[c.hash_address, c.hash_city].filter(Boolean).join(", ")} />
          <Item k="מסמך אחרון" v={d(c.last_document_date)} />
          <Item k="הנחה קבועה" v={Number(c.fixed_discount_pct) > 0 ? `${Number(c.fixed_discount_pct)}%` : "אין"} />
          <Item k="מע״מ" v={c.vat_exempt ? "פטור" : "חייב"} />
        </dl>
        <p className="mt-3 text-sm text-muted">הפרטים האלה מתעדכנים בכל סנכרון. שינוי שלהם נעשה בחשבשבת.</p>
      </section>

      <section className={panel}>
        <h2 className="mb-2 font-display text-base font-bold">כתובות אספקה</h2>
        {addresses.length === 0 ? (
          <p className="mb-3 text-muted">אין כתובת אספקה. בלי כתובת אי אפשר יהיה לפתוח ללקוח הזמנה עם משלוח.</p>
        ) : (
          <ul className="mb-3 flex flex-col gap-1.5">
            {addresses.map((a) => (
              <li key={a.id}>
                {a.street}
                {a.city ? `, ${a.city}` : ""}
                <span className="text-sm text-muted">
                  {a.label ? ` · ${a.label}` : ""}
                  {a.delivery_area ? ` · אזור ${a.delivery_area}` : ""}
                  {a.is_default ? " · ברירת מחדל" : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
        {canEdit ? (
          <ActionForm action={addAddressAction} submit="הוסף כתובת" primary={false}>
            <input type="hidden" name="customer_id" value={c.id} />
            <label className={label}>
              רחוב ומספר
              <input id="address-street" name="street" required className={field} />
            </label>
            <label className={label}>
              עיר
              <input id="address-city" name="city" className={field} />
            </label>
            <label className={label}>
              אזור חלוקה
              <input id="address-area" name="delivery_area" className={field} />
            </label>
            <label className={label}>
              תיאור (למשל: שער 3)
              <input id="address-label" name="label" className={field} />
            </label>
          </ActionForm>
        ) : null}
      </section>

      <section className={panel}>
        <h2 className="mb-2 font-display text-base font-bold">אנשי קשר</h2>
        {contacts.length === 0 ? (
          <p className="mb-3 text-muted">עוד לא הוזנו אנשי קשר.</p>
        ) : (
          <ul className="mb-3 flex flex-col gap-1.5">
            {contacts.map((p) => (
              <li key={p.id}>
                {p.full_name}
                <span className="text-sm text-muted">
                  {p.role_label ? ` · ${p.role_label}` : ""}
                  {p.phone ? (
                    <>
                      {" · "}
                      <span dir="ltr">{p.phone}</span>
                    </>
                  ) : null}
                  {p.email ? (
                    <>
                      {" · "}
                      <span dir="ltr">{p.email}</span>
                    </>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
        {canEdit ? (
          <ActionForm action={addContactAction} submit="הוסף איש קשר" primary={false}>
            <input type="hidden" name="customer_id" value={c.id} />
            <label className={label}>
              שם
              <input id="contact-name" name="full_name" required className={field} />
            </label>
            <label className={label}>
              תפקיד (מזמין, מקבל בשטח, הנהלת חשבונות)
              <input id="contact-role" name="role_label" className={field} />
            </label>
            <label className={label}>
              טלפון
              <input id="contact-phone" name="phone" type="tel" dir="ltr" className={field} />
            </label>
            <label className={label}>
              מייל
              <input id="contact-email" name="email" type="email" dir="ltr" className={field} />
            </label>
          </ActionForm>
        ) : null}
      </section>

      {activities ? (
        <section className={panel} id="customer-history">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-display text-base font-bold">היסטוריה ומעקב</h2>
            <div className="flex flex-wrap gap-2">
              {canCrm ? (
                <Link href={`/sales?customer=${c.id}`} className={small}>
                  פנייה חדשה
                </Link>
              ) : null}
              {can(user.role, "quotes.edit") ? (
                <Link href={`/quotes?customer=${c.id}`} className={small}>
                  הצעת מחיר חדשה
                </Link>
              ) : null}
            </div>
          </div>
          <p className="mb-3 text-sm text-muted" id="customer-summary">
            {summary.quotes} הצעות מחיר ({summary.open_quotes} פתוחות) · {summary.orders} הזמנות{showPrices && summary.ordered > 0 ? ` · ${money.format(summary.ordered)} בהזמנות, לפני מע״מ` : ""}
          </p>
          <div className="mb-3 flex flex-col gap-3">
            <TaskList rows={tasks} canEdit={canCrm} empty="אין משימות פתוחות ללקוח." />
            {canCrm ? <TaskForm target={{ customerId: c.id }} today={c.today} /> : null}
          </div>
          <Timeline rows={activities} target={{ customerId: c.id }} canEdit={canCrm} />
        </section>
      ) : null}

      {showPrices ? (
        <section className={panel}>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-display text-base font-bold">מחירים ממתינים לבדיקה · {pending.length}</h2>
            {canEditPrices && pending.length > 0 ? (
              <form action={approveAllPricesAction}>
                <input type="hidden" name="customer_id" value={c.id} />
                <button className="rounded-lg bg-accent px-4 py-2 font-medium text-surface">אשר את כל {pending.length} המחירים</button>
              </form>
            ) : null}
          </div>
          {pending.length === 0 ? (
            <p className="text-muted">אין מחירים שממתינים לבדיקה.</p>
          ) : (
            <>
              <p className="mb-2 text-sm text-muted">
                המחיר האחרון שהלקוח חויב בו בחשבשבת, לפני מע״מ. מחיר ממתין אינו משמש בהצעות ובהזמנות עד שמאשרים אותו.
              </p>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse tabular-nums">
                  <thead>
                    <tr className="border-b border-line text-xs text-muted">
                      <th className={th}>מק״ט</th>
                      <th className={th}>מוצר</th>
                      <th className="px-2 py-1.5 text-end font-medium">מחיר אחרון</th>
                      <th className="px-2 py-1.5 text-end font-medium">מחיר בסיס</th>
                      <th className={th}>מקור</th>
                      <th className="px-2 py-1.5" />
                    </tr>
                  </thead>
                  <tbody>
                    {pending.map((p) => {
                      const odd = isSuspiciousPrice(Number(p.price), Number(p.base_price));
                      return (
                        <tr key={p.id} className="border-b border-line last:border-0">
                          <td className="px-2 py-2">{p.sku}</td>
                          <td className="px-2 py-2">{p.product}</td>
                          <td className="px-2 py-2 text-end">
                            <b>{money.format(Number(p.price))}</b>
                            {odd ? <div className="text-sm font-medium">חריג, לבדוק</div> : null}
                          </td>
                          <td className="px-2 py-2 text-end text-muted">{Number(p.base_price) > 0 ? money.format(Number(p.base_price)) : "לא מוגדר"}</td>
                          <td className="px-2 py-2 text-sm text-muted">
                            {p.source_note} · {d(p.valid_from)}
                          </td>
                          <td className="px-2 py-2">
                            {canEditPrices ? (
                              <div className="flex justify-end gap-2">
                                <form action={approvePriceAction}>
                                  <input type="hidden" name="customer_id" value={c.id} />
                                  <input type="hidden" name="price_id" value={p.id} />
                                  <button className={small}>אשר</button>
                                </form>
                                <form action={removePriceAction}>
                                  <input type="hidden" name="customer_id" value={c.id} />
                                  <input type="hidden" name="price_id" value={p.id} />
                                  <button className={small}>הסר</button>
                                </form>
                              </div>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>
      ) : null}

      {showPrices ? (
        <section className={panel}>
          <h2 className="mb-2 font-display text-base font-bold">הסכם מחיר · {approved.filter((p) => p.current).length} מוצרים</h2>
          {approved.length === 0 ? (
            <p className="mb-3 text-muted">אין מחירים מאושרים. ללקוח הזה יחול מחיר הבסיס של כל מוצר.</p>
          ) : (
            <div className="mb-3 overflow-x-auto">
              <table className="w-full border-collapse tabular-nums">
                <thead>
                  <tr className="border-b border-line text-xs text-muted">
                    <th className={th}>מק״ט</th>
                    <th className={th}>מוצר</th>
                    <th className="px-2 py-1.5 text-end font-medium">מחיר לפני מע״מ</th>
                    <th className={th}>בתוקף מ-</th>
                    <th className={th}>מצב</th>
                    <th className="px-2 py-1.5" />
                  </tr>
                </thead>
                <tbody>
                  {approved.map((p) => (
                    <tr key={p.id} className={`border-b border-line last:border-0 ${p.current ? "" : "text-muted"}`}>
                      <td className="px-2 py-2">{p.sku}</td>
                      <td className="px-2 py-2">{p.product}</td>
                      <td className="px-2 py-2 text-end">{p.current ? <b>{money.format(Number(p.price))}</b> : money.format(Number(p.price))}</td>
                      <td className="px-2 py-2">{d(p.valid_from)}</td>
                      <td className="px-2 py-2 text-sm">{p.current ? "בתוקף" : p.valid_from > c.today ? "עתידי" : "היסטוריה"}</td>
                      <td className="px-2 py-2 text-end">
                        {canEditPrices ? (
                          <form action={removePriceAction}>
                            <input type="hidden" name="customer_id" value={c.id} />
                            <input type="hidden" name="price_id" value={p.id} />
                            <button className={small}>הסר</button>
                          </form>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {canEditPrices ? (
            <>
              <h3 className="mb-2 text-sm font-medium">קביעת מחיר למוצר</h3>
              <ActionForm action={setPriceAction} submit="שמור מחיר">
                <input type="hidden" name="customer_id" value={c.id} />
                <label className={label}>
                  מוצר
                  <select id="price-sku" name="sku" required className={field} defaultValue="">
                    <option value="">בחירה</option>
                    {products.map((p) => (
                      <option key={p.sku} value={p.sku}>
                        {p.name} · {p.sku}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={label}>
                  מחיר לפני מע״מ
                  <input id="price-value" name="price" inputMode="decimal" required dir="ltr" className={`${field} w-28 tabular-nums`} />
                </label>
                <label className={label}>
                  בתוקף מתאריך
                  <input id="price-from" name="valid_from" type="date" required defaultValue={c.today} className={field} />
                </label>
              </ActionForm>
              <p className="mt-2 text-sm text-muted">מחיר חדש אינו מוחק את הקודם: הקודם נשאר כהיסטוריה וחל עד תאריך התחילה של החדש.</p>
            </>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

function Item({ k, v, ltr }: { k: string; v: string | null | undefined; ltr?: boolean }) {
  return (
    <div>
      <dt className="text-muted">{k}</dt>
      <dd dir={ltr ? "ltr" : undefined} className={ltr ? "text-end" : undefined}>
        {v || "לא הוזן"}
      </dd>
    </div>
  );
}

function NotFound() {
  return (
    <div className="flex flex-col gap-2">
      <h1 className="font-display text-2xl font-bold">הלקוח לא נמצא</h1>
      <Link href="/customers" className="text-accent underline">
        חזרה לרשימת הלקוחות
      </Link>
    </div>
  );
}
