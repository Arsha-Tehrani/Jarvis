import { Suspense } from "react";
import { NotesView } from "@/components/notes-view";

export default function NotesPage() {
  return (
    <Suspense>
      <NotesView />
    </Suspense>
  );
}
