"use client";

import { useState, useSyncExternalStore } from "react";

const subscribe = () => () => {};

/** Shows a full link built from the current site address, with a copy button. */
export function CopyLink({ path }: { path: string }) {
  const origin = useSyncExternalStore(subscribe, () => window.location.origin, () => "");
  const [copied, setCopied] = useState(false);
  const url = origin + path;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input readOnly dir="ltr" value={url} aria-label="קישור לאישור ההצעה" onFocus={(e) => e.target.select()} className="min-w-0 flex-1 rounded-lg border border-line bg-sunken px-3 py-2 text-sm" />
      <button
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(url);
            setCopied(true);
          } catch {
            setCopied(false);
          }
        }}
        className="rounded-lg border border-line px-3 py-2 text-sm"
      >
        {copied ? "הועתק" : "העתק קישור"}
      </button>
    </div>
  );
}
