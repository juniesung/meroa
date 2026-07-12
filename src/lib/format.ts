// Mirrors server/src/lib/goals/summary.ts's formatMoney/formatNumber — kept
// in sync manually (no shared package between client/server). Money always
// pads to two decimals once it has any fraction ("$0.50", never the
// observed "$0.5"); a plain number (indirect measurements) never gets a
// forced ".00" it didn't need.

export function formatMoney(n: number): string {
  return Number.isInteger(n)
    ? n.toLocaleString()
    : n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatNumber(n: number): string {
  return Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
