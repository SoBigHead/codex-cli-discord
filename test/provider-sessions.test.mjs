import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildClaudeSessionRescueSummary,
  listRecentSessions,
  readClaudeSessionMetaBySessionId,
  readCodexSessionMetaBySessionId,
  readGeminiSessionState,
  resolveGeminiProjectRootBySessionId,
} from '../src/provider-sessions.js';

test('provider-sessions reads gemini session state from project-scoped files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-in-discord-gemini-'));
  const workspaceDir = path.join(root, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });

  const previousHome = process.env.HOME;
  process.env.HOME = root;

  try {
    const geminiRoot = path.join(root, '.gemini');
    const slug = '-tmp-workspace';
    const projectDir = path.join(geminiRoot, 'tmp', slug);
    const chatsDir = path.join(projectDir, 'chats');
    fs.mkdirSync(chatsDir, { recursive: true });
    fs.writeFileSync(path.join(geminiRoot, 'projects.json'), JSON.stringify({
      projects: {
        [path.resolve(workspaceDir)]: slug,
      },
    }, null, 2));
    fs.writeFileSync(path.join(projectDir, '.project_root'), `${path.resolve(workspaceDir)}\n`);

    const sessionId = '03c6d6dd-8920-42a6-ab7b-883d824ab355';
    fs.writeFileSync(path.join(chatsDir, 'session-test.json'), JSON.stringify({
      sessionId,
      lastUpdated: '2026-03-13T07:54:38.393Z',
      messages: [
        { type: 'user', content: [{ text: 'hi' }] },
        {
          type: 'gemini',
          content: 'I will inspect files.',
          tokens: { input: 10, output: 2, total: 12 },
        },
        {
          type: 'gemini',
          content: 'Final answer',
          tokens: { input: 11, output: 3, total: 14 },
        },
      ],
    }, null, 2));

    const recent = listRecentSessions({ provider: 'gemini', workspaceDir, limit: 5 });
    const sessionState = readGeminiSessionState({ sessionId, workspaceDir });

    assert.equal(recent.length, 1);
    assert.equal(recent[0].id, sessionId);
    assert.deepEqual(sessionState.messages, ['I will inspect files.']);
    assert.equal(sessionState.finalAnswer, 'Final answer');
    assert.deepEqual(sessionState.usage, { input: 11, output: 3, total: 14 });
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }
});

test('provider-sessions reads Antigravity conversation id from workspace cache', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-in-discord-antigravity-'));
  const workspaceDir = path.join(root, 'workspace');
  fs.mkdirSync(path.join(root, '.gemini', 'antigravity-cli', 'cache'), { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });

  const previousHome = process.env.HOME;
  process.env.HOME = root;

  try {
    const conversationId = 'b349594e-8cc8-4604-9443-cfbe6479fe51';
    fs.writeFileSync(path.join(root, '.gemini', 'antigravity-cli', 'cache', 'last_conversations.json'), JSON.stringify({
      [path.resolve(workspaceDir)]: conversationId,
    }, null, 2));

    const recent = listRecentSessions({ provider: 'gemini', workspaceDir, limit: 5 });
    const sessionState = readGeminiSessionState({ workspaceDir });
    const staleSessionState = readGeminiSessionState({ workspaceDir, notOlderThanMs: Date.now() + 60_000 });
    const resolved = resolveGeminiProjectRootBySessionId(conversationId, workspaceDir);

    assert.equal(recent.length, 1);
    assert.equal(recent[0].id, conversationId);
    assert.equal(sessionState.sessionId, conversationId);
    assert.equal(staleSessionState, null);
    assert.equal(sessionState.finalAnswer, '');
    assert.equal(resolved, path.resolve(workspaceDir));
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }
});

