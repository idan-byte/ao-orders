"use client";

import { useState } from "react";
import { NewCustomerPopup } from "@/components/new-customer-popup";

const field = "rounded-lg border border-line bg-surface px-3 py-2 text-foreground";
const label = "flex flex-col gap-1 text-sm text-muted";

// The customer choice of a form, with the option to add a customer that is not in the list yet.
// A customer added here is put in the list and chosen at once.
export function CustomerPicker({ customers, defaultValue, allowNew }: { customers: { id: string; name: string }[]; defaultValue: string; allowNew: boolean }) {
  const [list, setList] = useState(customers);
  const [value, setValue] = useState(defaultValue);

  return (
    <div className="flex flex-wrap items-end gap-3">
      <label className={label}>
        לקוח
        <select name="customer_id" required value={value} onChange={(e) => setValue(e.target.value)} className={`${field} max-w-80`}>
          <option value="">בחירת לקוח</option>
          {list.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      {allowNew ? (
        <NewCustomerPopup
          onCreated={(c) => {
            setList((l) => [...l.filter((x) => x.id !== c.id), c].sort((a, b) => a.name.localeCompare(b.name, "he")));
            setValue(c.id);
          }}
        />
      ) : null}
    </div>
  );
}
