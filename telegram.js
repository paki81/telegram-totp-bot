'use strict';

/**
 * Client minimale per la Telegram Bot API (fetch nativo, zero dipendenze).
 */
class Telegram {
  constructor(token) {
    this.token = token;
    this.api = `https://api.telegram.org/bot${token}`;
  }

  async call(method, params = {}) {
    const res = await fetch(`${this.api}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    const body = await res.json().catch(() => ({}));
    if (!body.ok) {
      const err = new Error(`Telegram ${method}: ${body.description || res.status}`);
      err.code = body.error_code;
      throw err;
    }
    return body.result;
  }

  getMe() {
    return this.call('getMe');
  }

  getWebhookInfo() {
    return this.call('getWebhookInfo');
  }

  getUpdates(offset, timeout = 30) {
    return this.call('getUpdates', {
      offset,
      timeout,
      allowed_updates: ['message', 'callback_query'],
    });
  }

  /** Invia un file (Buffer/stringa) come documento, multipart nativo */
  async sendDocument(chatId, filename, content, extra = {}) {
    const fd = new FormData();
    fd.append('chat_id', String(chatId));
    for (const [k, v] of Object.entries(extra)) {
      fd.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
    fd.append('document', new Blob([content]), filename);
    const res = await fetch(`${this.api}/sendDocument`, { method: 'POST', body: fd });
    const body = await res.json().catch(() => ({}));
    if (!body.ok) throw new Error(`Telegram sendDocument: ${body.description || res.status}`);
    return body.result;
  }

  getFile(fileId) {
    return this.call('getFile', { file_id: fileId });
  }

  /**
   * Scarica un file (foto/documento) dai server Telegram.
   * @returns {Promise<Buffer>}
   */
  async downloadFile(fileId) {
    const f = await this.getFile(fileId);
    if (!f.file_path) throw new Error('file_path mancante');
    const res = await fetch(`https://api.telegram.org/file/bot${this.token}/${f.file_path}`);
    if (!res.ok) throw new Error(`download file: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  setWebhook(url) {
    return this.call('setWebhook', { url, allowed_updates: ['message', 'callback_query'] });
  }

  /** Registra i comandi visibili nel menu "/" della chat */
  setMyCommands(commands) {
    return this.call('setMyCommands', { commands });
  }

  sendMessage(chatId, text, extra = {}) {
    return this.call('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra });
  }

  editMessageText(chatId, messageId, text, extra = {}) {
    return this.call('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      ...extra,
    });
  }

  answerCallbackQuery(id, extra = {}) {
    return this.call('answerCallbackQuery', { callback_query_id: id, ...extra });
  }

  deleteMessage(chatId, messageId) {
    return this.call('deleteMessage', { chat_id: chatId, message_id: messageId });
  }
}

module.exports = { Telegram };
