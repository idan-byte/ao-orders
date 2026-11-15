import Link from "next/link";
import { Suspense } from "react";
import { query } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { DISH_CATEGORIES, getDish, listDishes, type Dish } from "@/lib/dish-core";
import { ActionForm } from "@/components/action-form";
import { Loading } from "@/components/loading";
import { NoAccess } from "@/components/no-access";
import { dishAction } from "../menu-actions";

const panel = "rounded-xl border border-line bg-surface p-4";
const field = "rounded-lg border border-line bg-surface px-3 py-2 text-foreground";
const label = "flex flex-col gap-1 text-sm text-muted";
const small = "rounded-lg border border-line px-3 py-1.5 text-sm";
const PAGE = 50;
const categoryLabel = (key: string) => DISH_CATEGORIES.find((c) => c.key === key)?.label ?? key;

// The dish table: the portion weight of every dish per age group, in kilograms. It starts from Milgam's settings.
export default function DishesPage({ searchParams }: PageProps<"/hotfood/dishes">) {
  return (
    <Suspense fallback={<Loading />}>
      <Dishes searchParams={searchParams} />
    </Suspense>
  );
}

function DishForm({ dish }: { dish: Dish | null }) {
  const w = "w-24";
  return (
    <ActionForm action={dishAction} submit={dish ? "שמור מנה" : "הוסף מנה"} className="flex flex-col items-start gap-3">
      <input type="hidden" name="dish_id" value={dish?.id ?? ""} />
      <div className="flex flex-wrap gap-3">
        <label className={label}>
          קוד
          <input name="code" inputMode="numeric" defaultValue={dish?.code ?? ""} className={`${field} w-28`} />
        </label>
        <label className={label}>
          קטגוריה
          <select name="category" defaultValue={dish?.category ?? "main"} className={field}>
            {DISH_CATEGORIES.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label className={label}>
          שם
          <input name="name" required maxLength={120} defaultValue={dish?.name ?? ""} className={`${field} w-72`} />
        </label>
      </div>
      <div className="flex flex-wrap gap-3">
        <label className={label}>
          גן (ק״ג)
          <input name="weight_gan" inputMode="decimal" defaultValue={dish?.weightGan ?? ""} className={`${field} ${w}`} />
        </label>
        <label className={label}>
          א-ב (ק״ג)
          <input name="weight_ab" inputMode="decimal" defaultValue={dish?.weightAb ?? ""} className={`${field} ${w}`} />
        </label>
        <label className={label}>
          ג-ו (ק״ג)
          <input name="weight_gv" inputMode="decimal" defaultValue={dish?.weightGv ?? ""} className={`${field} ${w}`} />
        </label>
        <label className={label}>
          על יסודי (ק״ג)
          <input name="weight_high" inputMode="decimal" defaultValue={dish?.weightHigh ?? ""} className={`${field} ${w}`} />
        </label>
        <label className={label}>
          משקל בקופסת קילו
          <input name="kilo_box_weight" inputMode="decimal" defaultValue={dish?.kiloBoxWeight ?? ""} className={`${field} ${w}`} />
        </label>
        <label className={label}>
          יחס חומר גולמי (%)
          <input name="raw_ratio" inputMode="decimal" defaultValue={dish?.rawRatio ?? ""} className={`${field} ${w}`} />
        </label>
      </div>
      <div className="flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input name="routine_breaker" type="checkbox" defaultChecked={dish?.routineBreaker ?? false} />
          שובר שגרה
        </label>
        <label className="flex items-center gap-2">
          <input name="active" type="checkbox" defaultChecked={dish?.active ?? true} />
          מנה פעילה
        </label>
      </div>
    </ActionForm>
  );
}

async function Dishes({ searchParams }: Pick<PageProps<"/hotfood/dishes">, "searchParams">) {
  const { user, allowed } = await requirePermission("hotfood.view");
  if (!allowed) return <NoAccess />;
  const manage = can(user.role, "hotfood.manage");
  const sp = await searchParams;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const search = str(sp.q).slice(0, 60);
  const category = DISH_CATEGORIES.some((c) => c.key === str(sp.category)) ? str(sp.category) : "";
  const breakerOnly = str(sp.breaker) === "1";
  const page = /^\d{1,3}$/.test(str(sp.page)) ? Math.max(1, Number(str(sp.page))) : 1;
  const { dishes, total } = await listDishes(query, { search, category: category || undefined, breakerOnly, limit: PAGE, offset: (page - 1) * PAGE });
  const editing = manage && /^\d{1,9}$/.test(str(sp.edit)) ? await getDish(query, Number(str(sp.edit))) : null;
  const adding = manage && str(sp.add) === "1";
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const href = (over: Record<string, string>) => {
    const p = new URLSearchParams({ ...(search ? { q: search } : {}), ...(category ? { category } : {}), ...(breakerOnly ? { breaker: "1" } : {}), ...(page > 1 ? { page: String(page) } : {}), ...over });
    for (const [k, v] of [...p]) if (v === "") p.delete(k);
    const s = p.toString();
    return `/hotfood/dishes${s ? `?${s}` : ""}`;
  };
  const num = (v: string | null) => v ?? "–";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-2xl font-bold">טבלת מנות ומשקלים</h1>
        <div className="flex flex-wrap gap-2">
          {manage ? (
            <Link href={href({ add: "1", edit: "" })} className={small} id="dish-add-link">
              מנה חדשה
            </Link>
          ) : null}
          <Link href="/hotfood/menus" className={small}>
            תפריטים
          </Link>
        </div>
      </div>
      <p className="text-sm text-muted">משקל מנה בקילוגרמים לכל קבוצת גיל, לפי ההגדרות של מילגם. את המספרים אפשר לשנות כאן, וכל שינוי נרשם.</p>

      <form className="flex flex-wrap items-end gap-3" id="dish-filter">
        <label className={label}>
          חיפוש לפי שם או קוד
          <input name="q" defaultValue={search} maxLength={60} className={`${field} w-56`} />
        </label>
        <label className={label}>
          קטגוריה
          <select name="category" defaultValue={category} className={field}>
            <option value="">הכול</option>
            {DISH_CATEGORIES.filter((c) => c.key !== "other").map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 pb-2 text-sm">
          <input name="breaker" type="checkbox" value="1" defaultChecked={breakerOnly} />
          רק שובר שגרה
        </label>
        <button className="rounded-lg border border-line px-4 py-2">סנן</button>
      </form>

      {editing || adding ? (
        <section className={`${panel} border-2`} id="dish-edit">
          <h2 className="mb-3 font-display text-lg font-bold">{editing ? `עריכת מנה: ${editing.name}` : "מנה חדשה"}</h2>
          <DishForm key={editing?.id ?? "new"} dish={editing} />
          <Link href={href({ edit: "", add: "" })} className={`${small} mt-2 inline-block`}>
            סגור
          </Link>
        </section>
      ) : null}

      <section className={panel} id="dish-list">
        <p className="mb-2 text-sm text-muted" id="dish-count">
          {total} מנות{pages > 1 ? ` · עמוד ${page} מתוך ${pages}` : ""}
        </p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[52rem] text-start text-sm">
            <thead className="text-muted">
              <tr>
                <th className="py-1 text-start font-normal">קוד</th>
                <th className="py-1 text-start font-normal">קטגוריה</th>
                <th className="py-1 text-start font-normal">שם</th>
                <th className="py-1 text-start font-normal">גן</th>
                <th className="py-1 text-start font-normal">א-ב</th>
                <th className="py-1 text-start font-normal">ג-ו</th>
                <th className="py-1 text-start font-normal">על יסודי</th>
                <th className="py-1 text-start font-normal">קופסת קילו</th>
                <th className="py-1 text-start font-normal">חומר גולמי %</th>
                <th className="py-1 text-start font-normal">שובר שגרה</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {dishes.map((d) => (
                <tr key={d.id} data-dish={d.code ?? ""} className={`border-t border-line tabular-nums ${d.active ? "" : "text-muted"}`}>
                  <td className="py-1.5">{d.code ?? "–"}</td>
                  <td>{categoryLabel(d.category)}</td>
                  <td>
                    {d.name}
                    {d.active ? "" : " (לא פעילה)"}
                  </td>
                  <td data-w="gan">{num(d.weightGan)}</td>
                  <td data-w="ab">{num(d.weightAb)}</td>
                  <td data-w="gv">{num(d.weightGv)}</td>
                  <td data-w="high">{num(d.weightHigh)}</td>
                  <td>{num(d.kiloBoxWeight)}</td>
                  <td>{num(d.rawRatio)}</td>
                  <td>{d.routineBreaker ? "כן" : ""}</td>
                  <td>
                    {manage ? (
                      <Link href={href({ edit: String(d.id), add: "" })} className="underline" data-edit-dish>
                        עריכה
                      </Link>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {dishes.length === 0 ? <p className="mt-2 text-muted">לא נמצאו מנות.</p> : null}
        {pages > 1 ? (
          <div className="mt-3 flex flex-wrap gap-2" id="dish-pages">
            {page > 1 ? (
              <Link href={href({ page: String(page - 1), edit: "", add: "" })} className={small}>
                הקודם
              </Link>
            ) : null}
            {page < pages ? (
              <Link href={href({ page: String(page + 1), edit: "", add: "" })} className={small} id="dish-next">
                הבא
              </Link>
            ) : null}
          </div>
        ) : null}
      </section>
    </div>
  );
}
