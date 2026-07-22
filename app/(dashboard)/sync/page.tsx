import { SyncView } from "@/components/sync-view";

export const dynamic = "force-dynamic";

export default function SyncPage() {
  return (
    <div className="flex flex-col gap-6">
      <SyncView />
    </div>
  );
}
