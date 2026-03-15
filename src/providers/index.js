import { normalizeProvider } from '../provider-metadata.js';

export function createProviderAdapterRegistry(adapters = []) {
  const byId = new Map();
  for (const adapter of adapters) {
    const id = normalizeProvider(adapter?.id || '');
    if (!id) continue;
    byId.set(id, adapter);
  }

  return {
    get(provider) {
      return byId.get(normalizeProvider(provider)) || byId.get('codex') || null;
    },
    list() {
      return [...byId.values()];
    },
  };
}

