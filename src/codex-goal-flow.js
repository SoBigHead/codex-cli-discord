const GOAL_STATUSES = new Set(['active', 'paused', 'budgetLimited', 'complete']);

function normalizeText(value) {
  const text = String(value || '').trim();
  return text || null;
}

function normalizeObjective(value) {
  const objective = normalizeText(value);
  if (!objective) {
    throw new Error('goal objective is required');
  }
  return objective;
}

function normalizeGoalStatus(value) {
  const status = String(value || '').trim();
  if (!GOAL_STATUSES.has(status)) {
    throw new Error(`invalid goal status: ${value}`);
  }
  return status;
}

export function parseGoalTokenBudget(value) {
  if (value === undefined || value === null || String(value).trim() === '') return undefined;
  const raw = String(value).trim().toLowerCase();
  if (['clear', 'off', 'none', 'null', 'default'].includes(raw)) return null;
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error('invalid token budget: use a positive integer or clear');
  }
  const tokens = Number(raw);
  if (!Number.isSafeInteger(tokens) || tokens <= 0) {
    throw new Error('invalid token budget: use a positive integer or clear');
  }
  return tokens;
}

export function parseCodexGoalTextInput(input = '') {
  const text = String(input || '').trim();
  if (!text) return { type: 'status' };
  const [verbRaw, ...rest] = text.split(/\s+/);
  const verb = String(verbRaw || '').trim().toLowerCase();
  const tail = rest.join(' ').trim();

  try {
    if (['status', 'show', 'state', '查看', '状态'].includes(verb)) return { type: 'status' };
    if (['clear', 'delete', 'remove', 'unset', '清除'].includes(verb)) return { type: 'clear' };
    if (['pause', 'paused', '暂停'].includes(verb)) return { type: 'set_status', status: 'paused' };
    if (['resume', 'active', 'start', 'continue', '恢复', '继续'].includes(verb)) return { type: 'set_status', status: 'active' };
    if (['done', 'complete', 'completed', 'finish', '完成'].includes(verb)) return { type: 'set_status', status: 'complete' };
    if (['budget', 'token_budget', 'tokens'].includes(verb)) {
      return { type: 'set_budget', tokenBudget: parseGoalTokenBudget(tail) };
    }
    if (verb === 'set') {
      return { type: 'set', objective: normalizeObjective(tail), status: 'active' };
    }
    return { type: 'set', objective: normalizeObjective(text), status: 'active' };
  } catch (err) {
    return { type: 'invalid', message: String(err?.message || err) };
  }
}

export function parseCodexGoalSlashInput({ action = 'status', objective = '', tokenBudget = '' } = {}) {
  const normalizedAction = String(action || 'status').trim().toLowerCase();
  try {
    if (normalizedAction === 'status') return { type: 'status' };
    if (normalizedAction === 'clear') return { type: 'clear' };
    if (normalizedAction === 'pause') return { type: 'set_status', status: 'paused' };
    if (normalizedAction === 'resume') return { type: 'set_status', status: 'active' };
    if (normalizedAction === 'done' || normalizedAction === 'complete') return { type: 'set_status', status: 'complete' };
    if (normalizedAction === 'budget') return { type: 'set_budget', tokenBudget: parseGoalTokenBudget(tokenBudget) };
    if (normalizedAction === 'set') {
      const parsed = {
        type: 'set',
        objective: normalizeObjective(objective),
        status: 'active',
      };
      const parsedBudget = parseGoalTokenBudget(tokenBudget);
      if (parsedBudget !== undefined) parsed.tokenBudget = parsedBudget;
      return parsed;
    }
    return { type: 'invalid', message: `invalid goal action: ${action}` };
  } catch (err) {
    return { type: 'invalid', message: String(err?.message || err) };
  }
}

function getSessionThreadId(session, getSessionId) {
  if (typeof getSessionId === 'function') return normalizeText(getSessionId(session));
  return normalizeText(session?.runnerSessionId || session?.codexThreadId);
}

