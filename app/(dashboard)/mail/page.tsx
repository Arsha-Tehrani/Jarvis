import { Suspense } from "react";
import { MailView } from "@/components/mail-view";

export default function MailPage() {
  return (
    <Suspense>
      <MailView />
    </Suspense>
  );
}
