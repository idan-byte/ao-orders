"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

/**
 * Keeps a work screen current without reloading the page: every few seconds it asks the server whether
 * anything changed, and if so reloads the screen's data in place. What is typed in a field stays.
 * It rests while the tab is hidden and checks at once when the tab comes back.
 */
export function LiveRefresh({ seconds = 4 }: { seconds?: number }) {
  const router = useRouter();
  const seen = useRef<string | null>(null);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      clearTimeout(timer);
      if (!alive || document.hidden) return;
      try {
        const res = await fetch("/live", { cache: "no-store" });
        if (res.status === 401) return; // signed out: stop asking
        if (res.ok) {
          const { v } = (await res.json()) as { v: string };
          if (seen.current !== null && v !== seen.current) router.refresh();
          seen.current = v;
          document.documentElement.dataset.live = v;
        }
      } catch {
        // No network for a moment: the next round tries again.
      }
      if (alive) timer = setTimeout(check, seconds * 1000);
    };
    const wake = () => {
      if (!document.hidden) void check();
    };
    document.addEventListener("visibilitychange", wake);
    void check();
    return () => {
      alive = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [router, seconds]);
  return null;
}
