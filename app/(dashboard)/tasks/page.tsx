import { TasksView } from "@/components/tasks-view";

export default function TasksPage() {
  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold">Tasks</h2>
      <TasksView />
    </div>
  );
}
