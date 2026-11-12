"use client";

import { useActionState, useMemo, useState } from "react";
import { computeTotals, VAT_RATE } from "@/lib/quote-totals";

// One editor for three jobs: a quote, a new order, and a change to an existing delivery.
// The server action it submits to is passed in, so the same lines, prices and live totals serve all three.
type State = { error?: string; ok?: string };
export type EditorMode = "quote" | "order" | "delivery";

export type EditorVariant = { id: number; name: string };
export type EditorProduct = { sku: string; name: string; price: number; agreed: boolean; vatExempt: boolean; variants: EditorVariant[] };
export type EditorLine = { key: string; sku: string; variantId: string; description: string; quantity: string; unitPrice: string; discountPct: string; deliveryDate: string };
export type EditorInitial = {
  quoteId: string;
  version: number;
  customerVatExempt: boolean;
  lines: EditorLine[];
  discountPct: string;
  deliveryFee: string;
  deliveryDate: string;
  windowFrom: string;
  windowTo: string;
  addressId: string;
  customerNotes: string;
  internalNotes: string;
  validUntil: string;
  paymentTerms: string;
};

const money = new Intl.NumberFormat("he-IL", { style: "currency", currency: "ILS" });
const field = "rounded-lg border border-line bg-surface px-2.5 py-2 text-foreground";
const label = "flex flex-col gap-1 text-sm text-muted";
const num = (s: string) => Number(String(s).replace(",", "."));
let counter = 0;
const newKey = () => `n${++counter}`;

