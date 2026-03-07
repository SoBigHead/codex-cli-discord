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
      };
      channelStates.set(key, state);
    }
    return state;
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
    if (state.activeRun?.child) {
      state.activeRun.cancelRequested = true;
      cancelledRunning = true;
      pid = state.activeRun.child.pid ?? null;
      stopChildProcess(state.activeRun.child);
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

  return {
    getChannelState,
    setActiveRun,
    cancelChannelWork,
    cancelAllChannelWork,
    getRuntimeSnapshot,
  };
}

export function stopChildProcess(child, killGraceMs = 3000) {
  if (!child || child.killed) return;
  try {
    child.kill('SIGTERM');
  } catch {
    return;
  }
  setTimeout(() => {
    try {
      if (!child.killed) child.kill('SIGKILL');
    } catch {
      // ignore
    }
  }, killGraceMs).unref?.();
}
