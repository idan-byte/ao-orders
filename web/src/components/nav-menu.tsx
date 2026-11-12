"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

export type NavItem = { href: string; label: string };

const isCurrent = (pathname: string, href: string) => (href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(href + "/"));
const top = "whitespace-nowrap rounded-lg px-3 py-2 hover:bg-accent-soft hover:text-accent";

/** One screen in the top bar. */
export function NavLink({ href, label }: NavItem) {
  const current = isCurrent(usePathname(), href);
  return (
    <Link href={href} aria-current={current ? "page" : undefined} className={`${top} ${current ? "font-medium text-foreground" : "text-muted"}`}>
      {label}
    </Link>
  );
}

/**
 * A group of screens that opens under its name. With `gear` the button is a small cog (settings) and the
 * list opens towards the middle of the screen. The links stay in the page while the list is closed.
 */
export function NavMenu({ label, items, gear = false }: { label: string; items: NavItem[]; gear?: boolean }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const inside = items.some((i) => isCurrent(pathname, i.href));

  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  return (
    <div ref={box} className="relative" data-nav-group={label}>
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="true"
        aria-label={gear ? label : undefined}
        title={gear ? label : undefined}
        onClick={() => setOpen((v) => !v)}
        className={gear ? `rounded-lg border border-line p-1.5 hover:bg-accent-soft hover:text-accent ${inside || open ? "text-foreground" : "text-muted"}` : `${top} flex items-center gap-1 ${inside || open ? "font-medium text-foreground" : "text-muted"}`}
      >
        {gear ? (
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        ) : (
          <>
            {label}
            <span aria-hidden="true" className="text-xs">
              ▾
            </span>
          </>
        )}
      </button>
      <div hidden={!open} className={`absolute top-full z-20 mt-1 min-w-44 flex-col rounded-xl border border-line bg-surface p-1 shadow-lg ${open ? "flex" : ""} ${gear ? "end-0" : "start-0"}`}>
        {gear ? <div className="px-3 py-1.5 text-xs text-muted">{label}</div> : null}
        {items.map((i) => {
          const current = isCurrent(pathname, i.href);
          return (
            <Link key={i.href} href={i.href} onClick={() => setOpen(false)} aria-current={current ? "page" : undefined} className={`whitespace-nowrap rounded-lg px-3 py-2 hover:bg-accent-soft hover:text-accent ${current ? "font-medium text-foreground" : "text-muted"}`}>
              {i.label}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
