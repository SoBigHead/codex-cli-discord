import test from 'node:test';
import assert from 'node:assert/strict';

import {
  handleClaudeRunnerEvent,
  handleCodexRunnerEvent,
  handleGeminiRunnerEvent,
} from '../src/runner-event-handlers.js';
import {
  extractAgentMessageText,
  isFinalAnswerLikeAgentMessage,
} from '../src/codex-event-utils.js';

test('handleCodexRunnerEvent captures codex 0.111 item.completed final answer', () => {
  const state = {
    messages: [],
    finalAnswerMessages: [],
    reasonings: [],
    logs: [],
    usage: null,
    threadId: null,
    meta: {},
  };
  const bridges = [];

  handleCodexRunnerEvent({
    type: 'thread.started',
    thread_id: 'thread-123',
  }, state, (threadId) => bridges.push(threadId), {
    extractAgentMessageText,
    isFinalAnswerLikeAgentMessage,
  });

  handleCodexRunnerEvent({
    type: 'item.completed',
    item: {
      id: 'item_0',
      type: 'agent_message',
      text: '你好',
    },
  }, state, () => {}, {
    extractAgentMessageText,
    isFinalAnswerLikeAgentMessage,
  });

  handleCodexRunnerEvent({
    type: 'turn.completed',
    usage: {
      input_tokens: 13200,
      output_tokens: 28,
    },
  }, state, () => {}, {
    extractAgentMessageText,
    isFinalAnswerLikeAgentMessage,
  });

  assert.deepEqual(bridges, ['thread-123']);
  assert.equal(state.threadId, 'thread-123');
  assert.deepEqual(state.finalAnswerMessages, ['你好']);
  assert.deepEqual(state.messages, []);
  assert.deepEqual(state.usage, {
    type: 'turn.completed',
    usage: {
      input_tokens: 13200,
      output_tokens: 28,
    },
  });
});

test('handleCodexRunnerEvent keeps commentary item.completed out of final answer', () => {
  const state = {
    messages: [],
    finalAnswerMessages: [],
    reasonings: [],
    logs: [],
    usage: null,
    threadId: null,
    meta: {},
  };

  handleCodexRunnerEvent({
    type: 'item.completed',
    item: {
      id: 'item_1',
      type: 'agent_message',
      text: '我先看一下代码结构。',
      phase: 'commentary',
    },
  }, state, () => {}, {
    extractAgentMessageText,
    isFinalAnswerLikeAgentMessage,
  });

  assert.deepEqual(state.messages, ['我先看一下代码结构。']);
  assert.deepEqual(state.finalAnswerMessages, []);
});

test('handleCodexRunnerEvent captures final answer from bridged session events', () => {
  const state = {
    messages: [],
    finalAnswerMessages: [],
    reasonings: [],
    logs: [],
    usage: null,
    threadId: null,
    meta: {},
  };

  handleCodexRunnerEvent({
    type: 'event_msg',
    payload: {
      type: 'agent_message',
      message: '桥接来的最终总结。',
      phase: 'final_answer',
    },
  }, state, () => {}, {
    extractAgentMessageText,
    isFinalAnswerLikeAgentMessage,
  });

  handleCodexRunnerEvent({
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'output_text', text: 'response item 最终总结。' },
      ],
      phase: 'final_answer',
    },
  }, state, () => {}, {
    extractAgentMessageText,
    isFinalAnswerLikeAgentMessage,
  });

  handleCodexRunnerEvent({
    type: 'event_msg',
    payload: {
      type: 'task_complete',
      last_agent_message: 'task complete 最终总结。',
    },
  }, state, () => {}, {
    extractAgentMessageText,
    isFinalAnswerLikeAgentMessage,
  });

  assert.deepEqual(state.finalAnswerMessages, [
    '桥接来的最终总结。',
    'response item 最终总结。',
    'task complete 最终总结。',
  ]);
  assert.deepEqual(state.messages, []);
});

test('handleGeminiRunnerEvent captures init, delta messages, and result stats', () => {
  const state = {
    messages: [],
    finalAnswerMessages: [],
    reasonings: [],
    logs: [],
    usage: null,
    threadId: null,
    meta: {
      geminiDeltaBuffer: '',
    },
  };
  const bridges = [];

  handleGeminiRunnerEvent({
    type: 'init',
    session_id: 'gemini-session-123',
  }, state, (threadId) => bridges.push(threadId));

  handleGeminiRunnerEvent({
    type: 'message',
    role: 'assistant',
    content: 'I will inspect the repo.',
    delta: true,
  }, state, () => {});

  handleGeminiRunnerEvent({
    type: 'result',
    stats: {
      input_tokens: 18,
      output_tokens: 7,
    },
  }, state, () => {});

  assert.deepEqual(bridges, ['gemini-session-123']);
  assert.equal(state.threadId, 'gemini-session-123');
  assert.equal(state.meta.geminiDeltaBuffer, 'I will inspect the repo.');
  assert.deepEqual(state.usage, {
    input_tokens: 18,
    output_tokens: 7,
  });
});

