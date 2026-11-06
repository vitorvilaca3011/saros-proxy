/**
 * model-ladder.ts — Conservative effort ladder shared by the model catalogs.
 *
 * Some providers publish a reasoning model with no usable effort options: an
 * empty ladder, a bare toggle, or `{ type: 'effort', values: [] }`. Copied
 * verbatim into a harness config, that absence makes pi/omp invent a ladder
 * that includes `minimal`, which the CommandCode gateway rejects.
 * low|medium|high is accepted everywhere.
 */

/** Conservative effort ladder, least → most intensive (pi/omp schema). */
export const CONSERVATIVE_EFFORT_VALUES = ['low', 'medium', 'high'] as const;

/** Fresh effort ladder entry — callers may keep or mutate the array. */
export function conservativeEffortOptions(): Array<{ type: 'effort'; values: string[] }> {
  return [{ type: 'effort', values: [...CONSERVATIVE_EFFORT_VALUES] }];
}

/**
 * Does any reasoning option declare a usable effort ladder?
 *
 * Presence alone is not enough: `{ type: 'effort', values: [] }` is present but
 * yields no efforts, so the harness still invents a ladder with `minimal`.
 */
export function hasEffortOption(options: unknown): boolean {
  if (!Array.isArray(options)) return false;
  return options.some((option) => {
    if (typeof option !== 'object' || option === null || Array.isArray(option)) {
      return false;
    }
    const entry = option as Record<string, unknown>;
    return entry.type === 'effort' && Array.isArray(entry.values) && entry.values.length > 0;
  });
}

/**
 * Give a reasoning entry the conservative ladder when it declares none.
 *
 * Mutates and returns `entry`: non-reasoning entries and entries with a real
 * effort ladder are left untouched.
 */
export function ensureEffortLadder(entry: Record<string, unknown>): Record<string, unknown> {
  if (entry.reasoning === true && !hasEffortOption(entry.reasoning_options)) {
    entry.reasoning_options = conservativeEffortOptions();
  }
  return entry;
}
