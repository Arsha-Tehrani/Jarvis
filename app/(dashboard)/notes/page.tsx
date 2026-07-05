import { NotesView } from "@/components/notes-view";

export default function NotesPage() {
  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold">Notes</h2>
      <NotesView />
    </div>
  );
}
