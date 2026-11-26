import type { LinkStore } from './link-once';

/** For tests. */
/**
 * Enough of Redis for `once`: SET with NX, GET, DEL. Expiry is not modelled. */
export function memoryLinks(): LinkStore & { keys: Map<string, string> } {
  const keys = new Map<string, string>();
  return {
    keys,
    set: (async (key: string, value: string, ...args: unknown[]) => {
      if (args.includes('NX') && keys.has(key)) return null;
      keys.set(key, value);
      return 'OK';
    }) as LinkStore['set'],
    get: (async (key: string) => keys.get(key) ?? null) as LinkStore['get'],
    del: (async (key: string) => (keys.delete(key) ? 1 : 0)) as LinkStore['del'],
  } as LinkStore & { keys: Map<string, string> };
}
