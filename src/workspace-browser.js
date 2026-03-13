import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const WORKSPACE_BROWSER_PREFIX = 'wsp';
const MAX_SELECT_OPTIONS = 25;
const MAX_BUTTONS_PER_ROW = 5;

function normalizeMode(value) {
  return String(value || '').trim().toLowerCase() === 'default' ? 'default' : 'thread';
}

function normalizeLanguage(value) {
  return String(value || '').trim().toLowerCase() === 'en' ? 'en' : 'zh';
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function truncate(text, max) {
  const value = String(text || '');
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(1, max - 3))}...`;
}

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

function isExistingDirectory(dir) {
  try {
    return fs.existsSync(dir) && fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function resolveNearestExistingDirectory(dir) {
  const raw = String(dir || '').trim();
  if (!raw) return null;

  let current = path.resolve(raw);
  while (true) {
    if (isExistingDirectory(current)) return current;
    const parent = path.dirname(current);
    if (!parent || parent === current) return null;
    current = parent;
  }
}

function resolveFirstExistingDirectory(candidates) {
  for (const candidate of candidates) {
    const resolved = resolveNearestExistingDirectory(candidate);
    if (resolved) return resolved;
  }
  return resolveNearestExistingDirectory(process.cwd()) || path.resolve(process.cwd());
}

function isDirectoryEntry(parentDir, entry) {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return fs.statSync(path.join(parentDir, entry.name)).isDirectory();
  } catch {
    return false;
  }
}

function listChildDirectories(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => isDirectoryEntry(dir, entry))
      .map((entry) => path.join(dir, entry.name))
      .sort((a, b) => path.basename(a).localeCompare(path.basename(b), 'en', {
        numeric: true,
        sensitivity: 'base',
      }));
  } catch {
    return [];
  }
}

function formatWorkspaceSourceLabel(source, language) {
  const value = String(source || '').trim().toLowerCase();
  if (language === 'en') {
    if (value === 'thread override') return 'thread override';
    if (value === 'provider default') return 'provider default';
    if (value === 'legacy fallback') return 'legacy fallback';
    if (value === 'provider-scoped env') return 'provider env';
    if (value === 'shared env') return 'shared env';
    if (value === 'unset') return 'unset';
    return value || 'unknown';
  }

  if (value === 'thread override') return 'thread 覆盖';
  if (value === 'provider default') return 'provider 默认';
  if (value === 'legacy fallback') return 'legacy 回退';
  if (value === 'provider-scoped env') return 'provider 专属 env';
  if (value === 'shared env') return '共享 env';
  if (value === 'unset') return '未设置';
  return value || '未知';
}

function formatMaybePath(dir, language, source = null) {
  const value = String(dir || '').trim();
  if (!value) {
    return language === 'en' ? '(unset)' : '（未设置）';
  }
  return source ? `\`${value}\` (${source})` : `\`${value}\``;
}

function formatImpactLine({ mode, language, provider, changed }) {
  if (!changed) {
    return language === 'en'
      ? '• impact: no change'
      : '• 影响：不会产生变更';
  }

  if (mode === 'default') {
    if (provider === 'codex') {
      return language === 'en'
        ? '• impact: may reset Codex sessions in affected threads'
        : '• 影响：可能重置受影响 thread 的 Codex session';
    }
    return language === 'en'
      ? '• impact: updates provider default workspace'
      : '• 影响：会更新 provider 默认 workspace';
  }

  if (provider === 'codex') {
    return language === 'en'
      ? '• impact: resets current Codex session if applied'
      : '• 影响：应用后会重置当前 Codex session';
  }
  return language === 'en'
    ? '• impact: keeps current Claude session when possible'
    : '• 影响：Claude 会尽量保留当前 session';
}

function buildWorkspaceBrowserButtonId(action, token, userId, version, page) {
  return `${WORKSPACE_BROWSER_PREFIX}:btn:${String(action || '').trim().toLowerCase()}:${token}:${userId}:${version}:${page}`;
}

