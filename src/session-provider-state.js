const PROVIDER_SCOPED_SESSION_DEFAULTS = Object.freeze({
  runnerSessionId: null,
  codexThreadId: null,
  lastInputTokens: null,
  model: null,
  codexProfile: null,
  effort: null,
  fastMode: null,
  compactStrategy: null,
  compactEnabled: null,
  compactThresholdTokens: null,
  nativeCompactTokenLimit: null,
  runtimeMode: null,
  busyPromptMode: null,
  pendingForkFromSessionId: null,
  pendingCompactSummary: null,
  pendingCompactSourceSessionId: null,
  configOverrides: Object.freeze([]),
});

export const PROVIDER_SCOPED_SESSION_FIELDS = Object.freeze([
  'runnerSessionId',
  'codexThreadId',
  'lastInputTokens',
  'model',
  'codexProfile',
  'effort',
  'fastMode',
  'compactStrategy',
  'compactEnabled',
  'compactThresholdTokens',
  'nativeCompactTokenLimit',
  'runtimeMode',
  'busyPromptMode',
  'pendingForkFromSessionId',
  'pendingCompactSummary',
  'pendingCompactSourceSessionId',
  'configOverrides',
]);

function normalizeProviderKey(provider, normalizeProvider) {
  if (typeof normalizeProvider === 'function') return normalizeProvider(provider);
  return String(provider || '').trim().toLowerCase() || 'codex';
}

function cloneProviderScopedValue(field, value) {
  if (field === 'configOverrides') {
    return Array.isArray(value) ? [...value] : [];
  }
  return value ?? PROVIDER_SCOPED_SESSION_DEFAULTS[field];
}

function createDefaultValue(field) {
  return cloneProviderScopedValue(field, PROVIDER_SCOPED_SESSION_DEFAULTS[field]);
}

function createEmptyProviderSessionState() {
  const state = {};
  for (const field of PROVIDER_SCOPED_SESSION_FIELDS) {
    state[field] = createDefaultValue(field);
  }
  return state;
}

