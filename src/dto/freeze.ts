/**
 * Deeply freeze an object graph.
 *
 * Used by every mapper to guarantee DTO immutability:
 *   return deepFreeze({ ... });
 *
 * Behavior:
 *   - Primitives (null / undefined / number / string / boolean / bigint /
 *     symbol) are returned as-is.
 *   - Objects and arrays are frozen with Object.freeze, recursively descending
 *     into their own (non-inherited) enumerable properties.
 *   - Already-frozen sub-trees are skipped to avoid re-walking them.
 */
export function deepFreeze<T>(value: T): Readonly<T> {
  if (value === null || value === undefined) {
    return value as Readonly<T>;
  }
  if (typeof value !== 'object') {
    return value as Readonly<T>;
  }
  if (Object.isFrozen(value)) {
    return value as Readonly<T>;
  }

  // Freeze this node first so cycles (if any) terminate recursion.
  Object.freeze(value);

  if (Array.isArray(value)) {
    for (const entry of value as unknown[]) {
      if (entry !== null && typeof entry === 'object' && !Object.isFrozen(entry)) {
        deepFreeze(entry as object);
      }
    }
    return value as Readonly<T>;
  }

  for (const key of Object.keys(value as Record<string, unknown>)) {
    const child = (value as Record<string, unknown>)[key];
    if (child !== null && typeof child === 'object' && !Object.isFrozen(child)) {
      deepFreeze(child as object);
    }
  }

  return value as Readonly<T>;
}
