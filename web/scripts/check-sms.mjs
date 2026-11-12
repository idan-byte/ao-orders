// Tests sending the login code by SMS through 019, against a local stand-in for 019's API.
// Nothing here reaches the real service and no SMS is sent.
// Run from the web folder:  node scripts/check-sms.mjs
import { createServer } from "node:http";
import { build019Body, parse019Answer, loginCodeText, smsSettingsProblem, sendLoginCode } from "../src/lib/sms.ts";

let failed = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` -> got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
}

// ---------- a stand-in for 019
const received = [];
let answer = { status: 0, message: "SMS will be sent", shipment_id: "1" };
let raw = null;
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    received.push({ method: req.method, auth: req.headers.authorization, type: req.headers["content-type"], body: JSON.parse(body) });
    res.setHeader("Content-Type", "application/json");
    res.end(raw ?? JSON.stringify(answer));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const URL_ = `http://127.0.0.1:${server.address().port}/api`;
const logged = [];
const realError = console.error;
const realLog = console.log;
console.error = (...a) => logged.push(a.join(" "));
const env = (values) => {
  for (const k of ["SMS_PROVIDER", "SMS_019_USERNAME", "SMS_019_TOKEN", "SMS_SOURCE", "SMS_DEV_ALLOW", "SMS_019_URL", "NODE_ENV"]) delete process.env[k];
  Object.assign(process.env, values);
};
const FULL = { SMS_PROVIDER: "019", SMS_019_USERNAME: "user1", SMS_019_TOKEN: "secret-token", SMS_SOURCE: "AOFood", SMS_019_URL: URL_ };

// ---------- the request and the answer
check("the body 019 expects", build019Body("user1", "AOFood", "0521234567", "hi"), { sms: { user: { username: "user1" }, source: "AOFood", destinations: { phone: ["0521234567"] }, message: "hi" } });
check("the message says what the code is for and how long it lasts", loginCodeText("123456"), "קוד הכניסה למערכת A&O: 123456\nהקוד תקף ל-5 דקות.");
check("status 0 is success", parse019Answer({ status: 0, message: "SMS will be sent" }), { ok: true });
check("status as text is also read", parse019Answer({ status: "0" }), { ok: true });
check("no credit", parse019Answer({ status: 4 }), { ok: false, error: "אין מספיק יתרה בחשבון 019 (קוד 4)" });
check("an unapproved sender", parse019Answer({ status: 515 }), { ok: false, error: "שם השולח (SMS_SOURCE) לא אושר בחשבון 019 (קוד 515)" });
check("an unknown refusal keeps its number", parse019Answer({ status: 777 }), { ok: false, error: "019 דחה את הבקשה (קוד 777)" });
check("an answer without a status", [parse019Answer({}), parse019Answer(null)], [{ ok: false, error: "תשובה לא מובנת מ-019" }, { ok: false, error: "תשובה לא מובנת מ-019" }]);

// ---------- no provider
env({});
console.log = () => {};
const dev = await sendLoginCode("0521234567", "111111");
console.log = realLog;
check("development without a provider shows the code on the screen", dev, { delivered: false, devCode: "111111" });
env({ NODE_ENV: "production" });
let threw = false;
try { await sendLoginCode("0521234567", "111111"); } catch { threw = true; }
check("production without a provider refuses loudly", threw, true);

// ---------- development with a provider: only allowed numbers get a real SMS
env({ ...FULL });
check("a number that is not on the allow list gets the code on the screen", [await sendLoginCode("0521234567", "222222"), received.length], [{ delivered: false, devCode: "222222" }, 0]);
env({ ...FULL, SMS_DEV_ALLOW: "052-1234567, 0500000001" });
check("a number on the allow list gets a real SMS and no code on the screen", await sendLoginCode("0521234567", "333333"), { delivered: true });
check("the request carries the token, the sender and the code", received.at(-1), { method: "POST", auth: "Bearer secret-token", type: "application/json", body: { sms: { user: { username: "user1" }, source: "AOFood", destinations: { phone: ["0521234567"] }, message: "קוד הכניסה למערכת A&O: 333333\nהקוד תקף ל-5 דקות." } } });
check("another number is still kept on the screen", [(await sendLoginCode("0529999999", "444444")).devCode, received.length], ["444444", 1]);

// ---------- production
env({ ...FULL, NODE_ENV: "production" });
check("in production every number gets an SMS", [await sendLoginCode("0529999999", "555555"), received.at(-1).body.sms.destinations.phone], [{ delivered: true }, ["0529999999"]]);
answer = { status: 4, message: "Not enough credit" };
check("a refusal is reported, without the code", await sendLoginCode("0529999999", "666666"), { delivered: false, error: "אין מספיק יתרה בחשבון 019 (קוד 4)" });
check("the log names the reason and only the end of the number, never the code or the token", [logged.at(-1), logged.some((l) => l.includes("666666") || l.includes("secret-token") || l.includes("0529999999"))], ["[sms] login code to ***999 was not sent: אין מספיק יתרה בחשבון 019 (קוד 4)", false]);
raw = "<html>error</html>";
check("an answer that is not JSON is a failure", (await sendLoginCode("0529999999", "777777")).error, "019 ענה בלי תוכן מובן (HTTP 200)");
raw = null;
env({ ...FULL, NODE_ENV: "production", SMS_019_URL: "http://127.0.0.1:1/api" });
check("no connection is a failure, not a crash", (await sendLoginCode("0529999999", "888888")).error, "אין תשובה מ-019 (תקלה ברשת או חריגה מזמן ההמתנה)");

// ---------- settings
const before = received.length;
env({ ...FULL, NODE_ENV: "production", SMS_019_TOKEN: "" });
check("a missing token is reported and nothing is sent", [(await sendLoginCode("0529999999", "999999")).error, received.length - before], ["חסר SMS_019_TOKEN.", 0]);
env({ ...FULL, SMS_SOURCE: "אבי ועופר" });
check("a sender that is not English letters or digits", smsSettingsProblem(), "SMS_SOURCE חסר או לא תקין: עד 11 אותיות באנגלית או ספרות.");
env({ ...FULL, SMS_SOURCE: "ABCDEFGHIJKL" });
check("a sender longer than 11 characters", smsSettingsProblem() !== null, true);
env({ ...FULL, SMS_PROVIDER: "other" });
check("an unknown provider", smsSettingsProblem(), 'ספק ה-SMS "other" אינו נתמך. הערך הנתמך הוא 019.');
env({ ...FULL });
check("full settings have no problem", smsSettingsProblem(), null);

console.error = realError;
server.close();
console.log(failed ? `SMS CHECK FAILED (${failed})` : "SMS CHECK PASSED");
process.exit(failed ? 1 : 0);
