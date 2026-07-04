// Next.js instrumentation hook — runs once when the server starts
// (dev and prod), which is where the in-process cron worker belongs.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startCron } = await import("@/lib/cron");
    startCron();
  }
}
