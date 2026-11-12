// Sending the login code by SMS through 019 SMS (https://docs.019sms.co.il).
// Settings come from the environment and are never written to the log:
//   SMS_PROVIDER=019
//   SMS_019_USERNAME   the account's user name
//   SMS_019_TOKEN      an API token made in the 019 account (Settings > API Token Management)
//   SMS_SOURCE         the sender the customer sees: up to 11 English letters or digits, approved in the 019 account
//   SMS_DEV_ALLOW      outside production: the only numbers that get a real SMS (comma separated)
//   SMS_019_URL        another address for the API (tests use a local stand-in)
//
// Without SMS_PROVIDER, development shows the code on the login screen and production refuses to work.
// Outside production a real SMS goes only to the numbers in SMS_DEV_ALLOW, so automated tests and
// mistyped numbers never reach a stranger's phone; every other number gets the code on the screen.

export type SmsResult = { delivered: boolean; devCode?: string; error?: string };

const DEFAULT_URL = "https://019sms.co.il/api";
// What 019 answers when it refuses, in words a manager can act on. The numbers are 019's own status codes.
const REASONS: Record<number, string> = {
  3: "האסימון (API token) שגוי",
  4: "אין מספיק יתרה בחשבון 019",
  5: "לחשבון אין הרשאה לשלוח SMS כרגע",
  8: "המספר נמצא ברשימה חסומה",
  9: "מספר היעד אינו תקין",
  10: "תוקף האסימון (API token) פג",
  11: "האסימון אינו שייך לשם המשתמש",
  12: "אין מספיק יתרה בחשבון 019",
  50: "כתובת ה-IP של השרת אינה מורשית בחשבון 019",
  429: "יותר מדי בקשות בשנייה",
  503: "שם המשתמש אינו קיים בחשבון 019",
  504: "האסימון לא נמצא",
  515: "שם השולח (SMS_SOURCE) לא אושר בחשבון 019",
  992: "שם השולח (SMS_SOURCE) ארוך או קצר מדי",
};

export const loginCodeText = (code: string) => `קוד הכניסה למערכת A&O: ${code}\nהקוד תקף ל-5 דקות.`;

/** The body 019 expects for one message to one phone. */
export function build019Body(username: string, source: string, mobile: string, message: string) {
  return { sms: { user: { username }, source, destinations: { phone: [mobile] }, message } };
}

/** Reads 019's answer: status 0 means the message was accepted for sending. */
export function parse019Answer(json: unknown): { ok: boolean; error?: string } {
  const status = Number((json as { status?: unknown } | null)?.status);
  if (status === 0) return { ok: true };
  if (!Number.isFinite(status)) return { ok: false, error: "תשובה לא מובנת מ-019" };
  return { ok: false, error: `${REASONS[status] ?? "019 דחה את הבקשה"} (קוד ${status})` };
}

export function smsSettingsProblem(): string | null {
  if (process.env.SMS_PROVIDER !== "019") return `ספק ה-SMS "${process.env.SMS_PROVIDER}" אינו נתמך. הערך הנתמך הוא 019.`;
  if (!process.env.SMS_019_USERNAME) return "חסר SMS_019_USERNAME.";
  if (!process.env.SMS_019_TOKEN) return "חסר SMS_019_TOKEN.";
  if (!/^[A-Za-z0-9]{1,11}$/.test(process.env.SMS_SOURCE ?? "")) return "SMS_SOURCE חסר או לא תקין: עד 11 אותיות באנגלית או ספרות.";
  return null;
}

async function send019(mobile: string, message: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(process.env.SMS_019_URL || DEFAULT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.SMS_019_TOKEN}` },
      body: JSON.stringify(build019Body(process.env.SMS_019_USERNAME!, process.env.SMS_SOURCE!, mobile, message)),
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
    const json: unknown = await res.json().catch(() => null);
    if (json === null) return { ok: false, error: `019 ענה בלי תוכן מובן (HTTP ${res.status})` };
    return parse019Answer(json);
  } catch {
    return { ok: false, error: "אין תשובה מ-019 (תקלה ברשת או חריגה מזמן ההמתנה)" };
  }
}

export async function sendLoginCode(mobile: string, code: string): Promise<SmsResult> {
  const production = process.env.NODE_ENV === "production";
  if (!process.env.SMS_PROVIDER) {
    if (production) throw new Error("SMS_PROVIDER is not configured; login codes cannot be sent");
    console.log(`[dev] login code for ${mobile}: ${code}`);
    return { delivered: false, devCode: code };
  }
  if (!production) {
    const allowed = (process.env.SMS_DEV_ALLOW ?? "").split(",").map((s) => s.replace(/\D/g, "")).filter(Boolean);
    if (!allowed.includes(mobile)) return { delivered: false, devCode: code };
  }
  const problem = smsSettingsProblem();
  const result = problem ? { ok: false, error: problem } : await send019(mobile, loginCodeText(code));
  // The code itself is never logged once a real SMS is involved; only the last digits of the number are.
  if (!result.ok) console.error(`[sms] login code to ***${mobile.slice(-3)} was not sent: ${result.error}`);
  return { delivered: result.ok, error: result.error };
}
