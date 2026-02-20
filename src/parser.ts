export type ChatRole = "user" | "assistant" | "system" | "unknown";

export interface ChatTurn {
  role: ChatRole;
  content: string;
}

const rolePatterns: Array<{ regex: RegExp; role: ChatRole }> = [
  { regex: /^\s*(?:>\s*)?you\s*[:\-]\s*(.*)$/i, role: "user" },
  { regex: /^#{1,6}\s*user\s*[:\-]?\s*(.*)$/i, role: "user" },
  { regex: /^\s*(?:>\s*)?(?:github\s+)?copilot\s*[:\-]\s*(.*)$/i, role: "assistant" },
  { regex: /^#{1,6}\s*(?:assistant|copilot)\s*[:\-]?\s*(.*)$/i, role: "assistant" },
  { regex: /^#{1,6}\s*system\s*[:\-]?\s*(.*)$/i, role: "system" },
  { regex: /^\s*(?:>\s*)?user\s*[:\-]\s*(.*)$/i, role: "user" },
  { regex: /^(?:assistant|copilot)\s*[:\-]\s*(.*)$/i, role: "assistant" },
  { regex: /^system\s*[:\-]\s*(.*)$/i, role: "system" },
];

export function parseTranscript(transcript: string): ChatTurn[] {
  const normalized = transcript.replace(/\r\n?/g, "\n").trim();
  if (!normalized) {
    return [];
  }

  const lines = normalized.split("\n");
  const turns: ChatTurn[] = [];
  let activeRole: ChatRole = "unknown";
  let buffer: string[] = [];

  const flush = (): void => {
    const content = buffer.join("\n").trim();
    if (content) {
      turns.push({ role: activeRole, content });
    }
    buffer = [];
  };

  for (const line of lines) {
    let matchedHeader = false;

    for (const pattern of rolePatterns) {
      const match = line.match(pattern.regex);
      if (!match) {
        continue;
      }

      if (pattern.role === "assistant" && activeRole === "unknown" && turns.length === 0 && buffer.join("\n").trim().length > 0) {
        activeRole = "user";
      }

      flush();
      activeRole = pattern.role;
      const firstLine = (match[1] ?? "").trim();
      buffer = firstLine ? [firstLine] : [];
      matchedHeader = true;
      break;
    }

    if (!matchedHeader) {
      buffer.push(line);
    }
  }

  flush();

  if (turns.length === 0) {
    return [{ role: "unknown", content: normalized }];
  }

  return turns;
}
