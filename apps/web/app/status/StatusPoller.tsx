"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Re-checks the status while it can still change.
 *
 * Polling, not WebSockets, and deliberately so for now: the stack has a
 * Socket.IO gateway planned for live updates, and adding it here would mean
 * building the gateway before the flow it is meant to report on. Two seconds
 * of polling is honest, obvious, and easy to delete.
 *
 * It stops on its own once the server renders a settled status, because the
 * parent only mounts this component while the outcome is still open.
 */
export function StatusPoller({ intervalMs = 2000 }: { intervalMs?: number }) {
  const router = useRouter();

  useEffect(() => {
    const timer = setInterval(() => {
      router.refresh();
    }, intervalMs);

    return () => clearInterval(timer);
  }, [router, intervalMs]);

  return null;
}
