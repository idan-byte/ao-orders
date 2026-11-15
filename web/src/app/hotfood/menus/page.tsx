import Link from "next/link";
import { Suspense } from "react";
import { query } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { listMenus } from "@/lib/menu-core";
import { ActionForm } from "@/components/action-form";
import { Loading } from "@/components/loading";
import { NoAccess } from "@/components/no-access";
import { createMenuAction, uploadMenuAction } from "../menu-actions";

const panel = "rounded-xl border border-line bg-surface p-4";
const field = "rounded-lg border border-line bg-surface px-3 py-2 text-foreground";
const label = "flex flex-col gap-1 text-sm text-muted";
const small = "rounded-lg border border-line px-3 py-1.5 text-sm";
const dayFmt = new Intl.DateTimeFormat("he-IL", { timeZone: "UTC", day: "2-digit", month: "2-digit", year: "numeric" });

// The menus of the hot kitchen: closed, cyclic menus approved by Milgam's dietitian. Every institution follows one.
export default function MenusPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Menus />
    </Suspense>
  );
}

async function Menus() {
  const { user, allowed } = await requirePermission("hotfood.view");
  if (!allowed) return <NoAccess />;
  const manage = can(user.role, "hotfood.manage");
  const menus = await listMenus(query);
  const [{ n: without }] = await query<{ n: number }>("select count(*)::int as n from institutions where active and menu_id is null");

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-2xl font-bold">תפריטים</h1>
        <div className="flex flex-wrap gap-2">
          <Link href="/hotfood/menus/day" className={small}>
            דוח יומי למטבח
          </Link>
          <Link href="/hotfood/dishes" className={small}>
            טבלת מנות ומשקלים
          </Link>
        </div>
      </div>
      <p className="text-muted" id="menus-summary">
        {menus.length} תפריטים · {without} מוסדות פעילים עוד בלי תפריט
      </p>

      {manage ? (
        <section className={panel} id="menu-upload">
          <h2 className="font-display text-lg font-bold">העלאת תפריט מאושר</h2>
          <p className="mb-3 mt-1 text-sm text-muted">קובץ ה-PDF של התפריט כפי שהוא מגיע מהתזונאית: טבלה לכל שבוע במחזור, עמודה לכל יום ושורה לכל קטגוריה. המערכת מקימה ממנו את התפריט עם השבועות, התאריכים, המק״טים וההערות, ואחר כך אפשר לתקן כל תא.</p>
          <ActionForm action={uploadMenuAction} submit="העלה והקם תפריט" pendingLabel="קורא את הקובץ…">
            <label className={label}>
              קובץ התפריט (PDF)
              <input name="file" type="file" required accept=".pdf,application/pdf" className={field} />
            </label>
            <label className={label}>
              שם התפריט (לא חובה)
              <input name="name" maxLength={120} placeholder="לפי כותרת המסמך" className={`${field} w-72`} />
            </label>
          </ActionForm>
        </section>
      ) : null}

      <section className={panel} id="menu-list">
        {menus.length === 0 ? (
          <p className="text-muted">עוד אין תפריטים.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {menus.map((m) => (
              <li key={m.id} data-menu={m.name} data-active={String(m.active)} className="flex flex-wrap items-baseline justify-between gap-3 border-b border-line pb-2 last:border-0 last:pb-0">
                <Link href={`/hotfood/menus/${m.id}`} className="font-medium underline">
                  {m.name}
                </Link>
                <span className="text-sm text-muted">
                  מחזור של {m.weeks} שבועות · {m.institutions} מוסדות
                  {m.lastWeek ? ` · תאריכים עד השבוע של ${dayFmt.format(new Date(m.lastWeek))}` : " · עוד בלי תאריכים"}
                  {m.active ? "" : " · מושבת"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {manage ? (
        <section className={panel} id="menu-new">
          <h2 className="mb-2 font-display text-lg font-bold">תפריט ריק</h2>
          <ActionForm action={createMenuAction} submit="צור תפריט" primary={false}>
            <label className={label}>
              שם
              <input name="name" required maxLength={120} className={`${field} w-72`} />
            </label>
            <label className={label}>
              שבועות במחזור
              <input name="weeks" type="number" min={1} max={8} defaultValue={4} className={`${field} w-24`} />
            </label>
          </ActionForm>
        </section>
      ) : null}
    </div>
  );
}