function buildWorkspaceBrowserSelectId(token, userId, version, page) {
  return `${WORKSPACE_BROWSER_PREFIX}:sel:enter:${token}:${userId}:${version}:${page}`;
}

function buildWorkspaceBrowserRecentSelectId(token, userId, version) {
  return `${WORKSPACE_BROWSER_PREFIX}:sel:recent:${token}:${userId}:${version}:0`;
}

function buildWorkspaceBrowserFavoritesSelectId(token, userId, version) {
  return `${WORKSPACE_BROWSER_PREFIX}:sel:favorite:${token}:${userId}:${version}:0`;
}

export function parseWorkspaceBrowserComponentId(customId) {
  const match = /^wsp:(btn|sel):([a-z_]+):([a-z0-9_-]{6,32}):([0-9]{5,32}):([0-9]{1,6}):([0-9]{1,4})$/i
    .exec(String(customId || '').trim());
  if (!match) return null;

  const kind = match[1].toLowerCase() === 'sel' ? 'select' : 'button';
  const action = String(match[2] || '').trim().toLowerCase();
  const token = String(match[3] || '').trim();
  const userId = String(match[4] || '').trim();
  const version = Number(match[5]);
  const page = Number(match[6]);
  if (!Number.isInteger(version) || version <= 0) return null;
  if (!Number.isInteger(page) || page < 0) return null;

  const validButtonActions = new Set([
    'up',
    'apply',
    'cancel',
    'page_prev',
    'page_next',
    'jump_current',
    'jump_default',
    'jump_workspace',
    'jump_home',
    'favorite_add',
    'favorite_remove',
  ]);
  if (kind === 'button' && !validButtonActions.has(action)) return null;
  if (kind === 'select' && !new Set(['enter', 'recent', 'favorite']).has(action)) return null;

  return {
    kind,
    action,
    token,
    userId,
    version,
    page,
  };
}

export function isWorkspaceBrowserComponentId(customId) {
  return Boolean(parseWorkspaceBrowserComponentId(customId));
}

function formatWorkspaceBrowserReport({
  state,
  language,
  provider,
  binding,
  defaultBinding,
  currentDir,
  childCount,
  page,
  totalPages,
  isFavorite,
  favoriteCount,
}) {
  const targetLabel = state.mode === 'default'
    ? (language === 'en' ? 'provider default workspace' : 'provider 默认 workspace')
    : (language === 'en' ? 'current thread workspace' : '当前 thread workspace');
  const currentTarget = state.mode === 'default'
    ? formatMaybePath(defaultBinding.workspaceDir, language, formatWorkspaceSourceLabel(defaultBinding.source, language))
    : formatMaybePath(binding.workspaceDir, language, formatWorkspaceSourceLabel(binding.source, language));
  const changed = state.mode === 'default'
    ? String(defaultBinding.workspaceDir || '') !== String(currentDir || '')
    : String(binding.workspaceDir || '') !== String(currentDir || '');
  const pageLabel = totalPages > 1
    ? (language === 'en'
      ? `${page + 1}/${totalPages}`
      : `${page + 1}/${totalPages}`)
    : '1/1';

  if (language === 'en') {
    return [
      '📁 **Workspace Browser**',
      `• target: ${targetLabel}`,
      `• browsing: \`${currentDir}\``,
      `• current: ${currentTarget}`,
      `• subdirectories: ${childCount} (page ${pageLabel})`,
      `• favorites: ${isFavorite ? 'saved' : 'not saved'} (${favoriteCount})`,
      childCount > 0
        ? '• action: choose a child directory from the menu, then click "Use This Folder" to apply'
        : '• action: no child directories here; use "Up" or apply the current folder',
      formatImpactLine({ mode: state.mode, language, provider, changed }),
    ].join('\n');
  }

  return [
    '📁 **路径选择器**',
    `• 目标：${targetLabel}`,
    `• 当前浏览：\`${currentDir}\``,
    `• 当前生效：${currentTarget}`,
    `• 子目录：${childCount}（第 ${pageLabel} 页）`,
    `• 收藏：${isFavorite ? '已收藏' : '未收藏'}（共 ${favoriteCount} 个）`,
    childCount > 0
      ? '• 操作：先在下拉菜单里进入子目录，再点「使用当前目录」才会真正切换'
      : '• 操作：当前目录没有子目录，可以点「上一级」或直接使用当前目录',
    formatImpactLine({ mode: state.mode, language, provider, changed }),
  ].join('\n');
}

