import { FinanceView } from "@/components/finance-view";

export default function FinancePage() {
  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold">Finance</h2>
      <FinanceView />
    </div>
  );
}
