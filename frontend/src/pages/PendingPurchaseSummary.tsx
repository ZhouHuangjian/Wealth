import PendingPurchaseDetails from "./PendingPurchaseDetails";
import { pendingSummaryDisplay } from "../pending-purchases";

export default function PendingPurchaseSummary({
  summary,
  currency,
  compact = false,
}: {
  summary: any;
  currency?: string;
  compact?: boolean;
}) {
  const display = pendingSummaryDisplay(summary);
  if (!display.visible) return null;
  return (
    <div className="pending-purchase-summary">
      <PendingPurchaseDetails
        items={summary.items || []}
        amount={display.amount}
        currency={summary.currency || currency}
        compact={compact}
      />
      {display.note && <small>{display.note}</small>}
    </div>
  );
}
