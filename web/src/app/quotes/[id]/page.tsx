import Link from "next/link";
import { Suspense } from "react";
import { query } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { loadQuoteDoc, QUOTE_STATUS } from "@/lib/quotes-data";
import { quoteTone } from "@/lib/status-tone";
import { StatusPill } from "@/components/status-pill";
import { ActionForm } from "@/components/action-form";
import { CopyLink } from "@/components/copy-link";
import { Loading } from "@/components/loading";
import { NoAccess } from "@/components/no-access";
import { QuoteDocument } from "@/components/quote-document";
import { variantsBySku } from "@/lib/orders-data";
import { LinesEditor, type EditorInitial, type EditorProduct } from "@/components/lines-editor";
import { approveManualAction, rejectQuoteAction, saveQuoteAction } from "../actions";
import { emailQuoteAction } from "../email-action";
import { setQuoteLetterheadAction } from "@/app/letterheads/actions";
import { emailsOf } from "@/lib/mail-core";
import { mailConfigured } from "@/lib/mail";

const panel = "rounded-xl border border-line bg-surface p-4";
const field = "rounded-lg border border-line bg-surface px-3 py-2 text-foreground";
const dateFmt = new Intl.DateTimeFormat("he-IL", { timeZone: "Asia/Jerusalem", day: "2-digit", month: "2-digit", year: "numeric" });
const d = (iso: string | null) => (iso ? dateFmt.format(new Date(iso)) : "");
const REASONS = ["מחיר", "מועד האספקה", "בחרו בספק אחר", "הלקוח ביטל את האירוע", "אחר"];

export default function QuotePage({ params }: PageProps<"/quotes/[id]">) {
  return (
    <Suspense fallback={<Loading />}>
      <QuoteContent params={params} />
    </Suspense>
  );
}

