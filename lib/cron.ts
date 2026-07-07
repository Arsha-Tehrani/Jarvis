import cron from "node-cron";
import { morningBriefJob } from "@/lib/brief";
import { weeklyDigestJob } from "@/lib/digest";
import { syncGoodNotesJob } from "@/lib/goodnotes";
import { pollCalendarJob } from "@/lib/google";
import { pullLeetCodeJob } from "@/lib/leetcode";
import { pollMailJob } from "@/lib/mail";
import { netWorthSnapshotJob } from "@/lib/networth";
import { slackCheckinJob } from "@/lib/slack";
import { refreshSearchIndexJob } from "@/lib/search-index";
import { refreshStocksJob } from "@/lib/stocks";
import { syncJob } from "@/lib/sync/client";

// In-process scheduler. Non-negotiable #6: every scheduled job also runs
// once at startup (catch-up-on-launch) so gaps self-heal after sleep.

type Job = {
  name: string;
  schedule: string;
  run: () => Promise<void>;
};

const JOBS: Job[] = [
  { name: "leetcode-daily-pull", schedule: "0 8 * * *", run: pullLeetCodeJob },
  { name: "stocks-refresh", schedule: "*/15 * * * *", run: refreshStocksJob },
  { name: "calendar-poll", schedule: "0 * * * *", run: pollCalendarJob },
  // Offset from the calendar poll so the two Google calls don't stack.
  { name: "goodnotes-sync", schedule: "15 * * * *", run: syncGoodNotesJob },
  { name: "networth-daily-snapshot", schedule: "0 18 * * *", run: netWorthSnapshotJob },
  {
    name: "weekly-digest",
    schedule: "0 21 * * 0",
    run: async () => {
      await weeklyDigestJob();
    },
  },
  { name: "slack-morning-checkin", schedule: "30 8 * * *", run: slackCheckinJob },
  { name: "slack-morning-brief", schedule: "0 8 * * *", run: morningBriefJob },
  { name: "mail-poll", schedule: "*/30 * * * *", run: pollMailJob },
  // Offset from the mail poll so new subjects usually index right after it.
  { name: "search-index-refresh", schedule: "5,35 * * * *", run: refreshSearchIndexJob },
  // Device sync (no-op unless SYNC_ROLE=client): push dirty rows to the
  // host, pull everyone's back. Debounced pushes fire sooner after writes;
  // this tick is the backstop and the only pull path.
  { name: "sync", schedule: "*/5 * * * *", run: syncJob },
];

const globalForCron = globalThis as unknown as { __jarvisCronStarted?: boolean };

export function startCron(): void {
  if (globalForCron.__jarvisCronStarted) return;
  globalForCron.__jarvisCronStarted = true;

  for (const job of JOBS) {
    cron.schedule(job.schedule, () => {
      job.run().catch((err) => console.error(`[cron] ${job.name} failed:`, err));
    });
    console.log(`[cron] scheduled ${job.name} (${job.schedule})`);
    // Catch-up-on-launch: fire once now, off the startup path.
    job
      .run()
      .then(() => console.log(`[cron] catch-up ${job.name} done`))
      .catch((err) => console.error(`[cron] catch-up ${job.name} failed:`, err));
  }
}
