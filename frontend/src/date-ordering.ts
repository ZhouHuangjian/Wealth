/** Read-side ordering of ISO business dates, without browser timezone conversion. */
export const resourceDateFields: Record<string, string[]> = {
  calendar: ["date", "due_date"],
  events: ["economic_date"],
  occurrences: ["due_date"],
  installments: ["due_date"],
  goals: ["target_date"],
  scenarios: ["target_date"],
  plans: ["start_date"],
  loans: ["first_due_date"],
  reconciliations: ["as_of"],
  budgets: ["month"],
  todos: ["due_date", "economic_date", "date"],
  prices: ["economic_date"],
  fx: ["economic_date"],
  snapshots: ["economic_date"],
};

function businessDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (/^\d{4}$/.test(value)) return `${value}-01-01`;
  if (/^\d{4}-\d{2}$/.test(value)) value += "-01";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
    ? value
    : null;
}

/** Copy before sorting. Unknown dates trail known dates; equal dates retain API order. */
export function newestFirst<T extends Record<string, any>>(
  rows: readonly T[],
  fields: readonly string[] = ["date"],
): T[] {
  const dateOf = (row: T) => {
    for (const field of fields) {
      const value = businessDate(row[field]);
      if (value) return value;
    }
    return null;
  };
  return [...rows].sort((a, b) => {
    const first = dateOf(a),
      second = dateOf(b);
    if (!first) return second ? 1 : 0;
    if (!second) return -1;
    return second.localeCompare(first);
  });
}

export function shiftBusinessDay(value: string, days: number): string {
  const valid = businessDate(value);
  if (!valid) return value;
  const date = new Date(`${valid}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function newestYearsFirst(
  values: readonly (string | number)[],
): (string | number)[] {
  return [...values].sort((a, b) => {
    const first = businessDate(String(a)),
      second = businessDate(String(b));
    if (!first) return second ? 1 : 0;
    if (!second) return -1;
    return second.localeCompare(first);
  });
}
