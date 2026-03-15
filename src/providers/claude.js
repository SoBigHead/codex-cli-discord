import { getProviderCapabilities, getProviderDisplayName } from '../provider-metadata.js';

export function createClaudeProviderAdapter({
  buildArgs = () => [],
  parseEvent = () => {},
} = {}) {
  return {
    id: 'claude',
    displayName: getProviderDisplayName('claude'),
    capabilities: getProviderCapabilities('claude'),
    runtime: {
      buildArgs,
      parseEvent,
    },
  };
}

