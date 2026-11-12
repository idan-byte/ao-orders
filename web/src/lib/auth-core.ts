// Login logic with no dependency on Next.js, so it can be tested directly against a database.
// The login identifier is the user's mobile number. A six-digit code is sent by SMS.
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

export type Q = <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;

export const CODE_TTL_MINUTES = 5;
export const MAX_ATTEMPTS_PER_CODE = 5;
export const MAX_CODES_PER_15_MINUTES = 3;
export const SESSION_DAYS = 30;

export type SessionUser = {
  id: string;
  mobile: string;
  fullName: string;
  role: string;
  departmentId: number | null;
  customerId: string | null;
};

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Accepts 052-123-4567, 0521234567, +972521234567, 972521234567. Returns 05XXXXXXXX or null. */
export function normalizeMobile(input: string): string | null {
  let d = String(input ?? "").replace(/\D/g, "");
  if (d.startsWith("972")) d = "0" + d.slice(3);
  return /^05\d{8}$/.test(d) ? d : null;
}

export type RequestCodeResult =
  | { ok: true; mobile: string; code: string }
  | { ok: false; reason: "invalid_mobile" | "unknown_user" | "too_many" };

export async function requestCode(q: Q, mobileInput: string, now: Date = new Date(), maxCodes: number = MAX_CODES_PER_15_MINUTES): Promise<RequestCodeResult> {
  const mobile = normalizeMobile(mobileInput);
  if (!mobile) return { ok: false, reason: "invalid_mobile" };

  const users = await q("select id from users where mobile = $1 and active", [mobile]);
  if (users.length === 0) return { ok: false, reason: "unknown_user" };

  const recent = await q<{ n: number }>(
    "select count(*)::int as n from login_codes where mobile = $1 and created_at > $2::timestamptz - interval '15 minutes'",
    [mobile, now.toISOString()],
  );
  if (recent[0].n >= maxCodes) return { ok: false, reason: "too_many" };

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await q(
    `insert into login_codes (mobile, code_hash, created_at, expires_at)
     values ($1, $2, $3::timestamptz, $3::timestamptz + make_interval(mins => $4))`,
    [mobile, sha256(`${mobile}:${code}`), now.toISOString(), CODE_TTL_MINUTES],
  );
  return { ok: true, mobile, code };
}

export type VerifyCodeResult =
  | { ok: true; token: string; expiresAt: Date; userId: string }
  | { ok: false; reason: "invalid_mobile" | "expired" | "locked" | "wrong" };

export async function verifyCode(q: Q, mobileInput: string, codeInput: string, now: Date = new Date()): Promise<VerifyCodeResult> {
  const mobile = normalizeMobile(mobileInput);
  if (!mobile) return { ok: false, reason: "invalid_mobile" };
  const code = String(codeInput ?? "").replace(/\D/g, "");

  const rows = await q<{ id: string; code_hash: string; attempts: number }>(
    `select id::text, code_hash, attempts from login_codes
     where mobile = $1 and used_at is null and expires_at > $2::timestamptz
     order by created_at desc, id desc limit 1`,
    [mobile, now.toISOString()],
  );
  if (rows.length === 0) return { ok: false, reason: "expired" };
  const row = rows[0];
  if (row.attempts >= MAX_ATTEMPTS_PER_CODE) return { ok: false, reason: "locked" };

  const expected = Buffer.from(row.code_hash, "hex");
  const actual = Buffer.from(sha256(`${mobile}:${code}`), "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    await q("update login_codes set attempts = attempts + 1 where id = $1", [row.id]);
    return { ok: false, reason: row.attempts + 1 >= MAX_ATTEMPTS_PER_CODE ? "locked" : "wrong" };
  }

  const users = await q<{ id: string }>("select id::text from users where mobile = $1 and active", [mobile]);
  if (users.length === 0) return { ok: false, reason: "expired" };

  await q("update login_codes set used_at = $2::timestamptz where id = $1", [row.id, now.toISOString()]);
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await q("insert into sessions (token_hash, user_id, created_at, expires_at) values ($1, $2, $3::timestamptz, $4::timestamptz)", [
    sha256(token),
    users[0].id,
    now.toISOString(),
    expiresAt.toISOString(),
  ]);
  return { ok: true, token, expiresAt, userId: users[0].id };
}

// `now` is only passed by tests. In the app the database clock is used, so rendering never reads the
// current time itself (Next.js forbids that while it prerenders the static shell).
export async function getUserBySession(q: Q, token: string | undefined, now?: Date): Promise<SessionUser | null> {
  if (!token) return null;
  const rows = await q<{ id: string; mobile: string; full_name: string; role: string; department_id: number | null; customer_id: string | null }>(
    `select u.id::text, u.mobile, u.full_name, u.role::text, u.department_id, u.customer_id::text
     from sessions s join users u on u.id = s.user_id
     where s.token_hash = $1 and s.expires_at > coalesce($2::timestamptz, now()) and u.active`,
    [sha256(token), now ? now.toISOString() : null],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return { id: r.id, mobile: r.mobile, fullName: r.full_name, role: r.role, departmentId: r.department_id, customerId: r.customer_id };
}

export async function deleteSession(q: Q, token: string | undefined): Promise<void> {
  if (token) await q("delete from sessions where token_hash = $1", [sha256(token)]);
}

/** Deactivating a user must end their sessions immediately. */
export async function deleteSessionsOfUser(q: Q, userId: string): Promise<void> {
  await q("delete from sessions where user_id = $1", [userId]);
}
