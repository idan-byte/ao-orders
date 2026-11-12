import { query } from "@/lib/db";
import type { SessionUser } from "@/lib/auth-core";

export type Department = { id: number; name: string };

/**
 * Which department a user is looking at. Someone attached to a department (a department manager or a
 * production worker) always gets their own, whatever the address bar says. Others may choose.
 */
export async function resolveDepartment(user: SessionUser, requested: string | undefined): Promise<{ department: Department | null; all: Department[]; fixed: boolean }> {
  const all = await query<Department>("select id, name from departments order by id");
  if (user.departmentId !== null) return { department: all.find((d) => d.id === user.departmentId) ?? null, all, fixed: true };
  const wanted = Number(requested);
  return { department: all.find((d) => d.id === wanted) ?? all[0] ?? null, all, fixed: false };
}

export const isIsoDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
