"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

// Goals were folded into Trackers (Part E): a goal is now just a target on a
// Tracker, with progress computed from real logged data. This page is a
// short-lived redirect/banner so any lingering links don't dead-end.
export function GoalsView() {
  const router = useRouter();
  useEffect(() => {
    const t = setTimeout(() => router.replace("/trackers"), 2500);
    return () => clearTimeout(t);
  }, [router]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Goals moved into Trackers</CardTitle>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        A goal is now a target on a Tracker, tracked against real data. Redirecting to{" "}
        <Link href="/trackers" className="underline">
          Trackers
        </Link>
        …
      </CardContent>
    </Card>
  );
}
