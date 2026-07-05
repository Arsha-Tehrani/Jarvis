import Link from "next/link";
import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

// Hub metric card: small label + icon top-left, big semibold hero number
// with a small lowercase unit, optional range hint top-right, optional
// sparkline/gauge below. The whole card links into its section.

export function MetricCard({
  href,
  label,
  icon,
  hero,
  unit,
  sub,
  range,
  children,
  className,
}: {
  href: string;
  label: string;
  icon?: ReactNode;
  hero: ReactNode;
  unit?: string;
  sub?: ReactNode;
  range?: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <Link href={href} className="group block focus-visible:outline-none">
      <Card
        className={cn(
          "h-full gap-3 transition-shadow group-hover:ring-foreground/10 group-focus-visible:ring-2 group-focus-visible:ring-ring",
          className
        )}
      >
        <div className="flex items-start justify-between px-(--card-spacing)">
          <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <span className="text-primary [&>svg]:size-3.5">{icon}</span>
            {label}
          </span>
          {range && <span className="text-xs text-muted-foreground/70">{range}</span>}
        </div>
        <div className="px-(--card-spacing)">
          <p className="text-3xl leading-none font-semibold tracking-tight">
            {hero}
            {unit && (
              <span className="ml-1 text-sm font-normal text-muted-foreground lowercase">
                {unit}
              </span>
            )}
          </p>
          {sub && <div className="mt-1.5 text-xs text-muted-foreground">{sub}</div>}
        </div>
        {children && <div className="mt-auto px-(--card-spacing)">{children}</div>}
      </Card>
    </Link>
  );
}
