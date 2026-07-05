import { AppSidebar } from "@/components/app-sidebar";
import { TopBar } from "@/components/top-bar";

export default function DashboardLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="flex min-h-svh flex-col">
      <AppSidebar />
      <div className="flex flex-1 flex-col gap-6 px-4 pt-5 pb-24 sm:px-6 md:ml-16 md:pb-8">
        <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6">
          <TopBar />
          <main className="flex-1">{children}</main>
        </div>
      </div>
    </div>
  );
}
