import { getProviderCapabilities, getProviderDisplayName } from '../provider-metadata.js';

export function createKimiProviderAdapter({
  buildArgs = () => [],
  parseEvent = () => {},
} = {}) {
  return {
    id: 'kimi',
    displayName: getProviderDisplayName('kimi'),
    capabilities: getProviderCapabilities('kimi'),
    runtime: {
      buildArgs,
      parseEvent,
    },
  };
}
