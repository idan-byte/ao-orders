"use client";

import { useActionState } from "react";
import { loginAction, type LoginState } from "./actions";

const input = "w-full rounded-lg border border-line bg-surface px-3 py-2.5 text-lg tabular-nums";
const primary = "rounded-lg bg-accent px-4 py-2.5 font-medium text-surface disabled:opacity-60";

export function LoginForm() {
  const [state, action, pending] = useActionState<LoginState, FormData>(loginAction, { step: "mobile" });

  return (
    <form action={action} className="flex flex-col gap-3">
      {state.step === "mobile" ? (
        <>
          <label htmlFor="mobile" className="text-sm text-muted">
            מספר נייד
          </label>
          <input id="mobile" name="mobile" type="tel" inputMode="tel" autoComplete="tel" dir="ltr" placeholder="050-0000000" required className={input} />
          <button name="intent" value="request" disabled={pending} className={primary}>
            {pending ? "שולח…" : "שלח לי קוד"}
          </button>
        </>
      ) : (
        <>
          <input type="hidden" name="mobile" value={state.mobile ?? ""} />
          <p className="text-sm text-muted">
            נייד: <span dir="ltr">{state.mobile}</span>
          </p>
          <label htmlFor="code" className="text-sm text-muted">
            קוד בן 6 ספרות
          </label>
          <input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" dir="ltr" maxLength={6} pattern="\d{6}" className={input} />
          <button name="intent" value="verify" disabled={pending} className={primary}>
            {pending ? "בודק…" : "כניסה"}
          </button>
          <button name="intent" value="back" formNoValidate disabled={pending} className="rounded-lg px-4 py-2 text-muted">
            מספר אחר או קוד חדש
          </button>
        </>
      )}
      {state.info && !state.error ? <p className="text-sm text-muted">{state.info}</p> : null}
      {state.error ? (
        <p role="alert" className="rounded-lg bg-sunken px-3 py-2 text-sm font-medium">
          {state.error}
        </p>
      ) : null}
      {state.devCode ? (
        <p className="rounded-lg border border-dashed border-line px-3 py-2 text-sm">
          סביבת פיתוח: למספר הזה לא נשלח SMS. הקוד הוא{" "}
          <b dir="ltr" className="tabular-nums">
            {state.devCode}
          </b>
        </p>
      ) : null}
    </form>
  );
}
