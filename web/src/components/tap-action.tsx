"use client";

import { useActionState, type ReactNode } from "react";

type State = { error?: string; ok?: string };

/**
 * One large touch target bound to a server action, for work done standing next to a vehicle.
 * A refusal from the server is shown right under the button that caused it.
 */
export function TapAction({
  action,
  fields,
  children,
  className,
  pendingLabel = "רגע…",
  confirm,
}: {
  action: (prev: State, formData: FormData) => Promise<State>;
  fields: Record<string, string>;
  children: ReactNode;
  className: string;
  pendingLabel?: string;
  confirm?: string;
}) {
  const [state, formAction, pending] = useActionState<State, FormData>(action, {});
  return (
    <form
      action={formAction}
      className="flex flex-col gap-1"
      onSubmit={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      {Object.entries(fields).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      {/* A disabled button cannot be tapped twice while the first tap is on its way. */}
      <button disabled={pending} className={`${className} disabled:opacity-60`}>
        {pending ? pendingLabel : children}
      </button>
      {state.error ? (
        <p role="alert" className="rounded-lg bg-sunken px-3 py-2 text-sm font-medium">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
