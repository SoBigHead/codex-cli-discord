export function doesMessageTargetBot(message, botUserId) {
  const mentioned = Boolean(message.mentions?.users?.has?.(botUserId));
  const repliedToBot = message.mentions?.repliedUser?.id === botUserId;
  return mentioned || repliedToBot;
}

export function buildPromptFromMessage(rawContent, attachments) {
  const text = String(rawContent || '').trim();
  const attachmentBlock = formatAttachmentsForPrompt(attachments);

  if (!text && !attachmentBlock) return '';
  if (text && !attachmentBlock) return text;

  if (!text && attachmentBlock) {
    return [
      '用户发送了附件，请先查看附件再回复。',
      attachmentBlock,
    ].join('\n\n');
  }

  return [
    text,
    attachmentBlock,
  ].join('\n\n').trim();
}

export function formatAttachmentsForPrompt(attachments) {
  if (!attachments || !attachments.size) return '';

  const lines = [];
  let index = 0;
  for (const attachment of attachments.values()) {
    index += 1;
    if (index > 8) {
      lines.push(`...and ${attachments.size - 8} more attachment(s).`);
      break;
    }

    const name = attachment.name || 'unnamed-file';
    const type = attachment.contentType || 'unknown';
    const size = Number.isFinite(attachment.size) ? `${attachment.size}B` : 'unknown';
    const url = attachment.url || attachment.proxyURL || '(missing-url)';
    lines.push(`${index}. name=${name}; type=${type}; size=${size}; url=${url}`);
  }

  return [
    'Attachments:',
    ...lines,
  ].join('\n');
}
