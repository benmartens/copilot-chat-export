import { ChatTurn } from "./parser";
import { marked, Renderer } from "marked";

interface RenderOptions {
  title: string;
  generatedAt: string;
  version: string;
  summary?: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function token(): string {
  return `__TOKEN_${Math.random().toString(36).slice(2)}__`;
}

function getLinkDisplayText(text: string, href: string): string {
  const trimmed = text.trim();
  if (trimmed) { return trimmed; }
  try { return decodeURIComponent(href); } catch { return href; }
}

const markedRenderer = new Renderer();

// Open links in new tab, fall back to decoded URL when link text is empty
markedRenderer.link = function (href: string, title: string | null | undefined, text: string): string {
  const titleAttr = title ? ` title="${title}"` : "";
  const displayText = getLinkDisplayText(text, href);
  return `<a href="${href}"${titleAttr} target="_blank" rel="noopener noreferrer">${displayText}</a>`;
};

// Suppress empty code blocks (matches old renderer behavior)
markedRenderer.code = function (code: string, language: string | undefined): string {
  if (!code.trim()) { return ""; }
  const lang = language ? ` class="language-${escapeHtml(language)}"` : "";
  return `<pre><code${lang}>${escapeHtml(code)}</code></pre>\n`;
};

marked.setOptions({
  gfm: true,
  breaks: false,
  renderer: markedRenderer,
});

function renderInlineMarkdown(input: string): string {
  let html = escapeHtml(input);

  const codeToken = token();
  const linkToken = token();
  const codeSegments: string[] = [];
  const linkSegments: string[] = [];

  html = html.replace(/`([^`]+)`/g, (_match, code: string) => {
    const id = codeSegments.push(`<code>${code}</code>`) - 1;
    return `${codeToken}${id}${codeToken}`;
  });

  html = html.replace(/\[([^\]]*)\]\(((?:https?:\/\/|file:\/\/\/?)\S+?)\)/g, (_match, text: string, href: string) => {
    const displayText = getLinkDisplayText(text, href);
    const id = linkSegments.push(
      `<a href="${href}" target="_blank" rel="noopener noreferrer">${displayText}</a>`
    ) - 1;
    return `${linkToken}${id}${linkToken}`;
  });

  html = html.replace(/(^|\s)((?:https?:\/\/|file:\/\/\/?)\S+)/g, (_match, prefix: string, href: string) => {
    return `${prefix}<a href="${href}" target="_blank" rel="noopener noreferrer">${href}</a>`;
  });

  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  html = html.replace(/(^|\W)_([^_]+)_($|\W)/g, "$1<em>$2</em>$3");

  html = html.replace(new RegExp(`${linkToken}(\\d+)${linkToken}`, "g"), (_m, id) => linkSegments[Number(id)]);
  html = html.replace(new RegExp(`${codeToken}(\\d+)${codeToken}`, "g"), (_m, id) => codeSegments[Number(id)]);

  return html;
}

function renderMarkdown(content: string): string {
  return marked.parse(content) as string;
}

interface AssistantEvent {
  summary: string;
  details: string[];
}

function normalizeEventLine(line: string): string {
  return line.replace(/^[\s>*-]*(?:[✓✔☑✅]\s*)?/, "").trim();
}

const eventPattern = /^(?:planning|preparing|drafting|subagent\s*:|research\b|review\b|ask(?:ed|ing)\s+\d+\s+questions\b|fetched\s+https?:\/\/|read(?:ing)?\s+(?:file:\/\/|\[)|search(?:ed|ing)\s+for\b|starting:\s*\*.*?\*\s*\(\d+\/\d+\)|completed:\s*\*.*?\*\s*\(\d+\/\d+\)|generating\s+patch\b)/i;

const PREFIX_WORD_COUNT = 2;
const MIN_PREFIX_RUN = 3;

function getPrefixWords(value: string, count: number): string[] {
  const words = value.match(/[A-Za-z0-9]+(?:["'_-][A-Za-z0-9]+)*/g) ?? [];
  return words.slice(0, count);
}

function getPrefixKey(value: string): string | null {
  const prefixWords = getPrefixWords(value, PREFIX_WORD_COUNT);
  if (prefixWords.length < PREFIX_WORD_COUNT) {
    return null;
  }

  return prefixWords.map((word) => word.toLowerCase()).join(" ");
}

function getPrefixDisplay(value: string): string {
  return getPrefixWords(value, PREFIX_WORD_COUNT).join(" ");
}

function extractAssistantEvents(content: string): { events: AssistantEvent[]; narrative: string } {
  const lines = content.split("\n");
  const narrativeLines: string[] = [];
  const eventLines: string[] = [];
  const events: AssistantEvent[] = [];

  for (const line of lines) {
    const normalized = normalizeEventLine(line.trim());
    if (eventPattern.test(normalized)) {
      eventLines.push(normalized);
    } else {
      narrativeLines.push(line);
    }
  }

  let index = 0;
  while (index < eventLines.length) {
    const normalized = eventLines[index];
    const currentPrefixKey = getPrefixKey(normalized);

    if (!currentPrefixKey) {
      events.push({ summary: normalized, details: [] });
      index += 1;
      continue;
    }

    const details: string[] = [normalized];
    let runEnd = index + 1;
    while (runEnd < eventLines.length) {
      const nextNormalized = eventLines[runEnd];
      const nextPrefixKey = getPrefixKey(nextNormalized);
      if (!nextPrefixKey || nextPrefixKey !== currentPrefixKey) {
        break;
      }

      details.push(nextNormalized);
      runEnd += 1;
    }

    if (details.length >= MIN_PREFIX_RUN) {
      events.push({
        summary: `${getPrefixDisplay(normalized)}… (${details.length})`,
        details,
      });
      index = runEnd;
      continue;
    }

    events.push({ summary: normalized, details: [] });
    index += 1;
  }

  return { events, narrative: narrativeLines.join("\n").trim() };
}

function renderTurn(turn: ChatTurn): string {
  if (turn.role === "assistant") {
    const { events, narrative } = extractAssistantEvents(turn.content);
    const eventHtml = events
      .map((event) => {
        const details = event.details.length
          ? `<ul>${event.details
              .map((detail) => `<li>${renderInlineMarkdown(detail)}</li>`)
              .join("")}</ul>`
          : "";

        return `<details class="event"><summary>${renderInlineMarkdown(event.summary)}</summary>${details}</details>`;
      })
      .join("");

    const narrativeHtml = narrative ? `<section class="message">${renderMarkdown(narrative)}</section>` : "";

    return `
    <article class="turn assistant">
      <section class="assistant-wrap">
        ${eventHtml ? `<section class="events">${eventHtml}</section>` : ""}
        ${narrativeHtml}
      </section>
    </article>
  `;
  }

  return `
    <article class="turn ${turn.role}">
      <section class="message">${renderMarkdown(turn.content)}</section>
    </article>
  `;
}

export function renderTranscriptHtml(turns: ChatTurn[], options: RenderOptions): string {
  const generated = escapeHtml(options.generatedAt);
  const title = escapeHtml(options.title);
  const summaryHtml = options.summary?.trim()
    ? `<section class="summary"><h2>Summary</h2>${renderMarkdown(options.summary.trim())}</section>`
    : "";
  const turnHtml = turns.map((turn) => renderTurn(turn)).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0d1117;
      --panel: #161b22;
      --panel-2: #1f2937;
      --text: #e5e7eb;
      --muted: #9ca3af;
      --border: #30363d;
      --user-border: rgba(59, 130, 246, 0.45);
      --user-bg-1: rgba(29, 78, 216, 0.42);
      --user-bg-2: rgba(29, 78, 216, 0.26);
      --code-bg: #0b1220;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: "Segoe UI", Inter, system-ui, -apple-system, sans-serif;
      line-height: 1.45;
    }

    .wrap {
      max-width: 1024px;
      margin: 0 auto;
      padding: 20px;
    }

    .top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      margin-bottom: 14px;
      padding: 12px 14px;
      background: rgba(22, 27, 34, 0.9);
      border: 1px solid var(--border);
      border-radius: 10px;
      position: sticky;
      top: 10px;
      backdrop-filter: blur(5px);
    }

    .top h1 {
      margin: 0;
      font-size: 16px;
      font-weight: 600;
    }

    .meta {
      color: var(--muted);
      font-size: 12px;
      white-space: nowrap;
    }

    .thread {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .summary {
      margin: 0 0 12px;
      padding: 10px 12px;
      border: 1px solid var(--border);
      border-left: 4px solid var(--user-border);
      border-radius: 10px;
      background: var(--panel-2);
    }

    .summary h2 {
      margin: 0 0 8px;
      font-size: 13px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }

    .summary p:last-child {
      margin-bottom: 0;
    }

    .turn {
      display: flex;
      width: 100%;
    }

    .turn.user {
      justify-content: flex-end;
    }

    .message {
      width: 100%;
      padding: 10px 12px;
      border: 1px solid var(--border);
      border-radius: 10px;
      background: var(--panel);
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.22);
    }

    .turn.user .message {
      width: fit-content;
      max-width: min(820px, 84%);
      margin-left: auto;
      border: 1px solid var(--user-border);
      border-radius: 12px;
      background: var(--user-bg-1);
    }

    .assistant-wrap {
      width: 100%;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .events {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .event {
      border: 1px solid var(--border);
      border-radius: 8px;
      background: rgba(22, 27, 34, 0.85);
      padding: 0;
      overflow: hidden;
    }

    .event summary {
      list-style: none;
      cursor: pointer;
      padding: 8px 10px;
      color: var(--muted);
      font-size: 12px;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .event summary::before {
      content: "✓";
      color: #22c55e;
      font-weight: 700;
    }

    .event summary::-webkit-details-marker {
      display: none;
    }

    .event ul {
      margin: 0;
      padding: 0 16px 10px 34px;
      color: var(--muted);
      font-size: 12px;
    }

    .event li {
      margin: 2px 0;
      word-break: break-word;
    }

    .message p {
      margin: 0 0 10px;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .message p:last-child {
      margin-bottom: 0;
    }

    .message h1,
    .message h2,
    .message h3,
    .message h4,
    .message h5,
    .message h6 {
      margin: 0 0 8px;
      line-height: 1.25;
    }

    .message h1 { font-size: 20px; }
    .message h2 { font-size: 18px; }
    .message h3 { font-size: 16px; }
    .message h4,
    .message h5,
    .message h6 { font-size: 14px; }

    .message ul,
    .message ol {
      margin: 0 0 10px;
      padding-left: 20px;
    }

    .message li {
      margin: 2px 0;
    }

    .message blockquote {
      margin: 0 0 10px;
      padding: 8px 10px;
      border-left: 3px solid var(--border);
      background: rgba(11, 18, 32, 0.45);
      border-radius: 6px;
    }

    .message table {
      width: 100%;
      border-collapse: collapse;
      margin: 0 0 10px;
      font-size: 13px;
    }

    .message th,
    .message td {
      border: 1px solid var(--border);
      padding: 6px 10px;
      text-align: left;
    }

    .message th {
      background: var(--panel-2);
      font-weight: 600;
    }

    .message tr:nth-child(even) td {
      background: rgba(31, 41, 55, 0.35);
    }

    .message a {
      color: #93c5fd;
      text-decoration: underline;
    }

    pre {
      margin: 0 0 10px;
      padding: 10px;
      border: 1px solid var(--border);
      background: var(--code-bg);
      border-radius: 8px;
      overflow-x: auto;
    }

    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
      font-size: 12px;
    }

    @media (max-width: 760px) {
      .wrap {
        padding: 12px;
      }

      .top {
        flex-direction: column;
        align-items: flex-start;
      }

      .turn.user .message {
        max-width: 92%;
      }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <header class="top">
      <h1>${title}</h1>
      <div class="meta">v${escapeHtml(options.version)} &middot; Generated ${generated}</div>
    </header>
    ${summaryHtml}
    <main class="thread">
      ${turnHtml}
    </main>
  </div>
</body>
</html>`;
}
