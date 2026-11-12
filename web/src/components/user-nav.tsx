import Link from "next/link";
import { getCurrentUser } from "@/lib/auth";
import { can, isRole, ROLES, type Permission } from "@/lib/permissions";
import { signOutAction } from "@/app/login/actions";

const NAV: { href: string; label: string; permission: Permission }[] = [
  { href: "/", label: "דשבורד", permission: "dashboard.view" },
  { href: "/sales", label: "מכירות", permission: "leads.view" },
  { href: "/quotes", label: "הצעות מחיר", permission: "quotes.view" },
  { href: "/orders", label: "הזמנות", permission: "orders.view" },
  { href: "/production", label: "ייצור", permission: "production.view" },
  { href: "/customers", label: "לקוחות", permission: "customers.view" },
  { href: "/catalog", label: "קטלוג", permission: "catalog.view" },
  { href: "/users", label: "משתמשים", permission: "users.manage" },
];

/** Navigation and the signed-in user. Reads the session, so the layout renders it behind <Suspense>. */
export async function UserNav() {
  const user = await getCurrentUser();
  if (!user) return null;
  return (
    <>
      <nav className="flex min-w-0 flex-1 gap-1 overflow-x-auto" aria-label="מסכים">
        {NAV.filter((n) => can(user.role, n.permission)).map((n) => (
          <Link key={n.href} href={n.href} className="whitespace-nowrap rounded-lg px-3 py-2 text-muted hover:bg-accent-soft hover:text-accent">
            {n.label}
          </Link>
        ))}
      </nav>
      <form action={signOutAction} className="flex items-center gap-3 text-sm text-muted">
        <span>
          {user.fullName} · {isRole(user.role) ? ROLES[user.role] : user.role}
        </span>
        <button className="rounded-lg border border-line px-3 py-1.5 text-foreground">יציאה</button>
      </form>
    </>
  );
}
