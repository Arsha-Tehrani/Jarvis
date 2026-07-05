"use client";

import { usePathname } from "next/navigation";
import { NAV_ITEMS } from "@/components/app-sidebar";

// Top bar: current page title left, backup + identity right.
export function TopBar() {
  const pathname = usePathname();
  const current =
    NAV_ITEMS.find((item) =>
      item.href === "/" ? pathname === "/" : pathname.startsWith(item.href)
    )?.label ?? "Jarvis";

  return (
    <header className="flex items-center justify-between gap-4 py-1">
      <h1 className="text-xl font-semibold tracking-tight">{current}</h1>
      <div className="flex items-center gap-3">
        <a
          href="/api/backup"
          download
          className="text-sm text-muted-foreground hover:text-foreground hover:underline"
        >
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
