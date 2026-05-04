import fs from 'node:fs';
import path from 'node:path';

import {
  formatProjectUpgradeReport,
  formatProjectUpgradeStatusLine,
  normalizeProjectUpgradeMode,
} from './project-upgrade.js';

export function createProjectUpgradeScheduler({
  manager,
  intervalMs = 6 * 60 * 60_000,
  initialDelayMs = 30_000,
  notifyChannelIds = [],
  getClient = () => null,
  getRuntimeSnapshots = () => [],
  requestRestart = () => false,
  stateFile = '',
  logger = console,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let timer = null;
  let running = false;
  let stopped = false;

  function start() {
    if (!manager || timer) return stop;
    stopped = false;
    schedule(initialDelayMs);
    return stop;
  }

  function stop() {
    stopped = true;
    if (timer) clearTimer(timer);
    timer = null;
  }

  function schedule(delayMs = intervalMs) {
    if (stopped) return;
    timer = setTimer(async () => {
      timer = null;
      try {
        await tick();
      } finally {
        schedule(intervalMs);
      }
    }, Math.max(1000, Number(delayMs) || intervalMs));
    timer.unref?.();
  }

  async function tick() {
    if (running || !manager) return;
    running = true;
    try {
      const config = manager.resolveConfig();
      const mode = normalizeProjectUpgradeMode(config.mode);
      if (mode === 'off') return;
      const status = await manager.check({ fetch: true });
      if (!status?.ok || !status.updateAvailable) return;
      if (mode === 'notify') {
        await notifyOnce(status);
        return;
      }
      if (hasActiveWork()) {
        await notifyOnce({
          ...status,
          canApply: false,
          reasons: [...(status.reasons || []), 'bot has running or queued work'],
        });
        return;
      }
      await notifyAll(`🧭 ${formatProjectUpgradeStatusLine(status, 'zh')}\n正在自动升级，完成后会请求重启。`);
      const result = await manager.apply({ restart: false, requireIdle: checkIdle });
      await notifyAll(formatProjectUpgradeReport(null, 'zh', { applyResult: result }));
      if (result?.ok && result.changed) requestRestart();
    } catch (err) {
      logger.warn?.(`project upgrade scheduler failed: ${String(err?.message || err)}`);
    } finally {
      running = false;
    }
  }

  async function notifyOnce(status) {
    const state = readState();
    const key = status.remoteHead || `${status.remoteVersion || ''}:${status.remoteShort || ''}`;
    if (!key || state.lastNotified === key) return;
    await notifyAll(formatProjectUpgradeReport(status, 'zh'));
    writeState({ ...state, lastNotified: key, lastNotifiedAt: new Date().toISOString() });
  }

  async function notifyAll(content) {
    const ids = [...new Set(notifyChannelIds.map((id) => String(id || '').trim()).filter(Boolean))];
    if (!ids.length) return;
    const client = getClient();
    if (!client?.channels?.fetch) return;
    await Promise.all(ids.map(async (id) => {
      try {
        const channel = await client.channels.fetch(id);
        if (channel?.send) await channel.send({ content });
      } catch (err) {
        logger.warn?.(`project upgrade notify failed for ${id}: ${String(err?.message || err)}`);
      }
    }));
  }

  function hasActiveWork() {
    return !checkIdle().ok;
  }

  function checkIdle() {
    const snapshots = getRuntimeSnapshots() || [];
    const busy = snapshots.find((item) => item?.running || Number(item?.queued || 0) > 0);
    if (!busy) return { ok: true };
    return {
      ok: false,
      error: `bot has running or queued work in ${busy.key || 'a channel'}`,
    };
  }

  function readState() {
    if (!stateFile) return {};
    try {
      return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    } catch {
      return {};
    }
  }

  function writeState(state) {
    if (!stateFile) return;
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    } catch {
      // ignore
    }
    fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  }

  return {
    start,
    stop,
    tick,
  };
}
