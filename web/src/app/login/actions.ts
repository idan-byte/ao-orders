"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { query } from "@/lib/db";
import { SESSION_COOKIE } from "@/lib/auth";
import { deleteSession, normalizeMobile, requestCode, verifyCode } from "@/lib/auth-core";
import { sendLoginCode } from "@/lib/sms";

export type LoginState = {
  step: "mobile" | "code";
  mobile?: string;
  error?: string;
  info?: string;
  devCode?: string;
};

export async function loginAction(prev: LoginState, formData: FormData): Promise<LoginState> {
  const intent = String(formData.get("intent") ?? "");

  if (intent === "back") return { step: "mobile" };

  if (intent === "request") {
    const input = String(formData.get("mobile") ?? "");
    const result = await requestCode(query, input);
    if (!result.ok && result.reason === "invalid_mobile") {
      return { step: "mobile", error: "מספר הנייד אינו תקין. יש להזין מספר בן 10 ספרות שמתחיל ב-05." };
    }
    if (!result.ok && result.reason === "too_many") {
      return { step: "mobile", error: "נשלחו יותר מדי קודים למספר הזה. אפשר לנסות שוב בעוד רבע שעה." };
    }
    const mobile = normalizeMobile(input)!;
    // An unknown number gets the same answer as a known one, so the screen does not reveal who is registered.
    const info = "אם המספר רשום במערכת, נשלח אליו קוד בן 6 ספרות. הקוד תקף ל-5 דקות.";
    if (!result.ok) return { step: "code", mobile, info };
    const sms = await sendLoginCode(result.mobile, result.code);
    return { step: "code", mobile, info, devCode: sms.devCode };
  }

  if (intent === "verify") {
    const mobile = String(formData.get("mobile") ?? "");
    const result = await verifyCode(query, mobile, String(formData.get("code") ?? ""));
    if (!result.ok) {
      const error =
        result.reason === "locked"
          ? "יותר מדי ניסיונות שגויים. יש לבקש קוד חדש."
          : result.reason === "wrong"
            ? "הקוד שגוי. אפשר לנסות שוב."
            : "הקוד אינו תקף עוד. יש לבקש קוד חדש.";
      return { step: "code", mobile, error, devCode: prev.devCode };
    }
    (await cookies()).set(SESSION_COOKIE, result.token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      expires: result.expiresAt,
    });
    redirect("/");
  }

  return { step: "mobile" };
}

export async function signOutAction() {
  const store = await cookies();
  await deleteSession(query, store.get(SESSION_COOKIE)?.value);
  store.delete(SESSION_COOKIE);
  redirect("/login");
}
