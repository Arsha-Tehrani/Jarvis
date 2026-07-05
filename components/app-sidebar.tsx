"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  Calendar,
  FileText,
  Home,
  ListChecks,
  TrendingUp,
  Wallet,
} from "lucide-react";
import { cn } from "@/lib/utils";

export const NAV_ITEMS = [
  { href: "/", label: "Today", icon: Home },
  { href: "/tasks", label: "Tasks", icon: ListChecks },
  { href: "/trackers", label: "Trackers", icon: Activity },
  { href: "/finance", label: "Finance", icon: Wallet },
  { href: "/stocks", label: "Stocks", icon: TrendingUp },
  { href: "/notes", label: "Notes", icon: FileText },
  { href: "/calendar", label: "Calendar", icon: Calendar },
];

function NavIcon({
  href,
  label,
  icon: Icon,
  active,
}: {
  href: string;
  label: string;
  icon: typeof Home;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      title={label}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex size-10 items-center justify-center rounded-xl transition-colors",
        active
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground"
      )}
    >
      <Icon className="size-5" strokeWidth={1.75} />
    </Link>
  );
}

// Slim icon-only rail: fixed left on desktop, fixed bottom bar on phones.
export function AppSidebar() {
  const pathname = usePathname();
  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <>
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-16 flex-col items-center gap-2 border-r border-sidebar-border bg-sidebar py-4 md:flex">
        <Link
          href="/"
          className="mb-2 flex size-10 items-center justify-center rounded-xl bg-primary text-lg font-semibold text-primary-foreground"
          aria-label="Jarvis home"
        >
          J
        </Link>
        {NAV_ITEMS.map((item) => (
          <NavIcon key={item.href} {...item} active={isActive(item.href)} />
        ))}
      </aside>
      <nav className="fixed inset-x-0 bottom-0 z-20 flex items-center justify-around border-t border-sidebar-border bg-sidebar px-2 py-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))] md:hidden">
        {NAV_ITEMS.map((item) => (
          <NavIcon key={item.href} {...item} active={isActive(item.href)} />
        ))}
      </nav>
    </>
  );
}
