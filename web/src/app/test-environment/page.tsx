import { Suspense } from "react";
import { query } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { businessCounts, CONFIRM_WORDS } from "@/lib/test-env-core";
import { testAddress, testMode } from "@/lib/mail-test-mode";
import { ActionForm } from "@/components/action-form";
import { Loading } from "@/components/loading";
import { NoAccess } from "@/components/no-access";
import { cleanTestEnvAction } from "./actions";

const panel = "rounded-xl border border-line bg-surface p-4";
const field = "rounded-lg border border-line bg-surface px-3 py-2 text-foreground";
const label = "flex flex-col gap-1 text-sm text-muted";
const nf = new Intl.NumberFormat("he-IL");

// The test environment: when test mode is on, every email goes to the test address only, and the business records
// can be cleared to start again. Shown to people who manage settings.
export default function TestEnvironmentPage() {
  return (
    <Suspense fallback={<Loading />}>
      <TestEnvironment />
    </Suspense>
  );
}

async function TestEnvironment() {
  const { allowed } = await requirePermission("settings.manage");
  if (!allowed) return <NoAccess />;
  const on = testMode();
  const address = testAddress();
  const counts = await businessCounts(query);
  const total = counts.reduce((a, c) => a + c.rows, 0);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="font-display text-2xl font-bold">סביבת טסט</h1>

      <section className={panel} id="test-mode">
        <h2 className="font-display text-lg font-bold">מצב טסט</h2>
        <p className="mt-1" data-test-mode={String(on)}>
          {on ? "מצב טסט פעיל." : "מצב טסט כבוי. המערכת פועלת כסביבה רגילה."}
        </p>
        {on ? (
          <ul className="mt-2 flex list-disc flex-col gap-1 pr-5 text-sm">
            <li>
              כל מייל יוצא נשלח <b>רק</b> לכתובת הבדיקה{address ? <> <span dir="ltr">{address}</span></> : null}, לא משנה מי הנמען המקורי. הנושא מתחיל ב״[טסט]״, והגוף מציין אל מי הוא נועד.
            </li>
            {address ? null : <li className="font-bold">כתובת הבדיקה לא מוגדרת, ולכן אף מייל לא יישלח.</li>}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-muted">
            להפעלה: ב-<span dir="ltr">web/.env.local</span> מגדירים <span dir="ltr">AO_TEST_MODE=1</span> וגם <span dir="ltr">AO_TEST_EMAIL</span> עם כתובת הבדיקה, ואחר כך מפעילים מחדש את השרת.
          </p>
        )}
      </section>

      <section className={`${panel} border-2`} id="test-clean">
        <h2 className="font-display text-lg font-bold">ניקוי סביבת הטסט</h2>
        <p className="mb-2 mt-1 text-sm text-muted">
          מוחק את כל הנתונים העסקיים: לקוחות ואנשי קשר, כתובות, מחירי לקוחות, פניות, משימות, הצעות, הזמנות, אספקות, הזמנות קבועות, תכנון ייצור, שילוח, מוסדות וכמויות מילגם, דואר נכנס, מיילים שנשלחו והיסטוריית פעולות.
        </p>
        <p className="mb-2 text-sm">
          <b>נשאר:</b> המשתמשים וההתחברות שלהם, הקטלוג והמוצרים, ההגדרות, דפי הלוגו, ערוצי התקשורת, הרכב והנהגים, סוגי המנה, התפריטים, מנות המשקל ומילוני הביטויים.
        </p>
        <p className="mb-3 text-sm" id="test-counts">
          {total === 0 ? "אין כרגע נתונים עסקיים לניקוי." : `כרגע יש ${nf.format(total)} רשומות עסקיות ב-${counts.length} טבלאות.`}
        </p>
        {on ? (
          <ActionForm action={cleanTestEnvAction} submit="נקה סביבת טסט" pendingLabel="מנקה…" primary={false} className="flex flex-col items-start gap-3">
            <label className={label}>
              כדי לאשר, יש להקליד בדיוק: <span className="font-bold text-foreground">{CONFIRM_WORDS}</span>
              <input name="confirm" autoComplete="off" required className={`${field} w-72`} id="test-confirm" />
            </label>
          </ActionForm>
        ) : (
          <p className="text-sm font-bold">הניקוי זמין רק במצב טסט. כשמצב טסט כבוי אי אפשר למחוק דבר מכאן.</p>
        )}
      </section>
    </div>
  );
}
