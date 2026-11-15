import Link from "next/link";
import { Suspense } from "react";
import { query } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { getMenu } from "@/lib/menu-core";
import { COOK_CATEGORIES, menuPhrases } from "@/lib/menu-cook-core";
import { CELL_CATEGORIES } from "@/lib/menu-parse-core";
import { ActionForm } from "@/components/action-form";
import { Loading } from "@/components/loading";
import { NoAccess } from "@/components/no-access";
import { phraseDishAction } from "../../../menu-actions";

const panel = "rounded-xl border border-line bg-surface p-4";
const field = "rounded-lg border border-line bg-surface px-3 py-2 text-foreground";
const small = "rounded-lg border border-line px-3 py-1.5 text-sm";
const categoryLabel = (key: string) => CELL_CATEGORIES.find((c) => c.key === key)?.label ?? key;

// What the menu's cells say, phrase by phrase, and the dish of the dish table each phrase is weighed by.
export default function PhrasesPage({ params }: PageProps<"/hotfood/menus/[id]/phrases">) {
  return (
    <Suspense fallback={<Loading />}>
      <Phrases params={params} />
    </Suspense>
  );
}

async function Phrases({ params }: Pick<PageProps<"/hotfood/menus/[id]/phrases">, "params">) {
  const { user, allowed } = await requirePermission("hotfood.view");
  if (!allowed) return <NoAccess />;
  const { id } = await params;
  const menu = /^\d{1,9}$/.test(id) ? await getMenu(query, Number(id)) : null;
  if (!menu) {
    return (
      <div className="flex flex-col items-start gap-3">
        <h1 className="font-display text-2xl font-bold">התפריט לא נמצא</h1>
        <Link href="/hotfood/menus" className={small}>
          חזרה לתפריטים
        </Link>
      </div>
    );
  }
  const manage = can(user.role, "hotfood.manage");
  const phrases = await menuPhrases(query, menu.id);
  const dishes = await query<{ id: number; code: number | null; category: string; name: string; weighed: boolean }>(
    "select id, code, category, name, (weight_gan is not null or weight_ab is not null or weight_gv is not null or weight_high is not null) as weighed from dishes where active order by name, id",
  );
  const untied = phrases.filter((p) => p.dishId === null).length;
  const unweighed = phrases.filter((p) => p.dishId !== null && !p.hasWeights).length;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-2xl font-bold">קישור למנות ומשקלים</h1>
        <Link href={`/hotfood/menus/${menu.id}`} className={small}>
          חזרה לתפריט
        </Link>
      </div>
      <p className="text-muted">{menu.name}</p>
      <p id="phrases-summary">
        {phrases.length} ביטויים בתפריט · {untied} עוד לא קושרו למנה · {unweighed} קושרו למנה שאין לה משקלים
      </p>
      <p className="text-sm text-muted">
        כל ביטוי שמופיע בתאי התפריט נקשר פעם אחת למנה מטבלת המנות, ומאז כל תא שכתוב בו אותו ביטוי נשקל לפי המשקלים שלה, בכל התפריטים. ביטוי שזהה בדיוק לשם של מנה אחת בקטגוריה שלו מזוהה לבד. שורה שמתחילה ב״גנים:״ או ״בתי ספר:״ נספרת רק לאוכלוסייה הזאת; כותרת אחרת (למשל ״גוננים:״) מוצגת בדוח אבל אינה נספרת.
      </p>

      <section className={panel} id="phrase-list">
        {phrases.length === 0 ? (
          <p className="text-muted">בתפריט עוד אין תאים.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {phrases.map((p) => {
              const options = dishes.filter((d) => COOK_CATEGORIES[p.category]?.includes(d.category));
              return (
                <li key={`${p.category}-${p.phrase}`} data-phrase={p.phrase} data-category={p.category} data-how={p.how ?? ""} className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3 last:border-0 last:pb-0">
                  <div>
                    <span className="text-sm text-muted">{categoryLabel(p.category)} · </span>
                    <span className="font-medium">{p.phrase}</span>
                    <span className="text-sm text-muted">
                      {" "}
                      · {p.cells} תאים
                      {p.scopes.includes("gan") ? " · גנים" : ""}
                      {p.scopes.includes("school") ? " · בתי ספר" : ""}
                      {p.scopes.includes("other") ? " · בתנאי שאינו נספר" : ""}
                    </span>
                    <div className="text-sm" data-state>
                      {p.dishId === null ? <b>לא קושר</b> : `${p.how === "tied" ? "קושר ל" : "זוהה לפי השם:"} ${p.dish}${p.code ? ` (${p.code})` : ""}${p.hasWeights ? "" : " · למנה אין משקלים"}`}
                    </div>
                  </div>
                  {manage ? (
                    <ActionForm action={phraseDishAction} submit="שמור" primary={false} className="flex flex-wrap items-center gap-2">
                      <input type="hidden" name="category" value={p.category} />
                      <input type="hidden" name="phrase" value={p.phrase} />
                      <select name="dish_id" defaultValue={p.how === "tied" ? (p.dishId ?? "") : ""} aria-label={`מנה עבור ${p.phrase}`} className={`${field} max-w-80`}>
                        <option value="">{p.how === "name" ? "לפי השם (בלי קישור ידני)" : "לא קושר"}</option>
                        {options.map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.name}
                            {d.code ? ` · ${d.code}` : ""}
                            {d.weighed ? "" : " · בלי משקלים"}
                          </option>
                        ))}
                      </select>
                    </ActionForm>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
