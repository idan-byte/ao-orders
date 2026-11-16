"use client";

import { startTransition, useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createCustomerAction } from "@/app/quotes/actions";
import { Popup } from "@/components/popup";

const field = "rounded-lg border border-line bg-surface px-3 py-2 text-foreground";
const label = "flex flex-col gap-1 text-sm text-muted";
const empty = { name: "", tax_id: "", phone: "", email: "" };

// Adds a customer from a screen that has a customer choice (a quote, a mail recommendation).
// Only the name is required; the rest can be filled in later. It is not a form of its own, so it can sit inside
// another form. After saving, the caller gets the new customer; without a caller, the quote screen opens with it chosen.
export function NewCustomerPopup({ onCreated }: { onCreated?: (c: { id: string; name: string }) => void }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState(empty);
  const [state, dispatch, pending] = useActionState(createCustomerAction, {});

  useEffect(() => {
    if (!state.id) return;
    setOpen(false);
    setF(empty);
    if (onCreated) onCreated({ id: state.id, name: state.text ?? "" });
    else router.push(`/quotes?customer=${state.id}`);
    // Runs once for each newly saved customer.
  }, [state.id]);

  const save = () => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(f)) fd.set(k, v);
    startTransition(() => dispatch(fd));
  };

  return (
    <>
      <button type="button" id="new-customer-open" onClick={() => setOpen(true)} className="rounded-lg border border-line px-4 py-2">
        הוסף לקוח חדש
      </button>
      {open ? (
        <Popup title="לקוח חדש" onClose={() => setOpen(false)}>
          <div className="flex flex-col gap-3" id="new-customer-form">
            <p className="text-sm text-muted">אפשר לרשום עכשיו רק את השם, ולהשלים את השאר אחר כך. הלקוח ימתין להיכנס לחשבשבת.</p>
            <label className={label}>
              שם הלקוח
              <input id="new-customer-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required className={field} />
            </label>
            <label className={label}>
              ח.פ / עוסק מורשה (לא חובה)
              <input value={f.tax_id} onChange={(e) => setF({ ...f, tax_id: e.target.value })} dir="ltr" className={field} />
            </label>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className={label}>
                טלפון (לא חובה)
                <input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} dir="ltr" className={field} />
              </label>
              <label className={label}>
                מייל (לא חובה)
                <input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} type="email" dir="ltr" className={field} />
              </label>
            </div>
            {state.error ? (
              <p role="alert" className="rounded-lg bg-sunken px-3 py-2 text-sm font-medium">
                {state.error}
              </p>
            ) : null}
            <button type="button" onClick={save} disabled={pending || f.name.trim().length < 2} className="self-start rounded-lg bg-accent px-4 py-2.5 font-medium text-surface disabled:opacity-60">
              {pending ? "שומר…" : "שמור לקוח"}
            </button>
          </div>
        </Popup>
      ) : null}
    </>
  );
}
