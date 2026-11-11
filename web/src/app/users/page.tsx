import { Suspense } from "react";
import { query } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { DEPARTMENT_ROLES, isRole, ROLES } from "@/lib/permissions";
import { Loading } from "@/components/loading";
import { NoAccess } from "@/components/no-access";
import { setUserActiveAction } from "./actions";
import { UserForm } from "./user-form";

type UserRow = { id: string; mobile: string; full_name: string; role: string; active: boolean; department: string | null };

export default function UsersPage() {
  return (
    <Suspense fallback={<Loading />}>
      <UsersContent />
    </Suspense>
  );
}

async function UsersContent() {
  const { user, allowed } = await requirePermission("users.manage");
  if (!allowed) return <NoAccess />;

  const users = await query<UserRow>(`
    select u.id::text, u.mobile, u.full_name, u.role::text, u.active, d.name as department
    from users u left join departments d on d.id = u.department_id
    where u.role <> 'customer'
    order by u.active desc, u.full_name`);
  const departments = await query<{ id: number; name: string }>("select id, name from departments order by name");
  const roles = Object.entries(ROLES)
    .filter(([value]) => value !== "customer")
    .map(([value, label]) => ({ value, label }));

  return (
    <div className="flex flex-col gap-4">
      <h1 className="font-display text-2xl font-bold">משתמשים</h1>
      <section className="rounded-xl border border-line bg-surface p-4">
        <h2 className="mb-3 font-display text-base font-bold">משתמש חדש</h2>
        <UserForm roles={roles} departments={departments} departmentRoles={[...DEPARTMENT_ROLES]} />
      </section>
      <section className="rounded-xl border border-line bg-surface p-4">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-line text-xs text-muted">
                <th className="px-2 py-1.5 text-start font-medium">שם</th>
                <th className="px-2 py-1.5 text-start font-medium">נייד</th>
                <th className="px-2 py-1.5 text-start font-medium">תפקיד</th>
                <th className="px-2 py-1.5 text-start font-medium">מחלקה</th>
                <th className="px-2 py-1.5 text-start font-medium">מצב</th>
                <th className="px-2 py-1.5" />
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className={`border-b border-line last:border-0 ${u.active ? "" : "text-muted"}`}>
                  <td className="px-2 py-2">{u.full_name}</td>
                  <td className="px-2 py-2 tabular-nums" dir="ltr">
                    {u.mobile}
                  </td>
                  <td className="px-2 py-2">{isRole(u.role) ? ROLES[u.role] : u.role}</td>
                  <td className="px-2 py-2">{u.department ?? ""}</td>
                  <td className="px-2 py-2">{u.active ? "פעיל" : "לא פעיל"}</td>
                  <td className="px-2 py-2 text-end">
                    {u.id === user.id ? (
                      <span className="text-sm text-muted">זה אתה</span>
                    ) : (
                      <form action={setUserActiveAction}>
                        <input type="hidden" name="user_id" value={u.id} />
                        <input type="hidden" name="active" value={u.active ? "false" : "true"} />
                        <button className="rounded-lg border border-line px-3 py-1 text-sm text-foreground">{u.active ? "השבת" : "הפעל"}</button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-sm text-muted">השבתת משתמש מנתקת אותו מיד מכל המכשירים. המשתמש אינו נמחק, כדי שההיסטוריה שלו תישמר.</p>
      </section>
    </div>
  );
}
