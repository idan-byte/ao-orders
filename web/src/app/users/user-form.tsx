"use client";

import { useActionState, useState } from "react";
import { addUserAction, type UserFormState } from "./actions";

const field = "rounded-lg border border-line bg-surface px-3 py-2";

export function UserForm({ roles, departments, departmentRoles }: { roles: { value: string; label: string }[]; departments: { id: number; name: string }[]; departmentRoles: string[] }) {
  const [state, action, pending] = useActionState<UserFormState, FormData>(addUserAction, {});
  const [role, setRole] = useState("");
  const needsDepartment = departmentRoles.includes(role);

  return (
    <form action={action} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm text-muted">
          שם מלא
          <input id="new-user-name" name="full_name" required className={field} />
        </label>
        <label className="flex flex-col gap-1 text-sm text-muted">
          מספר נייד
          <input id="new-user-mobile" name="mobile" type="tel" dir="ltr" placeholder="050-0000000" required className={`${field} tabular-nums`} />
        </label>
        <label className="flex flex-col gap-1 text-sm text-muted">
          תפקיד
          <select id="new-user-role" name="role" required value={role} onChange={(e) => setRole(e.target.value)} className={field}>
            <option value="">בחירה</option>
            {roles.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        {needsDepartment ? (
          <label className="flex flex-col gap-1 text-sm text-muted">
            מחלקת ייצור
            <select id="new-user-department" name="department_id" required className={field}>
              <option value="">בחירה</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <button disabled={pending} className="rounded-lg bg-accent px-4 py-2 font-medium text-surface disabled:opacity-60">
          {pending ? "מוסיף…" : "הוסף משתמש"}
        </button>
      </div>
      {state.error ? (
        <p role="alert" className="rounded-lg bg-sunken px-3 py-2 text-sm font-medium">
          {state.error}
        </p>
      ) : null}
      {state.ok ? <p className="text-sm text-muted">{state.ok}</p> : null}
    </form>
  );
}
