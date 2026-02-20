export type ChatRole = "user" | "assistant" | "system" | "unknown";

export interface ChatTurn {
  role: ChatRole;
  label: string;
  content: string;
}