export function LinesEditor({
  initial,
  products,
  addresses,
  action: serverAction,
  mode,
  idName,
}: {
  initial: EditorInitial;
  products: EditorProduct[];
  addresses: { id: string; text: string }[];
  action: (prev: State, formData: FormData) => Promise<State>;
  mode: EditorMode;
  idName: string;
}) {
  const [state, action, pending] = useActionState<State, FormData>(serverAction, {});
  const [lines, setLines] = useState<EditorLine[]>(initial.lines);
  const [head, setHead] = useState({
    discountPct: initial.discountPct,
    deliveryFee: initial.deliveryFee,
    deliveryDate: initial.deliveryDate,
    windowFrom: initial.windowFrom,
    windowTo: initial.windowTo,
    addressId: initial.addressId,
    customerNotes: initial.customerNotes,
    internalNotes: initial.internalNotes,
    validUntil: initial.validUntil,
    paymentTerms: initial.paymentTerms,
  });
  const bySku = useMemo(() => new Map(products.map((p) => [p.sku, p])), [products]);
  const setH = (k: keyof typeof head) => (e: { target: { value: string } }) => setHead((h) => ({ ...h, [k]: e.target.value }));
  const patch = (key: string, change: Partial<EditorLine>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...change } : l)));

  const totals = computeTotals(
    lines.filter((l) => l.sku && num(l.quantity) > 0).map((l) => ({ quantity: num(l.quantity), unitPrice: num(l.unitPrice) || 0, discountPct: num(l.discountPct) || 0, vatExempt: bySku.get(l.sku)?.vatExempt ?? false })),
    num(head.discountPct) || 0,
    num(head.deliveryFee) || 0,
    VAT_RATE,
    initial.customerVatExempt,
  );
  const payload = JSON.stringify({
    ...head,
    discountPct: num(head.discountPct) || 0,
    deliveryFee: num(head.deliveryFee) || 0,
    lines: lines.filter((l) => l.sku).map((l) => ({ sku: l.sku, variantId: l.variantId ? Number(l.variantId) : null, description: l.description, quantity: num(l.quantity), unitPrice: num(l.unitPrice), discountPct: num(l.discountPct) || 0, deliveryDate: l.deliveryDate })),
  });

  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name={idName} value={initial.quoteId} />
      <input type="hidden" name="payload" value={payload} />

      <section className="rounded-xl border border-line bg-surface p-4">
        <h2 className="mb-3 font-display text-base font-bold">אספקה ותנאים</h2>
        <div className="flex flex-wrap items-end gap-3">
          <label className={label}>
            תאריך אספקה
            <input id="q-delivery-date" type="date" value={head.deliveryDate} onChange={setH("deliveryDate")} className={field} />
          </label>
          <label className={label}>
            משעה
            <input id="q-window-from" type="time" value={head.windowFrom} onChange={setH("windowFrom")} className={field} />
          </label>
          <label className={label}>
            עד שעה
            <input id="q-window-to" type="time" value={head.windowTo} onChange={setH("windowTo")} className={field} />
          </label>
          <label className={label}>
            כתובת אספקה
            <select id="q-address" value={head.addressId} onChange={setH("addressId")} className={field}>
              <option value="">לא נבחרה</option>
              {addresses.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.text}
                </option>
              ))}
            </select>
          </label>
          <label className={label} hidden={mode !== "quote"}>
            ההצעה בתוקף עד
            <input id="q-valid-until" type="date" value={head.validUntil} onChange={setH("validUntil")} className={field} />
          </label>
          <label className={label} hidden={mode !== "quote"}>
            תנאי תשלום
            <input id="q-payment-terms" value={head.paymentTerms} onChange={setH("paymentTerms")} placeholder="למשל: שוטף + 30" className={field} />
          </label>
        </div>
      </section>

      <section className="rounded-xl border border-line bg-surface p-4">
        <h2 className="mb-3 font-display text-base font-bold">פריטים</h2>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse tabular-nums">
            <thead>
              <tr className="border-b border-line text-xs text-muted">
                <th className="px-1.5 py-1.5 text-start font-medium">מוצר</th>
                <th className="px-1.5 py-1.5 text-start font-medium">תיאור בהצעה</th>
                <th className="px-1.5 py-1.5 text-start font-medium">כמות</th>
                <th className="px-1.5 py-1.5 text-start font-medium">מחיר ליחידה</th>
                <th className="px-1.5 py-1.5 text-start font-medium">הנחה %</th>
                <th hidden={mode === "delivery"} className="px-1.5 py-1.5 text-start font-medium">אספקה בתאריך אחר</th>
                <th className="px-1.5 py-1.5 text-end font-medium">סה״כ</th>
                <th className="px-1.5 py-1.5" />
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => {
                const p = bySku.get(l.sku);
                const lineTotal = l.sku && num(l.quantity) > 0 ? computeTotals([{ quantity: num(l.quantity), unitPrice: num(l.unitPrice) || 0, discountPct: num(l.discountPct) || 0 }], 0, 0, 0).subtotal : 0;
                return (
                  <tr key={l.key} className="border-b border-line align-top">
                    <td className="px-1.5 py-2">
                      <select
                        aria-label={`מוצר, שורה ${i + 1}`}
                        data-line-sku={i}
                        value={l.sku}
                        onChange={(e) => {
                          const np = bySku.get(e.target.value);
                          patch(l.key, { sku: e.target.value, variantId: "", description: np?.name ?? "", unitPrice: np ? String(np.price) : "" });
                        }}
                        className={`${field} max-w-56`}
                      >
                        <option value="">בחירה</option>
                        {products.map((pr) => (
                          <option key={pr.sku} value={pr.sku}>
                            {pr.name} · {pr.sku}
                          </option>
                        ))}
                      </select>
                      {p && p.variants.length > 0 ? (
                        <select
                          aria-label={`סוג, שורה ${i + 1}`}
                          data-line-variant={i}
                          value={l.variantId}
                          onChange={(e) => {
                            const v = p.variants.find((x) => String(x.id) === e.target.value);
                            // The description follows the variant unless someone typed their own wording.
                            const untouched = l.description === "" || l.description === p.name || p.variants.some((x) => l.description === `${p.name} · ${x.name}`);
                            patch(l.key, { variantId: e.target.value, ...(untouched ? { description: v ? `${p.name} · ${v.name}` : p.name } : {}) });
                          }}
                          className={`${field} mt-1 block max-w-56`}
                        >
                          <option value="">בחירת סוג</option>
                          {p.variants.map((v) => (
                            <option key={v.id} value={v.id}>
                              {v.name}
                            </option>
                          ))}
                        </select>
                      ) : null}
                      {p ? <div className="mt-1 text-xs text-muted">{p.agreed ? "מחיר הסכם" : p.price > 0 ? "מחיר בסיס" : "אין מחיר בסיס"}</div> : null}
                    </td>
                    <td className="px-1.5 py-2">
                      <input aria-label={`תיאור, שורה ${i + 1}`} value={l.description} onChange={(e) => patch(l.key, { description: e.target.value })} className={`${field} w-44`} />
                    </td>
                    <td className="px-1.5 py-2">
                      <input aria-label={`כמות, שורה ${i + 1}`} data-line-qty={i} inputMode="decimal" dir="ltr" value={l.quantity} onChange={(e) => patch(l.key, { quantity: e.target.value })} className={`${field} w-20`} />
                    </td>
                    <td className="px-1.5 py-2">
                      <input aria-label={`מחיר, שורה ${i + 1}`} data-line-price={i} inputMode="decimal" dir="ltr" value={l.unitPrice} onChange={(e) => patch(l.key, { unitPrice: e.target.value })} className={`${field} w-24`} />
                    </td>
                    <td className="px-1.5 py-2">
                      <input aria-label={`הנחה, שורה ${i + 1}`} inputMode="decimal" dir="ltr" value={l.discountPct} onChange={(e) => patch(l.key, { discountPct: e.target.value })} className={`${field} w-16`} />
                    </td>
                    <td hidden={mode === "delivery"} className="px-1.5 py-2">
                      <input aria-label={`תאריך אספקה, שורה ${i + 1}`} data-line-date={i} type="date" value={l.deliveryDate} onChange={(e) => patch(l.key, { deliveryDate: e.target.value })} className={field} />
                    </td>
                    <td className="px-1.5 py-2 text-end">{money.format(lineTotal)}</td>
                    <td className="px-1.5 py-2 text-end">
                      <button type="button" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} className="rounded-lg border border-line px-2.5 py-1.5 text-sm">
                        הסר
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <button
          type="button"
          id="q-add-line"
          onClick={() => setLines((ls) => [...ls, { key: newKey(), sku: "", variantId: "", description: "", quantity: "", unitPrice: "", discountPct: "", deliveryDate: "" }])}
          className="mt-3 rounded-lg border border-line px-4 py-2"
        >
          הוסף שורה
        </button>

        <div className="mt-4 flex flex-wrap items-start justify-between gap-6">
          <div className="flex flex-wrap items-end gap-3" hidden={mode === "delivery"}>
            <label className={label}>
              הנחה כללית %
              <input id="q-discount" inputMode="decimal" dir="ltr" value={head.discountPct} onChange={setH("discountPct")} className={`${field} w-20`} />
            </label>
            <label className={label}>
              דמי משלוח לפני מע״מ
              <input id="q-delivery-fee" inputMode="decimal" dir="ltr" value={head.deliveryFee} onChange={setH("deliveryFee")} className={`${field} w-28`} />
            </label>
          </div>
          <dl className="grid w-full max-w-xs grid-cols-[1fr_auto] gap-x-6 gap-y-1 tabular-nums">
            <dt>סה״כ פריטים</dt>
            <dd className="text-end">{money.format(totals.subtotal)}</dd>
            {totals.discount > 0 ? (
              <>
                <dt>הנחה</dt>
                <dd className="text-end" dir="ltr">
                  −{money.format(totals.discount)}
                </dd>
              </>
            ) : null}
            {totals.deliveryFee > 0 ? (
              <>
                <dt>דמי משלוח</dt>
                <dd className="text-end">{money.format(totals.deliveryFee)}</dd>
              </>
            ) : null}
            <dt>לפני מע״מ</dt>
            <dd className="text-end">{money.format(totals.beforeVat)}</dd>
            <dt>מע״מ {Math.round(VAT_RATE * 100)}%</dt>
            <dd className="text-end">{money.format(totals.vat)}</dd>
            <dt className="border-t border-line pt-1.5 font-display text-lg font-bold">לתשלום</dt>
            <dd id="q-total" className="border-t border-line pt-1.5 text-end font-display text-lg font-bold">
              {money.format(totals.total)}
            </dd>
          </dl>
        </div>
      </section>

      <section className="rounded-xl border border-line bg-surface p-4">
        <h2 className="mb-3 font-display text-base font-bold">הערות</h2>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-3">
          <label className={label}>
            {mode === "quote" ? "הערות ללקוח (מופיעות בהצעה)" : "הערות לשילוח"}
            <textarea id="q-customer-notes" rows={3} value={head.customerNotes} onChange={setH("customerNotes")} className={field} />
          </label>
          <label className={label}>
            {mode === "quote" ? "הערות פנימיות (לא מופיעות בהצעה)" : "הערות לייצור"}
            <textarea id="q-internal-notes" rows={3} value={head.internalNotes} onChange={setH("internalNotes")} className={field} />
          </label>
        </div>
      </section>

      <div className="flex flex-wrap items-center gap-3">
        {mode === "quote" ? (
          <>
            <button name="intent" value="save" disabled={pending} className="rounded-lg border border-line px-4 py-2.5 disabled:opacity-60">
              שמור טיוטה
            </button>
            <button name="intent" value="send" disabled={pending} className="rounded-lg bg-accent px-4 py-2.5 font-medium text-surface disabled:opacity-60">
              שמור ונעל לשליחה ללקוח
            </button>
            <span className="text-sm text-muted">אחרי נעילה, שינוי נוסף יפתח גרסה {initial.version + 1}.</span>
          </>
        ) : (
          <button name="intent" value="save" disabled={pending} className="rounded-lg bg-accent px-4 py-2.5 font-medium text-surface disabled:opacity-60">
            {pending ? "שומר…" : mode === "order" ? "פתח הזמנה" : "שמור שינויים"}
          </button>
        )}
      </div>
      {state.error ? (
        <p role="alert" className="rounded-lg bg-sunken px-3 py-2 text-sm font-medium">
          {state.error}
        </p>
      ) : null}
      {state.ok ? (
        <p role="status" className="text-sm text-muted">
          {state.ok}
        </p>
      ) : null}
    </form>
  );
}
