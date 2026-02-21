import * as vscode from "vscode";
import { ChatTurn } from "./parser";

export interface ChatInsights {
  title: string;
  summary: string;
}

const MAX_TRANSCRIPT_CHARS = 12000;
const MAX_TITLE_WORDS = 5;

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function toModelTranscript(turns: ChatTurn[]): string {
  const combined = turns
    .map((turn) => `${turn.role.toUpperCase()}:\n${turn.content}`)
    .join("\n\n");

  if (combined.length <= MAX_TRANSCRIPT_CHARS) {
    return combined;
  }

  return `${combined.slice(0, MAX_TRANSCRIPT_CHARS)}\n\n[Transcript truncated for length]`;
}

function cleanTitle(rawTitle: string): string | undefined {
  const normalized = compactWhitespace(rawTitle.replace(/^['"“”‘’]+|['"“”‘’]+$/g, ""));
  if (!normalized) {
    return undefined;
  }

  const words = normalized.split(" ").filter(Boolean).slice(0, MAX_TITLE_WORDS);
  const title = words.join(" ").trim();
  return title || undefined;
}

function parseInsights(rawResponse: string): ChatInsights | undefined {
  const raw = rawResponse.trim();
  if (!raw) {
    return undefined;
  }

  const titleMatch = raw.match(/^Title:\s*(.+)$/im);
  const summaryMatch = raw.match(/^Summary:\s*([\s\S]+)$/im);
  if (!titleMatch || !summaryMatch) {
    return undefined;
  }

  const title = cleanTitle(titleMatch[1] ?? "");
  const summary = summaryMatch[1]?.trim();
  if (!title || !summary) {
    return undefined;
  }

  return { title, summary };
}

async function selectModel(): Promise<vscode.LanguageModelChat | undefined> {
  const selectors: vscode.LanguageModelChatSelector[] = [
    { vendor: "copilot", family: "gpt-4o" },
    { vendor: "copilot" },
    { family: "gpt-4o" },
    {},
  ];

  for (const selector of selectors) {
    const models = await vscode.lm.selectChatModels(selector);
    if (models.length > 0) {
      return models[0];
    }
  }

  return undefined;
}

export async function generateInsights(turns: ChatTurn[]): Promise<ChatInsights | undefined> {
  try {
    const model = await selectModel();
    if (!model) {
      return undefined;
    }

    const prompt = [
      "Summarize this conversation transcript.",
      "Return exactly two lines and no markdown:",
      "Title: <descriptive title with 5 words or fewer>",
      "Summary: <2-4 complete sentences focused on key topic and outcome>",
      "If the transcript is incomplete, summarize only what is present.",
      "",
      "Transcript:",
      toModelTranscript(turns),
    ].join("\n");

    const response = await model.sendRequest(
      [vscode.LanguageModelChatMessage.User(prompt)],
      { justification: "Generate a short title and summary for exported Copilot chat transcript." }
    );

    let raw = "";
    for await (const fragment of response.text) {
      raw += fragment;
    }

    return parseInsights(raw);
  } catch {
    return undefined;
  }
}
