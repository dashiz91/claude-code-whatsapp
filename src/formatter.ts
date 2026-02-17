/**
 * Markdown-to-WhatsApp formatting and message chunking.
 *
 * WhatsApp uses its own lightweight markup:
 *   *bold*  _italic_  ~strikethrough~  ```monospace```
 *
 * Claude outputs standard Markdown, so we convert the most common patterns.
 */

const WHATSAPP_MAX_LENGTH = 4000; // leave a small buffer below the ~4096 hard limit

/**
 * Convert standard Markdown formatting to WhatsApp-compatible formatting.
 */
export function markdownToWhatsApp(text: string): string {
  let out = text;

  // Headers → *bold* (WhatsApp has no heading syntax)
  out = out.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');

  // Bold: **text** or __text__ → *text*
  out = out.replace(/\*\*(.+?)\*\*/g, '*$1*');
  out = out.replace(/__(.+?)__/g, '*$1*');

  // Italic: _text_ is already WhatsApp italic, leave it
  // But single *text* that is NOT bold needs to become _text_ for italic
  // This is tricky — skip for now since Claude mostly uses ** for bold

  // Strikethrough: ~~text~~ → ~text~
  out = out.replace(/~~(.+?)~~/g, '~$1~');

  // Inline code: `text` → ```text```
  // But don't touch already-triple-backtick blocks
  out = out.replace(/(?<!`)(`(?!`))(.+?)(`(?!`))/g, '```$2```');

  // Code blocks: ```lang\ncode\n``` → ```code``` (strip language identifier)
  out = out.replace(/```\w*\n/g, '```\n');

  // Bullet points: - item → - item (already fine for WhatsApp, keep as-is)

  // Links: [text](url) → text (url)
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');

  return out.trim();
}

/**
 * Split a long message into chunks that fit within WhatsApp's character limit.
 * Tries to split at paragraph boundaries, then sentence boundaries, then hard-cut.
 */
export function chunkMessage(text: string): string[] {
  if (text.length <= WHATSAPP_MAX_LENGTH) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= WHATSAPP_MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }

    // Try to find a paragraph break (double newline) within the limit
    let splitAt = remaining.lastIndexOf('\n\n', WHATSAPP_MAX_LENGTH);

    // Fall back to single newline
    if (splitAt < WHATSAPP_MAX_LENGTH * 0.3) {
      splitAt = remaining.lastIndexOf('\n', WHATSAPP_MAX_LENGTH);
    }

    // Fall back to sentence boundary (. followed by space or end)
    if (splitAt < WHATSAPP_MAX_LENGTH * 0.3) {
      splitAt = remaining.lastIndexOf('. ', WHATSAPP_MAX_LENGTH);
      if (splitAt > 0) splitAt += 1; // include the period
    }

    // Hard cut as last resort
    if (splitAt < WHATSAPP_MAX_LENGTH * 0.3) {
      splitAt = WHATSAPP_MAX_LENGTH;
    }

    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  return chunks;
}
