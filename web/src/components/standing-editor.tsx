"use client";

import { useActionState, useState } from "react";

// The weekly template of a standing order: one row per product, one column per day, a quantity in each cell.
type State = { error?: string; ok?: string };
export type StandingRow = { key: string; sku: string; variantId: string; qty: string[] };
export type StandingInitial = {
  standingId: string;
  customerId: string;
  rows: StandingRow[];
  addressId: string;
  windowFrom: string;
  windowTo: string;
  validFrom: string;
  validTo: string;
  productionNotes: string;
  shippingNotes: string;
};

const DAYS = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳"];
const field = "rounded-lg border border-line bg-surface px-2.5 py-2 text-foreground";
const label = "flex flex-col gap-1 text-sm text-muted";
const num = (v: string) => Number(String(v).replace(",", ".")) || 0;
let counter = 0;

export function StandingEditor({
  initial,
  products,
  addresses,
  action,
}: {
  initial: StandingInitial;
  products: { sku: string; name: string; variants: { id: number; name: string }[] }[];
  addresses: { id: string; text: string }[];
  action: (prev: State, formData: FormData) => Promise<State>;
}) {
  const [state, formAction, pending] = useActionState<State, FormData>(action, {});
  const [rows, setRows] = useState<StandingRow[]>(initial.rows);
  const [head, setHead] = useState({ addressId: initial.addressId, windowFrom: initial.windowFrom, windowTo: initial.windowTo, validFrom: initial.validFrom, validTo: initial.validTo, productionNotes: initial.productionNotes, shippingNotes: initial.shippingNotes });
  const setH = (k: keyof typeof head) => (e: { target: { value: string } }) => setHead((h) => ({ ...h, [k]: e.target.value }));
  const payload = JSON.stringify({ ...head, rows: rows.filter((r) => r.sku).map((r) => ({ sku: r.sku, variantId: r.variantId ? Number(r.variantId) : null, qty: r.qty.map(num) })) });
  const dayTotals = DAYS.map((_, d) => rows.reduce((s, r) => s + num(r.qty[d]), 0));

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="standing_id" value={initial.standingId} />
      <input type="hidden" name="customer_id" value={initial.customerId} />
      <input type="hidden" name="payload" value={payload} />

      <section className="rounded-xl border border-line bg-surface p-4">
        <h2 className="mb-3 font-display text-base font-bold">כמויות לפי יום בשבוע</h2>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse tabular-nums">
            <thead>
              <tr className="border-b border-line text-xs text-muted">
                <th className="px-1.5 py-1.5 text-start font-medium">מוצר</th>
                {DAYS.map((d) => (
                  <th key={d} className="px-1.5 py-1.5 text-start font-medium">
                    יום {d}
                  </th>
                ))}
                <th className="px-1.5 py-1.5" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.key} className="border-b border-line align-top">
                  <td className="px-1.5 py-2">
                    <select aria-label={`מוצר, שורה ${i + 1}`} data-st-sku={i} value={r.sku} onChange={(e) => setRows((rs) => rs.map((x) => (x.key === r.key ? { ...x, sku: e.target.value, variantId: "" } : x)))} className={`${field} max-w-56`}>
                      <option value="">בחירה</option>
                      {products.map((p) => (
                        <option key={p.sku} value={p.sku}>
                          {p.name} · {p.sku}
                        </option>
                      ))}
                    </select>
                    {(products.find((p) => p.sku === r.sku)?.variants.length ?? 0) > 0 ? (
                      <select aria-label={`סוג, שורה ${i + 1}`} data-st-variant={i} value={r.variantId} onChange={(e) => setRows((rs) => rs.map((x) => (x.key === r.key ? { ...x, variantId: e.target.value } : x)))} className={`${field} mt-1 block max-w-56`}>
                        <option value="">בחירת סוג</option>
                        {products
                          .find((p) => p.sku === r.sku)!
                          .variants.map((v) => (
                            <option key={v.id} value={v.id}>
                              {v.name}
                            </option>
                          ))}
                      </select>
                    ) : null}
                  </td>
                  {DAYS.map((d, k) => (
                    <td key={d} className="px-1.5 py-2">
                      <input
                        aria-label={`כמות ביום ${d}, שורה ${i + 1}`}
                        data-st-qty={`${i}-${k}`}
                        inputMode="decimal"
                        dir="ltr"
                        value={r.qty[k]}
                        onChange={(e) => setRows((rs) => rs.map((x) => (x.key === r.key ? { ...x, qty: x.qty.map((q, j) => (j === k ? e.target.value : q)) } : x)))}
                        className={`${field} w-16`}
                      />
                    </td>
                  ))}
                  <td className="px-1.5 py-2 text-end">
                    <button type="button" onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))} className="rounded-lg border border-line px-2.5 py-1.5 text-sm">
                      הסר
                    </button>
                  </td>
                </tr>
              ))}
              <tr className="text-sm text-muted">
                <td className="px-1.5 py-2">סה״כ יחידות ביום</td>
                {dayTotals.map((t, k) => (
                  <td key={k} data-st-total={k} className="px-1.5 py-2 font-medium text-foreground">
                    {t > 0 ? t.toLocaleString("he-IL") : ""}
                  </td>
                ))}
                <td />
              </tr>
            </tbody>
          </table>
        </div>
        <button type="button" id="st-add-row" onClick={() => setRows((rs) => [...rs, { key: `n${++counter}`, sku: "", variantId: "", qty: DAYS.map(() => "") }])} className="mt-3 rounded-lg border border-line px-4 py-2">
          הוסף מוצר
        </button>
      </section>

      <section className="rounded-xl border border-line bg-surface p-4">
        <h2 className="mb-3 font-display text-base font-bold">אספקה ותוקף</h2>
        <div className="flex flex-wrap items-end gap-3">
          <label className={label}>
            כתובת אספקה
            <select id="st-address" value={head.addressId} onChange={setH("addressId")} className={field}>
              <option value="">לא נבחרה</option>
              {addresses.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.text}
                </option>
              ))}
            </select>
          </label>
          <label className={label}>
            משעה
            <input id="st-window-from" type="time" value={head.windowFrom} onChange={setH("windowFrom")} className={field} />
          </label>
          <label className={label}>
            עד שעה
            <input id="st-window-to" type="time" value={head.windowTo} onChange={setH("windowTo")} className={field} />
          </label>
          <label className={label}>
            בתוקף מתאריך
            <input id="st-valid-from" type="date" value={head.validFrom} onChange={setH("validFrom")} className={field} />
          </label>
          <label className={label}>
            עד תאריך (ריק = ללא הגבלה)
            <input id="st-valid-to" type="date" value={head.validTo} onChange={setH("validTo")} className={field} />
          </label>
        </div>
        <div className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-3">
          <label className={label}>
            הערות לייצור (יופיעו בכל הזמנה)
            <textarea id="st-production-notes" rows={2} value={head.productionNotes} onChange={setH("productionNotes")} className={field} />
          </label>
          <label className={label}>
            הערות לשילוח (יופיעו בכל הזמנה)
            <textarea id="st-shipping-notes" rows={2} value={head.shippingNotes} onChange={setH("shippingNotes")} className={field} />
          </label>
        </div>
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <button id="st-save" disabled={pending} className="rounded-lg bg-accent px-4 py-2.5 font-medium text-surface disabled:opacity-60">
          {pending ? "שומר…" : "שמור הזמנה קבועה"}
        </button>
        <span className="text-sm text-muted">המחיר נקבע בכל יצירת הזמנה לפי הסכם הלקוח באותו יום.</span>
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
