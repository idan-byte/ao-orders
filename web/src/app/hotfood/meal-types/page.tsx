import { Suspense } from "react";
import { query } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { listMealTypes } from "@/lib/milgam-core";
import { ActionForm } from "@/components/action-form";
import { Loading } from "@/components/loading";
import { NoAccess } from "@/components/no-access";
import { AGE_GROUPS, DIETS } from "@/lib/menu-core";
import { mealTypeSkuAction } from "../actions";
import { mealTypeGroupAction } from "../menu-actions";

const panel = "rounded-xl border border-line bg-surface p-4";
const field = "rounded-lg border border-line bg-surface px-3 py-2 text-foreground";

// Milgam's meal types, each mapped once to the Hashavshevet item it is billed as.
export default function MealTypesPage() {
  return (
    <Suspense fallback={<Loading />}>
      <MealTypes />
    </Suspense>
  );
}

async function MealTypes() {
  const { user, allowed } = await requirePermission("hotfood.view");
  if (!allowed) return <NoAccess />;
  const manage = can(user.role, "hotfood.manage");
  const list = await listMealTypes(query);
  // Hot food items of the catalogue (sort group 600), as synced from Hashavshevet.
  const products = await query<{ sku: string; name: string }>("select sku, name from products where sort_group = 600 and hash_active order by name, sku");
  const unmapped = list.filter((m) => !m.sku).length;
  const ungrouped = list.filter((m) => !m.ageGroup).length;

  return (
    <div className="flex flex-col gap-4">
      <h1 className="font-display text-2xl font-bold">סוגי מנה</h1>
      <p className="text-muted" id="meal-types-summary">
        {list.length} סוגי מנה מקובצי מילגם · {unmapped} עוד לא שויכו למק״ט בחשבשבת · {ungrouped} בלי קבוצת גיל
      </p>
      <section className={panel}>
        {list.length === 0 ? (
          <p>עוד אין סוגי מנה. הם נוצרים בטעינת קובץ מילגם.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {list.map((m) => (
              <li key={m.id} data-meal-type={m.name} data-sku={m.sku ?? ""} data-age-group={m.ageGroup ?? ""} data-diet={m.diet} className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3 last:border-0 last:pb-0">
                <span className="font-medium">{m.name}</span>
                {manage ? (
                  <ActionForm action={mealTypeSkuAction} submit="שמור" primary={false} className="flex flex-wrap items-center gap-2">
                    <input type="hidden" name="meal_type_id" value={m.id} />
                    <select name="sku" defaultValue={m.sku ?? ""} aria-label={`מק״ט עבור ${m.name}`} className={`${field} max-w-72`}>
                      <option value="">לא שויך</option>
                      {m.sku && !products.some((p) => p.sku === m.sku) ? <option value={m.sku}>{`${m.sku} · ${m.product ?? ""}`}</option> : null}
                      {products.map((p) => (
                        <option key={p.sku} value={p.sku}>
                          {p.sku} · {p.name}
                        </option>
                      ))}
                    </select>
                  </ActionForm>
                ) : (
                  <span className="text-muted">{m.sku ? `${m.sku} · ${m.product ?? ""}` : "לא שויך"}</span>
                )}
                {manage ? (
                  <ActionForm action={mealTypeGroupAction} submit="שמור" primary={false} className="flex flex-wrap items-center gap-2">
                    <input type="hidden" name="meal_type_id" value={m.id} />
                    <select name="age_group" defaultValue={m.ageGroup ?? ""} aria-label={`קבוצת גיל עבור ${m.name}`} className={field}>
                      <option value="">בלי קבוצת גיל</option>
                      {AGE_GROUPS.map((g) => (
                        <option key={g.key} value={g.key}>
                          {g.label}
                        </option>
                      ))}
                    </select>
                    <select name="diet" defaultValue={m.diet} aria-label={`תזונה עבור ${m.name}`} className={field}>
                      {DIETS.map((d) => (
                        <option key={d.key} value={d.key}>
                          {d.label}
                        </option>
                      ))}
                    </select>
                  </ActionForm>
                ) : (
                  <span className="text-muted">
                    {AGE_GROUPS.find((g) => g.key === m.ageGroup)?.label ?? "בלי קבוצת גיל"} · {DIETS.find((d) => d.key === m.diet)?.label}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      <p className="text-sm text-muted">ברשימה מופיעים פריטי ״הזנה חמה״ מהקטלוג (קבוצת מיון 600). השיוך קובע לפי איזה מק״ט תחויב כל מנה; הוא אינו קובע מחיר. קבוצת הגיל והתזונה (רגיל, צמחוני, ללא אלרגנים) מנוחשות משם סוג המנה ואפשר לתקן אותן; לפיהן הדוח היומי למטבח מחלק את המנות.</p>
    </div>
  );
}
