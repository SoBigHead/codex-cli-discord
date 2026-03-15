import { getProviderCapabilities, getProviderDisplayName } from '../provider-metadata.js';

export function createGeminiProviderAdapter({
  buildArgs = () => [],
  parseEvent = () => {},
} = {}) {
  return {
    id: 'gemini',
    displayName: getProviderDisplayName('gemini'),
    capabilities: getProviderCapabilities('gemini'),
    runtime: {
      buildArgs,
      parseEvent,
    },
  };
}