test('provider-sessions builds a local Claude rescue summary when the session is over context', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-in-discord-claude-rescue-'));
  const workspaceDir = path.join(root, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });

  const previousHome = process.env.HOME;
  process.env.HOME = root;

  try {
    const projectDir = path.join(
      root,
      '.claude',
      'projects',
      path.resolve(workspaceDir).replace(/[\\/]/g, '-'),
    );
    fs.mkdirSync(projectDir, { recursive: true });

    const sessionId = 'b4e0977d-2fdd-49cb-93ea-3f8164cdb1a3';
    const sessionFile = path.join(projectDir, `${sessionId}.jsonl`);
    fs.writeFileSync(sessionFile, [
      JSON.stringify({
        type: 'last-prompt',
        lastPrompt: '继续批量生成报告',
        sessionId,
      }),
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: '<task-notification><task-id>task-1</task-id><status>completed</status><summary>Generate report 1001 completed</summary><output-file>/tmp/out</output-file><result>报告已生成并验证 75/75 通过。</result></task-notification>',
        },
        cwd: workspaceDir,
        sessionId,
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '1001 通过。' }],
        },
        sessionId,
      }),
      JSON.stringify({
        type: 'assistant',
        isApiErrorMessage: true,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'API Error: The model has reached its context window limit.' }],
        },
        sessionId,
      }),
      '',
    ].join('\n'));

    const result = buildClaudeSessionRescueSummary({ sessionId, workspaceDir });

    assert.equal(result.ok, true);
    assert.equal(result.sourceFile, sessionFile);
    assert.match(result.summary, /继续批量生成报告/);
    assert.match(result.summary, /Generate report 1001 completed/);
    assert.match(result.summary, /context window limit/);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }
});

test('provider-sessions reads codex session meta cwd from rollout file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-in-discord-codex-'));
  const workspaceDir = path.join(root, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });

  const previousHome = process.env.HOME;
  process.env.HOME = root;

  try {
    const sessionsDir = path.join(root, '.codex', 'sessions', '2026', '03', '22');
    fs.mkdirSync(sessionsDir, { recursive: true });

    const sessionId = '019d157d-a96a-7542-bf9c-987c885f603e';
    const rollout = path.join(sessionsDir, `rollout-2026-03-22T20-20-50-${sessionId}.jsonl`);
    fs.writeFileSync(rollout, `${JSON.stringify({
      timestamp: '2026-03-22T12:20:50.295Z',
      type: 'session_meta',
      payload: {
        id: sessionId,
        cwd: workspaceDir,
      },
    })}\n`);

    const meta = readCodexSessionMetaBySessionId(sessionId);
    assert.equal(meta.cwd, path.resolve(workspaceDir));
    assert.equal(meta.file, rollout);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }
});

test('provider-sessions reads claude session meta cwd from project session file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-in-discord-claude-'));
  const workspaceDir = path.join(root, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });

  const previousHome = process.env.HOME;
  process.env.HOME = root;

  try {
    const projectDir = path.join(
      root,
      '.claude',
      'projects',
      path.resolve(workspaceDir).replace(/[\\/]/g, '-'),
    );
    fs.mkdirSync(projectDir, { recursive: true });

    const sessionId = '43e6f310-5d27-4019-a664-b5dfaea09eaa';
    const sessionFile = path.join(projectDir, `${sessionId}.jsonl`);
    fs.writeFileSync(sessionFile, [
      JSON.stringify({
        type: 'queue-operation',
        operation: 'enqueue',
        sessionId,
      }),
      JSON.stringify({
        type: 'user',
        cwd: workspaceDir,
        sessionId,
      }),
      '',
    ].join('\n'));

    const meta = readClaudeSessionMetaBySessionId(sessionId);
    assert.equal(meta.cwd, path.resolve(workspaceDir));
    assert.equal(meta.file, sessionFile);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }
});

test('provider-sessions resolves gemini project root by session id', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-in-discord-gemini-root-'));
  const workspaceDir = path.join(root, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });

  const previousHome = process.env.HOME;
  process.env.HOME = root;

  try {
    const geminiRoot = path.join(root, '.gemini');
    const slug = '-tmp-workspace';
    const projectDir = path.join(geminiRoot, 'tmp', slug);
    const chatsDir = path.join(projectDir, 'chats');
    fs.mkdirSync(chatsDir, { recursive: true });
    fs.writeFileSync(path.join(geminiRoot, 'projects.json'), JSON.stringify({
      projects: {
        [path.resolve(workspaceDir)]: slug,
      },
    }, null, 2));
    fs.writeFileSync(path.join(projectDir, '.project_root'), `${path.resolve(workspaceDir)}\n`);

    const sessionId = '03c6d6dd-8920-42a6-ab7b-883d824ab355';
    fs.writeFileSync(path.join(chatsDir, 'session-test.json'), JSON.stringify({ sessionId }, null, 2));

    const resolved = resolveGeminiProjectRootBySessionId(sessionId, workspaceDir);
    assert.equal(resolved, path.resolve(workspaceDir));
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }
});
