"use client";

import { useMemo, useState } from "react";
import { NewCustomerPopup } from "@/components/new-customer-popup";

const field = "rounded-lg border border-line bg-surface px-3 py-2 text-foreground";
const label = "flex flex-col gap-1 text-sm text-muted";

// The customer choice of a form, with the option to add a customer that is not in the list yet.
// A long list is narrowed by typing part of a name, so the right customer is found at once.
// A customer added here is put in the list and chosen at once.
export function CustomerPicker({ customers, defaultValue, allowNew, id, hint }: { customers: { id: string; name: string }[]; defaultValue: string; allowNew: boolean; id?: string; hint?: string }) {
  const [list, setList] = useState(customers);
  const [value, setValue] = useState(defaultValue);
  const [search, setSearch] = useState("");

  // The chosen customer stays in the list even when the search leaves it out.
  const shown = useMemo(() => {
    const words = search.trim().toLocaleLowerCase("he").split(/\s+/).filter(Boolean);
    return list.filter((c) => c.id === value || words.every((w) => c.name.toLocaleLowerCase("he").includes(w)));
  }, [list, search, value]);

  return (
    <div className="flex flex-wrap items-end gap-3">
      <label className={label}>
        חיפוש לקוח
        <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="הקלידו חלק משם" className={`${field} w-56`} />
      </label>
      <label className={label}>
        לקוח{search.trim() ? <span className="text-xs">{shown.length} תוצאות</span> : null}
        <select id={id} name="customer_id" required value={value} onChange={(e) => setValue(e.target.value)} className={`${field} max-w-80`}>
          <option value="">בחירת לקוח</option>
          {shown.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      {hint && value === "" ? <p className="w-full text-sm font-bold">{hint}</p> : null}
      {allowNew ? (
        <NewCustomerPopup
          onCreated={(c) => {
            setList((l) => [...l.filter((x) => x.id !== c.id), c].sort((a, b) => a.name.localeCompare(b.name, "he")));
            setValue(c.id);
            setSearch("");
          }}
        />
      ) : null}
    </div>
  );
}