async function QuoteContent({ params }: { params: PageProps<"/quotes/[id]">["params"] }) {
  const { user, allowed } = await requirePermission("quotes.view");
  if (!allowed) return <NoAccess />;
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return <Missing />;

  const [quote] = await query<{ id: string; number: number; status: string; customer_id: string; customer: string; vat_exempt: boolean; valid_until: string | null; payment_terms: string | null; lost_reason: string | null; today: string }>(
    `select qt.id::text, qt.number, qt.status::text, qt.customer_id::text, c.name as customer, c.vat_exempt, qt.valid_until::text, qt.payment_terms, qt.lost_reason,
            (now() at time zone 'Asia/Jerusalem')::date::text as today
     from quotes qt join customers c on c.id = qt.customer_id where qt.id = $1`,
    [id],
  );
  if (!quote) return <Missing />;

  const versions = await query<{ id: string; version: number; sent_at: string | null; approved_at: string | null; public_token: string | null; total: number; discount_pct: number; delivery_fee: number; delivery_date: string | null; window_from: string | null; window_to: string | null; address_id: string | null; customer_notes: string | null; internal_notes: string | null }>(
    `select id::text, version, sent_at::text, approved_at::text, public_token, total::float, discount_pct::float, delivery_fee::float, delivery_date::text,
            to_char(window_from, 'HH24:MI') as window_from, to_char(window_to, 'HH24:MI') as window_to, address_id::text, customer_notes, internal_notes
     from quote_versions where quote_id = $1 order by version desc`,
    [id],
  );
  const latest = versions[0];
  const lastSent = versions.find((v) => v.sent_at);
  const canEdit = can(user.role, "quotes.edit") && quote.status !== "approved" && quote.status !== "rejected";
  const canApprove = can(user.role, "quotes.approve");
  const [order] = quote.status === "approved" ? await query<{ number: number }>("select o.number from orders o join quote_versions v on v.id = o.quote_version_id where v.quote_id = $1", [id]) : [];

  let editor: { initial: EditorInitial; products: EditorProduct[]; addresses: { id: string; text: string }[] } | null = null;
  if (canEdit) {
    const lines = await query<{ id: string; sku: string; variant_id: number | null; description: string; quantity: number; unit_price: number; discount_pct: number; delivery_date: string | null }>(
      "select id::text, sku, variant_id, description, quantity::float, unit_price::float, discount_pct::float, delivery_date::text from quote_lines where quote_version_id = $1 order by position",
      [latest.id],
    );
    const pricingDate = latest.delivery_date ?? quote.today;
    const products = await query<Omit<EditorProduct, "variants"> & { agreed_price: number | null; base_price: number }>(
      `select p.sku, p.name, p.vat_exempt as "vatExempt", p.base_price::float as base_price,
              (select cp.price::float from customer_prices cp
               where cp.customer_id = $1 and cp.sku = p.sku and cp.approved_at is not null and cp.valid_from <= $2::date and (cp.valid_to is null or cp.valid_to >= $2::date)
               order by cp.valid_from desc, cp.id desc limit 1) as agreed_price
       from products p join product_ops o on o.sku = p.sku
       where o.orderable or p.sku in (select sku from quote_lines where quote_version_id = $3)
       order by p.name`,
      [quote.customer_id, pricingDate, latest.id],
    );
    const addresses = await query<{ id: string; text: string }>("select id::text, concat_ws(', ', street, city) as text from customer_addresses where customer_id = $1 order by is_default desc, street", [quote.customer_id]);
    const variants = await variantsBySku("quote", latest.id);
    editor = {
      products: products.map((p) => ({ variants: variants.get(p.sku) ?? [], sku: p.sku, name: p.name, vatExempt: p.vatExempt, price: p.agreed_price ?? p.base_price, agreed: p.agreed_price !== null })),
      addresses,
      initial: {
        quoteId: id,
        version: latest.version,
        customerVatExempt: quote.vat_exempt,
        lines: lines.map((l) => ({ key: l.id, sku: l.sku, variantId: l.variant_id === null ? "" : String(l.variant_id), description: l.description, quantity: String(l.quantity), unitPrice: String(l.unit_price), discountPct: l.discount_pct ? String(l.discount_pct) : "", deliveryDate: l.delivery_date ?? "" })),
        discountPct: latest.discount_pct ? String(latest.discount_pct) : "",
        deliveryFee: latest.delivery_fee ? String(latest.delivery_fee) : "",
        deliveryDate: latest.delivery_date ?? "",
        windowFrom: latest.window_from ?? "",
        windowTo: latest.window_to ?? "",
        addressId: latest.address_id ?? "",
        customerNotes: latest.customer_notes ?? "",
        internalNotes: latest.internal_notes ?? "",
        validUntil: quote.valid_until ?? "",
        paymentTerms: quote.payment_terms ?? "",
      },
    };
  }
  const sentDoc = lastSent ? await loadQuoteDoc(lastSent.id) : null;
  const letterheads = await query<{ id: number; name: string; is_default: boolean; chosen: boolean }>(
    "select l.id, l.name, l.is_default, l.id = (select letterhead_id from quotes where id = $1) as chosen from letterheads l where l.active or l.id = (select letterhead_id from quotes where id = $1) order by l.is_default desc, l.name",
    [id],
  );
  const emails = await emailsOf(query, "quote", id);
  const contactEmails = canEdit ? await query<{ email: string; full_name: string }>("select email, full_name from customer_contacts where customer_id = $1 and email is not null and email <> '' order by full_name", [quote.customer_id]) : [];
  const awaitingCustomer = quote.status === "sent" && lastSent && latest.id === lastSent.id;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-2xl font-bold">
          הצעת מחיר <span dir="ltr">{quote.number}</span> · {quote.customer}
        </h1>
        <div className="flex items-center gap-2">
          <StatusPill id="quote-status" tone={quoteTone(quote.status)} className="px-3 py-1">
            {QUOTE_STATUS[quote.status] ?? quote.status}
          </StatusPill>
          <Link href="/quotes" className="rounded-lg border border-line px-3 py-1.5 text-sm">
            לכל ההצעות
          </Link>
        </div>
      </div>

      {quote.status === "approved" ? (
        <section className={panel}>
          <p id="quote-approved">
            ההצעה אושרה{sentDoc?.approvedByName ? ` על ידי ${sentDoc.approvedByName}` : ""} ב-{d(sentDoc?.approvedAt ?? null)} ({sentDoc?.approvalMethod === "link" ? "בקישור" : "אישור ידני של עובד"}).
            {order ? (
              <>
                {" "}
                נפתחה הזמנה <b dir="ltr">{order.number}</b> עם המחירים שסוכמו.
              </>
            ) : null}
          </p>
        </section>
      ) : null}
      {quote.status === "rejected" ? (
        <section className={panel}>
          <p>ההצעה נסגרה כנדחתה. סיבה: {quote.lost_reason}.</p>
        </section>
      ) : null}

      {awaitingCustomer && lastSent?.public_token ? (
        <section className={panel}>
          <h2 className="mb-2 font-display text-base font-bold">גרסה {lastSent.version} ממתינה לאישור הלקוח</h2>
          <p className="mb-2 text-sm text-muted">זה הקישור שהלקוח מאשר דרכו. אפשר להעתיק אותו ולשלוח בוואטסאפ, או לשלוח את ההצעה במייל מכאן.</p>
          <CopyLink path={`/q/${lastSent.public_token}`} />
          <div className="mt-3 flex flex-wrap gap-3">
            <a id="quote-pdf" href={`/quotes/${id}/pdf?v=${lastSent.version}`} className="rounded-lg border border-line px-4 py-2">
              הורד PDF
            </a>
            <Link href={`/quotes/${id}/print?v=${lastSent.version}`} className="rounded-lg border border-line px-4 py-2">
              תצוגה להדפסה ולשמירה כ-PDF
            </Link>
          </div>
          {canEdit ? (
            <div className="mt-4 border-t border-line pt-3" id="quote-email">
              <h3 className="mb-1 text-sm font-medium">שליחה במייל</h3>
              <p className="mb-2 text-sm text-muted">
                ההצעה מצורפת כ-PDF.{" "}
                {process.env.AO_PUBLIC_BASE_URL ? "המייל כולל גם את הקישור לאישור." : "הקישור לאישור לא ייכלל במייל, כי למערכת עדיין אין כתובת שלקוחות יכולים לפתוח."}
                {mailConfigured() ? "" : " לא הוגדר שרת דואר, ולכן המייל לא יישלח בפועל."}
              </p>
              <ActionForm action={emailQuoteAction} submit="שלח במייל" pendingLabel="שולח…" primary={false}>
                <input type="hidden" name="quote_id" value={id} />
                <label className="flex flex-col gap-1 text-sm text-muted">
                  אל
                  <input id="email-to" name="to" type="email" required dir="ltr" list="email-contacts" defaultValue={contactEmails[0]?.email ?? ""} className={`${field} w-72`} />
                  <datalist id="email-contacts">
                    {contactEmails.map((c) => (
                      <option key={c.email} value={c.email}>
                        {c.full_name}
                      </option>
                    ))}
                  </datalist>
                </label>
                <label className="flex flex-col gap-1 text-sm text-muted">
                  הודעה אישית (לא חובה)
                  <textarea id="email-message" name="message" rows={2} maxLength={2000} className={`${field} w-96 max-w-full`} />
                </label>
              </ActionForm>
            </div>
          ) : null}
          {canApprove ? (
            <div className="mt-4 border-t border-line pt-3">
              <h3 className="mb-2 text-sm font-medium">הלקוח אישר בטלפון או בהודעה</h3>
              <ActionForm action={approveManualAction} submit="אשר ופתח הזמנה" pendingLabel="מאשר…">
                <input type="hidden" name="quote_id" value={id} />
                <input type="hidden" name="version_id" value={lastSent.id} />
                <label className="flex flex-col gap-1 text-sm text-muted">
                  מי אישר ואיך
                  <input id="manual-approver" name="name" required placeholder="למשל: דנה, בטלפון" className={field} />
                </label>
              </ActionForm>
            </div>
          ) : null}
          {canEdit ? (
            <div className="mt-4 border-t border-line pt-3">
              <h3 className="mb-2 text-sm font-medium">הלקוח לא מעוניין</h3>
              <ActionForm action={rejectQuoteAction} submit="סגור כנדחתה" primary={false}>
                <input type="hidden" name="quote_id" value={id} />
                <label className="flex flex-col gap-1 text-sm text-muted">
                  סיבה
                  <select id="reject-reason" name="reason" required defaultValue="" className={field}>
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
      ) : null}

      {emails.length > 0 ? (
        <section className={panel}>
          <h2 className="mb-2 font-display text-base font-bold">מיילים</h2>
          <ul className="flex flex-col gap-1.5 text-sm" data-emails>
            {emails.map((e) => (
              <li key={e.id} data-email-status={e.status}>
                <span dir="ltr">{e.to}</span> · {e.status === "sent" ? "נשלח" : e.status === "failed" ? `נכשל: ${e.error}` : "לא נשלח (אין שרת דואר)"} · {d(e.at)}
                {e.by ? ` · ${e.by}` : ""}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {canEdit ? (
        <section className={panel} id="quote-letterhead">
          <h2 className="mb-2 font-display text-base font-bold">דף לוגו</h2>
          <ActionForm action={setQuoteLetterheadAction} submit="שמור דף לוגו" primary={false}>
            <input type="hidden" name="quote_id" value={id} />
            <label className="flex flex-col gap-1 text-sm text-muted">
              ההצעה תודפס תחת
              <select id="letterhead-select" name="letterhead_id" defaultValue={letterheads.find((l) => l.chosen)?.id ?? ""} className={field}>
                <option value="">ברירת המחדל ({letterheads.find((l) => l.is_default)?.name})</option>
                {letterheads.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </label>
          </ActionForm>
        </section>
      ) : null}

      {quote.status === "approved" && lastSent ? (
        <a id="quote-pdf-approved" href={`/quotes/${id}/pdf?v=${lastSent.version}`} className="self-start rounded-lg border border-line px-4 py-2">
          הורד PDF של ההצעה המאושרת
        </a>
      ) : null}

      {sentDoc && (quote.status !== "draft" || !canEdit) ? <QuoteDocument doc={sentDoc} /> : null}

      {editor ? (
        <>
          <h2 className="font-display text-lg font-bold">
            {latest.sent_at ? `תיקון ההצעה (שמירה תפתח גרסה ${latest.version + 1})` : `עריכת גרסה ${latest.version}`}
          </h2>
          <LinesEditor key={`${latest.id}-${latest.sent_at ?? "draft"}`} mode="quote" idName="quote_id" action={saveQuoteAction} initial={editor.initial} products={editor.products} addresses={editor.addresses} customerId={quote.customer_id} />
        </>
      ) : null}

      {versions.length > 1 || lastSent ? (
        <section className={panel}>
          <h2 className="mb-2 font-display text-base font-bold">גרסאות</h2>
          <ul className="flex flex-col gap-1.5">
            {versions.map((v) => (
              <li key={v.id}>
                גרסה {v.version} · {v.approved_at ? `אושרה ${d(v.approved_at)}` : v.sent_at ? `נשלחה ${d(v.sent_at)}` : "טיוטה"}
                {v.sent_at ? (
                  <>
                    {" · "}
                    <Link href={`/quotes/${id}/print?v=${v.version}`} className="text-accent underline-offset-2 hover:underline">
                      הצג
                    </Link>
                    {" · "}
                    <a href={`/quotes/${id}/pdf?v=${v.version}`} className="text-accent underline-offset-2 hover:underline">
                      הורד PDF
                    </a>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function Missing() {
  return (
    <div className="flex flex-col gap-2">
      <h1 className="font-display text-2xl font-bold">ההצעה לא נמצאה</h1>
      <Link href="/quotes" className="text-accent underline">
        לכל ההצעות
      </Link>
    </div>
  );
}
