"use client";

import { useEffect, useState } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { TopBar } from "@/components/top-bar";
import { cn } from "@/lib/utils";

const STORAGE_KEY = "jarvis-sidebar-open";

// Client shell owning the sidebar open/closed state so the content margin
// can track the sidebar width. Starts collapsed on the server render, then
// restores the saved preference after mount to avoid a hydration mismatch.
export function DashboardShell({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (window.localStorage.getItem(STORAGE_KEY) === "1") setOpen(true);
  }, []);

  const toggle = () =>
    setOpen((prev) => {
      const next = !prev;
      window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
      return next;
    });

  return (
    <div className="flex min-h-svh flex-col">
      <AppSidebar open={open} onToggle={toggle} />
      <div
        className={cn(
          "flex flex-1 flex-col gap-6 px-4 pt-5 pb-24 transition-[margin-left] duration-200 sm:px-6 md:pb-8",
          open ? "md:ml-60" : "md:ml-16"
        )}
      >
        <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6">
          <TopBar />
          <main className="flex-1">{children}</main>
        </div>
      </div>
    </div>
  );
}
