import { getProviderCapabilities, getProviderDisplayName } from '../provider-metadata.js';

export function createAntigravityProviderAdapter({
  buildArgs = () => [],
  parseEvent = () => {},
} = {}) {
  return {
    id: 'antigravity',
    displayName: getProviderDisplayName('antigravity'),
    capabilities: getProviderCapabilities('antigravity'),
    runtime: {
      buildArgs,
      parseEvent,
    },
  };
}
