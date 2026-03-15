import { getProviderCapabilities, getProviderDisplayName } from '../provider-metadata.js';

export function createCodexProviderAdapter({
  buildArgs = () => [],
  parseEvent = () => {},
} = {}) {
  return {
    id: 'codex',
    displayName: getProviderDisplayName('codex'),
    capabilities: getProviderCapabilities('codex'),
    runtime: {
      buildArgs,
      parseEvent,
    },
  };
}

