"use client";

import { startTransition, useActionState, useEffect, useState } from "react";
import { addQuoteAddressAction } from "@/app/quotes/actions";
import { Popup } from "@/components/popup";

const field = "rounded-lg border border-line bg-surface px-3 py-2 text-foreground";
const label = "flex flex-col gap-1 text-sm text-muted";

// Adds a delivery address for the customer from inside a quote. The address is saved with the customer, and the
// quote takes it at once. It is not a form of its own: the quote form it sits in must not be submitted by it.
export function NewAddressPopup({ customerId, onAdded }: { customerId: string; onAdded: (a: { id: string; text: string }) => void }) {
  const [open, setOpen] = useState(false);
  const [state, dispatch, pending] = useActionState(addQuoteAddressAction, {});
  const [f, setF] = useState({ street: "", city: "", delivery_area: "", label: "" });

  useEffect(() => {
    if (state.id && state.text) {
      onAdded({ id: state.id, text: state.text });
      setF({ street: "", city: "", delivery_area: "", label: "" });
      setOpen(false);
    }
  }, [state.id]);

  const save = () => {
    const fd = new FormData();
    fd.set("customer_id", customerId);
    for (const [k, v] of Object.entries(f)) fd.set(k, v);
    startTransition(() => dispatch(fd));
  };

  return (
    <>
      <button type="button" id="new-address-open" onClick={() => setOpen(true)} className="rounded-lg border border-line px-3 py-2 text-sm">
        כתובת חדשה
      </button>
      {open ? (
        <Popup title="כתובת אספקה חדשה" onClose={() => setOpen(false)}>
          <div className="flex flex-col gap-3">
            <label className={label}>
              כתובת (רחוב ומספר)
              <input id="new-address-street" value={f.street} onChange={(e) => setF({ ...f, street: e.target.value })} required className={field} />
            </label>
            <label className={label}>
              עיר
              <input id="new-address-city" value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} className={field} />
            </label>
            <label className={label}>
              אזור אספקה (לא חובה)
              <input value={f.delivery_area} onChange={(e) => setF({ ...f, delivery_area: e.target.value })} className={field} />
            </label>
            <label className={label}>
              שם לכתובת (לא חובה, למשל: מטבח ראשי)
              <input value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} className={field} />
            </label>
            {state.error ? (
              <p role="alert" className="rounded-lg bg-sunken px-3 py-2 text-sm font-medium">
                {state.error}
              </p>
            ) : null}
            <button type="button" id="new-address-save" onClick={save} disabled={pending || f.street.trim().length < 2} className="self-start rounded-lg bg-accent px-4 py-2.5 font-medium text-surface disabled:opacity-60">
              {pending ? "שומר…" : "שמור כתובת ובחר בהצעה"}
            </button>
          </div>
        </Popup>
      ) : null}
    </>
  );
}
