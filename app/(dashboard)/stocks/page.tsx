import { StocksView } from "@/components/stocks-view";

export default function StocksPage() {
  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold">Stocks</h2>
      <StocksView />
    </div>
  );
}
