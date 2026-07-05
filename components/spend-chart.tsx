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
// Colors are validated categorical slots (see dataviz palette); the table
// beside this chart is the relief for light-mode contrast on series 2.

const usd = (v: number) =>
  `$${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

export function SpendChart({ data }: { data: CategorySpend[] }) {
  if (data.length === 0) return null;
  const rows = data.slice(0, 8);
  const height = 40 + rows.length * 52;

  return (
    <div
      className={[
        "[--gridline:#e1e0d9] [--ink-muted:#898781] [--series-1:#2a78d6] [--series-2:#1baf7a]",
        "dark:[--gridline:#2c2c2a] dark:[--series-1:#3987e5] dark:[--series-2:#199e70]",
      ].join(" ")}
    >
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
            stroke="var(--gridline)"
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
