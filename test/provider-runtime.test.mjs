import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  buildSpawnEnv,
  createCachedProviderRateLimitReader,
  formatCliHealth,
  getCodexAccountRateLimits,
  getProviderBin,
  isCliNotFound,
} from '../src/provider-runtime.js';
import {
  getLaunchctlGuardBinDir,
} from '../src/launchctl-guard.js';

test('buildSpawnEnv prepends the launchctl guard and appends common executable locations', () => {
  const env = buildSpawnEnv({
    HOME: '/tmp/home',
    PATH: '/usr/bin',
  });

  const parts = env.PATH.split(':');
  assert.equal(parts[0], getLaunchctlGuardBinDir());
  assert.ok(parts.includes('/usr/bin'));
  assert.ok(parts.includes('/tmp/home/.local/bin'));
  assert.ok(parts.includes('/opt/homebrew/bin'));
});

test('getProviderBin respects configured provider bins', () => {
  assert.equal(getProviderBin('codex', { codexBin: '/bin/codex-custom' }), '/bin/codex-custom');
  assert.equal(getProviderBin('claude', { claudeBin: '/bin/claude-custom' }), '/bin/claude-custom');
  assert.equal(getProviderBin('antigravity', { antigravityBin: '/bin/agy-custom' }), '/bin/agy-custom');
  assert.equal(getProviderBin('gemini', { legacyGeminiBin: '/bin/agy-legacy' }), '/bin/agy-legacy');
});

test('formatCliHealth renders not-found and success states', () => {
  assert.equal(isCliNotFound('spawn agy ENOENT'), true);
  assert.match(formatCliHealth({ ok: false, bin: 'agy', envKey: 'ANTIGRAVITY_BIN', error: 'spawn agy ENOENT' }, 'en'), /ANTIGRAVITY_BIN/);
  assert.equal(formatCliHealth({ ok: true, bin: 'agy', version: '1.0.0' }, 'zh'), '✅ `agy` (1.0.0)');
});

test('getCodexAccountRateLimits reads official app-server rate limit response', async () => {
  const spawnCalls = [];
  const spawnImpl = (bin, args) => {
    spawnCalls.push({ bin, args });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.kill = (signal) => {
      child.killed = true;
      child.emit('exit', null, signal);
    };
    child.stdin = {
      write(line) {
        const message = JSON.parse(line);
        if (message.id === 1) {
          setImmediate(() => {
            child.stdout.write(`${JSON.stringify({ id: 1, result: { userAgent: 'test' } })}\n`);
          });
        }
        if (message.id === 2) {
          setImmediate(() => {
            child.stdout.write(`${JSON.stringify({
              id: 2,
              result: {
                rateLimits: {
                  limitId: 'codex',
                  primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1776169989 },
                  secondary: { usedPercent: 34, windowDurationMins: 10080, resetsAt: 1776756789 },
                  credits: null,
                  planType: 'pro',
                },
                rateLimitsByLimitId: null,
              },
            })}\n`);
          });
        }
      },
    };
    return child;
  };

  const result = await getCodexAccountRateLimits('codex', {
    codexBin: '/bin/codex',
    spawnImpl,
    timeoutMs: 1000,
  });

  assert.equal(result.ok, true);
  assert.equal(result.rateLimits.primary.usedPercent, 12);
  assert.equal(result.rateLimits.secondary.windowDurationMins, 10080);
  assert.deepEqual(spawnCalls, [
    { bin: '/bin/codex', args: ['app-server', '--listen', 'stdio://'] },
  ]);
});

test('getCodexAccountRateLimits includes account identity from local auth.json', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'codex-auth-home-'));
  const codexDir = path.join(homeDir, '.codex');
  await mkdir(codexDir, { recursive: true });
  const idPayload = {
    email: 'demo@example.com',
    name: 'Demo User',
    'https://api.openai.com/auth': {
      chatgpt_plan_type: 'pro',
      organizations: [{ title: 'Personal', is_default: true }],
    },
  };
  const accessPayload = {
    'https://api.openai.com/profile': {
      email: 'demo@example.com',
    },
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'acct-123',
      chatgpt_plan_type: 'pro',
      organizations: [{ title: 'Personal', is_default: true }],
    },
  };
  const encode = (payload) => {
    const raw = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    return `header.${raw}.sig`;
  };
  await writeFile(path.join(codexDir, 'auth.json'), JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: {
      account_id: 'acct-123',
      id_token: encode(idPayload),
      access_token: encode(accessPayload),
    },
  }), 'utf8');

  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.kill = (signal) => {
      child.killed = true;
      child.emit('exit', null, signal);
    };
    child.stdin = {
      write(line) {
        const message = JSON.parse(line);
        if (message.id === 1) {
          setImmediate(() => {
            child.stdout.write(`${JSON.stringify({ id: 1, result: { userAgent: 'test' } })}\n`);
          });
        }
        if (message.id === 2) {
          setImmediate(() => {
            child.stdout.write(`${JSON.stringify({
              id: 2,
              result: {
                rateLimits: {
                  limitId: 'codex',
                  primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1776169989 },
                  secondary: { usedPercent: 34, windowDurationMins: 10080, resetsAt: 1776756789 },
                  credits: null,
                  planType: 'pro',
                },
                rateLimitsByLimitId: null,
              },
            })}\n`);
          });
        }
      },
    };
    return child;
  };

  const result = await getCodexAccountRateLimits('codex', {
    codexBin: '/bin/codex',
    spawnEnv: { ...process.env, HOME: homeDir },
    spawnImpl,
    timeoutMs: 1000,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.account, {
    authMode: 'chatgpt',
    email: 'demo@example.com',
    name: 'Demo User',
    planType: 'pro',
    accountId: 'acct-123',
    organizationTitle: 'Personal',
  });
});

test('createCachedProviderRateLimitReader returns stale snapshot when live query fails after success', async () => {
  let now = 1000;
  let calls = 0;
  const reader = createCachedProviderRateLimitReader({
    now: () => now,
    readRateLimits: async () => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: true,
          rateLimits: {
            limitId: 'codex',
            primary: { usedPercent: 11, windowDurationMins: 300, resetsAt: 1776169989 },
            secondary: { usedPercent: 22, windowDurationMins: 10080, resetsAt: 1776756789 },
          },
        };
      }
      return {
        ok: false,
        error: 'network timeout',
      };
    },
  });

  const live = await reader('codex');
  assert.equal(live.ok, true);
  assert.equal(live.stale, undefined);

  now = 61_000;
  const stale = await reader('codex');
  assert.equal(stale.ok, true);
  assert.equal(stale.stale, true);
  assert.equal(stale.staleReason, 'network timeout');
  assert.equal(stale.cachedAt, 1000);
  assert.equal(stale.cacheAgeMs, 60_000);
  assert.equal(stale.rateLimits.primary.usedPercent, 11);
});
