"use server";

import { refresh } from "next/cache";
import { query } from "@/lib/db";
import { assertPermission } from "@/lib/auth";
import { deleteSessionsOfUser, normalizeMobile } from "@/lib/auth-core";
import { DEPARTMENT_ROLES, isRole, type Role } from "@/lib/permissions";

export type UserFormState = { error?: string; ok?: string };

export async function addUserAction(_prev: UserFormState, formData: FormData): Promise<UserFormState> {
  const actor = await assertPermission("users.manage");

  const mobile = normalizeMobile(String(formData.get("mobile") ?? ""));
  const fullName = String(formData.get("full_name") ?? "").trim();
  const role = String(formData.get("role") ?? "");
  const departmentRaw = String(formData.get("department_id") ?? "");

  if (!mobile) return { error: "מספר הנייד אינו תקין. יש להזין מספר בן 10 ספרות שמתחיל ב-05." };
  if (fullName.length < 2) return { error: "יש להזין שם מלא." };
  if (!isRole(role) || role === "customer") return { error: "יש לבחור תפקיד." };

  const needsDepartment = DEPARTMENT_ROLES.includes(role as Role);
  const departmentId = needsDepartment ? Number(departmentRaw) : null;
  if (needsDepartment && !Number.isInteger(departmentId)) return { error: "לתפקיד הזה יש לבחור מחלקת ייצור." };

  const existing = await query("select 1 from users where mobile = $1", [mobile]);
  if (existing.length > 0) return { error: "כבר קיים משתמש עם מספר הנייד הזה." };

  const [created] = await query<{ id: string }>(
    "insert into users (mobile, full_name, role, department_id) values ($1, $2, $3, $4) returning id::text",
    [mobile, fullName, role, departmentId],
  );
  await query("insert into audit_log (user_id, action, entity_type, entity_id, after) values ($1, 'create', 'user', $2, $3)", [
    actor.id,
    created.id,
    JSON.stringify({ mobile, fullName, role, departmentId }),
  ]);
  refresh();
  return { ok: `${fullName} נוסף. אפשר להיכנס עם הנייד ${mobile}.` };
}

export async function setUserActiveAction(formData: FormData): Promise<void> {
  const actor = await assertPermission("users.manage");
  const userId = String(formData.get("user_id") ?? "");
  const active = formData.get("active") === "true";

  // An administrator cannot lock themselves out.
  if (userId === actor.id && !active) return;

  const changed = await query("update users set active = $2 where id = $1 and active <> $2 returning id", [userId, active]);
  if (changed.length === 0) return;
  if (!active) await deleteSessionsOfUser(query, userId);
  await query("insert into audit_log (user_id, action, entity_type, entity_id, after) values ($1, $2, 'user', $3, $4)", [
    actor.id,
    active ? "activate" : "deactivate",
    userId,
    JSON.stringify({ active }),
  ]);
  refresh();
}
