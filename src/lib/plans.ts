/**
 * The `plans` table is the approved long-term pricing source. No plans have been
 * published and no payment provider is integrated, so this model stays empty
 * and the pricing page renders an unavailable state instead of invented tiers.
 */
export interface Plan {
  slug: string;
  name: string;
  description: string;
  priceLabel: string;
  billingInterval: string;
  entitlements: readonly string[];
  available: boolean;
}

export const plans: readonly Plan[] = [];

export const plannedPricingFields: readonly { field: string; description: string }[] = [
  { field: "Plan name", description: "The label shown on the pricing page." },
  { field: "Price", description: "The amount and currency recorded for the plan." },
  { field: "Billing interval", description: "Whether the plan bills monthly or once." },
  { field: "Entitlements", description: "What access a plan grants inside the platform." },
  { field: "Availability", description: "Whether the plan can be purchased right now." },
];
