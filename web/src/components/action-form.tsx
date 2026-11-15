"use client";

import { startTransition, useActionState, type FormEvent, type ReactNode } from "react";

type State = { error?: string; ok?: string };

/** A form bound to a server action that returns { error } or { ok }, with the message shown under it. */
export function ActionForm({
  action,
  children,
  submit,
  pendingLabel,
  className = "flex flex-wrap items-end gap-3",
  primary = true,
  keep = false,
}: {
  action: (prev: State, formData: FormData) => Promise<State>;
  children?: ReactNode;
  submit: string;
  pendingLabel?: string;
  className?: string;
  primary?: boolean;
  /** Keeps what was typed when the action answers with an error, instead of resetting the form. For long forms a person corrects. */
  keep?: boolean;
}) {
  const [state, formAction, pending] = useActionState<State, FormData>(action, {});
  // A form sent through `action` is reset by React when the action returns. Sending it by hand leaves the fields alone.
  const send = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    startTransition(() => formAction(data));
  };
  return (
    <form action={keep ? undefined : formAction} onSubmit={keep ? send : undefined} className="flex flex-col gap-2">
      <div className={className}>
        {children}
        <button
          disabled={pending}
          className={
            primary
              ? "rounded-lg bg-accent px-4 py-2 font-medium text-surface disabled:opacity-60"
              : "rounded-lg border border-line px-4 py-2 text-foreground disabled:opacity-60"
          }
        >
          {pending ? (pendingLabel ?? "שומר…") : submit}
        </button>
      </div>
      {state.error ? (
        <p role="alert" className="rounded-lg bg-sunken px-3 py-2 text-sm font-medium">
          {state.error}
        </p>
      ) : null}
      {state.ok ? (
        <p role="status" className="text-sm text-muted">
          {state.ok}
        </p>
      ) : null}
    </form>
  );
}
