import { marked, Renderer } from "marked";
import { ChatTurn } from "./parser";

export type ThinkingMode = "hidden" | "collapsed" | "shown";
export type ExportTheme = "system" | "light" | "dark";
export type ExportLayout = "readable";

export interface ExportRenderOptions {
  title: string;
  generatedAt: string;
  version: string;
  summary?: string;
  thinkingMode: ThinkingMode;
  includeMetadata: boolean;
  includeCodeBlocks: boolean;
  includeLinks: boolean;
  theme: ExportTheme;
  layout: ExportLayout;
}

interface AssistantEvent {
  summary: string;
  details: string[];
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
  if (trimmed) {
    return trimmed;
  }

  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
}

function createMarkedRenderer(options: ExportRenderOptions): Renderer {
  const renderer = new Renderer();

  renderer.link = function (href: string | null, title: string | null | undefined, text: string): string {
    const safeHref = href ?? "";
    const displayText = escapeHtml(getLinkDisplayText(text, safeHref));
    if (!options.includeLinks) {
      return displayText;
    }

    const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
    return `<a href="${escapeHtml(safeHref)}"${titleAttr} target="_blank" rel="noopener noreferrer">${displayText}</a>`;
  };

  renderer.code = function (code: string, language: string | undefined): string {
    if (!options.includeCodeBlocks || !code.trim()) {
      return "";
    }

    const languageClass = language ? ` class="language-${escapeHtml(language)}"` : "";
    return `<pre><code${languageClass}>${escapeHtml(code)}</code></pre>\n`;
  };

  return renderer;
}