function isProviderStateContainer(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function ensureProviderEntryShape(entry) {
  const state = isProviderStateContainer(entry) ? entry : {};
  for (const field of PROVIDER_SCOPED_SESSION_FIELDS) {
    if (!(field in state)) {
      state[field] = createDefaultValue(field);
    } else {
      state[field] = cloneProviderScopedValue(field, state[field]);
    }
  }
  return state;
}

function hasProviderScopedValue(field, value) {
  if (field === 'configOverrides') return Array.isArray(value) && value.length > 0;
  return value !== null && value !== undefined && value !== '';
}

function mergeProviderEntryShape(existing, incoming, {
  session,
  fromProvider,
  intoProvider,
} = {}) {
  const target = ensureProviderEntryShape(existing);
  const source = ensureProviderEntryShape(incoming);
  for (const field of PROVIDER_SCOPED_SESSION_FIELDS) {
    const targetHasValue = hasProviderScopedValue(field, target[field]);
    const sourceHasValue = hasProviderScopedValue(field, source[field]);
    if (!targetHasValue && sourceHasValue) {
      target[field] = cloneProviderScopedValue(field, source[field]);
      continue;
    }
    if (targetHasValue && sourceHasValue && JSON.stringify(target[field]) !== JSON.stringify(source[field])) {
      const warning = `legacy provider state ${fromProvider || 'unknown'}.${field} conflicts with ${intoProvider || 'provider'}.${field}; kept ${intoProvider || 'provider'}`;
      if (session && typeof session === 'object') {
        if (!Array.isArray(session.providerMigrationWarnings)) session.providerMigrationWarnings = [];
        if (!session.providerMigrationWarnings.includes(warning)) session.providerMigrationWarnings.push(warning);
      }
    }
  }
  return target;
}

function hasTopLevelProviderScopedState(session) {
  if (!session || typeof session !== 'object') return false;
  return PROVIDER_SCOPED_SESSION_FIELDS.some((field) => {
    const value = session[field];
    if (field === 'configOverrides') return Array.isArray(value) && value.length > 0;
    return value !== null && value !== undefined && value !== '';
  });
}

export function ensureSessionProviderStates(session, {
  normalizeProvider,
  provider = null,
  hydrateFromTopLevel = true,
} = {}) {
  if (!session || typeof session !== 'object') return { provider: 'codex', changed: false };
  let changed = false;
  if (!isProviderStateContainer(session.providers)) {
    session.providers = {};
    changed = true;
  }

  for (const [providerKey, rawState] of Object.entries({ ...session.providers })) {
    const normalizedProvider = normalizeProviderKey(providerKey, normalizeProvider);
    const nextState = ensureProviderEntryShape(rawState);
    if (normalizedProvider !== providerKey) {
      delete session.providers[providerKey];
      if (session.providers[normalizedProvider]) {
        session.providers[normalizedProvider] = mergeProviderEntryShape(session.providers[normalizedProvider], nextState, {
          session,
          fromProvider: providerKey,
          intoProvider: normalizedProvider,
        });
      } else {
        session.providers[normalizedProvider] = nextState;
      }
      changed = true;
      continue;
    }
    if (session.providers[providerKey] !== nextState) {
      session.providers[providerKey] = nextState;
      changed = true;
    }
  }

  const currentProvider = normalizeProviderKey(provider ?? session.provider, normalizeProvider);
  if (!session.providers[currentProvider]) {
    session.providers[currentProvider] = createEmptyProviderSessionState();
    changed = true;
    if (hydrateFromTopLevel && hasTopLevelProviderScopedState(session)) {
      for (const field of PROVIDER_SCOPED_SESSION_FIELDS) {
        session.providers[currentProvider][field] = cloneProviderScopedValue(field, session[field]);
      }
    }
  } else {
    const shaped = ensureProviderEntryShape(session.providers[currentProvider]);
    if (shaped !== session.providers[currentProvider]) {
      session.providers[currentProvider] = shaped;
      changed = true;
    }
  }

  return {
    provider: currentProvider,
    changed,
    state: session.providers[currentProvider],
  };
}

export function commitSessionProviderState(session, {
  normalizeProvider,
  provider = null,
} = {}) {
  const ensured = ensureSessionProviderStates(session, {
    normalizeProvider,
    provider,
    hydrateFromTopLevel: true,
  });
  if (!session || typeof session !== 'object') return ensured.state;
  for (const field of PROVIDER_SCOPED_SESSION_FIELDS) {
    ensured.state[field] = cloneProviderScopedValue(field, session[field]);
  }
  return ensured.state;
}

export function projectSessionProviderState(session, {
  normalizeProvider,
  provider = null,
} = {}) {
  const ensured = ensureSessionProviderStates(session, {
    normalizeProvider,
    provider,
    hydrateFromTopLevel: true,
  });
  if (!session || typeof session !== 'object') return ensured.state;
  for (const field of PROVIDER_SCOPED_SESSION_FIELDS) {
    session[field] = cloneProviderScopedValue(field, ensured.state[field]);
  }
  return ensured.state;
}

export function readSessionProviderScopedField(session, field, {
  normalizeProvider,
  provider = null,
} = {}) {
  if (!PROVIDER_SCOPED_SESSION_FIELDS.includes(field)) {
    return undefined;
  }
  const ensured = ensureSessionProviderStates(session, {
    normalizeProvider,
    provider,
    hydrateFromTopLevel: true,
  });
  return cloneProviderScopedValue(field, ensured?.state?.[field]);
}

export function switchSessionProviderState(session, nextProvider, {
  normalizeProvider,
} = {}) {
  const previousProvider = normalizeProviderKey(session?.provider, normalizeProvider);
  commitSessionProviderState(session, {
    normalizeProvider,
    provider: previousProvider,
  });

  const provider = normalizeProviderKey(nextProvider, normalizeProvider);
  session.provider = provider;
  ensureSessionProviderStates(session, {
    normalizeProvider,
    provider,
    hydrateFromTopLevel: false,
  });
  projectSessionProviderState(session, {
    normalizeProvider,
    provider,
  });

  return {
    previous: previousProvider,
    provider,
  };
}
