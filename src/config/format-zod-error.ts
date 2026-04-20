/**
 * Render a `ZodError` into a human-readable multiline summary.
 *
 * Output format: one issue per line, indented with two spaces, in the form
 *   `  path.to.field: message`
 * Root-level issues (empty path) appear as `  (root): message`.
 *
 * Keeping this helper framework-agnostic lets the `ConfigLoader` embed the
 * summary into the `IamConfigurationError` message at boot, and lets consumers
 * format their own `safeParse` errors uniformly if they need to.
 */
import type { ZodError } from 'zod';

export function formatZodError(err: ZodError): string {
  const lines: string[] = [];
  for (const issue of err.issues) {
    const path = issue.path.length === 0 ? '(root)' : issue.path.join('.');
    lines.push(`  ${path}: ${issue.message}`);
  }
  return lines.join('\n');
}
