import { ChatRole, ChatTurn } from "./types";

const rolePatterns: Array<{ regex: RegExp; role: ChatRole; label: string }> = [
  { regex: /^\s*(?:>\s*)?you\s*[:\-]\s*(.*)$/i, role: "user", label: "User" },
  { regex: /^#{1,6}\s*user\s*[:\-]?\s*(.*)$/i, role: "user", label: "User" },
  { regex: /^\s*(?:>\s*)?(?:github\s+)?copilot\s*[:\-]\s*(.*)$/i, role: "assistant", label: "Copilot" },
  { regex: /^#{1,6}\s*(assistant|copilot)\s*[:\-]?\s*(.*)$/i, role: "assistant", label: "Copilot" },
  { regex: /^#{1,6}\s*system\s*[:\-]?\s*(.*)$/i, role: "system", label: "System" },
  { regex: /^\s*(?:>\s*)?user\s*[:\-]\s*(.*)$/i, role: "user", label: "User" },
  { regex: /^user\s*[:\-]\s*(.*)$/i, role: "user", label: "User" },
  { regex: /^(assistant|copilot)\s*[:\-]\s*(.*)$/i, role: "assistant", label: "Copilot" },
  { regex: /^\s*(?:github\s+)?copilot\s*[:\-]\s*(.*)$/i, role: "assistant", label: "Copilot" },
  { regex: /^system\s*[:\-]\s*(.*)$/i, role: "system", label: "System" }
];

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function parseTranscript(transcript: string): ChatTurn[] {
  const normalized = normalizeLineEndings(transcript).trim();
  if (!normalized) {
    return [];
  }

  const lines = normalized.split("\n");
  const turns: ChatTurn[] = [];

  let activeRole: ChatRole = "unknown";
  let activeLabel = "Transcript";
  let buffer: string[] = [];

  const flush = (): void => {
    const content = buffer.join("\n").trim();
    if (!content) {
      buffer = [];
      return;
    }

    turns.push({
      role: activeRole,
      label: activeLabel,
      content
    });

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
        activeLabel = "User";
      }

      flush();
      activeRole = pattern.role;
      activeLabel = pattern.label;
      const firstLine = (match[2] ?? match[1] ?? "").trim();
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
    return [
      {
        role: "unknown",
        label: "Transcript",
        content: normalized
      }
    ];
  }

  return turns;
}