function renderInlineMarkdown(input: string, options: ExportRenderOptions): string {
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
    const displayText = escapeHtml(getLinkDisplayText(text, href));
    const segment = options.includeLinks
      ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${displayText}</a>`
      : displayText;
    const id = linkSegments.push(segment) - 1;
    return `${linkToken}${id}${linkToken}`;
  });

  html = html.replace(/(^|\s)((?:https?:\/\/|file:\/\/\/?)\S+)/g, (_match, prefix: string, href: string) => {
    if (!options.includeLinks) {
      return `${prefix}${escapeHtml(href)}`;
    }

    const safeHref = escapeHtml(href);
    return `${prefix}<a href="${safeHref}" target="_blank" rel="noopener noreferrer">${safeHref}</a>`;
  });

  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  html = html.replace(/(^|\W)_([^_]+)_($|\W)/g, "$1<em>$2</em>$3");

  html = html.replace(new RegExp(`${linkToken}(\\d+)${linkToken}`, "g"), (_match, id) => linkSegments[Number(id)]);
  html = html.replace(new RegExp(`${codeToken}(\\d+)${codeToken}`, "g"), (_match, id) => codeSegments[Number(id)]);

  return html;
}

function renderMarkdown(content: string, options: ExportRenderOptions): string {
  return marked.parse(content, {
    gfm: true,
    breaks: false,
    renderer: createMarkedRenderer(options),
  }) as string;
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
        summary: `${getPrefixDisplay(normalized)}... (${details.length})`,
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

function renderCollapsedEvents(events: AssistantEvent[], options: ExportRenderOptions): string {
  return events
    .map((event) => {
      const details = event.details.length
        ? `<ul>${event.details.map((detail) => `<li>${renderInlineMarkdown(detail, options)}</li>`).join("")}</ul>`
        : "";

      return `<details class="event"><summary>${renderInlineMarkdown(event.summary, options)}</summary>${details}</details>`;
    })
    .join("");
}

function renderShownEvents(events: AssistantEvent[], options: ExportRenderOptions): string {
  const lines = events.flatMap((event) => (event.details.length > 0 ? event.details : [event.summary]));
  if (lines.length === 0) {
    return "";
  }

  return `<section class="events-inline">${lines
    .map((line) => `<div class="event-line">${renderInlineMarkdown(line, options)}</div>`)
    .join("")}</section>`;
}

function renderTurn(turn: ChatTurn, options: ExportRenderOptions): string {
  if (turn.role === "assistant") {
    const { events, narrative } = extractAssistantEvents(turn.content);
    const eventHtml = options.thinkingMode === "hidden"
      ? ""
      : options.thinkingMode === "shown"
        ? renderShownEvents(events, options)
        : `<section class="events">${renderCollapsedEvents(events, options)}</section>`;
    const narrativeHtml = narrative ? `<section class="message">${renderMarkdown(narrative, options)}</section>` : "";

    if (!eventHtml && !narrativeHtml) {
      return "";
    }

    return `
    <article class="turn assistant">
      <section class="assistant-wrap">
        ${eventHtml}
        ${narrativeHtml}
      </section>
    </article>
  `;
  }

  return `
    <article class="turn ${turn.role}">
      <section class="message">${renderMarkdown(turn.content, options)}</section>
    </article>
  `;
}

function renderMetadata(options: ExportRenderOptions, title: string, generated: string): string {
  if (!options.includeMetadata) {
    return "";
  }

  return `
    <header class="top">
      <h1>${title}</h1>
      <div class="meta">v${escapeHtml(options.version)} &middot; Generated ${generated}</div>
    </header>
  `;
}

export function renderTranscriptHtml(turns: ChatTurn[], options: ExportRenderOptions): string {
  const generated = escapeHtml(options.generatedAt);
  const title = escapeHtml(options.title);
  const summaryHtml = options.summary?.trim()
    ? `<section class="summary"><h2>Summary</h2>${renderMarkdown(options.summary.trim(), options)}</section>`
    : "";
  const turnHtml = turns
    .map((turn) => renderTurn(turn, options))
    .filter(Boolean)
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en" data-theme="${escapeHtml(options.theme)}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <style>
    :root {
      --light-bg: #eef3f9;
      --light-panel: rgba(255, 255, 255, 0.92);
      --light-panel-2: #e8eef7;
      --light-text: #111827;
      --light-muted: #64748b;
      --light-border: rgba(148, 163, 184, 0.34);
      --light-user-border: rgba(59, 130, 246, 0.34);
      --light-user-bg: linear-gradient(135deg, rgba(219, 234, 254, 0.96), rgba(239, 246, 255, 0.92));
      --light-code-bg: #f8fafc;
      --light-shadow: 0 10px 28px rgba(15, 23, 42, 0.08);
      --light-event-bg: rgba(255, 255, 255, 0.82);
      --light-top-bg: rgba(255, 255, 255, 0.8);
      --light-summary-border: rgba(59, 130, 246, 0.34);
      --dark-bg: #0d1117;
      --dark-panel: #161b22;
      --dark-panel-2: #1f2937;
      --dark-text: #e5e7eb;
      --dark-muted: #9ca3af;
      --dark-border: #30363d;
      --dark-user-border: rgba(59, 130, 246, 0.45);
      --dark-user-bg: linear-gradient(135deg, rgba(29, 78, 216, 0.42), rgba(29, 78, 216, 0.26));
      --dark-code-bg: #0b1220;
      --dark-shadow: 0 6px 20px rgba(0, 0, 0, 0.22);
      --dark-event-bg: rgba(22, 27, 34, 0.85);
      --dark-top-bg: rgba(22, 27, 34, 0.9);
      --dark-summary-border: rgba(59, 130, 246, 0.45);
      --link: #2563eb;
      --link-visited: #1d4ed8;
    }

    :root[data-theme="light"] {
      color-scheme: light;
      --bg: var(--light-bg);
      --panel: var(--light-panel);
      --panel-2: var(--light-panel-2);
      --text: var(--light-text);
      --muted: var(--light-muted);
      --border: var(--light-border);
      --user-border: var(--light-user-border);
      --user-bg: var(--light-user-bg);
      --code-bg: var(--light-code-bg);
      --shadow: var(--light-shadow);
      --event-bg: var(--light-event-bg);
      --top-bg: var(--light-top-bg);
      --summary-border: var(--light-summary-border);
    }

    :root[data-theme="dark"] {
      color-scheme: dark;
      --bg: var(--dark-bg);
      --panel: var(--dark-panel);
      --panel-2: var(--dark-panel-2);
      --text: var(--dark-text);
      --muted: var(--dark-muted);
      --border: var(--dark-border);
      --user-border: var(--dark-user-border);
      --user-bg: var(--dark-user-bg);
      --code-bg: var(--dark-code-bg);
      --link: #93c5fd;
      --link-visited: #bfdbfe;
      --shadow: var(--dark-shadow);
      --event-bg: var(--dark-event-bg);
      --top-bg: var(--dark-top-bg);
      --summary-border: var(--dark-summary-border);
    }

    :root[data-theme="system"] {
      color-scheme: light dark;
      --bg: var(--light-bg);
      --panel: var(--light-panel);
      --panel-2: var(--light-panel-2);
      --text: var(--light-text);
      --muted: var(--light-muted);
      --border: var(--light-border);
      --user-border: var(--light-user-border);
      --user-bg: var(--light-user-bg);
      --code-bg: var(--light-code-bg);
      --shadow: var(--light-shadow);
      --event-bg: var(--light-event-bg);
      --top-bg: var(--light-top-bg);
      --summary-border: var(--light-summary-border);
    }

    @media (prefers-color-scheme: dark) {
      :root[data-theme="system"] {
        --bg: var(--dark-bg);
        --panel: var(--dark-panel);
        --panel-2: var(--dark-panel-2);
        --text: var(--dark-text);
        --muted: var(--dark-muted);
        --border: var(--dark-border);
        --user-border: var(--dark-user-border);
        --user-bg: var(--dark-user-bg);
        --code-bg: var(--dark-code-bg);
        --link: #93c5fd;
        --link-visited: #bfdbfe;
        --shadow: var(--dark-shadow);
        --event-bg: var(--dark-event-bg);
        --top-bg: var(--dark-top-bg);
        --summary-border: var(--dark-summary-border);
      }
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      background-image:
        radial-gradient(circle at top, rgba(59, 130, 246, 0.08), transparent 28%),
        linear-gradient(180deg, rgba(255, 255, 255, 0.02), transparent 220px);
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
      background: var(--top-bg);
      border: 1px solid var(--border);
      border-radius: 10px;
      position: sticky;
      top: 10px;
      backdrop-filter: blur(5px);
      box-shadow: var(--shadow);
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
      border-left: 4px solid var(--summary-border);
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
      box-shadow: var(--shadow);
    }

    .turn.user .message {
      width: fit-content;
      max-width: min(820px, 84%);
      margin-left: auto;
      border: 1px solid var(--user-border);
      border-radius: 12px;
      background: var(--user-bg);
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

    .events-inline {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 10px 12px;
      border: 1px solid var(--border);
      border-radius: 10px;
      background: var(--event-bg);
    }

    .event-line {
      color: var(--muted);
      font-size: 13px;
      word-break: break-word;
    }

    .event-line::before {
      content: "Activity";
      display: inline-block;
      margin-right: 8px;
      padding: 1px 6px;
      border-radius: 999px;
      background: var(--panel-2);
      color: var(--text);
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }

    .event {
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--event-bg);
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

    .message h1 {
      font-size: 20px;
    }

    .message h2 {
      font-size: 18px;
    }

    .message h3 {
      font-size: 16px;
    }

    .message h4,
    .message h5,
    .message h6 {
      font-size: 14px;
    }

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
      background: color-mix(in srgb, var(--code-bg) 68%, transparent);
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
      background: color-mix(in srgb, var(--panel-2) 82%, transparent);
    }

    .message a {
      color: var(--link);
      text-decoration: underline;
    }

    .message a:visited {
      color: var(--link-visited);
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
    ${renderMetadata(options, title, generated)}
    ${summaryHtml}
    <main class="thread">
      ${turnHtml}
    </main>
  </div>
</body>
</html>`;
}
