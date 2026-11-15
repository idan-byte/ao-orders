import Link from "next/link";
import { Suspense } from "react";
import { query } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { milgamDays } from "@/lib/milgam-core";
import { AGE_GROUPS, menuDayReport } from "@/lib/menu-core";
import { CELL_CATEGORIES, WEEKDAYS } from "@/lib/menu-parse-core";
import { Loading } from "@/components/loading";
import { NoAccess } from "@/components/no-access";

const panel = "rounded-xl border border-line bg-surface p-4";
const field = "rounded-lg border border-line bg-surface px-3 py-2 text-foreground";
const small = "rounded-lg border border-line px-3 py-1.5 text-sm";
const nf = new Intl.NumberFormat("he-IL");
const dayFmt = new Intl.DateTimeFormat("he-IL", { timeZone: "UTC", weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" });
const isDay = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(new Date(`${v}T00:00:00Z`).getTime());
const categoryLabel = (key: string) => CELL_CATEGORIES.find((c) => c.key === key)?.label ?? key;

// What the kitchen cooks on one day: for every menu, the day's plates by the menu's week of the cycle, and how many
// portions of each, split by age group.
export default function MenuDayPage({ searchParams }: PageProps<"/hotfood/menus/day">) {
  return (
    <Suspense fallback={<Loading />}>
      <MenuDay searchParams={searchParams} />
    </Suspense>
  );
}

async function MenuDay({ searchParams }: Pick<PageProps<"/hotfood/menus/day">, "searchParams">) {
  const { allowed } = await requirePermission("hotfood.view");
  if (!allowed) return <NoAccess />;
  const wanted = (await searchParams).day;
  const days = await milgamDays(query, 45);
  const day = isDay(wanted) ? wanted : (days[0]?.day ?? null);
  const report = day ? await menuDayReport(query, day) : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-2xl font-bold">דוח יומי למטבח</h1>
        <Link href="/hotfood/menus" className={small}>
          תפריטים
        </Link>
      </div>
      <form className="flex flex-wrap items-end gap-3" id="day-pick">
        <label className="flex flex-col gap-1 text-sm text-muted">
          יום
          <input name="day" type="date" defaultValue={day ?? ""} required className={field} />
        </label>
        <button className="rounded-lg border border-line px-4 py-2">הצג</button>
      </form>

      {!report || !day ? (
        <p className="text-muted">עוד לא נטען קובץ מילגם. בוחרים יום כדי לראות מה התפריט קובע לו.</p>
      ) : (
        <>
          <p id="day-summary">
            <b>{dayFmt.format(new Date(day))}</b> · {nf.format(report.total)} מנות · {report.ordered ? "לפי ההזמנה היומית" : "לפי הצפי (ההזמנה היומית עוד לא נטענה)"}
          </p>
          {report.menus.length === 0 ? <p className="text-muted">ליום הזה אין כמויות ממילגם.</p> : null}
          {report.menus.map((m) => (
            <section key={m.menuId ?? "none"} className={`${panel} ${m.menuId === null ? "border-2" : ""}`} data-day-menu={m.menu ?? ""}>
              <h2 className="font-display text-lg font-bold">
                {m.menuId === null ? (
                  "מוסדות בלי תפריט"
                ) : (
                  <Link href={`/hotfood/menus/${m.menuId}${m.weekNo ? `?week=${m.weekNo}` : ""}`} className="underline">
                    {m.menu}
                  </Link>
                )}
              </h2>
              <p className="text-sm text-muted" data-day-menu-summary>
                {m.menuId === null ? "" : m.weekNo ? `שבוע ${m.weekNo} במחזור, יום ${WEEKDAYS[report.weekday] ?? ""} · ` : "לתאריך הזה לא נקבע שבוע במחזור · "}
                {m.institutions} מוסדות · {nf.format(m.portions)} מנות
              </p>
              {m.menuId === null ? <p className="mt-1 font-bold">המנות האלה אינן משויכות לתפריט. משייכים תפריט בכרטיס המוסד.</p> : null}
              {m.note ? (
                <p className="mt-1 font-bold" data-day-note>
                  {m.note}
                </p>
              ) : null}

              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[44rem] border-collapse text-start text-sm">
                  <thead>
                    <tr>
                      <th className="border border-line bg-sunken p-2 text-start">מנה</th>
                      <th className="border border-line bg-sunken p-2 text-start">מה בה</th>
                      {AGE_GROUPS.map((g) => (
                        <th key={g.key} className="border border-line bg-sunken p-2 text-start">
                          {g.label}
                        </th>
                      ))}
                      {m.plates.some((p) => p.byAge.unknown > 0) ? <th className="border border-line bg-sunken p-2 text-start">בלי קבוצת גיל</th> : null}
                      <th className="border border-line bg-sunken p-2 text-start">סך הכול</th>
                    </tr>
                  </thead>
                  <tbody>
                    {m.plates.map((p) => (
                      <tr key={p.diet} data-plate={p.diet} className="tabular-nums">
                        <th className="border border-line p-2 text-start align-top">{p.label}</th>
                        <td className="border border-line p-2 align-top">
                          {p.parts.length === 0 ? (
                            <span className="text-muted">{m.menuId === null || !m.weekNo ? "–" : "התפריט ריק ליום הזה"}</span>
                          ) : (
                            <ul className="flex flex-col gap-1">
                              {p.parts.map((part) => (
                                <li key={part.category}>
                                  <span className="text-muted">{categoryLabel(part.category)}: </span>
                                  <span className="whitespace-pre-line">{part.text}</span>
                                  {part.sku ? (
                                    <span className="text-muted">
                                      {" "}
                                      · מק״ט <span dir="auto">{part.sku}</span>
                                    </span>
                                  ) : null}
                                </li>
                              ))}
                            </ul>
                          )}
                        </td>
                        {AGE_GROUPS.map((g) => (
                          <td key={g.key} data-age={g.key} className="border border-line p-2 align-top">
                            {p.byAge[g.key] > 0 ? nf.format(p.byAge[g.key]) : ""}
                          </td>
                        ))}
                        {m.plates.some((x) => x.byAge.unknown > 0) ? <td className="border border-line p-2 align-top font-bold">{p.byAge.unknown > 0 ? nf.format(p.byAge.unknown) : ""}</td> : null}
                        <td className="border border-line p-2 align-top font-bold" data-plate-total>
                          {nf.format(p.portions)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {m.plates.some((p) => p.byAge.unknown > 0) ? (
                <p className="mt-2 text-sm">
                  יש סוגי מנה בלי קבוצת גיל. קובעים אותה ב
                  <Link href="/hotfood/meal-types" className="underline">
                    מסך סוגי המנה
                  </Link>
                  .
                </p>
              ) : null}
              {m.extras.length > 0 ? (
                <ul className="mt-3 flex flex-col gap-1 text-sm" data-extras>
                  {m.extras.map((e) => (
                    <li key={e.category}>
                      <b>{categoryLabel(e.category)}: </b>
                      <span className="whitespace-pre-line">{e.text}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              <p className="mt-3 text-sm text-muted">לפי סוג מנה: {m.meals.map((x) => `${nf.format(x.quantity)} ${x.mealType}`).join(" · ")}</p>
            </section>
          ))}
        </>
      )}
    </div>
  );
}
