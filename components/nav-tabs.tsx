"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const TABS = [
  { href: "/", label: "Today" },
  { href: "/tasks", label: "Tasks" },
  { href: "/trackers", label: "Trackers" },
  { href: "/finance", label: "Finance" },
  { href: "/stocks", label: "Stocks" },
  { href: "/notes", label: "Notes" },
  { href: "/calendar", label: "Calendar" },
];

export function NavTabs() {
  const pathname = usePathname();
  return (
    <nav className="flex flex-wrap gap-1">
      {TABS.map((tab) => {
        const active =
          tab.href === "/" ? pathname === "/" : pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              active
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
