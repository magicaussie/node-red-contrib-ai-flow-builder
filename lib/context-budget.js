"use strict";

const MAX_HISTORY_MESSAGES = 8;
const MAX_MESSAGE_CHARS = 6000;
const MAX_TEXT_ATTACHMENT_CHARS = 20000;
const MAX_BINARY_ATTACHMENT_BYTES = 4 * 1024 * 1024;

function truncateText(value, maxChars = MAX_MESSAGE_CHARS) {
  const text = String(value || "");
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n[truncated]` : text;
}

function limitMessages(messages) {
  const recent = messages.slice(-MAX_HISTORY_MESSAGES);
  return recent.map(message => ({
    ...message,
    content: truncateText(message.content),
    attachments: (message.attachments || []).map(attachment => ({
      ...attachment,
      maxTextChars: MAX_TEXT_ATTACHMENT_CHARS
    }))
  }));
}

module.exports = {
  MAX_HISTORY_MESSAGES,
  MAX_MESSAGE_CHARS,
  MAX_TEXT_ATTACHMENT_CHARS,
  MAX_BINARY_ATTACHMENT_BYTES,
  truncateText,
  limitMessages
};