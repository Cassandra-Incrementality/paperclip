/**
 * Codepoint-safe truncation. A naive `value.slice(0, maxChars)` counts UTF-16
 * code units, so it can cut an astral character (e.g. an emoji) in half and
 * leave a lone surrogate at the end of the result. That lone surrogate is a
 * valid JS string but is not valid JSON text for Postgres's json/jsonb input
 * (PPC-7299: `activity_log.details.bodySnippet` 500'd on exactly this).
 * Iterating the string (`Array.from`) walks whole code points, so a
 * surrogate pair is always kept or dropped together.
 */
export function truncateByCodePoint(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return Array.from(value).slice(0, maxChars).join("");
}
