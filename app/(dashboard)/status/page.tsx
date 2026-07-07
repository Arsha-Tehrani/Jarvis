import { AgentStats } from "@/components/agent-stats";
import { StatusView } from "@/components/status-view";

export const dynamic = "force-dynamic";

export default function StatusPage() {
  return (
    <div className="flex flex-col gap-6">
      <StatusView />
      <AgentStats />
    </div>
  );
}
