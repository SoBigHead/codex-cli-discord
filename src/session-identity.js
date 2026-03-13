import { normalizeProvider } from './provider-metadata.js';

export function createSessionIdentityHelpers({ defaultProvider = 'codex' } = {}) {
  function getSessionProvider(session) {
    return normalizeProvider(session?.provider || defaultProvider);
  }

  function getSessionId(session) {
    const id = session?.runnerSessionId ?? session?.codexThreadId ?? null;
    const normalized = String(id || '').trim();
    return normalized || null;
  }

  function setSessionId(session, value) {
    if (!session || typeof session !== 'object') return null;
    const normalized = String(value || '').trim() || null;
    session.runnerSessionId = normalized;
    session.codexThreadId = normalized;
    return normalized;
  }

  function clearSessionId(session) {
    setSessionId(session, null);
  }

  function formatSessionIdLabel(sessionId) {
    return `\`${sessionId || '(auto — 下条消息新建)'}\``;
  }

  return {
    clearSessionId,
    formatSessionIdLabel,
    getSessionId,
    getSessionProvider,
    setSessionId,
  };
}
