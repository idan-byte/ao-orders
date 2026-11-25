import { cookies } from "next/headers";
import { connection } from "next/server";
import { getCurrentUser, RETURN_COOKIE } from "@/lib/auth";
import { testAddress, testMode } from "@/lib/mail-test-mode";
import { isRole, ROLES } from "@/lib/permissions";
import { returnToAdminAction } from "@/app/test-environment/switch-actions";

// Shown on every page while test mode is on: this is not the working system, and mail goes only to the test address.
// While the test environment is signed in as another person, the banner names that person and offers the way back.
export async function TestBanner() {
  await connection();
  if (!testMode()) return null;
  const address = testAddress();
  const borrowing = Boolean((await cookies()).get(RETURN_COOKIE)?.value);
  const user = borrowing ? await getCurrentUser() : null;
  return (
    <div role="status" data-test-banner className="border-b border-line bg-sunken px-4 py-1.5 text-center text-sm font-bold">
      מצב טסט: מיילים נשלחים רק לכתובת הבדיקה{address ? <> <span dir="ltr">{address}</span></> : " (לא מוגדרת, ולכן לא נשלח דבר)"}
      {user ? (
        <span data-test-as className="mr-3 inline-flex flex-wrap items-center justify-center gap-2 font-medium">
          · מחובר כ-{user.fullName} ({isRole(user.role) ? ROLES[user.role] : user.role})
          <form action={returnToAdminAction} className="inline">
            <button data-test-return className="rounded-lg border border-line bg-surface px-3 py-0.5 text-sm font-bold text-foreground">
              חזרה למנהל
            </button>
          </form>
        </span>
      ) : null}
    </div>
  );
}
