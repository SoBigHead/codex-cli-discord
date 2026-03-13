import test from 'node:test';
import assert from 'node:assert/strict';

import { createSessionIdentityHelpers } from '../src/session-identity.js';

test('createSessionIdentityHelpers normalizes provider and session ids', () => {
  const helpers = createSessionIdentityHelpers({ defaultProvider: 'gemini' });
  const session = {
    provider: 'Claude',
    runnerSessionId: ' sess-1 ',
    codexThreadId: 'legacy',
  };

  assert.equal(helpers.getSessionProvider(session), 'claude');
  assert.equal(helpers.getSessionId(session), 'sess-1');
  assert.equal(helpers.formatSessionIdLabel('sess-1'), '`sess-1`');
});

test('createSessionIdentityHelpers sets and clears mirrored session ids', () => {
  const helpers = createSessionIdentityHelpers({ defaultProvider: 'codex' });
  const session = {};

  assert.equal(helpers.setSessionId(session, ' next-id '), 'next-id');
  assert.equal(session.runnerSessionId, 'next-id');
  assert.equal(session.codexThreadId, 'next-id');

  helpers.clearSessionId(session);
  assert.equal(session.runnerSessionId, null);
  assert.equal(session.codexThreadId, null);
});
