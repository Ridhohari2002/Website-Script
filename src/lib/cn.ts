/** Joins conditional class names. Keeps component variants readable without a merge dependency. */
export function cn(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}
