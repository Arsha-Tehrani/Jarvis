export function PlaceholderPage({ title, phase }: { title: string; phase: number }) {
  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="text-sm text-muted-foreground">
        Coming in Phase {phase}. Nothing here yet.
      </p>
    </div>
  );
}