function formatBrowserClosed(language) {
  return language === 'en'
    ? '📁 Workspace browser closed.'
    : '📁 路径选择器已关闭。';
}

function formatBrowserExpired(language) {
  return language === 'en'
    ? '⏳ This workspace browser has expired. Start a new workspace browse command.'
    : '⏳ 这个路径选择器已经过期。请重新执行一次 workspace 浏览命令。';
}

function formatBrowserOwnedByOther(language) {
  return language === 'en'
    ? '⛔ This workspace browser belongs to another user.'
    : '⛔ 这个路径选择器只允许创建它的用户操作。';
}

function formatBrowserStale(language) {
  return language === 'en'
    ? 'ℹ️ This workspace browser view is stale. Use the latest panel instead.'
    : 'ℹ️ 这个路径面板已经过期，请使用最新面板。';
}

function formatNoChangeReport({ mode, language, currentDir }) {
  if (language === 'en') {
    return [
      'ℹ️ No workspace change applied.',
      `• target: ${mode === 'default' ? 'provider default workspace' : 'current thread workspace'}`,
      `• current: \`${currentDir}\``,
    ].join('\n');
  }

  return [
    'ℹ️ 没有应用任何 workspace 变更。',
    `• 目标：${mode === 'default' ? 'provider 默认 workspace' : '当前 thread workspace'}`,
    `• 当前：\`${currentDir}\``,
  ].join('\n');
}

