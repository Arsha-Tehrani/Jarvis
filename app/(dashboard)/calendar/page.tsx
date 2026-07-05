import { Suspense } from "react";
import { CalendarView } from "@/components/calendar-view";

export default function CalendarPage() {
  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold">Calendar</h2>
      <Suspense>
        <CalendarView />
      </Suspense>
    </div>
  );
}
