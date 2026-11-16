"use server";

import { refresh } from "next/cache";
import { withTransaction } from "@/lib/db";
import { assertPermission } from "@/lib/auth";
import { cleanTestEnvironment, TestEnvError } from "@/lib/test-env-core";

export type TestEnvState = { error?: string; ok?: string };

/** Removes every business record of the test environment. Only in test mode; only with the exact words typed. */
export async function cleanTestEnvAction(_prev: TestEnvState, fd: FormData): Promise<TestEnvState> {
  await assertPermission("settings.manage");
  try {
    const r = await withTransaction((q) => cleanTestEnvironment(q, String(fd.get("confirm") ?? "")));
    refresh();
    const total = r.removed.reduce((a, t) => a + t.rows, 0);
    return { ok: total === 0 ? "לא היו רשומות לנקות." : `נוקו ${total} רשומות מ-${r.removed.length} טבלאות. האנשים, הקטלוג, ההגדרות והמנות נשארו.` };
  } catch (e) {
    if (e instanceof TestEnvError) return { error: e.message };
    console.error("[test environment clean]", e instanceof Error ? e.name : "error");
    return { error: "הניקוי נכשל. שום דבר לא נמחק." };
  }
}
