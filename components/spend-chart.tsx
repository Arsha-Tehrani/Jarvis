"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { CategorySpend } from "@/lib/finance/analyze";

// Grouped horizontal bars: this month vs last month per category.
// Ledger chart grammar: the accent (oxblood) is reserved for interactive/
// selected UI and never colors a bar — the primary series uses --ink-soft,
// the comparison series the hairline --line. Identity also carried by the
// legend + table beside this chart.

const usd = (v: number) =>
  `$${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

export function SpendChart({
  data,
  onSelect,
}: {
  data: CategorySpend[];
  onSelect?: (category: string) => void;
}) {
  if (data.length === 0) return null;
  const rows = data.slice(0, 8);
  const height = 40 + rows.length * 52;

  return (
    <div className="[--series-1:var(--ink-soft)] [--series-2:var(--line)]">
      <div className="mb-2 flex gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="inline-block size-2.5 rounded-[2px] bg-[var(--series-1)]" />
          This month
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block size-2.5 rounded-[2px] bg-[var(--series-2)]" />
          Last month
        </span>
      </div>
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={rows} layout="vertical" barGap={2} barSize={10}>
          <CartesianGrid
            horizontal={false}
            stroke="var(--line)"
            strokeWidth={1}
          />
          <XAxis
            type="number"
            tickFormatter={usd}
            tick={{ fill: "var(--ink-muted)", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            type="category"
            dataKey="category"
            width={110}
            tick={{ fill: "var(--ink-muted)", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip
            cursor={{ fill: "transparent" }}
            formatter={(value) => usd(Number(value))}
            contentStyle={{
              borderRadius: 8,
              border: "1px solid var(--border)",
              background: "var(--background)",
              color: "var(--foreground)",
              fontSize: 12,
            }}
          />
          <Bar
            dataKey="thisMonth"
            name="This month"
            fill="var(--series-1)"
            radius={[0, 4, 4, 0]}
            cursor={onSelect ? "pointer" : undefined}
            onClick={(entry: unknown) => {
              // recharts hands the bar's data point; the original row is on .payload.
              const cat = (entry as { payload?: { category?: string } })?.payload?.category;
              if (cat) onSelect?.(cat);
            }}
          />
          <Bar
            dataKey="lastMonth"
            name="Last month"
            fill="var(--series-2)"
            radius={[0, 4, 4, 0]}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
