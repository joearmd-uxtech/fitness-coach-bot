/**
 * Telegram Bot API wrapper.
 * Handles sending messages, downloading photos, and registering the webhook.
 */

const BOT_TOKEN = () => process.env.TELEGRAM_BOT_TOKEN
const API_BASE = () => `https://api.telegram.org/bot${BOT_TOKEN()}`
const FILE_BASE = () => `https://api.telegram.org/file/bot${BOT_TOKEN()}`

/**
 * Sends a text message (Markdown v2 parse mode).
 */
export async function sendMessage(chatId, text, options = {}) {
  const res = await fetch(`${API_BASE()}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
      ...options,
    }),
  })
  if (!res.ok) {
    const body = await res.text()
    console.error(`[telegram] sendMessage failed: ${res.status} ${body}`)
  }
  return res
}

/**
 * Sends a "typing..." action to indicate the bot is working.
 */
export async function sendTyping(chatId) {
  await fetch(`${API_BASE()}/sendChatAction`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, action: 'typing' }),
  })
}

/**
 * Downloads a Telegram file and returns it as a base64 string.
 * Used for /plan screenshot parsing.
 *
 * @param {string} fileId   Telegram file_id from the message
 * @returns {string}        Base64-encoded file contents
 */
export async function downloadFileAsBase64(fileId) {
  // Step 1: get the file path from Telegram
  const fileRes = await fetch(`${API_BASE()}/getFile?file_id=${fileId}`)
  if (!fileRes.ok) {
    throw new Error(`getFile failed: ${fileRes.status}`)
  }
  const { result } = await fileRes.json()
  const filePath = result.file_path

  // Step 2: download the actual file
  const dataRes = await fetch(`${FILE_BASE()}/${filePath}`)
  if (!dataRes.ok) {
    throw new Error(`File download failed: ${dataRes.status}`)
  }

  const buffer = await dataRes.arrayBuffer()
  return Buffer.from(buffer).toString('base64')
}

/**
 * Registers the Telegram webhook to point to this Vercel deployment.
 * Call once after deploying: GET /api/telegram-webhook?register=1
 */
export async function registerWebhook(webhookUrl) {
  const res = await fetch(`${API_BASE()}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: webhookUrl }),
  })
  return res.json()
}

/**
 * Extracts the command and args from a Telegram message text.
 * e.g. "/sleep 6.5 2.1" → { command: 'sleep', args: ['6.5', '2.1'] }
 */
export function parseCommand(text) {
  if (!text?.startsWith('/')) return null
  const parts = text.trim().split(/\s+/)
  const command = parts[0].slice(1).toLowerCase().split('@')[0] // strip bot username suffix
  const args = parts.slice(1)
  return { command, args }
}