test('handleClaudeRunnerEvent captures tool use session id and final result text', () => {
  const state = {
    messages: [],
    finalAnswerMessages: [],
    reasonings: [],
    logs: [],
    usage: null,
    threadId: null,
    meta: {
      claudeSawAgentToolUse: false,
      claudeStopReason: '',
    },
  };
  const bridges = [];

  handleClaudeRunnerEvent({
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      content_block: {
        type: 'tool_use',
        name: 'agent',
      },
    },
  }, state, () => {});

  handleClaudeRunnerEvent({
    type: 'session.created',
    session_id: 'claude-session-1',
  }, state, (threadId) => bridges.push(threadId));

  handleClaudeRunnerEvent({
    type: 'result',
    session_id: 'claude-session-1',
    stop_reason: 'end_turn',
    usage: { input_tokens: 21, output_tokens: 8 },
    content: [
      { type: 'text', text: '结论：可以继续推进。' },
    ],
  }, state, (threadId) => bridges.push(threadId));

  assert.equal(state.meta.claudeSawAgentToolUse, true);
  assert.equal(state.meta.claudeStopReason, 'end_turn');
  assert.equal(state.threadId, 'claude-session-1');
  assert.deepEqual(state.finalAnswerMessages, ['结论：可以继续推进。']);
  assert.deepEqual(state.usage, { input_tokens: 21, output_tokens: 8 });
  assert.deepEqual(bridges, ['claude-session-1', 'claude-session-1']);
});

test('handleClaudeRunnerEvent reads real Claude assistant session messages and separates final answer', () => {
  const state = {
    messages: [],
    finalAnswerMessages: [],
    reasonings: [],
    logs: [],
    usage: null,
    threadId: null,
    meta: {
      claudeSawAgentToolUse: false,
      claudeStopReason: '',
    },
  };
  const bridges = [];

  handleClaudeRunnerEvent({
    type: 'assistant',
    sessionId: 'claude-session-2',
    message: {
      role: 'assistant',
      type: 'message',
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: '我先检查一下这个问题的复现路径。' },
        { type: 'tool_use', name: 'Bash' },
      ],
    },
  }, state, (threadId) => bridges.push(threadId));

  handleClaudeRunnerEvent({
    type: 'assistant',
    sessionId: 'claude-session-2',
    message: {
      role: 'assistant',
      type: 'message',
      stop_reason: 'end_turn',
      content: [
        { type: 'text', text: '结论：问题出在 Claude session 最终答案被误判成过程内容。' },
      ],
    },
  }, state, (threadId) => bridges.push(threadId));

  handleClaudeRunnerEvent({
    type: 'result',
    session_id: 'claude-session-2',
    stop_reason: 'end_turn',
    content: [
      { type: 'text', text: '结论：问题出在 Claude session 最终答案被误判成过程内容。' },
    ],
  }, state, (threadId) => bridges.push(threadId));

  assert.deepEqual(state.messages, ['我先检查一下这个问题的复现路径。']);
  assert.deepEqual(state.finalAnswerMessages, ['结论：问题出在 Claude session 最终答案被误判成过程内容。']);
  assert.equal(state.threadId, 'claude-session-2');
  assert.deepEqual(bridges, ['claude-session-2', 'claude-session-2']);
});

test('handleClaudeRunnerEvent captures visible tool_result text from Claude session user events', () => {
  const state = {
    messages: [],
    finalAnswerMessages: [],
    reasonings: [],
    logs: [],
    usage: null,
    threadId: null,
    meta: {
      claudeSawAgentToolUse: false,
      claudeStopReason: '',
    },
  };

  handleClaudeRunnerEvent({
    type: 'user',
    sessionId: 'claude-session-3',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'call_1',
          content: '## 角色卡 #1\n\n完整正文',
        },
      ],
    },
  }, state, () => {});

  assert.equal(state.threadId, 'claude-session-3');
  assert.deepEqual(state.meta.claudeToolResultMessages, ['## 角色卡 #1\n\n完整正文']);
  assert.deepEqual(state.messages, []);
  assert.deepEqual(state.finalAnswerMessages, []);
});
