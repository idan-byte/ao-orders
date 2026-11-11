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
| `db/migrations/0001_init.sql` | סכמת הנתונים של מהדורה 1 (PostgreSQL) | לא הורצה עדיין |

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

בדיקת הסכמה:

```bash
node scripts/check-schema.mjs
```

## הערות לסביבה

- התיקיות `node_modules`, `.next`, `.data` ו-`.git` סומנו כך ש-Dropbox ידלג עליהן. למרות זאת Dropbox עדיין נוגע בקבצים בתוך `node_modules` ומאט את שרת הפיתוח. מומלץ להעביר את הקוד לתיקייה מחוץ ל-Dropbox.
- הטלמטריה של Next.js כובתה.
- ב-Next.js 16 עם Cache Components כל קריאה למסד חייבת להיות בתוך `<Suspense>`. ראו `src/app/catalog/page.tsx` כדוגמה, ואת המדריכים ב-`web/node_modules/next/dist/docs`.

## כללים

- קריאה בלבד מחשבשבת. כתיבה לחשבשבת תיעשה רק דרך ממשק היבוא שלה, ולא ישירות לטבלאות.
- המק"ט של חשבשבת הוא המזהה של המוצר. נתוני ייצור (מחלקה, משמרת, סוגים) נשמרים רק במערכת הזו.
- מחירים נשמרים לפני מע"מ.
