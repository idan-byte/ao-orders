import Link from "next/link";
import { Suspense } from "react";
import { query } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { dayByMealType, milgamDays, recentImports, type FileProblem, type Held } from "@/lib/milgam-core";
import { ActionForm } from "@/components/action-form";
import { LiveRefresh } from "@/components/live-refresh";
import { Loading } from "@/components/loading";
import { NoAccess } from "@/components/no-access";
import { importMilgamAction } from "../actions";

const panel = "rounded-xl border border-line bg-surface p-4";
const field = "rounded-lg border border-line bg-surface px-3 py-2 text-foreground";
const label = "flex flex-col gap-1 text-sm text-muted";
const nf = new Intl.NumberFormat("he-IL");
const dayFmt = new Intl.DateTimeFormat("he-IL", { timeZone: "UTC", weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" });
const stamp = new Intl.DateTimeFormat("he-IL", { timeZone: "Asia/Jerusalem", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const KIND = { forecast: "צפי", daily: "הזמנה יומית" } as const;
const isDay = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const diff = (n: number) => (n > 0 ? `+${nf.format(n)}` : n < 0 ? `−${nf.format(-n)}` : "0");

export default function MilgamPage({ searchParams }: PageProps<"/hotfood/milgam">) {
  return (
    <>
      <LiveRefresh />
      <Suspense fallback={<Loading />}>
        <Milgam searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function Milgam({ searchParams }: Pick<PageProps<"/hotfood/milgam">, "searchParams">) {
  const { user, allowed } = await requirePermission("hotfood.view");
  if (!allowed) return <NoAccess />;
  const manage = can(user.role, "hotfood.manage");
  const days = await milgamDays(query, 45);
  const imports = await recentImports(query, 8);
  const wanted = (await searchParams).day;
  const day = isDay(wanted) ? wanted : (days[0]?.day ?? null);
  const meals = day ? await dayByMealType(query, day) : [];
  const ordered = meals.some((m) => m.ordered !== null);
  const unmapped = meals.filter((m) => !m.sku).length;
  // What the latest load left out, so it is looked at and not forgotten.
  const [last] = imports.length > 0 ? await query<{ held: { rows: Held[]; problems: FileProblem[] } | null }>("select held from milgam_imports where id = $1", [imports[0].id]) : [];
  const heldRows = last?.held?.rows ?? [];
  const problems = last?.held?.problems ?? [];

  return (
    <div className="flex flex-col gap-4">
      <h1 className="font-display text-2xl font-bold">מילגם · צפי והזמנה יומית</h1>

      {manage ? (
        <section className={panel} id="milgam-upload">
          <h2 className="font-display text-lg font-bold">טעינת קובץ</h2>
          <p className="mb-3 mt-1 text-sm text-muted">קובץ האקסל כפי שהוא יורד ממילגם: שורה לכל מוסד, כיתה וסוג מנה, ועמודת כמות לכל תאריך. טעינה חוזרת של אותם ימים מעדכנת אותם ואינה מכפילה.</p>
          <ActionForm action={importMilgamAction} submit="טען קובץ" pendingLabel="טוען…">
            <label className={label}>
              סוג הקובץ
              <select name="kind" defaultValue="forecast" className={field}>
                <option value="forecast">צפי</option>
                <option value="daily">הזמנה יומית</option>
              </select>
            </label>
            <label className={label}>
              קובץ אקסל (xlsx)
              <input name="file" type="file" required accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className={field} />
            </label>
            <label className="flex items-center gap-2 pb-2 text-sm">
              <input name="add_new" type="checkbox" />
              להוסיף למערכת מוסדות וסוגי מנה חדשים שבקובץ
            </label>
          </ActionForm>
          <p className="mt-2 text-sm text-muted">בלי הסימון, שורה שהמוסד או סוג המנה שלה אינם מוכרים למערכת לא נקלטת ומוצגת כאן לבדיקה. כיתה חדשה במוסד מוכר נוספת מעצמה.</p>
        </section>
      ) : null}

      {heldRows.length + problems.length > 0 ? (
        <section className={`${panel} border-2`} id="milgam-held">
          <h2 className="font-display text-lg font-bold">
            {heldRows.length + problems.length} שורות לא נקלטו בטעינה האחרונה
          </h2>
          <p className="mb-2 mt-1 text-sm text-muted">
            הקובץ: <span dir="auto">{imports[0].fileName}</span>. המנות שבשורות האלה אינן נספרות עד שהקובץ ייטען שוב אחרי התיקון.
          </p>
          <ul className="flex flex-col gap-1">
            {heldRows.slice(0, 60).map((h) => (
              <li key={h.line} data-held={h.symbol}>
                שורה {h.line} · {h.name} ({h.symbol}) · {h.className} · {h.mealType} · {nf.format(h.portions)} מנות · <b>{h.reason}</b>
              </li>
            ))}
            {problems.slice(0, 60).map((p) => (
              <li key={`p${p.line}`} data-problem={p.line}>
                שורה {p.line} · <b>{p.reason}</b>
              </li>
            ))}
          </ul>
          {heldRows.length > 60 || problems.length > 60 ? <p className="mt-2 text-sm text-muted">מוצגות 60 הראשונות מכל סוג.</p> : null}
        </section>
      ) : null}

      <section className={panel} id="milgam-days">
        <h2 className="mb-2 font-display text-lg font-bold">ימים</h2>
        {days.length === 0 ? (
          <p className="text-muted">עוד לא נטען קובץ.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-start">
              <thead className="text-sm text-muted">
                <tr>
                  <th className="py-1 text-start font-normal">יום</th>
                  <th className="py-1 text-start font-normal">מוסדות</th>
                  <th className="py-1 text-start font-normal">מסגרות</th>
                  <th className="py-1 text-start font-normal">צפי</th>
                  <th className="py-1 text-start font-normal">הזמנה</th>
                  <th className="py-1 text-start font-normal">הפרש</th>
                </tr>
              </thead>
              <tbody>
                {days.map((d) => (
                  <tr key={d.day} data-day={d.day} className={`border-t border-line tabular-nums ${d.day === day ? "font-bold" : ""}`}>
                    <td className="py-1.5">
                      <Link href={`/hotfood/milgam?day=${d.day}`} className="underline">
                        {dayFmt.format(new Date(d.day))}
                      </Link>
                    </td>
                    <td>{d.institutions}</td>
                    <td>{d.groups}</td>
                    <td data-forecast>{d.forecast > 0 ? nf.format(d.forecast) : "–"}</td>
                    <td data-ordered>{d.ordered === null ? "טרם נטענה" : nf.format(d.ordered)}</td>
                    <td data-diff>{d.ordered === null || d.forecast === 0 ? "" : diff(d.ordered - d.forecast)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {day && meals.length > 0 ? (
        <section className={panel} id="milgam-day">
          <h2 className="font-display text-lg font-bold">{dayFmt.format(new Date(day))} לפי סוג מנה</h2>
          <p className="mb-2 mt-1 text-sm text-muted">
            {ordered ? "ההזמנה היומית נטענה ליום הזה." : "ליום הזה יש צפי בלבד."}
            {unmapped > 0 ? (
              <>
                {" "}
                {unmapped} סוגי מנה עוד לא שויכו למק״ט, ב
                <Link href="/hotfood/meal-types" className="underline">
                  מסך סוגי המנה
                </Link>
                .
              </>
            ) : null}
          </p>
          <table className="w-full text-start">
            <thead className="text-sm text-muted">
              <tr>
                <th className="py-1 text-start font-normal">סוג מנה</th>
                <th className="py-1 text-start font-normal">מק״ט</th>
                <th className="py-1 text-start font-normal">צפי</th>
                {ordered ? <th className="py-1 text-start font-normal">הזמנה</th> : null}
                {ordered ? <th className="py-1 text-start font-normal">הפרש</th> : null}
              </tr>
            </thead>
            <tbody>
              {meals.map((m) => (
                <tr key={m.mealType} data-meal={m.mealType} className="border-t border-line tabular-nums">
                  <td className="py-1.5">{m.mealType}</td>
                  <td>{m.sku ?? "–"}</td>
                  <td>{nf.format(m.forecast)}</td>
                  {ordered ? <td>{nf.format(m.ordered ?? 0)}</td> : null}
                  {ordered ? <td>{diff((m.ordered ?? 0) - m.forecast)}</td> : null}
                </tr>
              ))}
              <tr className="border-t-2 border-line font-bold tabular-nums" data-meal-total>
                <td className="py-1.5">סך הכול</td>
                <td />
                <td>{nf.format(meals.reduce((a, m) => a + m.forecast, 0))}</td>
                {ordered ? <td>{nf.format(meals.reduce((a, m) => a + (m.ordered ?? 0), 0))}</td> : null}
                {ordered ? <td>{diff(meals.reduce((a, m) => a + (m.ordered ?? 0) - m.forecast, 0))}</td> : null}
              </tr>
            </tbody>
          </table>
        </section>
      ) : null}

      <section className={panel} id="milgam-imports">
        <h2 className="mb-2 font-display text-lg font-bold">טעינות אחרונות</h2>
        {imports.length === 0 ? (
          <p className="text-muted">אין עדיין טעינות.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {imports.map((i) => (
              <li key={i.id} data-import={i.kind} className="tabular-nums">
                {stamp.format(new Date(i.uploadedAt))} · <b>{KIND[i.kind]}</b> · <span dir="auto">{i.fileName}</span> · {nf.format(i.portions)} מנות
                {i.dayFrom ? ` · ${i.dayFrom === i.dayTo ? dayFmt.format(new Date(i.dayFrom)) : `${dayFmt.format(new Date(i.dayFrom))} עד ${dayFmt.format(new Date(i.dayTo!))}`}` : ""}
                {i.by ? ` · ${i.by}` : ""}
                {i.held + i.problems > 0 ? <b> · {i.held + i.problems} שורות לא נקלטו</b> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
