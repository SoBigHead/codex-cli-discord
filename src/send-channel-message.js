import fs from 'node:fs/promises';

const PROVIDER_CHOICES = new Set(['shared', 'codex', 'claude', 'antigravity', 'gemini', 'google', 'agy']);
const CHANNEL_ID_RE = /^\d{15,25}$/;
const DISCORD_MESSAGE_LIMIT = 2000;

export function buildSendChannelMessageUsage() {
  return [
    'Usage:',
    '  node scripts/send-channel-message.mjs --channel <channel-id> [--content "text" | --content-file <path> | --stdin] [--provider shared|codex|claude|antigravity] [--json]',
    '',
    'Examples:',
    '  node scripts/send-channel-message.mjs --channel 123456789012345678 --content "Deploy finished."',
    '  printf \'Build green\\n\' | node scripts/send-channel-message.mjs --channel 123456789012345678 --stdin',
    '  node scripts/send-channel-message.mjs --channel 123456789012345678 --content-file ./notice.md --provider codex',
  ].join('\n');
}

export function parseSendChannelMessageArgs(argv = []) {
  const args = [...argv];
  const options = {
    channelId: '',
    content: null,
    contentFile: '',
    stdin: false,
    json: false,
    provider: '',
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const token = String(args[index] || '').trim();
    if (!token) continue;

    if (token === '--help' || token === '-h') {
      options.help = true;
      continue;
    }
    if (token === '--json') {
      options.json = true;
      continue;
    }
    if (token === '--stdin') {
      options.stdin = true;
      continue;
    }
    if (token === '--channel' || token === '-c') {
      options.channelId = requireValue(args, ++index, token);
      continue;
    }
    if (token === '--content' || token === '-m') {
      options.content = requireValue(args, ++index, token);
      continue;
    }
    if (token === '--content-file' || token === '--file') {
      options.contentFile = requireValue(args, ++index, token);
      continue;
    }
    if (token === '--provider' || token === '-p') {
      const provider = requireValue(args, ++index, token).toLowerCase();
      if (!PROVIDER_CHOICES.has(provider)) {
        throw new Error(`Unsupported provider: ${provider}`);
      }
      options.provider = provider;
      continue;
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  if (options.help) return options;
  if (!CHANNEL_ID_RE.test(options.channelId)) {
    throw new Error('Missing or invalid --channel <channel-id>');
  }

  const explicitSourceCount = [options.content !== null, Boolean(options.contentFile), options.stdin]
    .filter(Boolean)
    .length;
  if (explicitSourceCount > 1) {
    throw new Error('Choose only one content source: --content, --content-file, or --stdin');
  }

  return options;
}

export async function resolveSendChannelMessageContent(
  options,
  {
    stdin = process.stdin,
    readFile = (filePath) => fs.readFile(filePath, 'utf8'),
    readStdin = () => readStdinText(stdin),
  } = {},
) {
  if (options.content !== null) {
    return normalizeMessageContent(options.content);
  }
  if (options.contentFile) {
    return normalizeMessageContent(await readFile(options.contentFile));
  }

  const shouldReadStdin = options.stdin || stdin?.isTTY === false;
  if (shouldReadStdin) {
    return normalizeMessageContent(await readStdin());
  }

  throw new Error('Missing message content. Use --content, --content-file, or pipe text via --stdin');
}

export function normalizeMessageContent(value) {
  const text = String(value ?? '');
  if (!text.trim()) {
    throw new Error('Message content is empty');
  }
  if (text.length > DISCORD_MESSAGE_LIMIT) {
    throw new Error(`Message content exceeds Discord limit (${DISCORD_MESSAGE_LIMIT} chars)`);
  }
  return text;
}

async function readStdinText(stdin) {
  if (!stdin) return '';

  let content = '';
  stdin.setEncoding?.('utf8');
  for await (const chunk of stdin) {
    content += chunk;
  }
  return content;
}

function requireValue(args, index, flag) {
  const value = String(args[index] || '');
  if (!value) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}
