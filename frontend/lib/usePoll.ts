"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Polls a URL on an interval. Deliberately tiny. The alternative was pulling
 * in a data library for two endpoints that return arrays.
 */
export function usePoll<T>(url: string | null, intervalMs: number) {
  const [data, setData] = useState<T | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    if (!url) return;
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (res.ok) setData((await res.json()) as T);
    } catch {
      /* a failed poll is not worth surfacing; the next one may succeed */
    }
  }, [url]);

  useEffect(() => {
    if (!url) return;
    let alive = true;
    const tick = async () => {
      await load();
      if (alive) timer.current = setTimeout(tick, intervalMs);
    };
    void tick();
    return () => {
      alive = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [url, intervalMs, load]);

  return { data, refresh: load };
}
