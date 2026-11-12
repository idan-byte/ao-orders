import Link from "next/link";
import { Suspense } from "react";
import { query } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { lockedPlans, lockTimes, planRows, planSources, SHIFTS } from "@/lib/production-core";
import { ActionForm } from "@/components/action-form";
import { isIsoDate, resolveDepartment } from "@/lib/production-access";
import { LiveRefresh } from "@/components/live-refresh";
import { Loading } from "@/components/loading";
import { NoAccess } from "@/components/no-access";
import { PrintButton } from "@/components/print-button";
import { acknowledgeAction, lockAction, lockTimesAction, markAction, moveShiftAction, unlockAction } from "./actions";

const qty = new Intl.NumberFormat("he-IL", { maximumFractionDigits: 3 });
const dayFmt = new Intl.DateTimeFormat("he-IL", { timeZone: "UTC", weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" });
const stamp = new Intl.DateTimeFormat("he-IL", { timeZone: "Asia/Jerusalem", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const panel = "rounded-xl border border-line bg-surface p-4";
const field = "rounded-lg border border-line bg-surface px-3 py-2 text-foreground";

export default function ProductionPage({ searchParams }: PageProps<"/production">) {
  return (
    <>
      <LiveRefresh />
      <Suspense fallback={<Loading />}>
        <Production searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function Production({ searchParams }: { searchParams: PageProps<"/production">["searchParams"] }) {
  const { user, allowed } = await requirePermission("production.view");
  if (!allowed) return <NoAccess />;
  const sp = await searchParams;
  const [dates] = await query<{ today: string; tomorrow: string }>("select (now() at time zone 'Asia/Jerusalem')::date::text as today, ((now() at time zone 'Asia/Jerusalem')::date + 1)::text as tomorrow");
  const date = isIsoDate(sp.date) ? sp.date : dates.today;
  const { department, all, fixed } = await resolveDepartment(user, typeof sp.dept === "string" ? sp.dept : undefined);
  if (!department) return <p className="text-muted">עוד לא הוגדרו מחלקות ייצור. הן נוצרות בסנכרון הראשון מחשבשבת.</p>;

  const rows = await planRows(query, date, department.id);
  const sources = await planSources(query, date, department.id);
  const locks = await lockedPlans(query, date, department.id);
  const mayMark = can(user.role, "production.mark");
  const mayLock = can(user.role, "production.lock");
  const times = await lockTimes(query, department.id);
  const hidden = (shift?: number, sku?: string, variantId?: number | null) => (
    <>
      <input type="hidden" name="date" value={date} />
      <input type="hidden" name="department_id" value={department.id} />
      {shift !== undefined ? <input type="hidden" name="shift" value={shift} /> : null}
      {sku !== undefined ? <input type="hidden" name="sku" value={sku} /> : null}
      {sku !== undefined ? <input type="hidden" name="variant_id" value={variantId ?? ""} /> : null}
    </>
  );
  const link = (d: string, dept: number) => `/production?date=${d}&dept=${dept}`;
  const shiftsWithWork = SHIFTS.map((name, i) => ({ name, i, rows: rows.filter((r) => r.shift === i), lock: locks.find((l) => l.shift === i) })).filter((s) => s.rows.length > 0 || s.lock);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-2xl font-bold">
          תוכנית ייצור · {department.name}
        </h1>
        <div className="no-print flex flex-wrap items-center gap-2">
          <a id="production-csv" href={`/production/export?date=${date}&dept=${department.id}`} className="rounded-lg border border-line px-4 py-2">
            ייצוא לאקסל
          </a>
          <PrintButton />
        </div>
      </div>
      <p className="text-lg">
        אספקה ביום {dayFmt.format(new Date(date))}
        {date === dates.today ? " · היום" : date === dates.tomorrow ? " · מחר" : ""}
      </p>

      <section className={`${panel} no-print`}>
        <form action="/production" className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm text-muted">
            תאריך אספקה
            <input id="production-date" name="date" type="date" defaultValue={date} className={field} />
          </label>
          <input type="hidden" name="dept" value={department.id} />
          <button className="rounded-lg border border-line px-4 py-2">הצג</button>
          <Link href={link(dates.today, department.id)} className="rounded-lg border border-line px-4 py-2">
            היום
          </Link>
          <Link href={link(dates.tomorrow, department.id)} className="rounded-lg border border-line px-4 py-2">
            מחר
          </Link>
        </form>
        {!fixed ? (
          <div className="mt-3 flex flex-wrap gap-2" data-departments>
            {all.map((d) => (
              <Link key={d.id} href={link(date, d.id)} aria-current={d.id === department.id ? "page" : undefined} className={`rounded-full border px-3 py-1 text-sm ${d.id === department.id ? "border-accent bg-accent text-surface" : "border-line"}`}>
                {d.name}
              </Link>
            ))}
          </div>
        ) : null}
      </section>

      {locks
        .filter((l) => l.changes.length > 0)
        .map((l) => (
          <section key={l.planId} data-late-changes className="rounded-xl border-2 border-foreground bg-surface p-4">
            <h2 className="mb-2 font-display text-base font-bold">שינויים אחרי נעילה · משמרת {SHIFTS[l.shift]}</h2>
            <ul className="mb-3 flex flex-col gap-1 text-lg">
              {l.changes.map((c) => (
                <li key={c.key}>
                  {c.label}: <span dir="ltr">{qty.format(c.before)}</span> ← <b dir="ltr">{qty.format(c.after)}</b>
                  <span className="text-sm text-muted"> ({c.after > c.before ? `להוסיף ${qty.format(c.after - c.before)}` : `פחות ${qty.format(c.before - c.after)}`})</span>
                </li>
              ))}
            </ul>
            {mayMark ? (
              <form action={acknowledgeAction} className="no-print">
                {hidden()}
                <input type="hidden" name="plan_id" value={l.planId} />
                <button className="rounded-lg bg-accent px-5 py-3 text-lg font-medium text-surface">ראיתי, התוכנית מעודכנת</button>
              </form>
            ) : null}
          </section>
        ))}

      {shiftsWithWork.length === 0 ? (
        <section className={panel}>
          <p className="text-muted">אין ייצור למחלקה בתאריך הזה.</p>
        </section>
      ) : null}

      {shiftsWithWork.map(({ name, i, rows: shiftRows, lock }) => (
        <section key={i} data-shift={i} className={panel}>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-display text-lg font-bold">
              משמרת {name}
              <span className="font-sans text-sm font-normal text-muted"> · {qty.format(shiftRows.reduce((s, r) => s + r.quantity, 0))} יחידות</span>
            </h2>
            <div className="no-print flex flex-wrap items-center gap-2 text-sm">
              {lock ? (
                <>
                  <span data-locked className="rounded-full bg-sunken px-3 py-1">
                    נעולה מ-{stamp.format(new Date(lock.lockedAt))}
                    {lock.lockedBy ? ` · ${lock.lockedBy}` : " · אוטומטית"}
                  </span>
                  {mayLock ? (
                    <form action={unlockAction}>
                      {hidden()}
                      <input type="hidden" name="plan_id" value={lock.planId} />
                      <button className="rounded-lg border border-line px-3 py-1.5">בטל נעילה</button>
                    </form>
                  ) : null}
                </>
              ) : mayLock ? (
                <form action={lockAction}>
                  {hidden(i)}
                  <button data-lock className="rounded-lg border border-line px-3 py-1.5">
                    נעל תוכנית
                  </button>
                </form>
              ) : null}
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse tabular-nums">
              <thead>
                <tr className="border-b border-line text-xs text-muted">
                  <th className="px-2 py-1.5 text-start font-medium">מק״ט</th>
                  <th className="px-2 py-1.5 text-start font-medium">מוצר</th>
                  <th className="px-2 py-1.5 text-end font-medium">כמות</th>
                  <th className="px-2 py-1.5 text-start font-medium">הזמנות מקור</th>
                  <th className="no-print px-2 py-1.5 text-start font-medium">ביצוע</th>
                  {mayLock ? <th className="no-print px-2 py-1.5 text-start font-medium">העברת משמרת</th> : null}
                </tr>
              </thead>
              <tbody>
                {shiftRows.map((r) => {
                  const done = r.producedLines === r.lines;
                  const partial = r.producedLines > 0 && !done;
                  const src = sources.filter((s) => s.shift === i && s.sku === r.sku && s.variantId === r.variantId);
                  return (
                    <tr key={`${r.sku}|${r.variantId ?? ""}`} data-row={`${r.sku}|${r.variantId ?? ""}`} className={`border-b border-line align-top last:border-0 ${done ? "text-muted" : ""}`}>
                      <td className="px-2 py-3">{r.sku}</td>
                      <td className="px-2 py-3 text-lg">
                        {r.product}
                        {r.variant ? <div className="font-medium">{r.variant}</div> : null}
                      </td>
                      <td className="px-2 py-3 text-end">
                        <span data-qty className={`font-display text-3xl font-bold ${done ? "line-through" : ""}`}>
                          {qty.format(r.quantity)}
                        </span>
                      </td>
                      <td className="px-2 py-3 text-sm">
                        <details>
                          <summary className="cursor-pointer">{src.length} הזמנות</summary>
                          <ul className="mt-1 flex flex-col gap-1">
                            {src.map((s) => (
                              <li key={s.orderId}>
                                {s.orderNumber} · {s.customer} · <b>{qty.format(s.quantity)}</b>
                                {s.window ? <span dir="ltr"> · {s.window}</span> : null}
                                {s.notes ? <div className="font-medium">{s.notes}</div> : null}
                              </li>
                            ))}
                          </ul>
                        </details>
                        {src.some((s) => s.notes) ? <div className="mt-1 font-medium">יש הערות לייצור</div> : null}
                      </td>
                      <td className="no-print px-2 py-3">
                        {mayMark ? (
                          <form action={markAction}>
                            {hidden(i, r.sku, r.variantId)}
                            <input type="hidden" name="produced" value={done ? "false" : "true"} />
                            <button data-mark className={`rounded-lg px-5 py-3 text-lg font-medium ${done ? "border border-line" : "bg-accent text-surface"}`}>
                              {done ? "בטל סימון" : partial ? "השלם ביצוע" : "בוצע"}
                            </button>
                          </form>
                        ) : done ? (
                          "בוצע"
                        ) : (
                          ""
                        )}
                      </td>
                      {mayLock ? (
                        <td className="no-print px-2 py-3">
                          <form action={moveShiftAction} className="flex items-center gap-2">
                            {hidden(i, r.sku, r.variantId)}
                            <select name="to_shift" defaultValue={i} aria-label="משמרת יעד" className={field}>
                              {SHIFTS.map((n, k) => (
                                <option key={k} value={k}>
                                  {n}
                                </option>
                              ))}
                            </select>
                            <button data-move className="rounded-lg border border-line px-3 py-2">
                              העבר
                            </button>
                          </form>
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ))}
      <section className={`${panel} no-print`} data-lock-times>
        <h2 className="mb-1 font-display text-base font-bold">נעילה אוטומטית · {department.name}</h2>
        <p className="mb-3 text-sm text-muted">
          בשעה שנקבעה התוכנית של המשמרת ננעלת מעצמה, וכל שינוי בהזמנות אחריה מוצג כ״שינוי אחרי נעילה״. משמרת בלי שעה ננעלת רק בלחיצה. מי שביטל נעילה אוטומטית של יום מסוים, נועל אותו שוב בעצמו.
        </p>
        {mayLock ? (
          <ActionForm action={lockTimesAction} submit="שמור שעות נעילה" primary={false} className="flex flex-col items-start gap-3">
            <input type="hidden" name="department_id" value={department.id} />
            {SHIFTS.map((name, i) => {
              const t = times.find((x) => x.shift === i);
              return (
                <div key={i} className="flex flex-wrap items-end gap-3">
                  <span className="w-24 pb-2 font-medium">משמרת {name}</span>
                  <label className="flex flex-col gap-1 text-sm text-muted">
                    ננעלת
                    <select id={`lock-offset-${i}`} name={`offset_${i}`} defaultValue={t ? String(t.dayOffset) : ""} className={field}>
                      <option value="">רק בלחיצה</option>
                      <option value="0">ביום האספקה</option>
                      <option value="1">יום לפני האספקה</option>
                      <option value="2">יומיים לפני האספקה</option>
                      <option value="3">שלושה ימים לפני האספקה</option>
                    </select>
                  </label>
                  <label className="flex flex-col gap-1 text-sm text-muted">
                    בשעה
                    <input id={`lock-time-${i}`} name={`time_${i}`} type="time" defaultValue={t?.time ?? ""} className={field} />
                  </label>
                </div>
              );
            })}
          </ActionForm>
        ) : times.length === 0 ? (
          <p>לא הוגדרו שעות נעילה.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {times.map((t) => (
              <li key={t.shift}>
                משמרת {SHIFTS[t.shift]}: {t.dayOffset === 0 ? "ביום האספקה" : t.dayOffset === 1 ? "יום לפני האספקה" : `${t.dayOffset} ימים לפני האספקה`} בשעה <span dir="ltr">{t.time}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <p className="no-print text-sm text-muted">הכמויות מאוגדות מכל ההזמנות המאושרות לתאריך. סימון ״בוצע״ מעדכן גם את מצב ההזמנות: כשכל פריטי האספקה מוכנים היא עוברת ל״מוכנה לשילוח״.</p>
    </div>
  );
}
