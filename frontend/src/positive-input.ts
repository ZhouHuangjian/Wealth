/** Validation instead of InputNumber min: never turn a user's zero into a holding. */
export function positiveDecimalInput(value: unknown, places = 18): boolean {
  const input = String(value ?? "").trim();
  return (
    new RegExp(`^\\d+(\\.\\d{1,${places}})?$`).test(input) &&
    /[1-9]/.test(input)
  );
}
