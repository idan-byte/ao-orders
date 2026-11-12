import { getCurrentUser } from "@/lib/auth";
import { can, isRole, ROLES, type Permission } from "@/lib/permissions";
import { signOutAction } from "@/app/login/actions";
import { NavLink, NavMenu } from "@/components/nav-menu";

type Entry = { href: string; label: string; permission: Permission };

// The top bar: the dashboard, then two groups. A person sees only the screens their role allows;
// a group with a single allowed screen is shown as that screen itself, without a list to open.
const GROUPS: { label: string; items: Entry[] }[] = [
  {
    label: "מכירות",
    items: [
      { href: "/sales", label: "לידים ופניות", permission: "leads.view" },
      { href: "/quotes", label: "הצעות מחיר", permission: "quotes.view" },
      { href: "/orders", label: "הזמנות", permission: "orders.view" },
      { href: "/standing", label: "קבועות", permission: "orders.view" },
      { href: "/customers", label: "לקוחות", permission: "customers.view" },
      { href: "/catalog", label: "קטלוג", permission: "catalog.view" },
    ],
  },
  {
    label: "ייצור",
    items: [
      { href: "/production", label: "תוכנית ייצור", permission: "production.view" },
      { href: "/shipping", label: "שילוח", permission: "shipping.manage" },
      { href: "/drive", label: "טעינה והפצה", permission: "shipping.ship" },
    ],
  },
];
// Behind the cog next to the sign-out button.
const SETTINGS: Entry[] = [
  { href: "/users", label: "משתמשים", permission: "users.manage" },
  { href: "/letterheads", label: "דפי לוגו", permission: "settings.manage" },
  { href: "/communication", label: "ניהול תקשורת", permission: "settings.manage" },
];

/** Navigation and the signed-in user. Reads the session, so the layout renders it behind <Suspense>. */
export async function UserNav() {
  const user = await getCurrentUser();
  if (!user) return null;
  const allowed = (items: Entry[]) => items.filter((i) => can(user.role, i.permission)).map(({ href, label }) => ({ href, label }));
  const settings = allowed(SETTINGS);
  return (
    <>
      <nav className="flex min-w-0 flex-1 flex-wrap gap-1" aria-label="מסכים">
        {can(user.role, "dashboard.view") ? <NavLink href="/" label="דשבורד" /> : null}
        {GROUPS.map((g) => {
          const items = allowed(g.items);
          if (items.length === 0) return null;
          return items.length === 1 ? <NavLink key={g.label} {...items[0]} /> : <NavMenu key={g.label} label={g.label} items={items} />;
        })}
      </nav>
      <div className="flex items-center gap-3 text-sm text-muted">
        <span>
          {user.fullName} · {isRole(user.role) ? ROLES[user.role] : user.role}
        </span>
        {settings.length > 0 ? (
          <nav aria-label="הגדרות">
            <NavMenu label="הגדרות" items={settings} gear />
          </nav>
        ) : null}
        <form action={signOutAction}>
          <button className="rounded-lg border border-line px-3 py-1.5 text-foreground">יציאה</button>
        </form>
      </div>
    </>
  );
}
