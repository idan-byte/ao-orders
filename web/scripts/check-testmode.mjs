// Tests test mode for outgoing mail: with AO_TEST_MODE=1 every message goes to AO_TEST_EMAIL only, whoever the
// recipient is; the subject and the body say so. All addresses here are made up.
// Run from the web folder:  node scripts/check-testmode.mjs
import { inTestMode, testAddress, testMode } from "../src/lib/mail-test-mode.ts";

let failed = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` -> got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
}

const mail = { to: "customer@example.org", subject: "הצעת מחיר 1234", text: "שלום", html: "<p>שלום</p>" };
const TEST = "tester@example.net";

delete process.env.AO_TEST_MODE;
delete process.env.AO_TEST_EMAIL;
check("test mode is off unless AO_TEST_MODE is 1", testMode(), false);

process.env.AO_TEST_MODE = "1";
process.env.AO_TEST_EMAIL = `  ${TEST}  `;
check("test mode is on with AO_TEST_MODE=1", testMode(), true);
check("the test address is read without its spaces", testAddress(), TEST);
const out = inTestMode(mail);
check("the recipient is always the test address", out.to, TEST);
check("the intended recipient never appears as the address", out.to === mail.to, false);
check("the subject says it is a test", out.subject, "[טסט] הצעת מחיר 1234");
check("the body names the intended recipient", out.text.includes("נועדה במקור אל customer@example.org"), true);
check("the body keeps the message", out.text.endsWith("שלום"), true);
check("the html keeps the message and names the recipient", out.html.includes("<p>שלום</p>") && out.html.includes("customer@example.org"), true);
check("a message without html stays without html", inTestMode({ ...mail, html: undefined }).html, undefined);
check("the original message is not changed", mail.to, "customer@example.org");

console.log(failed === 0 ? "TESTMODE CHECK PASSED" : `TESTMODE CHECK FAILED (${failed})`);
process.exit(failed === 0 ? 0 : 1);
