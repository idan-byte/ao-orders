// Tests the login logic and the permission matrix against a throwaway in-memory PostgreSQL.
// Run from the web folder:  node scripts/check-auth.mjs
import { PGlite } from "@electric-sql/pglite";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  normalizeMobile, requestCode, verifyCode, getUserBySession, deleteSession, deleteSessionsOfUser,
  MAX_ATTEMPTS_PER_CODE, MAX_CODES_PER_15_MINUTES, CODE_TTL_MINUTES, SESSION_DAYS,
} from "../src/lib/auth-core.ts";
import { can, ROLES, PERMISSIONS } from "../src/lib/permissions.ts";

const db = new PGlite();
const dir = path.join(process.cwd(), "..", "db", "migrations");
for (const f of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort()) await db.exec(await readFile(path.join(dir, f), "utf8"));
const q = async (sql, params = []) => (await db.query(sql, params)).rows;

let failed = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` -> got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
}
const minutes = (base, m) => new Date(base.getTime() + m * 60_000);
const t0 = new Date("2026-11-12T06:00:00Z");

// --- mobile numbers
check("mobile with dashes", normalizeMobile("052-123-4567"), "0521234567");
check("mobile with +972", normalizeMobile("+972 52 123 4567"), "0521234567");
check("landline rejected", normalizeMobile("02-5551234"), null);
check("short number rejected", normalizeMobile("05212345"), null);

await q("insert into users (mobile, full_name, role) values ('0521234567', 'מנהלת בדיקה', 'admin'), ('0529999999', 'עובד לא פעיל', 'sales')");
await q("update users set active = false where mobile = '0529999999'");

// --- requesting a code
check("invalid mobile", (await requestCode(q, "123", t0)).reason, "invalid_mobile");
check("unknown mobile", (await requestCode(q, "0540000000", t0)).reason, "unknown_user");
check("inactive user gets no code", (await requestCode(q, "0529999999", t0)).reason, "unknown_user");
const r1 = await requestCode(q, "052-1234567", t0);
check("code issued", [r1.ok, /^\d{6}$/.test(r1.code)], [true, true]);
check("code is stored hashed, not in clear", (await q("select count(*)::int as n from login_codes where code_hash = $1", [r1.code]))[0].n, 0);

// --- verifying
check("wrong code", (await verifyCode(q, "0521234567", r1.code === "000000" ? "111111" : "000000", minutes(t0, 1))).reason, "wrong");
check("expired code", (await verifyCode(q, "0521234567", r1.code, minutes(t0, CODE_TTL_MINUTES + 1))).reason, "expired");
const v1 = await verifyCode(q, "0521234567", r1.code, minutes(t0, 2));
check("correct code signs in", v1.ok, true);
check("code cannot be reused", (await verifyCode(q, "0521234567", r1.code, minutes(t0, 3))).reason, "expired");
check("token is stored hashed, not in clear", (await q("select count(*)::int as n from sessions where token_hash = $1", [v1.token]))[0].n, 0);

// --- sessions
const u1 = await getUserBySession(q, v1.token, minutes(t0, 5));
check("session resolves the user", [u1?.mobile, u1?.role, u1?.fullName], ["0521234567", "admin", "מנהלת בדיקה"]);
check("unknown token", await getUserBySession(q, "not-a-token", minutes(t0, 5)), null);
check("missing token", await getUserBySession(q, undefined, minutes(t0, 5)), null);
check("session expires", await getUserBySession(q, v1.token, minutes(t0, SESSION_DAYS * 24 * 60 + 10)), null);
await q("update users set active = false where mobile = '0521234567'");
check("deactivated user loses access", await getUserBySession(q, v1.token, minutes(t0, 6)), null);
await q("update users set active = true where mobile = '0521234567'");
await deleteSession(q, v1.token);
check("sign out ends the session", await getUserBySession(q, v1.token, minutes(t0, 7)), null);

// --- lockout after repeated wrong codes
const t1 = minutes(t0, 30);
const r2 = await requestCode(q, "0521234567", t1);
const wrong = r2.code === "000000" ? "111111" : "000000";
let last;
for (let i = 0; i < MAX_ATTEMPTS_PER_CODE; i++) last = await verifyCode(q, "0521234567", wrong, minutes(t1, 1));
check("locked after max wrong attempts", last.reason, "locked");
check("correct code refused once locked", (await verifyCode(q, "0521234567", r2.code, minutes(t1, 1))).reason, "locked");

// --- rate limit on requesting codes
const t2 = minutes(t0, 120);
const results = [];
for (let i = 0; i <= MAX_CODES_PER_15_MINUTES; i++) results.push((await requestCode(q, "0521234567", minutes(t2, i))).ok);
check("rate limit on code requests", results, [...Array(MAX_CODES_PER_15_MINUTES).fill(true), false]);
check("rate limit clears after 15 minutes", (await requestCode(q, "0521234567", minutes(t2, 20))).ok, true);

// --- deactivation ends all sessions
const r3 = await requestCode(q, "0521234567", minutes(t2, 60));
const v3 = await verifyCode(q, "0521234567", r3.code, minutes(t2, 61));
await deleteSessionsOfUser(q, v3.userId);
check("ending a user's sessions", await getUserBySession(q, v3.token, minutes(t2, 62)), null);

// --- permission matrix
check("admin has every permission", PERMISSIONS.every((p) => can("admin", p)), true);
check("company manager cannot manage users", can("company_manager", "users.manage"), false);
check("sales sees prices", can("sales", "prices.view"), true);
const noPrices = ["dept_manager", "production_worker", "shipping_manager", "loading_manager", "driver", "customer"];
check("production and shipping roles never see prices", noPrices.map((r) => can(r, "prices.view")), noPrices.map(() => false));
check("production worker cannot edit orders", can("production_worker", "orders.edit"), false);
check("driver can mark shipping only", [can("driver", "shipping.ship"), can("driver", "orders.view")], [true, false]);
check("external customer has no internal permission", PERMISSIONS.some((p) => can("customer", p)), false);
check("unknown role has no permission", can("superuser", "dashboard.view"), false);
check("every role is in the matrix", Object.keys(ROLES).every((r) => typeof can(r, "dashboard.view") === "boolean"), true);

console.log(failed ? `AUTH CHECK FAILED (${failed})` : "AUTH CHECK PASSED");
process.exit(failed ? 1 : 0);
