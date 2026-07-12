"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  BookOpen,
  Briefcase,
  Calendar,
  FileText,
  HeartPulse,
  Home,
  Landmark,
  ListChecks,
  Mail,
  Menu,
  Repeat,
  Search,
  ShieldCheck,
  Target,
  TrendingUp,
  Users,
  Wallet,
} from "lucide-react";
import { cn } from "@/lib/utils";

export const NAV_ITEMS = [
  { href: "/", label: "Today", icon: Home },
  { href: "/search", label: "Search", icon: Search },
  { href: "/tasks", label: "Tasks", icon: ListChecks },
  { href: "/mail", label: "Mail", icon: Mail },
  { href: "/calendar", label: "Calendar", icon: Calendar },
  { href: "/trackers", label: "Trackers", icon: Activity },
  { href: "/health", label: "Health", icon: HeartPulse },
  { href: "/habits", label: "Habits", icon: Repeat },
  { href: "/goals", label: "Goals", icon: Target },
  { href: "/career", label: "Career", icon: Briefcase },
  { href: "/reading", label: "Reading", icon: BookOpen },
  { href: "/people", label: "People", icon: Users },
  { href: "/finance", label: "Finance", icon: Wallet },
  { href: "/stocks", label: "Stocks", icon: TrendingUp },
  { href: "/networth", label: "Net worth", icon: Landmark },
  { href: "/notes", label: "Notes", icon: FileText },
  { href: "/status", label: "Status", icon: ShieldCheck },
];

// Sidebar section grouping (Paper Ledger nav). Goals isn't named in the
// spec's grouping — it lives beside its sibling Trackers/Habits since it's
// the same tracker-target concept (README: "Goals are just Tracker
// targets") and the page itself just redirects to Trackers.
const NAV_SECTIONS: { label: string; hrefs: string[] }[] = [
  { label: "Do", hrefs: ["/", "/search", "/tasks", "/mail", "/calendar"] },
  {
    label: "Track",
    hrefs: [
      "/trackers",
      "/health",
      "/habits",
      "/goals",
      "/career",
      "/reading",
      "/people",
    ],
  },
  { label: "Money", hrefs: ["/finance", "/stocks", "/networth"] },
];
const GROUPED_HREFS = new Set(NAV_SECTIONS.flatMap((s) => s.hrefs));
const UNGROUPED_ITEMS = NAV_ITEMS.filter((item) => !GROUPED_HREFS.has(item.href));

function NavItem({
  href,
  label,
  icon: Icon,
  active,
  expanded,
}: {
  href: string;
  label: string;
  icon: typeof Home;
  active: boolean;
  expanded: boolean;
}) {
  return (
    <Link
      href={href}
      title={expanded ? undefined : label}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex h-10 items-center rounded-xl transition-colors",
        expanded ? "w-full gap-3 px-3" : "w-10 justify-center",
        active
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground"
      )}
    >
      <Icon className="size-5 shrink-0" strokeWidth={1.75} />
      {expanded && <span className="truncate text-sm font-medium">{label}</span>}
    </Link>
  );
}

// Desktop: collapsible sidebar — a slim icon rail that expands to show
// labels when the hamburger at the top is clicked. Phones keep the fixed
// bottom bar (no hover there, and no room for a persistent sidebar).
export function AppSidebar({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle: () => void;
}) {
  const pathname = usePathname();
  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <>
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-20 hidden flex-col gap-2 border-r border-sidebar-border bg-sidebar py-4 transition-[width] duration-200 md:flex",
          open ? "w-60 px-3" : "w-16 items-center"
        )}
      >
        <div className={cn("mb-2 flex items-center gap-2", !open && "justify-center")}>
          <button
            type="button"
            onClick={onToggle}
            aria-label={open ? "Collapse sidebar" : "Expand sidebar"}
            aria-expanded={open}
            className="flex size-10 shrink-0 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <Menu className="size-5" strokeWidth={1.75} />
          </button>
          {open && (
            <Link href="/" className="truncate text-lg font-semibold tracking-tight">
              Jarvis
            </Link>
          )}
        </div>
        <nav
          className={cn(
            "flex min-h-0 flex-1 flex-col overflow-y-auto",
            open ? "gap-4" : "items-center gap-2"
          )}
        >
          {open ? (
            <>
              {NAV_SECTIONS.map((section) => (
                <div key={section.label} className="flex flex-col gap-1">
                  <span className="px-3 text-[11px] font-medium tracking-[0.04em] text-muted-foreground uppercase">
                    {section.label}
                  </span>
                  {section.hrefs.map((href) => {
                    const item = NAV_ITEMS.find((i) => i.href === href);
                    if (!item) return null;
                    return (
                      <NavItem
                        key={item.href}
                        {...item}
                        active={isActive(item.href)}
                        expanded
                      />
                    );
                  })}
                </div>
              ))}
              <div className="flex flex-col gap-1">
                {UNGROUPED_ITEMS.map((item) => (
                  <NavItem
                    key={item.href}
                    {...item}
                    active={isActive(item.href)}
                    expanded
                  />
                ))}
              </div>
            </>
          ) : (
            NAV_ITEMS.map((item) => (
              <NavItem
                key={item.href}
                {...item}
                active={isActive(item.href)}
                expanded={false}
              />
            ))
          )}
        </nav>
      </aside>
      <nav className="fixed inset-x-0 bottom-0 z-20 flex items-center justify-around border-t border-sidebar-border bg-sidebar px-2 py-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))] md:hidden">
        {NAV_ITEMS.map((item) => (
          <NavItem
            key={item.href}
            {...item}
            active={isActive(item.href)}
            expanded={false}
          />
        ))}
      </nav>
    </>
  );
}
