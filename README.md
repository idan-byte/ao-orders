# A&O ניהול הזמנות

מערכת ניהול הצעות מחיר, הזמנות, ייצור ושילוח של אבי ועופר שירותי מזון.

- אפיון: https://claude.ai/artifact/C3ZuRMcMqGB6DQrUD4aNtz
- אבטיפוס: https://claude.ai/artifact/H4S4odbSdA1S475FfD6oUy

## מצב נוכחי (11.11.2026)

מהדורה 1: מכירות, הזמנות וייצור. מה שקיים בתיקייה:

| קובץ | מה זה | נבדק? |
| --- | --- | --- |
| `integrations/hashavshevet/queries/catalog.sql` | קריאת מוצרי המכירה מחשבשבת | כן, מול המסד החי: 285 מוצרים |
| `integrations/hashavshevet/queries/customers.sql` | קריאת לקוחות פעילים מחשבשבת | כן, מול המסד החי: 373 לקוחות |
| `integrations/hashavshevet/queries/last_prices.sql` | מחיר אחרון לכל לקוח ומוצר, לאתחול הסכמי מחיר | כן, מול המסד החי: 903 שורות |
| `db/migrations/0001_init.sql` | סכמת הנתונים של מהדורה 1 (PostgreSQL) | כן, `check-schema.mjs` |
| `db/migrations/0002_sessions.sql` | טבלת חיבורים פעילים והגבלת קצב לקודי כניסה | כן |
| `web/src/lib/auth-core.ts` | כניסה עם מספר נייד וקוד חד-פעמי, חיבורים | כן, `check-auth.mjs` (34 בדיקות) |
| `web/src/lib/permissions.ts` | תפקידים ומטריצת הרשאות | כן, `check-auth.mjs` |
| `web/src/app/login`, `web/src/app/users` | מסך כניסה ומסך ניהול משתמשים | כן, `e2e-login.mjs` (19 בדיקות בדפדפן) |
| `db/seed/catalog.json` | 121 המוצרים שנמכרו ב-12 החודשים האחרונים, כפי שנקראו מחשבשבת ב-11.11.2026 | כן, נטען למסד בעלייה |
| `web/` | האפליקציה (Next.js 16, TypeScript, Tailwind). מסכים: דשבורד התחלתי וקטלוג | כן, נבדק בדפדפן |
| `web/src/lib/db.ts` | חיבור למסד, הרצת מיגרציות וטעינת הקטלוג | כן |
| `web/scripts/check-schema.mjs` | בדיקת הסכמה והאילוצים המרכזיים על מסד זמני | כן, עוברת |

## הרצה

מתוך התיקייה `web`:

```bash
npm run dev
```

ואז לפתוח את http://localhost:3000. בפיתוח המסד הוא PostgreSQL מוטמע (PGlite) שנשמר ב-`web/.data`. מחיקת התיקייה הזו מאפסת את המסד.

### כניסה בסביבת הפיתוח

- מנהל המערכת הראשון נוצר מהמספר שב-`web/.env.local` (המשתנה `AO_BOOTSTRAP_ADMIN_MOBILE`), רק כשטבלת המשתמשים ריקה. ראו `web/.env.example`.
- עדיין לא מחובר ספק SMS. בפיתוח הקוד החד-פעמי מוצג במסך הכניסה ונרשם ביומן השרת. בסביבת ייצור, כניסה בלי ספק SMS מוגדר נכשלת בכוונה.
- קוד תקף ל-5 דקות, עד 5 ניסיונות שגויים לקוד, ועד 3 קודים ב-15 דקות למספר. חיבור תקף ל-30 יום.

### בדיקות

```bash
node scripts/check-schema.mjs
```

```bash
node scripts/check-auth.mjs
```

בדיקה מקצה לקצה בדפדפן (דורשת שהשרת רץ, ומשתמשת ב-Microsoft Edge המותקן):

```bash
node scripts/e2e-login.mjs
```

## הערות לסביבה

- הקוד יושב ב-`C:\dev\ao-orders`, מחוץ ל-Dropbox (הועבר ב-11.11.2026 כי Dropbox האט את שרת הפיתוח). המסמכים והקבצים של מילגם נשארו ב-`D:\Dropbox\עידן`. הקוד עדיין לא מגובה מחוץ למחשב הזה.
- אחרי העתקה נקייה של הפרויקט יש להריץ `npx next typegen` לפני בדיקת טיפוסים, כי הטיפוס `LayoutProps` נוצר אוטומטית.
- הטלמטריה של Next.js כובתה.
- ב-Next.js 16 עם Cache Components כל קריאה למסד חייבת להיות בתוך `<Suspense>`. ראו `src/app/catalog/page.tsx` כדוגמה, ואת המדריכים ב-`web/node_modules/next/dist/docs`.

## כללים

- קריאה בלבד מחשבשבת. כתיבה לחשבשבת תיעשה רק דרך ממשק היבוא שלה, ולא ישירות לטבלאות.
- המק"ט של חשבשבת הוא המזהה של המוצר. נתוני ייצור (מחלקה, משמרת, סוגים) נשמרים רק במערכת הזו.
- מחירים נשמרים לפני מע"מ.
