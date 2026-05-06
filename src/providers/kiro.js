import { getProviderCapabilities, getProviderDisplayName } from '../provider-metadata.js';

export function createKiroProviderAdapter({
  buildArgs = () => [],
  parseEvent = () => {},
} = {}) {
  return {
    id: 'kiro',
    displayName: getProviderDisplayName('kiro'),
    capabilities: getProviderCapabilities('kiro'),
    runtime: {
      buildArgs,
      parseEvent,
    },
  };
}
