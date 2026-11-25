"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { query } from "@/lib/db";
import { assertPermission, RETURN_COOKIE, SESSION_COOKIE } from "@/lib/auth";
import { deleteSession, openSessionFor } from "@/lib/auth-core";
import { testMode } from "@/lib/mail-test-mode";

const cookieOptions = { httpOnly: true, sameSite: "lax" as const, path: "/" };

/**
 * Test mode only: signs in as another active staff member, so every screen is seen the way that person sees it.
 * The administrator's session is kept in a cookie, so "back to administrator" needs no password or code.
 */
export async function switchUserAction(fd: FormData): Promise<void> {
  if (!testMode()) throw new Error("ההחלפת משתמש זמינה רק במצב טסט.");
  await assertPermission("settings.manage");
  const store = await cookies();
  if (store.get(RETURN_COOKIE)?.value) throw new Error("כבר מחוברים כמשתמש אחר. יש לחזור למנהל קודם.");

  const userId = String(fd.get("user_id") ?? "");
  const rows = await query<{ id: string }>("select id::text from users where id = $1::uuid and active and role <> 'customer'", [userId]);
  if (rows.length === 0) throw new Error("המשתמש לא נמצא או אינו פעיל.");

  const current = store.get(SESSION_COOKIE)?.value;
  const { token, expiresAt } = await openSessionFor(query, rows[0].id);
  if (current) store.set(RETURN_COOKIE, current, { ...cookieOptions, expires: expiresAt });
  store.set(SESSION_COOKIE, token, { ...cookieOptions, expires: expiresAt });
  redirect("/");
}

/** Test mode only: ends the test sign-in and restores the administrator's session. */
export async function returnToAdminAction(): Promise<void> {
  if (!testMode()) throw new Error("ההחלפת משתמש זמינה רק במצב טסט.");
  const store = await cookies();
  const admin = store.get(RETURN_COOKIE)?.value;
  if (!admin) redirect("/test-environment");
  await deleteSession(query, store.get(SESSION_COOKIE)?.value);
  store.delete(RETURN_COOKIE);
  store.set(SESSION_COOKIE, admin, cookieOptions);
  redirect("/test-environment");
}
