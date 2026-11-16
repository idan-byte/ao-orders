import { connection } from "next/server";
import { testAddress, testMode } from "@/lib/mail-test-mode";

// Shown on every page while test mode is on: this is not the working system, and mail goes only to the test address.
export async function TestBanner() {
  await connection();
  if (!testMode()) return null;
  const address = testAddress();
  return (
    <div role="status" data-test-banner className="border-b border-line bg-sunken px-4 py-1.5 text-center text-sm font-bold">
      מצב טסט: מיילים נשלחים רק לכתובת הבדיקה{address ? <> <span dir="ltr">{address}</span></> : " (לא מוגדרת, ולכן לא נשלח דבר)"}
    </div>
  );
}
