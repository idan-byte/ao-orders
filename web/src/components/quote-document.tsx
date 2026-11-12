import type { QuoteDoc } from "@/lib/quotes-data";

const money = new Intl.NumberFormat("he-IL", { style: "currency", currency: "ILS" });
const qty = new Intl.NumberFormat("he-IL", { maximumFractionDigits: 3 });
const dateFmt = new Intl.DateTimeFormat("he-IL", { timeZone: "Asia/Jerusalem", day: "2-digit", month: "2-digit", year: "numeric" });
const d = (iso: string | null) => (iso ? dateFmt.format(new Date(iso)) : "");

/** The quote as the customer sees it: used for the print view and for the approval link. */
export function QuoteDocument({ doc }: { doc: QuoteDoc }) {
  const subtotal = doc.lines.reduce((s, l) => s + l.lineTotal, 0);
  const discount = Math.round((subtotal + doc.deliveryFee - doc.beforeVat) * 100) / 100;
  const hasLineDiscount = doc.lines.some((l) => l.discountPct > 0);
  const hasLineDates = doc.lines.some((l) => l.deliveryDate);
  return (
    <article className="quote-doc rounded-xl border border-line bg-surface p-6">
      <header className="mb-5 flex flex-wrap items-start justify-between gap-4 border-b border-line pb-4">
        <div>
          <div className="font-display text-xl font-bold">אבי ועופר שירותי מזון בע״מ</div>
          <div className="text-sm text-muted">A&amp;O Food Services · אזור התעשייה עטרות, ירושלים</div>
        </div>
        <div className="text-end">
          <div className="font-display text-lg font-bold">
            הצעת מחיר <span dir="ltr">{doc.number}</span>
          </div>
          <div className="text-sm text-muted">
            גרסה {doc.version}
            {doc.sentAt ? ` · ${d(doc.sentAt)}` : " · טיוטה"}
          </div>
        </div>
      </header>

      <dl className="mb-5 grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-3 text-sm">
        <div>
          <dt className="text-muted">לכבוד</dt>
          <dd className="font-medium">{doc.customerName}</dd>
          {doc.customerTaxId ? <dd className="text-muted">ח.פ. {doc.customerTaxId}</dd> : null}
        </div>
        {doc.deliveryDate ? (
          <div>
            <dt className="text-muted">אספקה</dt>
            <dd>
              {d(doc.deliveryDate)}
              {doc.windowFrom || doc.windowTo ? (
                <span dir="ltr"> {[doc.windowFrom, doc.windowTo].filter(Boolean).join("–")}</span>
              ) : null}
            </dd>
          </div>
        ) : null}
        {doc.address ? (
          <div>
            <dt className="text-muted">כתובת אספקה</dt>
            <dd>{doc.address}</dd>
          </div>
        ) : null}
        {doc.validUntil ? (
          <div>
            <dt className="text-muted">ההצעה בתוקף עד</dt>
            <dd>{d(doc.validUntil)}</dd>
          </div>
        ) : null}
        {doc.paymentTerms ? (
          <div>
            <dt className="text-muted">תנאי תשלום</dt>
            <dd>{doc.paymentTerms}</dd>
          </div>
        ) : null}
      </dl>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse tabular-nums">
          <thead>
            <tr className="border-b border-line text-xs text-muted">
              <th className="px-2 py-1.5 text-start font-medium">מק״ט</th>
              <th className="px-2 py-1.5 text-start font-medium">פריט</th>
              {hasLineDates ? <th className="px-2 py-1.5 text-start font-medium">אספקה</th> : null}
              <th className="px-2 py-1.5 text-end font-medium">כמות</th>
              <th className="px-2 py-1.5 text-end font-medium">מחיר ליחידה</th>
              {hasLineDiscount ? <th className="px-2 py-1.5 text-end font-medium">הנחה</th> : null}
              <th className="px-2 py-1.5 text-end font-medium">סה״כ</th>
            </tr>
          </thead>
          <tbody>
            {doc.lines.map((l) => (
              <tr key={l.position} className="border-b border-line">
                <td className="px-2 py-2">{l.sku}</td>
                <td className="px-2 py-2">{l.description}</td>
                {hasLineDates ? <td className="px-2 py-2">{d(l.deliveryDate ?? doc.deliveryDate)}</td> : null}
                <td className="px-2 py-2 text-end">{qty.format(l.quantity)}</td>
                <td className="px-2 py-2 text-end">{money.format(l.unitPrice)}</td>
                {hasLineDiscount ? <td className="px-2 py-2 text-end">{l.discountPct > 0 ? `${l.discountPct}%` : ""}</td> : null}
                <td className="px-2 py-2 text-end">{money.format(l.lineTotal)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <dl className="ms-auto mt-4 grid w-full max-w-xs grid-cols-[1fr_auto] gap-x-6 gap-y-1 tabular-nums">
        <dt>סה״כ פריטים</dt>
        <dd className="text-end">{money.format(subtotal)}</dd>
        {discount > 0 ? (
          <>
            <dt>הנחה {doc.discountPct}%</dt>
            <dd className="text-end" dir="ltr">
              −{money.format(discount)}
            </dd>
          </>
        ) : null}
        {doc.deliveryFee > 0 ? (
          <>
            <dt>דמי משלוח</dt>
            <dd className="text-end">{money.format(doc.deliveryFee)}</dd>
          </>
        ) : null}
        <dt>לפני מע״מ</dt>
        <dd className="text-end">{money.format(doc.beforeVat)}</dd>
        <dt>מע״מ {Math.round(doc.vatRate * 100)}%</dt>
        <dd className="text-end">{money.format(doc.vat)}</dd>
        <dt className="border-t border-line pt-1.5 font-display text-lg font-bold">לתשלום</dt>
        <dd className="border-t border-line pt-1.5 text-end font-display text-lg font-bold">{money.format(doc.total)}</dd>
      </dl>

      {doc.customerNotes ? (
        <div className="mt-5 border-t border-line pt-3">
          <div className="text-sm text-muted">הערות</div>
          <p className="whitespace-pre-wrap">{doc.customerNotes}</p>
        </div>
      ) : null}
    </article>
  );
}
