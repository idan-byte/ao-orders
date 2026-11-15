import Link from "next/link";
import { Suspense } from "react";
import { query } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { getMenu, menuWeeks } from "@/lib/menu-core";
import { CELL_CATEGORIES, WEEKDAYS } from "@/lib/menu-parse-core";
import { ActionForm } from "@/components/action-form";
import { Loading } from "@/components/loading";
import { NoAccess } from "@/components/no-access";
import { clearWarningsAction, extendCycleAction, menuDayAction, updateMenuAction, weekStartsAction } from "../../menu-actions";

const panel = "rounded-xl border border-line bg-surface p-4";
const field = "rounded-lg border border-line bg-surface px-3 py-2 text-foreground";
const label = "flex flex-col gap-1 text-sm text-muted";
const small = "rounded-lg border border-line px-3 py-1.5 text-sm";
const dayFmt = new Intl.DateTimeFormat("he-IL", { timeZone: "UTC", day: "2-digit", month: "2-digit", year: "numeric" });
const il = (iso: string) => dayFmt.format(new Date(iso)).replace(/\./g, "/");

// One menu: its details, and the cycle week by week: a column per weekday and a row per category.
export default function MenuPage({ params, searchParams }: PageProps<"/hotfood/menus/[id]">) {
  return (
    <Suspense fallback={<Loading />}>
      <Menu params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function Menu({ params, searchParams }: Pick<PageProps<"/hotfood/menus/[id]">, "params" | "searchParams">) {
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
  const sp = await searchParams;
  const weeks = await menuWeeks(query, menu.id);
  const wanted = typeof sp.week === "string" && /^\d$/.test(sp.week) ? Number(sp.week) : 1;
  const week = weeks.find((w) => w.weekNo === wanted) ?? weeks[0];
  const editing = manage && typeof sp.edit === "string" && /^[0-5]$/.test(sp.edit) ? Number(sp.edit) : null;
  // Friday is shown only when the menu has something on it, or when it is being edited.
  const shownDays = WEEKDAYS.map((_, i) => i).filter((i) => i < 5 || editing === i || weeks.some((w) => w.days[i].note || Object.keys(w.days[i].cells).length > 0));
  const categories = CELL_CATEGORIES.filter((c) => c.key !== "other" || weeks.some((w) => w.days.some((d) => d.cells.other)));
  const institutions = await query<{ id: number; name: string; symbol: string }>("select id, name, symbol from institutions where menu_id = $1 order by name", [menu.id]);
  const href = (w: number, edit?: number) => `/hotfood/menus/${menu.id}?week=${w}${edit === undefined ? "" : `&edit=${edit}`}`;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-2xl font-bold">
          {menu.name} {menu.active ? null : <span className="text-lg font-normal text-muted">· מושבת</span>}
        </h1>
        <Link href="/hotfood/menus" className={small}>
          כל התפריטים
        </Link>
      </div>
      <p className="text-muted" id="menu-summary">
        מחזור של {menu.weeks} שבועות
        {menu.period ? ` · ${menu.period}` : ""}
        {menu.approvedBy ? ` · אושר על ידי ${menu.approvedBy}` : ""}
        {menu.approvedOn ? ` בתאריך ${il(menu.approvedOn)}` : ""}
        {menu.sourceFile ? (
          <>
            {" · מהקובץ "}
            <span dir="auto">{menu.sourceFile}</span>
          </>
        ) : null}
      </p>

      {menu.uploadWarnings ? (
        <section className={`${panel} border-2`} id="menu-warnings">
          <h2 className="font-display text-lg font-bold">לבדיקה אחרי ההעלאה</h2>
          <p className="mt-1 whitespace-pre-line">{menu.uploadWarnings}</p>
          {manage ? (
            <div className="mt-2">
              <ActionForm action={clearWarningsAction} submit="בדקתי" primary={false}>
                <input type="hidden" name="menu_id" value={menu.id} />
              </ActionForm>
            </div>
          ) : null}
        </section>
      ) : null}

      <section className={panel} id="menu-week">
        <div className="mb-3 flex flex-wrap items-center gap-2" id="week-tabs">
          {weeks.map((w) => (
            <Link key={w.weekNo} href={href(w.weekNo)} data-week={w.weekNo} aria-current={w.weekNo === week.weekNo ? "page" : undefined} className={`${small} ${w.weekNo === week.weekNo ? "bg-sunken font-bold" : ""}`}>
              שבוע {w.weekNo}
            </Link>
          ))}
        </div>
        <p className="mb-3 text-sm" id="week-dates">
          {week.starts.length === 0 ? "לשבוע הזה עוד לא נקבעו תאריכים." : `חל בשבועות שמתחילים ב: ${week.starts.map(il).join(" · ")}`}
        </p>

        {editing !== null ? (
          <div id="day-edit">
            <h2 className="mb-2 font-display text-lg font-bold">
              שבוע {week.weekNo} · יום {WEEKDAYS[editing]}
            </h2>
            <ActionForm action={menuDayAction} submit="שמור יום" className="flex flex-col items-start gap-3">
              <input type="hidden" name="menu_id" value={menu.id} />
              <input type="hidden" name="week" value={week.weekNo} />
              <input type="hidden" name="weekday" value={editing} />
              <label className={`${label} w-full max-w-xl`}>
                הערת היום (למשל: שוברת שגרה לבתי ספר בלבד)
                <input name="note" maxLength={200} defaultValue={week.days[editing].note ?? ""} className={field} />
              </label>
              {CELL_CATEGORIES.map((c) => (
                <div key={c.key} className="flex w-full max-w-3xl flex-wrap items-start gap-3">
                  <label className={`${label} min-w-64 flex-1`}>
                    {c.label}
                    <textarea name={`text_${c.key}`} rows={c.key === "vegetable" ? 4 : 2} maxLength={600} defaultValue={week.days[editing].cells[c.key]?.text ?? ""} className={field} />
                  </label>
                  {c.sku ? (
                    <label className={`${label} w-48`}>
                      מק״ט
                      <input name={`sku_${c.key}`} maxLength={80} dir="auto" defaultValue={week.days[editing].cells[c.key]?.sku ?? ""} className={field} />
                    </label>
                  ) : null}
                </div>
              ))}
              <p className="text-sm text-muted">שורה לכל הנחיה. הבדל בין גנים, בתי ספר או יישוב נכתב כמו במסמך: ״גנים: …״ בשורה אחת, ״בתי ספר: …״ בשורה הבאה.</p>
            </ActionForm>
            <Link href={href(week.weekNo)} className={`${small} mt-2 inline-block`}>
              ביטול
            </Link>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[56rem] border-collapse text-start text-sm" id="menu-grid">
              <thead>
                <tr>
                  <th className="w-28 border border-line bg-sunken p-2 text-start">שבוע {week.weekNo}</th>
                  {shownDays.map((d) => (
                    <th key={d} data-day-head={d} className="border border-line bg-sunken p-2 text-start align-top">
                      <div className="flex items-baseline justify-between gap-2">
                        <span>{WEEKDAYS[d]}</span>
                        {manage ? (
                          <Link href={href(week.weekNo, d)} className="font-normal underline" data-edit-day={d}>
                            עריכה
                          </Link>
                        ) : null}
                      </div>
                      {week.days[d].note ? <div className="mt-1 font-bold">{week.days[d].note}</div> : null}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {categories.map((c) => (
                  <tr key={c.key} data-category={c.key}>
                    <th className="border border-line bg-sunken p-2 text-start align-top">{c.label}</th>
                    {shownDays.map((d) => {
                      const cell = week.days[d].cells[c.key];
                      return (
                        <td key={d} data-cell={`${d}-${c.key}`} className="border border-line p-2 align-top">
                          {cell ? <div className="whitespace-pre-line">{cell.text}</div> : <span className="text-muted">–</span>}
                          {cell?.sku ? (
                            <div className="mt-1 text-muted" data-sku>
                              מק״ט <span dir="auto">{cell.sku}</span>
                            </div>
                          ) : null}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {manage && editing === null ? (
        <section className={panel} id="menu-dates">
          <h2 className="font-display text-lg font-bold">התאריכים של שבוע {week.weekNo}</h2>
          <p className="mb-3 mt-1 text-sm text-muted">תאריך אחד מכל שבוע קלנדרי שבו חל השבוע הזה של המחזור (יום/חודש/שנה), מופרדים ברווח או בשורה חדשה. שבוע קלנדרי שהיה שייך לשבוע אחר במחזור עובר לכאן.</p>
          <ActionForm action={weekStartsAction} submit="שמור תאריכים" primary={false}>
            <input type="hidden" name="menu_id" value={menu.id} />
            <input type="hidden" name="week" value={week.weekNo} />
            <label className={label}>
              שבועות
              <textarea name="dates" rows={3} dir="ltr" defaultValue={week.starts.map(il).join("\n")} className={`${field} w-56`} />
            </label>
          </ActionForm>
          <h3 className="mb-1 mt-4 font-bold">המשך המחזור</h3>
          <p className="mb-2 text-sm text-muted">אחרי השבוע האחרון שיש לו תאריך, השבועות ממשיכים בתור (1, 2, 3, 4 וחוזר חלילה) עד התאריך שנבחר.</p>
          <ActionForm action={extendCycleAction} submit="המשך את המחזור" primary={false}>
            <input type="hidden" name="menu_id" value={menu.id} />
            <label className={label}>
              עד תאריך
              <input name="until" type="date" required className={field} />
            </label>
          </ActionForm>
        </section>
      ) : null}

      {editing === null ? (
        <section className={panel} id="menu-details">
          <h2 className="mb-2 font-display text-lg font-bold">פרטי התפריט והנחיות</h2>
          {manage ? (
            <ActionForm action={updateMenuAction} submit="שמור פרטים" primary={false} className="flex flex-col items-start gap-3">
              <input type="hidden" name="menu_id" value={menu.id} />
              <div className="flex flex-wrap gap-3">
                <label className={label}>
                  שם
                  <input name="name" required maxLength={120} defaultValue={menu.name} className={`${field} w-80`} />
                </label>
                <label className={label}>
                  תקופה
                  <input name="period" maxLength={80} defaultValue={menu.period ?? ""} className={`${field} w-56`} />
                </label>
                <label className={label}>
                  אושר על ידי
                  <input name="approved_by" maxLength={80} defaultValue={menu.approvedBy ?? ""} className={`${field} w-48`} />
                </label>
                <label className={label}>
                  תאריך האישור
                  <input name="approved_on" type="date" defaultValue={menu.approvedOn ?? ""} className={field} />
                </label>
              </div>
              <label className={`${label} w-full`}>
                דגשים והנחיות מהמסמך
                <textarea name="notes" rows={8} maxLength={8000} defaultValue={menu.notes ?? ""} className={field} />
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input name="active" type="checkbox" defaultChecked={menu.active} />
                תפריט פעיל (אפשר לשייך אליו מוסדות)
              </label>
            </ActionForm>
          ) : (
            <p className="whitespace-pre-line">{menu.notes ?? "אין הנחיות."}</p>
          )}
        </section>
      ) : null}

      {editing === null ? (
        <section className={panel} id="menu-institutions">
          <h2 className="mb-2 font-display text-lg font-bold">{institutions.length} מוסדות בתפריט הזה</h2>
          {institutions.length === 0 ? (
            <p className="text-sm text-muted">
              משייכים מוסד לתפריט בכרטיס המוסד, ב
              <Link href="/hotfood/institutions" className="underline">
                מסך המוסדות
              </Link>
              .
            </p>
          ) : (
            <ul className="flex flex-wrap gap-x-4 gap-y-1">
              {institutions.map((i) => (
                <li key={i.id}>
                  <Link href={`/hotfood/institutions/${i.id}`} className="underline">
                    {i.name}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </div>
  );
}
