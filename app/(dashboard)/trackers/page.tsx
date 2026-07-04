import { TrackersView } from "@/components/trackers-view";

export default function TrackersPage() {
  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold">Trackers</h2>
      <TrackersView />
    </div>
  );
}
