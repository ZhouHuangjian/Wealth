export type ProductIdentity = { code?: unknown; kind?: unknown };
export function productIdentityKey(value: ProductIdentity): string {
  return `${String(value.kind || "").toLowerCase()}|${String(value.code || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "")}`;
}
/** Only explicit user rules and unrelated user labels survive a product replacement. */
export function clearAutomaticSpecification(
  specification: Record<string, any> = {},
): Record<string, any> {
  const preserved: Record<string, any> = {};
  for (const key of [
    "metadata_overrides",
    "strategy",
    "watchlisted",
    "allocation_tag_id",
  ])
    if (specification[key] !== undefined)
      preserved[key] =
        key === "metadata_overrides"
          ? { ...specification[key] }
          : specification[key];
  return preserved;
}
export function specificationForIdentity(
  specification: Record<string, any> = {},
  identity: ProductIdentity,
  previousIdentity?: string,
): Record<string, any> {
  const owner = specification.metadata_identity
    ? productIdentityKey(specification.metadata_identity)
    : previousIdentity;
  return owner && owner !== productIdentityKey(identity)
    ? clearAutomaticSpecification(specification)
    : { ...specification };
}
/** The same snapshot is used by the debouncer and completion guard. */
export function resolutionInput(values: Record<string, any>): string {
  return JSON.stringify({
    code: values.code,
    name: values.name,
    kind: values.kind,
    ...(values.identity_manual
      ? { market: values.market, currency: values.currency }
      : {}),
    days: values.confirmation_days_override,
    calendar: values.calendar_override,
    cutoff: values.cutoff_override,
    manual: values.identity_manual,
    exchange: values.exchange_override,
    noForecast: values.confirmation_no_forecast,
    subscriptionCalendar: values.subscription_calendar,
  });
}
export function resolutionStillCurrent(
  request: string,
  values: Record<string, any>,
): boolean {
  return request === resolutionInput(values);
}

/** Hydrate only explicit overrides, never a prior resolver's inferred values. */
export function manualIdentityFields(
  specification: Record<string, any> = {},
): Record<string, any> {
  const overrides = specification.metadata_overrides || {};
  return {
    subscription_calendar: specification.subscription_calendar,
    identity_manual: ["kind", "market", "currency", "exchange"].some((key) =>
      Object.hasOwn(overrides, key),
    ),
    exchange_override: overrides.exchange,
    confirmation_no_forecast: overrides.confirmation_days === null,
    confirmation_days_override: overrides.confirmation_days,
    calendar_override: overrides.calendar_id,
    cutoff_override: overrides.cutoff_time,
  };
}
