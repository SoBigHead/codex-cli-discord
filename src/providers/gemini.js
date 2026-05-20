import { createAntigravityProviderAdapter } from './antigravity.js';

// Legacy shim for imports that still reference the historical Gemini provider module.
export function createGeminiProviderAdapter({
  buildArgs = () => [],
  parseEvent = () => {},
} = {}) {
  return createAntigravityProviderAdapter({ buildArgs, parseEvent });
}

export { createAntigravityProviderAdapter };
