"use client";

import { usePathname } from "next/navigation";
import { NAV_ITEMS } from "@/components/app-sidebar";
import { SystemClock } from "@/components/system-clock";

// Top bar: current page title left, server clock + backup + identity right.
export function TopBar() {
  const pathname = usePathname();
  const current =
    NAV_ITEMS.find((item) =>
      item.href === "/" ? pathname === "/" : pathname.startsWith(item.href)
    )?.label ?? "Jarvis";

  return (
    <header className="flex items-center justify-between gap-4 py-1">
      <h1 className="font-heading text-[26px] font-semibold tracking-tight text-foreground">
        {current}
      </h1>
      <div className="flex items-center gap-3">
        <SystemClock />
        <a href="/api/backup" download className="action-link text-sm">
          Backup ↓
        </a>
        <span className="hidden text-sm text-muted-foreground sm:inline">Arsha</span>
        <span
          aria-hidden
          className="flex size-8 items-center justify-center rounded-full bg-accent text-sm font-medium text-accent-foreground"
        >
          A
        </span>
      </div>
    </header>
  );
}
