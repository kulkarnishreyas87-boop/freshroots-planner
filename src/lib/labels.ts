export const FLAG_LABEL: Record<string, string> = {
  STOCKOUT_RISK: "Stockout risk",
  OVERSTOCK_RISK: "Overstock risk",
  OK: "OK",
};

export const FLAG_CHIP: Record<string, string> = {
  STOCKOUT_RISK: "c-red",
  OVERSTOCK_RISK: "c-amber",
  OK: "c-green",
};

export const ACTION_LABEL: Record<string, string> = {
  REORDER_STANDARD: "Reorder now",
  REORDER_1_5X: "Reorder 1.5×",
  PAUSE_NEXT_ORDER: "Pause next order",
  NO_ACTION: "No action",
};

export function fmtIST(ts: string | null | undefined): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