export async function executeCodexGoalAction({
  action,
  session,
  provider = 'codex',
  getSessionId,
  getCodexThreadGoal,
  setCodexThreadGoal,
  clearCodexThreadGoal,
} = {}) {
  if (!action || action.type === 'invalid') {
    return { ok: false, reason: 'invalid', message: action?.message || 'invalid goal command' };
  }
  if (provider !== 'codex') {
    return { ok: false, reason: 'unsupported_provider', provider };
  }
  const threadId = getSessionThreadId(session, getSessionId);
  if (!threadId) {
    return { ok: false, reason: 'missing_session' };
  }

  if (action.type === 'status') {
    const result = await getCodexThreadGoal({ threadId });
    return { ok: true, kind: 'status', goal: result?.goal || null };
  }
  if (action.type === 'clear') {
    const result = await clearCodexThreadGoal({ threadId });
    return { ok: true, kind: 'clear', removed: Boolean(result?.removed ?? result?.cleared) };
  }
  if (action.type === 'set') {
    const params = {
      threadId,
      objective: action.objective,
      status: normalizeGoalStatus(action.status || 'active'),
    };
    if (Object.prototype.hasOwnProperty.call(action, 'tokenBudget')) params.tokenBudget = action.tokenBudget;
    const result = await setCodexThreadGoal(params);
    return { ok: true, kind: 'set', goal: result?.goal || null };
  }
  if (action.type === 'set_status') {
    const result = await setCodexThreadGoal({
      threadId,
      status: normalizeGoalStatus(action.status),
    });
    return { ok: true, kind: 'update', goal: result?.goal || null };
  }
  if (action.type === 'set_budget') {
    if (action.tokenBudget === undefined) {
      return { ok: false, reason: 'invalid', message: 'token budget is required' };
    }
    const result = await setCodexThreadGoal({
      threadId,
      tokenBudget: action.tokenBudget,
    });
    return { ok: true, kind: 'update', goal: result?.goal || null };
  }
  return { ok: false, reason: 'invalid', message: `unsupported goal action: ${action.type}` };
}

export function formatCodexGoalStatus(status, language = 'zh') {
  const normalized = String(status || '').trim();
  if (language === 'en') return normalized || 'unknown';
  if (normalized === 'active') return '进行中';
  if (normalized === 'paused') return '已暂停';
  if (normalized === 'budgetLimited') return '预算受限';
  if (normalized === 'complete') return '已完成';
  return normalized || '未知';
}

export function formatCodexGoalBudget(goal, language = 'zh') {
  const budget = goal?.tokenBudget;
  const used = goal?.tokensUsed;
  if (!Number.isFinite(budget)) return language === 'en' ? 'none' : '未设置';
  if (Number.isFinite(used)) return `${used}/${budget}`;
  return String(budget);
}

export function formatCodexGoalSummary(goal, language = 'zh') {
  if (!goal) return '';
  if (language === 'en') {
    return [
      `objective: ${goal.objective}`,
      `status: ${formatCodexGoalStatus(goal.status, language)}`,
      `budget: ${formatCodexGoalBudget(goal, language)}`,
    ].join('\n');
  }
  return [
    `目标：${goal.objective}`,
    `状态：${formatCodexGoalStatus(goal.status, language)}`,
    `预算：${formatCodexGoalBudget(goal, language)}`,
  ].join('\n');
}

function formatGoalRunHint(language) {
  return language === 'en'
    ? 'Run state: setting a goal does not start a task. Send a normal prompt to run against it.'
    : '运行状态：设置 goal 不会自动开跑。再发送一条普通任务，才会按这个 goal 继续工作。';
}

export function formatCodexGoalResult(result, language = 'zh') {
  if (!result?.ok) {
    if (result?.reason === 'unsupported_provider') {
      return language === 'en'
        ? `❌ Codex goal only supports Codex. Current provider is ${result.provider || 'unknown'}.`
        : `❌ goal 只支持 Codex。当前 provider 是 ${result.provider || 'unknown'}。`;
    }
    if (result?.reason === 'missing_session') {
      return language === 'en'
        ? '❌ No Codex session is bound here yet. Run one task first or bind an existing session.'
        : '❌ 当前频道还没有绑定 Codex session。先跑一轮，或用 `!resume` 绑定已有 session。';
    }
    return `❌ ${result?.message || (language === 'en' ? 'Invalid goal command.' : 'goal 指令无效。')}`;
  }

  if (result.kind === 'clear') {
    if (result.removed) return language === 'en' ? '✅ goal cleared.' : '✅ goal 已清除。';
    return language === 'en' ? 'ℹ️ no goal to clear.' : 'ℹ️ 当前没有可清除的 goal。';
  }
  if (!result.goal) {
    return language === 'en' ? 'ℹ️ no goal is set for this Codex session.' : 'ℹ️ 当前 Codex session 没有 goal。';
  }
  if (result.kind === 'status') {
    return language === 'en'
      ? `🎯 current goal\n${formatCodexGoalSummary(result.goal, language)}\n${formatGoalRunHint(language)}`
      : `🎯 当前 goal\n${formatCodexGoalSummary(result.goal, language)}\n${formatGoalRunHint(language)}`;
  }
  if (result.kind === 'set') {
    return language === 'en'
      ? `✅ goal set\n${formatCodexGoalSummary(result.goal, language)}\n${formatGoalRunHint(language)}`
      : `✅ goal 已设置\n${formatCodexGoalSummary(result.goal, language)}\n${formatGoalRunHint(language)}`;
  }
  return language === 'en'
    ? `✅ goal updated\n${formatCodexGoalSummary(result.goal, language)}\n${formatGoalRunHint(language)}`
    : `✅ goal 已更新\n${formatCodexGoalSummary(result.goal, language)}\n${formatGoalRunHint(language)}`;
}
