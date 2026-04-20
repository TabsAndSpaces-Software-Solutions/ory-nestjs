/**
 * Unit tests for `formatZodError` — the helper that renders a `ZodError` into
 * a human-readable multiline summary, one issue per line in the form
 *   `  path: message`.
 */
import { z, ZodError } from 'zod';
import { formatZodError } from '../../../src/config/format-zod-error';

describe('formatZodError', () => {
  it('returns a summary with one line per issue in `path: message` format', () => {
    const schema = z.object({
      tenants: z.object({
        customer: z.object({
          kratos: z.object({
            publicUrl: z.string(),
          }),
        }),
      }),
    });
    const result = schema.safeParse({ tenants: { customer: { kratos: {} } } });
    expect(result.success).toBe(false);
    const err = (result as { success: false; error: ZodError }).error;
    const out = formatZodError(err);
    // Full path, colon, message on a single line.
    expect(out).toMatch(/tenants\.customer\.kratos\.publicUrl:\s+/);
    // One issue in this fixture → one non-empty line.
    const lines = out.split('\n').filter((l: string) => l.trim().length > 0);
    expect(lines).toHaveLength(1);
  });

  it('aggregates multiple issues into multiple lines', () => {
    const schema = z.object({
      a: z.string(),
      b: z.number(),
      c: z.boolean(),
    });
    const result = schema.safeParse({});
    expect(result.success).toBe(false);
    const err = (result as { success: false; error: ZodError }).error;
    const out = formatZodError(err);
    const lines = out.split('\n').filter((l: string) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(3);
    // Each line starts with indentation and contains a colon.
    for (const line of lines) {
      expect(line).toMatch(/^\s{2}\S.*:\s+/);
    }
  });

  it('renders the root path as "(root)" when the issue has no path', () => {
    const schema = z
      .object({})
      .refine(() => false, { message: 'root failure' });
    const result = schema.safeParse({});
    expect(result.success).toBe(false);
    const err = (result as { success: false; error: ZodError }).error;
    const out = formatZodError(err);
    expect(out).toMatch(/\(root\):\s+root failure/);
  });
});