export function createWorkspaceBrowser({
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  commandActions = {},
  workspaceRoot = '',
  homeDir = process.env.HOME || process.env.USERPROFILE || '',
  browserTtlMs = 10 * 60 * 1000,
  createToken = () => randomUUID().replace(/-/g, '').slice(0, 12),
  getSession = () => null,
  getSessionLanguage = () => 'zh',
  getSessionProvider = () => 'codex',
  getWorkspaceBinding = () => ({ workspaceDir: null, source: 'unset' }),
  listStoredSessions = () => [],
  listFavoriteWorkspaces = () => [],
  addFavoriteWorkspace = () => ({ changed: false, favorites: [] }),
  removeFavoriteWorkspace = () => ({ changed: false, favorites: [] }),
  resolveProviderDefaultWorkspace = () => ({ workspaceDir: null, source: 'unset' }),
  formatWorkspaceUpdateReport = () => '',
  formatDefaultWorkspaceUpdateReport = () => '',
} = {}) {
  const browsers = new Map();
  const fallbackWorkspaceRoot = resolveNearestExistingDirectory(workspaceRoot);
  const fallbackHomeDir = resolveNearestExistingDirectory(homeDir);

  function cleanupExpiredBrowsers(now = Date.now()) {
    for (const [token, state] of browsers.entries()) {
      if (now - state.updatedAt > browserTtlMs) {
        browsers.delete(token);
      }
    }
  }

  function resolveAnchorDirectory(state) {
    return resolveFirstExistingDirectory([
      state.currentDir,
      state.startDir,
      state.workspaceRoot,
      state.homeDir,
      process.cwd(),
    ]);
  }

  function buildRootJumpButton({ action, label, disabled, token, userId, version, page, style = ButtonStyle.Secondary }) {
    return new ButtonBuilder()
      .setCustomId(buildWorkspaceBrowserButtonId(action, token, userId, version, page))
      .setLabel(label)
      .setStyle(style)
      .setDisabled(disabled);
  }

  function resolveStateCurrentTargetDir({ state, binding, defaultBinding }) {
    return state.mode === 'default'
      ? resolveNearestExistingDirectory(defaultBinding.workspaceDir)
      : resolveNearestExistingDirectory(binding.workspaceDir);
  }

  function collectShortcutTargets({ state, binding, defaultBinding, currentDir, language }) {
    const items = [];
    const seen = new Set();

    function pushShortcut(action, label, dir) {
      const resolved = resolveNearestExistingDirectory(dir);
      if (!resolved) return;
      if (seen.has(resolved)) return;
      seen.add(resolved);
      items.push({
        action,
        label,
        dir: resolved,
        disabled: resolved === currentDir,
      });
    }

    const currentTargetDir = resolveStateCurrentTargetDir({ state, binding, defaultBinding });
    if (state.mode === 'thread') {
      pushShortcut('jump_current', language === 'en' ? 'Current' : '当前目录', currentTargetDir);
      pushShortcut('jump_default', language === 'en' ? 'Provider Default' : 'Provider 默认', defaultBinding.workspaceDir);
    } else {
      pushShortcut('jump_default', language === 'en' ? 'Provider Default' : 'Provider 默认', defaultBinding.workspaceDir);
      pushShortcut('jump_current', language === 'en' ? 'Current' : '当前目录', currentTargetDir);
    }

    pushShortcut('jump_workspace', 'WORKSPACE_ROOT', state.workspaceRoot);
    pushShortcut('jump_home', 'HOME', state.homeDir);

    return items;
  }

  function collectFavoriteDirectories({ provider, currentDir }) {
    const favorites = listFavoriteWorkspaces({ provider }) || [];
    const seen = new Set();
    const items = [];

    for (const dir of favorites) {
      const resolved = resolveNearestExistingDirectory(dir);
      if (!resolved || resolved === currentDir || seen.has(resolved)) continue;
      seen.add(resolved);
      items.push({
        dir: resolved,
        label: truncate(path.basename(resolved) || resolved, 100),
        description: truncate(resolved, 100),
      });
      if (items.length >= 10) break;
    }

    return items;
  }

  function collectRecentDirectories({ state, provider, currentDir }) {
    const entries = listStoredSessions({ provider }) || [];
    const seen = new Set();
    const items = [];

    const sortedEntries = [...entries].sort((a, b) => {
      const aTime = Date.parse(a?.session?.updatedAt || 0);
      const bTime = Date.parse(b?.session?.updatedAt || 0);
      return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
    });

    for (const entry of sortedEntries) {
      const key = String(entry?.key || '').trim();
      if (!key || key === state.channelId) continue;
      const binding = getWorkspaceBinding(entry.session, key) || {};
      const resolved = resolveNearestExistingDirectory(binding.workspaceDir);
      if (!resolved || resolved === currentDir || seen.has(resolved)) continue;
      seen.add(resolved);
      items.push({
        dir: resolved,
        key,
        label: truncate(path.basename(resolved) || resolved, 100),
        description: truncate(resolved, 100),
      });
      if (items.length >= 5) break;
    }

    return items;
  }

  function buildBrowserPayload(state, session, key, { flags } = {}) {
    const language = normalizeLanguage(getSessionLanguage(session));
    const provider = getSessionProvider(session);
    const binding = getWorkspaceBinding(session, key) || {};
    const defaultBinding = resolveProviderDefaultWorkspace(provider) || {};
    const currentDir = resolveAnchorDirectory(state);
    state.currentDir = currentDir;

    const directories = listChildDirectories(currentDir);
    const totalPages = Math.max(1, Math.ceil(directories.length / MAX_SELECT_OPTIONS));
    state.page = clamp(state.page, 0, totalPages - 1);
    const page = state.page;
    const pageEntries = directories.slice(page * MAX_SELECT_OPTIONS, (page + 1) * MAX_SELECT_OPTIONS);
    const noChange = state.mode === 'default'
      ? String(defaultBinding.workspaceDir || '') === currentDir
      : String(binding.workspaceDir || '') === currentDir;
    const favoriteDirectories = collectFavoriteDirectories({
      provider,
      currentDir,
    });
    const allFavoriteDirectories = listFavoriteWorkspaces({ provider }) || [];
    const isFavorite = allFavoriteDirectories.includes(currentDir);
    const recentDirectories = collectRecentDirectories({
      state,
      provider,
      currentDir,
    });
    state.favoriteDirectories = favoriteDirectories;
    state.recentDirectories = recentDirectories;

    const components = [
      new ActionRowBuilder().addComponents(
        buildRootJumpButton({
          action: 'up',
          label: language === 'en' ? 'Up' : '上一级',
          disabled: path.dirname(currentDir) === currentDir,
          token: state.token,
          userId: state.userId,
          version: state.version,
          page,
        }),
        buildRootJumpButton({
          action: 'apply',
          label: language === 'en' ? 'Use This Folder' : '使用当前目录',
          disabled: noChange,
          token: state.token,
          userId: state.userId,
          version: state.version,
          page,
          style: ButtonStyle.Primary,
        }),
        buildRootJumpButton({
          action: 'cancel',
          label: language === 'en' ? 'Cancel' : '取消',
          disabled: false,
          token: state.token,
          userId: state.userId,
          version: state.version,
          page,
          style: ButtonStyle.Danger,
        }),
        buildRootJumpButton({
          action: 'page_prev',
          label: language === 'en' ? 'Prev Page' : '上一页',
          disabled: page <= 0 || totalPages <= 1,
          token: state.token,
          userId: state.userId,
          version: state.version,
          page,
        }),
        buildRootJumpButton({
          action: 'page_next',
          label: language === 'en' ? 'Next Page' : '下一页',
          disabled: page >= totalPages - 1 || totalPages <= 1,
          token: state.token,
          userId: state.userId,
          version: state.version,
          page,
        }),
      ),
    ];

    if (pageEntries.length > 0) {
      components.push(
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(buildWorkspaceBrowserSelectId(state.token, state.userId, state.version, page))
            .setPlaceholder(language === 'en' ? 'Choose a child directory' : '选择一个子目录')
            .addOptions(pageEntries.map((dir, index) => ({
              label: truncate(path.basename(dir) || dir, 100),
              value: String(index),
              description: truncate(dir, 100),
            }))),
        ),
      );
    }

    if (favoriteDirectories.length > 0) {
      components.push(
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(buildWorkspaceBrowserFavoritesSelectId(state.token, state.userId, state.version))
            .setPlaceholder(language === 'en' ? 'Jump to a favorite directory' : '跳到收藏目录')
            .addOptions(favoriteDirectories.map((item, index) => ({
              label: item.label,
              value: String(index),
              description: item.description,
            }))),
        ),
      );
    }

    if (recentDirectories.length > 0) {
      components.push(
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(buildWorkspaceBrowserRecentSelectId(state.token, state.userId, state.version))
            .setPlaceholder(language === 'en' ? 'Jump to a recent directory' : '跳到最近使用的目录')
            .addOptions(recentDirectories.map((item, index) => ({
              label: item.label,
              value: String(index),
              description: item.description,
            }))),
        ),
      );
    }

    const shortcutTargets = collectShortcutTargets({
      state,
      binding,
      defaultBinding,
      currentDir,
      language,
    });

    const shortcutButtons = shortcutTargets.map((item) => buildRootJumpButton({
      action: item.action,
      label: item.label,
      disabled: item.disabled,
      token: state.token,
      userId: state.userId,
      version: state.version,
      page,
    }));
    shortcutButtons.push(buildRootJumpButton({
      action: isFavorite ? 'favorite_remove' : 'favorite_add',
      label: isFavorite
        ? (language === 'en' ? 'Unfavorite' : '取消收藏')
        : (language === 'en' ? 'Favorite' : '收藏当前'),
      disabled: false,
      token: state.token,
      userId: state.userId,
      version: state.version,
      page,
      style: isFavorite ? ButtonStyle.Secondary : ButtonStyle.Success,
    }));

    for (const rowItems of chunk(shortcutButtons, MAX_BUTTONS_PER_ROW)) {
      components.push(new ActionRowBuilder().addComponents(...rowItems));
    }

    const payload = {
      content: formatWorkspaceBrowserReport({
        state,
        language,
        provider,
        binding,
        defaultBinding,
        currentDir,
        childCount: directories.length,
        page,
        totalPages,
        isFavorite,
        favoriteCount: allFavoriteDirectories.length,
      }),
      components,
    };

    if (flags !== undefined) payload.flags = flags;
    return payload;
  }

  function openWorkspaceBrowser({ key, session, userId, mode = 'thread', flags } = {}) {
    cleanupExpiredBrowsers();
    const normalizedMode = normalizeMode(mode);
    const provider = getSessionProvider(session);
    const binding = getWorkspaceBinding(session, key) || {};
    const defaultBinding = resolveProviderDefaultWorkspace(provider) || {};
    const startDir = resolveFirstExistingDirectory([
      normalizedMode === 'default' ? defaultBinding.workspaceDir : binding.workspaceDir,
      binding.workspaceDir,
      defaultBinding.workspaceDir,
      fallbackWorkspaceRoot,
      fallbackHomeDir,
      process.cwd(),
    ]);

    const state = {
      token: createToken(),
      mode: normalizedMode,
      userId: String(userId || '').trim(),
      channelId: String(key || '').trim(),
      startDir,
      currentDir: startDir,
      page: 0,
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      workspaceRoot: fallbackWorkspaceRoot,
      homeDir: fallbackHomeDir,
    };
    browsers.set(state.token, state);
    return buildBrowserPayload(state, session, key, { flags });
  }

  async function handleWorkspaceBrowserInteraction(interaction) {
    cleanupExpiredBrowsers();

    const parsed = parseWorkspaceBrowserComponentId(interaction.customId);
    if (!parsed) return false;

    const state = browsers.get(parsed.token);
    const key = String(interaction.channelId || '').trim();
    const session = key ? getSession(key) : null;
    const language = normalizeLanguage(getSessionLanguage(session));

    if (!state || !key || state.channelId !== key) {
      browsers.delete(parsed.token);
      await interaction.reply({ content: formatBrowserExpired(language), flags: 64 });
      return true;
    }

    if (state.userId !== interaction.user.id || parsed.userId !== interaction.user.id) {
      await interaction.reply({ content: formatBrowserOwnedByOther(language), flags: 64 });
      return true;
    }

    if (parsed.version !== state.version) {
      await interaction.reply({ content: formatBrowserStale(language), flags: 64 });
      return true;
    }

    const provider = getSessionProvider(session);
    state.updatedAt = Date.now();
    state.currentDir = resolveAnchorDirectory(state);

    if (parsed.kind === 'select') {
      if (parsed.action === 'favorite') {
        const selectedIndex = Number.parseInt(interaction.values?.[0] || '', 10);
        const selectedDir = Number.isInteger(selectedIndex)
          ? state.favoriteDirectories?.[selectedIndex]?.dir
          : null;
        if (selectedDir) {
          state.currentDir = selectedDir;
          state.page = 0;
          state.version += 1;
        }

        await interaction.update(buildBrowserPayload(state, session, key));
        return true;
      }

      if (parsed.action === 'recent') {
        const selectedIndex = Number.parseInt(interaction.values?.[0] || '', 10);
        const selectedDir = Number.isInteger(selectedIndex)
          ? state.recentDirectories?.[selectedIndex]?.dir
          : null;
        if (selectedDir) {
          state.currentDir = selectedDir;
          state.page = 0;
          state.version += 1;
        }

        await interaction.update(buildBrowserPayload(state, session, key));
        return true;
      }

      const directories = listChildDirectories(state.currentDir);
      const totalPages = Math.max(1, Math.ceil(directories.length / MAX_SELECT_OPTIONS));
      state.page = clamp(state.page, 0, totalPages - 1);

      const selectedIndex = Number.parseInt(interaction.values?.[0] || '', 10);
      const pageEntries = directories.slice(state.page * MAX_SELECT_OPTIONS, (state.page + 1) * MAX_SELECT_OPTIONS);
      const selectedDir = Number.isInteger(selectedIndex) ? pageEntries[selectedIndex] : null;
      if (selectedDir) {
        state.currentDir = selectedDir;
        state.page = 0;
        state.version += 1;
      }

      await interaction.update(buildBrowserPayload(state, session, key));
      return true;
    }

    switch (parsed.action) {
      case 'cancel': {
        browsers.delete(state.token);
        await interaction.update({
          content: formatBrowserClosed(language),
          components: [],
        });
        return true;
      }

      case 'up':
        state.currentDir = path.dirname(state.currentDir) || state.currentDir;
        state.page = 0;
        state.version += 1;
        break;

      case 'page_prev':
        state.page = Math.max(0, state.page - 1);
        state.version += 1;
        break;

      case 'page_next': {
        const directories = listChildDirectories(state.currentDir);
        const totalPages = Math.max(1, Math.ceil(directories.length / MAX_SELECT_OPTIONS));
        state.page = Math.min(totalPages - 1, state.page + 1);
        state.version += 1;
        break;
      }

      case 'jump_current': {
        const binding = getWorkspaceBinding(session, key) || {};
        const defaultBinding = resolveProviderDefaultWorkspace(provider) || {};
        state.currentDir = resolveFirstExistingDirectory([
          resolveStateCurrentTargetDir({ state, binding, defaultBinding }),
          state.startDir,
          state.workspaceRoot,
          state.homeDir,
          process.cwd(),
        ]);
        state.page = 0;
        state.version += 1;
        break;
      }

      case 'jump_default':
        state.currentDir = resolveFirstExistingDirectory([
          resolveProviderDefaultWorkspace(provider)?.workspaceDir,
          state.startDir,
          state.workspaceRoot,
          state.homeDir,
          process.cwd(),
        ]);
        state.page = 0;
        state.version += 1;
        break;

      case 'jump_workspace':
        state.currentDir = resolveFirstExistingDirectory([state.workspaceRoot, state.startDir, state.homeDir, process.cwd()]);
        state.page = 0;
        state.version += 1;
        break;

      case 'jump_home':
        state.currentDir = resolveFirstExistingDirectory([state.homeDir, state.startDir, state.workspaceRoot, process.cwd()]);
        state.page = 0;
        state.version += 1;
        break;

      case 'favorite_add':
        addFavoriteWorkspace(provider, state.currentDir);
        state.version += 1;
        break;

      case 'favorite_remove':
        removeFavoriteWorkspace(provider, state.currentDir);
        state.version += 1;
        break;

      case 'apply': {
        const binding = getWorkspaceBinding(session, key) || {};
        const defaultBinding = resolveProviderDefaultWorkspace(provider) || {};
        const currentDir = resolveAnchorDirectory(state);
        const unchanged = state.mode === 'default'
          ? String(defaultBinding.workspaceDir || '') === String(currentDir)
          : String(binding.workspaceDir || '') === String(currentDir);

        browsers.delete(state.token);
        if (unchanged) {
          await interaction.update({
            content: formatNoChangeReport({
              mode: state.mode,
              language,
              currentDir,
            }),
            components: [],
          });
          return true;
        }

        if (state.mode === 'default') {
          const result = commandActions.setDefaultWorkspaceDir(session, currentDir);
          await interaction.update({
            content: formatDefaultWorkspaceUpdateReport(key, session, result),
            components: [],
          });
          return true;
        }

        const result = commandActions.setWorkspaceDir(session, key, currentDir);
        await interaction.update({
          content: formatWorkspaceUpdateReport(key, session, result),
          components: [],
        });
        return true;
      }

      default:
        await interaction.reply({ content: formatBrowserExpired(language), flags: 64 });
        return true;
    }

    await interaction.update(buildBrowserPayload(state, session, key));
    return true;
  }

  return {
    openWorkspaceBrowser,
    handleWorkspaceBrowserInteraction,
    isWorkspaceBrowserComponentId,
  };
}
