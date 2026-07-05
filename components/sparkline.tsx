"use client";

import { useRef, useState } from "react";

// Tiny inline chart for hub cards: thin muted stroke, minimal fill, and the
// signature hover tooltip — date + value with a thin dotted vertical guide.

export type SparkPoint = { label: string; value: number };

type Props = {
  data: SparkPoint[];
  height?: number;
  variant?: "line" | "bars";
  formatValue?: (v: number) => string;
};

const W = 200; // viewBox units; scales to container width

export function Sparkline({
  data,
  height = 48,
  variant = "line",
  formatValue = (v) => String(Math.round(v * 100) / 100),
}: Props) {
  const [hover, setHover] = useState<number | null>(null);
  const ref = useRef<SVGSVGElement>(null);
  if (data.length === 0) return null;

  const max = Math.max(...data.map((d) => d.value), 1e-9);
  const min = variant === "bars" ? 0 : Math.min(...data.map((d) => d.value));
  const span = max - min || 1;
  const pad = 4;
  const innerH = height - pad * 2;
  const x = (i: number) =>
    data.length === 1 ? W / 2 : (i / (data.length - 1)) * (W - pad * 2) + pad;
  const y = (v: number) => pad + innerH - ((v - min) / span) * innerH;

  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    const rel = ((e.clientX - rect.left) / rect.width) * W;
    const idx = Math.round(((rel - pad) / (W - pad * 2)) * (data.length - 1));
    setHover(Math.max(0, Math.min(data.length - 1, idx)));
  }

  const hovered = hover != null ? data[hover] : null;

  return (
    <div className="relative">
      <svg
        ref={ref}
        viewBox={`0 0 ${W} ${height}`}
        className="block w-full"
        style={{ height }}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        role="img"
        aria-label={`Trend, latest ${formatValue(data[data.length - 1].value)}`}
      >
        {variant === "line" ? (
          <>
            <polygon
              points={[
                `${x(0)},${height - pad}`,
                ...data.map((d, i) => `${x(i)},${y(d.value)}`),
                `${x(data.length - 1)},${height - pad}`,
              ].join(" ")}
              fill="var(--primary)"
              opacity={0.07}
            />
            <polyline
              points={data.map((d, i) => `${x(i)},${y(d.value)}`).join(" ")}
              fill="none"
              stroke="var(--primary)"
              strokeWidth={1.75}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          </>
        ) : (
          data.map((d, i) => {
            const bw = Math.min(10, (W - pad * 2) / data.length - 2);
            return (
              <rect
                key={i}
                x={x(i) - bw / 2}
                y={y(d.value)}
                width={bw}
                height={Math.max(1.5, height - pad - y(d.value))}
                rx={2}
                fill={hover === i ? "var(--primary)" : "var(--primary)"}
                opacity={hover === i ? 1 : 0.45}
              />
            );
          })
        )}
        {hovered && (
          <>
            <line
              x1={x(hover as number)}
              x2={x(hover as number)}
              y1={pad}
              y2={height - pad}
              stroke="var(--muted-foreground)"
              strokeWidth={1}
              strokeDasharray="2 3"
            />
            {variant === "line" && (
              <circle
                cx={x(hover as number)}
                cy={y(hovered.value)}
                r={3}
                fill="var(--primary)"
                stroke="var(--card)"
                strokeWidth={1.5}
              />
            )}
          </>
        )}
      </svg>
      {hovered && (
        <div
          className="pointer-events-none absolute -top-1 z-10 -translate-x-1/2 -translate-y-full rounded-md border bg-popover px-2 py-1 text-xs whitespace-nowrap text-popover-foreground shadow-soft"
          style={{ left: `${(x(hover as number) / W) * 100}%` }}
        >
          <span className="text-muted-foreground">{hovered.label}</span>{" "}
          <span className="font-medium">{formatValue(hovered.value)}</span>
        </div>
      )}
    </div>
  );
}
