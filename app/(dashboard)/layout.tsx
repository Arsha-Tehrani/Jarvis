import { NavTabs } from "@/components/nav-tabs";

export default function DashboardLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-4 py-6">
      <header className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Jarvis</h1>
        <NavTabs />
      </header>
      <main className="flex-1">{children}</main>
    </div>
  );
}
