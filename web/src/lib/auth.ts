import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { query } from "@/lib/db";
import { getUserBySession, type SessionUser } from "@/lib/auth-core";
import { can, type Permission } from "@/lib/permissions";

export const SESSION_COOKIE = "ao_session";
/** Test mode only: the administrator's session, kept while the test environment is signed in as another person. */
export const RETURN_COOKIE = "ao_test_return";

/** The signed-in user, or null. Reads the request, so callers must sit behind <Suspense>. */
export async function getCurrentUser(): Promise<SessionUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return getUserBySession(query, token);
}

/** For screens: sends anonymous visitors to the login screen. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

/** For screens: the user plus whether they hold the permission. The screen renders <NoAccess /> when denied. */
export async function requirePermission(permission: Permission): Promise<{ user: SessionUser; allowed: boolean }> {
  const user = await requireUser();
  return { user, allowed: can(user.role, permission) };
}

/** For server actions: throws unless the caller is signed in and holds the permission. */
export async function assertPermission(permission: Permission): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (!can(user.role, permission)) throw new Error("אין הרשאה לפעולה זו");
  return user;
}
