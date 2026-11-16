"use client";

import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";

// A small dialog drawn over the page. Closes with the button, a click outside it, or Escape.
// It is drawn into the body of the page, so it is never inside another form: Enter in its fields submits nothing else.
export function Popup({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={title} className="w-full max-w-lg rounded-xl border border-line bg-surface p-5" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="font-display text-lg font-bold">{title}</h2>
          <button type="button" onClick={onClose} className="rounded-lg border border-line px-2.5 py-1 text-sm">
            סגור
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}
