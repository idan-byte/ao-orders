"use client";

import { useEffect, useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import { createCustomerAction } from "@/app/quotes/actions";
import { Popup } from "@/components/popup";

const field = "rounded-lg border border-line bg-surface px-3 py-2 text-foreground";
const label = "flex flex-col gap-1 text-sm text-muted";

// Adds a customer from the quote screen. Only the name is required; the rest can be filled in later.
// After saving, the new customer is chosen in the quote form.
export function NewCustomerPopup() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(createCustomerAction, {});

  useEffect(() => {
    if (state.id) {
      setOpen(false);
      router.push(`/quotes?customer=${state.id}`);
    }
  }, [state.id, router]);

  return (
    <>
      <button type="button" id="new-customer-open" onClick={() => setOpen(true)} className="rounded-lg border border-line px-4 py-2">
        הוסף לקוח חדש
      </button>
      {open ? (
        <Popup title="לקוח חדש" onClose={() => setOpen(false)}>
          <form action={formAction} className="flex flex-col gap-3" id="new-customer-form">
            <p className="text-sm text-muted">אפשר לרשום עכשיו רק את השם, ולהשלים את השאר אחר כך. הלקוח ימתין להיכנס לחשבשבת.</p>
            <label className={label}>
              שם הלקוח
              <input id="new-customer-name" name="name" required minLength={2} className={field} />
            </label>
            <label className={label}>
              ח.פ / עוסק מורשה (לא חובה)
              <input name="tax_id" dir="ltr" className={field} />
            </label>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className={label}>
                טלפון (לא חובה)
                <input name="phone" dir="ltr" className={field} />
              </label>
              <label className={label}>
                מייל (לא חובה)
                <input name="email" type="email" dir="ltr" className={field} />
              </label>
            </div>
            {state.error ? (
              <p role="alert" className="rounded-lg bg-sunken px-3 py-2 text-sm font-medium">
                {state.error}
              </p>
            ) : null}
            <button type="submit" disabled={pending} className="self-start rounded-lg bg-accent px-4 py-2.5 font-medium text-surface disabled:opacity-60">
              {pending ? "שומר…" : "שמור לקוח"}
            </button>
          </form>
        </Popup>
      ) : null}
    </>
  );
}
