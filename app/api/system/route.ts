import { NextResponse } from "next/server";
import si from "systeminformation";

// Live hardware stats for the dashboard <SystemMonitor /> widget.
// Read-only probes; systeminformation covers both the macOS and Windows
// boxes this runs on. Polled by the client every few seconds, so keep it
// to the three cheap calls below.

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [load, mem, disks, graphics] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.fsSize(),
      si.graphics(),
    ]);
    // The OS drive: "/" on macOS/Linux, "C:" on Windows; largest as fallback.
    const main =
      disks.find((d) => d.mount === "/" || /^c:/i.test(d.mount)) ??
      disks.reduce<(typeof disks)[number] | undefined>(
        (a, b) => (b.size > (a?.size ?? 0) ? b : a),
        undefined
      );
    // Prefer whichever controller actually reports live utilization (the
    // discrete GPU on a dual-GPU Windows laptop, say); fall back to the
    // first one otherwise. Integrated GPUs (Apple Silicon in particular)
    // report model/cores but no live load — that's a platform limit, not
    // a bug, so load/memory stay null rather than faked.
    const gpu =
      graphics.controllers.find((c) => c.utilizationGpu != null) ??
      graphics.controllers[0];
    return NextResponse.json({
      cpu: { load: Math.round(load.currentLoad * 10) / 10, cores: load.cpus.length },
      // "active" excludes the OS file cache — matches what Activity Monitor
      // and Task Manager report as used.
      memory: { used: mem.active, total: mem.total },
      disk: main ? { used: main.used, size: main.size, mount: main.mount } : null,
      gpu: gpu
        ? {
            model: gpu.model,
            load: gpu.utilizationGpu ?? null,
            memoryUsed: gpu.memoryUsed != null ? gpu.memoryUsed * 1024 * 1024 : null,
            memoryTotal: gpu.memoryTotal != null ? gpu.memoryTotal * 1024 * 1024 : null,
          }
        : null,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "System probe failed" },
      { status: 500 }
    );
  }
}
