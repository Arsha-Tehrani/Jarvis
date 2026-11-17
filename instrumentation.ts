// Next.js instrumentation hook — runs once when the server starts
// (dev and prod), which is where the in-process cron worker belongs, and now
// the Slack Socket Mode connection too: both are persistent, process-lifetime
// things that can't live in a request handler. Both self-guard against dev
// hot-reload double-initialization.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startCron } = await import("@/lib/cron");
    startCron();
    const { startSlackSocket } = await import("@/lib/slack/socket");
    // Awaited connect, but never fatal — startSlackSocket swallows its own
    // failure so a bad app token can't stop the server from booting.
    await startSlackSocket();
  }
}
