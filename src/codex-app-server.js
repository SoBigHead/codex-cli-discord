import { spawn } from 'node:child_process';
import readline from 'node:readline';

function normalizeText(value) {
  const text = String(value || '').trim();
  return text || null;
}

function writeJsonLine(stream, payload) {
  stream.write(`${JSON.stringify(payload)}\n`);
}

function buildThreadForkParams({
  threadId,
  path = null,
  model = null,
  modelProvider = null,
  serviceTier = null,
  cwd = null,
  approvalPolicy = null,
  approvalsReviewer = null,
  sandbox = null,
  permissionProfile = null,
  config = null,
  baseInstructions = null,
  developerInstructions = null,
  ephemeral = null,
  excludeTurns = true,
  persistExtendedHistory = true,
} = {}) {
  const normalizedThreadId = normalizeText(threadId);
  if (!normalizedThreadId) {
    throw new Error('threadId is required for Codex fork');
  }

  const params = {
    threadId: normalizedThreadId,
    excludeTurns: Boolean(excludeTurns),
    persistExtendedHistory: Boolean(persistExtendedHistory),
  };

  const optionals = {
    path,
    model,
    modelProvider,
    serviceTier,
    cwd,
    approvalPolicy,
    approvalsReviewer,
    sandbox,
    permissionProfile,
    config,
    baseInstructions,
    developerInstructions,
    ephemeral,
  };

  for (const [key, value] of Object.entries(optionals)) {
    if (value !== null && value !== undefined) {
      params[key] = value;
    }
  }

  return params;
}

function appendEnabledFeatureArgs(args, features = []) {
  for (const feature of features) {
    const name = normalizeText(feature);
    if (!name) continue;
    args.push('--enable', name);
  }
  return args;
}

function buildThreadGoalSetParams(options = {}) {
  const {
    threadId,
    objective,
    status,
    tokenBudget,
  } = options;
  const normalizedThreadId = normalizeText(threadId);
  if (!normalizedThreadId) {
    throw new Error('threadId is required for Codex goal');
  }
  const params = { threadId: normalizedThreadId };
  if (objective !== undefined && objective !== null) {
    const normalizedObjective = normalizeText(objective);
    if (!normalizedObjective) {
      throw new Error('objective is required for Codex goal');
    }
    params.objective = normalizedObjective;
  }
  if (status !== undefined && status !== null) {
    params.status = String(status || '').trim();
  }
  if (Object.prototype.hasOwnProperty.call(options, 'tokenBudget')) {
    params.tokenBudget = tokenBudget;
  }
  return params;
}

function buildThreadGoalParams({ threadId } = {}) {
  const normalizedThreadId = normalizeText(threadId);
  if (!normalizedThreadId) {
    throw new Error('threadId is required for Codex goal');
  }
  return { threadId: normalizedThreadId };
}

export function createCodexAppServerClient({
  codexBin = 'codex',
  env = process.env,
  spawnFn = spawn,
  timeoutMs = 10_000,
  clientInfo = { name: 'agents-in-discord', version: '0' },
  capabilities = { experimentalApi: true },
  enabledFeatures = [],
} = {}) {
  const bin = normalizeText(codexBin) || 'codex';

  async function request(method, params = {}) {
    const args = appendEnabledFeatureArgs(['app-server', '--listen', 'stdio://'], enabledFeatures);
    const child = spawnFn(bin, args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let nextId = 1;
    let stderr = '';
    let closed = false;
    let rl = null;
    const pending = new Map();

    const cleanup = () => {
      closed = true;
      clearTimeout(timer);
      try {
        rl?.close?.();
      } catch {
      }
      try {
        child.stdin?.end?.();
      } catch {
      }
      if (!child.killed && typeof child.kill === 'function') {
        try {
          child.kill();
        } catch {
        }
      }
    };

    const rejectAll = (err) => {
      for (const { reject } of pending.values()) {
        reject(err);
      }
      pending.clear();
    };

    const formatProcessError = (prefix) => {
      const detail = stderr.trim();
      return new Error(detail ? `${prefix}: ${detail}` : prefix);
    };

    const timer = setTimeout(() => {
      rejectAll(formatProcessError(`Codex app-server timed out after ${timeoutMs}ms`));
      cleanup();
    }, timeoutMs);

    child.stderr?.setEncoding?.('utf8');
    child.stderr?.on?.('data', (chunk) => {
      stderr += String(chunk || '');
    });
    child.on?.('error', (err) => {
      rejectAll(err);
      cleanup();
    });
    child.on?.('exit', (code, signal) => {
      if (closed || pending.size === 0) return;
      rejectAll(formatProcessError(`Codex app-server exited before replying (code ${code ?? 'null'}, signal ${signal ?? 'null'})`));
    });

    rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      let payload = null;
      try {
        payload = JSON.parse(String(line || ''));
      } catch {
        return;
      }
      if (!payload || !Object.prototype.hasOwnProperty.call(payload, 'id')) return;
      const slot = pending.get(payload.id);
      if (!slot) return;
      pending.delete(payload.id);
      if (payload.error) {
        const message = payload.error.message || JSON.stringify(payload.error);
        slot.reject(new Error(`Codex app-server ${slot.method} failed: ${message}`));
        return;
      }
      slot.resolve(payload.result);
    });

    const send = (requestMethod, requestParams) => new Promise((resolve, reject) => {
      const id = nextId;
      nextId += 1;
      pending.set(id, { resolve, reject, method: requestMethod });
      try {
        writeJsonLine(child.stdin, {
          id,
          method: requestMethod,
          params: requestParams,
        });
      } catch (err) {
        pending.delete(id);
        reject(err);
      }
    });

    try {
      await send('initialize', {
        clientInfo,
        capabilities,
      });
      return await send(method, params);
    } finally {
      cleanup();
    }
  }

  async function forkThread(options = {}) {
    const result = await request('thread/fork', buildThreadForkParams(options));
    const thread = result?.thread || null;
    const forkedThreadId = normalizeText(thread?.id || result?.threadId);
    if (!forkedThreadId) {
      throw new Error('Codex app-server did not return a forked thread id');
    }
    return {
      threadId: forkedThreadId,
      forkedFromId: normalizeText(thread?.forkedFromId) || normalizeText(options.threadId),
      thread,
      raw: result,
    };
  }

  async function getThreadGoal(options = {}) {
    return request('thread/goal/get', buildThreadGoalParams(options));
  }

  async function setThreadGoal(options = {}) {
    return request('thread/goal/set', buildThreadGoalSetParams(options));
  }

  async function clearThreadGoal(options = {}) {
    return request('thread/goal/clear', buildThreadGoalParams(options));
  }

  return {
    clearThreadGoal,
    getThreadGoal,
    request,
    forkThread,
    setThreadGoal,
  };
}

export async function forkCodexThread(options = {}) {
  return createCodexAppServerClient(options).forkThread(options);
}

function createGoalClient(options = {}) {
  return createCodexAppServerClient({
    ...options,
    enabledFeatures: options.enabledFeatures || [],
  });
}

export async function getCodexThreadGoal(options = {}) {
  return createGoalClient(options).getThreadGoal(options);
}

export async function setCodexThreadGoal(options = {}) {
  return createGoalClient(options).setThreadGoal(options);
}

export async function clearCodexThreadGoal(options = {}) {
  return createGoalClient(options).clearThreadGoal(options);
}
