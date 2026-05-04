const STOP_CHILD_PROCESS_STATE = Symbol('agentsInDiscordStopChildProcessState');

export function createChannelRuntimeStore({
  cloneProgressPlan,
  truncate,
  promptPreviewChars = 120,
} = {}) {
  const channelStates = new Map();

  function getChannelState(key) {
    let state = channelStates.get(key);
    if (!state) {
      state = {
        running: false,
        queue: [],
        activeRun: null,
        cancelRequested: false,
        lastFailedPrompt: null,
      };
      channelStates.set(key, state);
    }
    return state;
  }

  function resolveChannelState(target) {
    return typeof target === 'string' ? getChannelState(target) : target;
  }

  function setActiveRun(channelState, message, prompt, child, phase = 'exec') {
    const prev = channelState.activeRun;
    channelState.activeRun = {
      child,
      startedAt: Date.now(),
      messageId: message.id,
      phase,
      promptPreview: truncate(String(prompt || '').replace(/\s+/g, ' '), promptPreviewChars),
      cancelRequested: Boolean(channelState.cancelRequested),
      progressEvents: prev?.progressEvents || 0,
      lastProgressText: prev?.lastProgressText || null,
      lastProgressAt: prev?.lastProgressAt || null,
      progressMessageId: prev?.progressMessageId || null,
      progressPlan: cloneProgressPlan(prev?.progressPlan),
      completedSteps: Array.isArray(prev?.completedSteps) ? [...prev.completedSteps] : [],
      recentActivities: Array.isArray(prev?.recentActivities) ? [...prev.recentActivities] : [],
    };
  }

  function cancelChannelWork(key, reason = 'manual') {
    const state = getChannelState(key);
    const queued = state.queue.length;
    state.queue.length = 0;
    state.cancelRequested = true;

    let cancelledRunning = false;
    let pid = null;
    if (state.activeRun) {
      state.activeRun.cancelRequested = true;
      cancelledRunning = true;
      pid = state.activeRun.child?.pid ?? null;
      if (state.activeRun.child) {
        stopChildProcess(state.activeRun.child);
      }
    }

    return {
      key,
      reason,
      cancelledRunning,
      pid,
      clearedQueued: queued,
    };
  }

  function cancelAllChannelWork(reason = 'system') {
    for (const key of channelStates.keys()) {
      cancelChannelWork(key, reason);
    }
  }

  function getRuntimeSnapshot(key) {
    const state = getChannelState(key);
    const active = state.activeRun;
    return {
      running: Boolean(state.running || active),
      queued: state.queue.length,
      activeSinceMs: active ? Math.max(0, Date.now() - active.startedAt) : null,
      phase: active?.phase || null,
      pid: active?.child?.pid ?? null,
      messageId: active?.messageId || null,
      progressEvents: active?.progressEvents || 0,
      progressText: active?.lastProgressText || null,
      progressAgoMs: active?.lastProgressAt ? Math.max(0, Date.now() - active.lastProgressAt) : null,
      progressMessageId: active?.progressMessageId || null,
      progressPlan: cloneProgressPlan(active?.progressPlan),
      completedSteps: Array.isArray(active?.completedSteps) ? [...active.completedSteps] : [],
      recentActivities: Array.isArray(active?.recentActivities) ? [...active.recentActivities] : [],
    };
  }

  function getAllRuntimeSnapshots() {
    return [...channelStates.entries()].map(([key]) => ({
      key,
      ...getRuntimeSnapshot(key),
    }));
  }

  function rememberFailedPrompt(target, failedPrompt) {
    const state = resolveChannelState(target);
    state.lastFailedPrompt = failedPrompt || null;
    return state.lastFailedPrompt;
  }

  function clearLastFailedPrompt(target) {
    const state = resolveChannelState(target);
    state.lastFailedPrompt = null;
  }

  function getLastFailedPrompt(key) {
    return getChannelState(key).lastFailedPrompt || null;
  }

  return {
    getChannelState,
    setActiveRun,
    cancelChannelWork,
    cancelAllChannelWork,
    getRuntimeSnapshot,
    getAllRuntimeSnapshots,
    rememberFailedPrompt,
    clearLastFailedPrompt,
    getLastFailedPrompt,
  };
}

export function stopChildProcess(child, killGraceMs = 3000) {
  if (!child) return;
  let exited = child.exitCode !== null && child.exitCode !== undefined;
  exited = exited || Boolean(child.signalCode);
  if (exited) return;
  if (child[STOP_CHILD_PROCESS_STATE]?.stopping) return;
  child[STOP_CHILD_PROCESS_STATE] = { stopping: true };
  const markExited = () => {
    exited = true;
    if (child[STOP_CHILD_PROCESS_STATE]) {
      child[STOP_CHILD_PROCESS_STATE].stopping = false;
    }
  };
  child.once?.('exit', markExited);
  child.once?.('close', markExited);
  try {
    child.kill?.('SIGTERM');
  } catch {
    return;
  }
  setTimeout(() => {
    try {
      if (!exited) child.kill?.('SIGKILL');
    } catch {
    }
  }, killGraceMs).unref?.();
}
