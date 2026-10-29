import { readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  CustomEditor,
  getAgentDir,
  getSelectListTheme,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from '@earendil-works/pi-coding-agent';
import {
  type Component,
  Container,
  decodeKittyPrintable,
  fuzzyFilter,
  matchesKey,
  renderFakeCursor,
  SelectList,
  stripTerminalSequences,
  type SelectListTheme,
  Text,
  truncateToWidth,
  type TUI,
  visibleWidth,
} from '@earendil-works/pi-tui';
import { Type } from 'typebox';
import {
  type HistoryScope,
  extractText,
  isSkillBlock,
  loadPromptHistory,
  type TimedPrompt,
} from './history.ts';

type Usage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

function sanitizeStatusText(text: string): string {
  return text
    .replace(/[\r\n\t]/g, ' ')
    .replace(/ +/g, ' ')
    .trim();
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 999500) return `${Math.round(count / 1000)}k`;
  return `${Math.round(count / 1000000)}m`;
}

function cacheHitRate(u: Usage): number | undefined {
  const prompt = u.input + u.cacheRead + u.cacheWrite;
  return prompt > 0 ? (u.cacheRead / prompt) * 100 : undefined;
}

function getUsage(ctx: ExtensionContext) {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const add = (u: Usage) => {
    totals.input += u.input;
    totals.output += u.output;
    totals.cacheRead += u.cacheRead;
    totals.cacheWrite += u.cacheWrite;
  };
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === 'usage') {
      add(entry.usage);
    } else if (entry.type === 'message' && entry.message.role === 'assistant') {
      add(entry.message.usage);
    } else if (
      entry.type === 'message' &&
      entry.message.role === 'toolResult' &&
      entry.message.usage
    ) {
      add(entry.message.usage);
    } else if ((entry.type === 'branch_summary' || entry.type === 'compaction') && entry.usage) {
      add(entry.usage);
    }
  }
  let latestCacheHitRate: number | undefined;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === 'message' && entry.message.role === 'assistant') {
      latestCacheHitRate = cacheHitRate(entry.message.usage);
    }
  }
  return { totals, latestCacheHitRate };
}

class HistoryEditor extends CustomEditor {
  private prompts: string[] = [];
  private submitting = false;
  onReverseSearch?: () => void;
  onPromptSent?: (text: string) => void;
  getSessionName?: () => string | undefined;
  dimColor?: (text: string) => string;
  onInput?: () => void;
  private suggestion = '';

  setSuggestion(text: string): void {
    this.suggestion = text;
    this.tui.requestRender();
  }

  clearSuggestion(): void {
    if (!this.suggestion) return;
    this.suggestion = '';
    this.tui.requestRender();
  }

  override setWorkingStatusIndicator(
    indicator: Parameters<CustomEditor['setWorkingStatusIndicator']>[0],
  ): void {
    const dim = (text: string) =>
      this.dimColor ? this.dimColor(stripTerminalSequences(text)) : text;
    if (!indicator) {
      const ready = {
        renderInBorder: () => dim('Ready'),
        renderSpinnerInBorder: () => '',
      } as unknown as NonNullable<typeof indicator>;
      return super.setWorkingStatusIndicator(ready);
    }
    const dimmed = Object.create(indicator) as typeof indicator;
    dimmed.renderInBorder = (width) => dim(indicator.renderInBorder(width));
    dimmed.renderSpinnerInBorder = (width) => dim(indicator.renderSpinnerInBorder(width));
    super.setWorkingStatusIndicator(dimmed);
  }

  override render(width: number): string[] {
    const assigned = this.borderColor;
    if (this.dimColor && !this.getText().trimStart().startsWith('!')) {
      this.borderColor = this.dimColor;
    }
    try {
      const lines = super.render(width);
      if (this.suggestion && !this.getText() && lines[1] !== undefined) {
        lines[1] = this.renderSuggestion(lines[1], width);
      }
      return lines;
    } finally {
      this.borderColor = assigned;
    }
  }

  private renderSuggestion(line: string, width: number): string {
    const cursor = line.indexOf(renderFakeCursor(' '));
    if (cursor < 0) return line;
    const start = line.slice(0, cursor);
    const room = width - visibleWidth(start);
    if (room < 1) return line;
    const ghost = truncateToWidth(this.suggestion, room, '\u2026');
    const [first = '', ...rest] = Array.from(ghost);
    const dim = this.dimColor ?? ((text: string) => text);
    const padding = ' '.repeat(room - visibleWidth(ghost));
    return start + renderFakeCursor(dim(first)) + dim(rest.join('')) + padding;
  }

  protected override renderTopBorder(width: number, hiddenLineCount: number): string {
    const border = super.renderTopBorder(width, hiddenLineCount);
    const name = sanitizeStatusText(this.getSessionName?.() ?? '');
    if (!name) return border;
    const plain = stripTerminalSequences(border);
    const freeWidth = plain.length - plain.replace(/\u2500+$/, '').length;
    const maxNameWidth = freeWidth - 5;
    if (maxNameWidth < 1) return border;
    const label = ` ${truncateToWidth(name, maxNameWidth, '\u2026')} \u2500\u2500`;
    return truncateToWidth(border, width - visibleWidth(label), '') + this.borderColor(label);
  }

  setHistory(prompts: string[]): void {
    this.prompts = [];
    for (const prompt of prompts) this.addToHistory(prompt);
  }

  getHistory(): string[] {
    return this.prompts;
  }

  override addToHistory(text: string): void {
    const trimmed = text.trim();
    if (isSkillBlock(trimmed)) return;
    if (trimmed) {
      if (!this.submitting && this.prompts.includes(trimmed)) return;
      if (this.submitting) this.onPromptSent?.(trimmed);
      this.prompts = [...this.prompts.filter((prompt) => prompt !== trimmed), trimmed];
      const base = this as unknown as { history: string[] };
      base.history = base.history.filter((prompt) => prompt !== trimmed);
    }
    super.addToHistory(text);
  }

  override handleInput(data: string): void {
    this.onInput?.();
    const suggestion = this.suggestion;
    this.clearSuggestion();
    if (suggestion && !this.getText() && matchesKey(data, 'tab')) {
      this.setText(suggestion);
      return;
    }
    if (matchesKey(data, 'ctrl+r')) {
      this.onReverseSearch?.();
      return;
    }
    this.submitting = true;
    try {
      super.handleInput(data);
    } finally {
      this.submitting = false;
    }
  }
}

class ReverseSearch implements Component {
  private query: string;
  private scope: HistoryScope = 'current';
  private readonly prompts: Record<HistoryScope, string[] | undefined>;
  private loadingAll = false;
  private list: SelectList;
  private readonly header = new Text('', 1, 0);
  private readonly loadAllPrompts: () => Promise<string[]>;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly listTheme: SelectListTheme;
  private readonly done: (value: string | null) => void;

  constructor(
    currentPrompts: string[],
    initialQuery: string,
    loadAllPrompts: () => Promise<string[]>,
    tui: TUI,
    theme: Theme,
    listTheme: SelectListTheme,
    done: (value: string | null) => void,
  ) {
    this.loadAllPrompts = loadAllPrompts;
    this.tui = tui;
    this.theme = theme;
    this.listTheme = listTheme;
    this.done = done;
    this.query = initialQuery.trim();
    this.prompts = { current: currentPrompts, all: undefined };
    this.list = this.buildList();
    this.refreshHeader();
  }

  private buildList(): SelectList {
    const ordered = [...(this.prompts[this.scope] ?? [])].reverse();
    const prompts = this.query ? fuzzyFilter(ordered, this.query, (p) => p) : ordered;
    const items = prompts.map((prompt) => ({
      value: prompt,
      label: prompt.replace(/\s+/g, ' ').trim(),
    }));
    const list = new SelectList(items, 10, this.listTheme);
    list.onSelect = (item) => this.done(item.value);
    list.onCancel = () => this.done(null);
    return list;
  }

  private refreshHeader(): void {
    const tabs = (['current', 'all'] as const)
      .map((scope) => {
        const label = scope === 'current' ? 'Current folder' : 'All folders';
        return this.scope === scope
          ? this.theme.fg('accent', `[${label}]`)
          : this.theme.fg('dim', label);
      })
      .join(this.theme.fg('dim', '  '));
    const label = this.theme.fg('accent', 'reverse-search');
    const query = this.query
      ? this.theme.fg('toolOutput', this.query)
      : this.theme.fg('dim', '(type to filter)');
    const loading =
      this.scope === 'all' && this.loadingAll ? this.theme.fg('dim', ' loading…') : '';
    const hint = this.theme.fg('dim', '  Tab scope · ↑↓ move · Enter load · Esc cancel');
    this.header.setText(`${tabs}\n${label}: ${query}${loading}${hint}`);
  }

  private refresh(): void {
    this.list = this.buildList();
    this.refreshHeader();
    this.tui.requestRender();
  }

  private switchScope(): void {
    this.scope = this.scope === 'current' ? 'all' : 'current';
    if (this.scope === 'all' && !this.prompts.all && !this.loadingAll) {
      this.loadingAll = true;
      void this.loadAllPrompts()
        .catch(() => [])
        .then((prompts) => {
          this.prompts.all = prompts;
          this.loadingAll = false;
          if (this.scope === 'all') this.refresh();
        });
    }
    this.refresh();
  }

  handleInput(data: string): void {
    if (data.startsWith('\x1b[200~')) {
      this.query += data.replace('\x1b[200~', '').replace('\x1b[201~', '').replace(/\s+/g, ' ');
      this.refresh();
    } else if (matchesKey(data, 'escape')) {
      this.done(null);
    } else if (matchesKey(data, 'return') || matchesKey(data, 'enter')) {
      this.done(this.list.getSelectedItem()?.value ?? null);
    } else if (
      matchesKey(data, 'tab') ||
      matchesKey(data, 'right') ||
      matchesKey(data, 'shift+tab') ||
      matchesKey(data, 'left')
    ) {
      this.switchScope();
    } else if (matchesKey(data, 'up') || matchesKey(data, 'down')) {
      this.list.handleInput(data);
      this.tui.requestRender();
    } else if (matchesKey(data, 'backspace')) {
      if (!this.query) return;
      this.query = Array.from(this.query).slice(0, -1).join('');
      this.refresh();
    } else {
      const typed = decodeKittyPrintable(data) ?? data;
      if (!typed || /\p{Cc}/u.test(typed)) return;
      this.query += typed;
      this.refresh();
    }
  }

  render(width: number): string[] {
    return [...this.header.render(width), ...this.list.render(width)];
  }

  invalidate(): void {
    this.header.invalidate();
    this.list.invalidate();
  }
}

async function openReverseSearch(
  ctx: ExtensionContext,
  editor: HistoryEditor,
  sessionPrompts: TimedPrompt[],
) {
  const listTheme = getSelectListTheme();
  const result = await ctx.ui.custom<string | null>(
    (tui, theme, _kb, done) =>
      new ReverseSearch(
        editor.getHistory(),
        ctx.ui.getEditorText(),
        () =>
          loadPromptHistory(
            ctx.sessionManager.getCwd(),
            ctx.sessionManager.getSessionDir(),
            'all',
            sessionPrompts,
          ),
        tui,
        theme,
        listTheme,
        done,
      ),
  );
  if (result) ctx.ui.setEditorText(result);
}

const settingsPath = () => join(getAgentDir(), 'pi-statusline.json');

type Settings = { predict?: boolean };

async function loadSettings(): Promise<Settings> {
  try {
    const settings: unknown = JSON.parse(await readFile(settingsPath(), 'utf8'));
    if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) return {};
    return settings as Settings;
  } catch {
    return {};
  }
}

async function saveSettings(change: { predict: boolean }) {
  const settings = { ...(await loadSettings()), ...change };
  await writeFile(settingsPath(), JSON.stringify(settings, null, 2) + '\n');
}

async function predictNextPrompt(ctx: ExtensionContext, signal: AbortSignal): Promise<string> {
  if (!ctx.model) return '';
  const prompts: string[] = [];
  let reply = '';
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== 'message') continue;
    const message = entry.message;
    if (message.role === 'user') {
      prompts.push(extractText(message.content).trim());
      reply = '';
    } else if (message.role === 'assistant') {
      reply = extractText(message.content).trim() || reply;
    }
  }
  const recent = prompts
    .slice(-5)
    .map((prompt) => `- ${prompt.slice(0, 500)}`)
    .join('\n');
  const response = await ctx.modelRegistry.complete(
    ctx.model,
    {
      systemPrompt:
        "Predict the next prompt the user will send to their coding agent. Reply with only that prompt, on one line, in the user's style. Reply with nothing if you cannot tell.",
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Recent user prompts:\n${recent}\n\nLast assistant reply:\n${reply.slice(-2000)}`,
            },
          ],
          timestamp: Date.now(),
        },
      ],
    },
    { signal },
  );
  if (response.stopReason === 'aborted' || response.stopReason === 'error') return '';
  return extractText(response.content).replace(/\s+/g, ' ').trim();
}

export default function (pi: ExtensionAPI) {
  const sessionPrompts: TimedPrompt[] = [];
  let toolRegistered = false;
  let predict = true;
  let prediction: AbortController | undefined;
  let activeEditor: HistoryEditor | undefined;

  pi.registerCommand('predict', {
    description: 'Turn next prompt prediction on or off',
    handler: async (_args, ctx) => {
      predict = !predict;
      if (!predict) {
        prediction?.abort();
        activeEditor?.clearSuggestion();
      }
      const state = `Prompt prediction ${predict ? 'on' : 'off'}`;
      try {
        await saveSettings({ predict });
      } catch {
        ctx.ui.notify(`${state}, but the setting could not be saved`, 'warning');
        return;
      }
      ctx.ui.notify(state, 'info');
    },
  });

  pi.on('agent_settled', (event, ctx) => {
    const editor = activeEditor;
    if (event.aborted || !predict || !editor || editor.getText()) return;
    prediction?.abort();
    const controller = new AbortController();
    prediction = controller;
    void predictNextPrompt(ctx, controller.signal)
      .catch(() => '')
      .then((text) => {
        if (controller.signal.aborted || editor.getText() || !text) return;
        editor.setSuggestion(text);
      });
  });

  pi.on('session_start', async (_event, ctx) => {
    prediction?.abort();
    activeEditor = undefined;
    if (!ctx.hasUI) return;
    if (!toolRegistered) {
      toolRegistered = true;
      pi.registerTool({
        name: 'set_session_name',
        label: 'Set session name',
        description:
          'Set a short name for the current session. Pi shows it in the editor border and the session list.',
        promptSnippet: 'Set a short name for the current session',
        promptGuidelines: [
          'Call set_session_name with a short name (2\u20135 words) on the first user prompt, even if it is only a greeting, and again whenever the topic or task changes.',
        ],
        parameters: Type.Object({
          name: Type.String({ description: 'Short session name' }),
        }),
        async execute(_toolCallId, params) {
          pi.setSessionName(params.name);
          return {
            content: [{ type: 'text', text: `Session named: ${params.name}` }],
            details: {},
          };
        },
        renderShell: 'self',
        renderCall: () => new Container(),
        renderResult: () => new Container(),
      });
    }
    if (ctx.mode !== 'tui') return;

    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsub = footerData.onBranchChange(() => tui.requestRender());
      let cached: { leafId: string | null; usage: ReturnType<typeof getUsage> } | undefined;
      return {
        dispose: unsub,
        invalidate() {},
        render(width: number): string[] {
          const model = ctx.model;
          const leafId = ctx.sessionManager.getLeafId();
          if (cached?.leafId !== leafId) cached = { leafId, usage: getUsage(ctx) };
          const { totals, latestCacheHitRate } = cached.usage;
          const contextUsage = ctx.getContextUsage();
          const contextWindow = contextUsage?.contextWindow ?? model?.contextWindow ?? 0;
          const contextPercent = contextUsage?.percent?.toFixed(0) ?? '?';

          const modelName = model?.id.replace(/^claude-/, '') || 'no-model';
          const dim = (text: string) => theme.fg('dim', text);
          const topParts = [dim(basename(ctx.sessionManager.getCwd()))];
          const branch = footerData.getGitBranch();
          if (branch) topParts.push(dim(branch));
          topParts.push(
            dim(model?.reasoning ? `${modelName}:${ctx.thinkingLevel || 'off'}` : modelName),
          );
          const contextDisplay =
            contextPercent === '?'
              ? `?/${formatTokens(contextWindow)}`
              : `${contextPercent}%/${formatTokens(contextWindow)}`;
          topParts.push(dim(contextDisplay));

          const statsParts: string[] = [];
          if (totals.input) statsParts.push(`↑${formatTokens(totals.input)}`);
          if (totals.output) statsParts.push(`↓${formatTokens(totals.output)}`);
          if (totals.cacheRead) statsParts.push(`R${formatTokens(totals.cacheRead)}`);
          if (totals.cacheWrite) statsParts.push(`W${formatTokens(totals.cacheWrite)}`);
          const cacheHitRate = latestCacheHitRate?.toFixed(0);
          if (
            (totals.cacheRead > 0 || totals.cacheWrite > 0) &&
            cacheHitRate !== undefined &&
            Number(cacheHitRate) < 80
          ) {
            statsParts.push(`CH${cacheHitRate}%`);
          }

          if (statsParts.length > 0) topParts.push(dim(statsParts.join(' ')));

          if (process.env['PI_EXPERIMENTAL'] === '1') {
            topParts.push(theme.bold(theme.fg('warning', 'xp')));
          }

          const statusParts = Array.from(footerData.getExtensionStatuses().entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([, text]) => sanitizeStatusText(text));

          const separator = dim(' • ');
          const lines: string[] = [];
          let line = '';
          for (const part of [...topParts, ...statusParts]) {
            const fitted = truncateToWidth(part, width, dim('...'));
            if (line && visibleWidth(line + separator + fitted) <= width) {
              line += separator + fitted;
            } else {
              if (line) lines.push(line);
              line = fitted;
            }
          }
          lines.push(line);
          return lines;
        },
      };
    });

    predict = (await loadSettings()).predict !== false;
    sessionPrompts.length = 0;
    const prompts = await loadPromptHistory(
      ctx.sessionManager.getCwd(),
      ctx.sessionManager.getSessionDir(),
      'current',
    );
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      const editor = new HistoryEditor(tui, theme, keybindings, { embedWorkingStatus: true });
      editor.setHistory(prompts);
      editor.getSessionName = () => pi.getSessionName();
      editor.dimColor = (text) => ctx.ui.theme.fg('dim', text);
      editor.setWorkingStatusIndicator(undefined);
      editor.onPromptSent = (text) => sessionPrompts.push({ text, time: Date.now() });
      editor.onReverseSearch = () =>
        void openReverseSearch(ctx, editor, sessionPrompts).catch((error: unknown) => {
          const reason = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`Could not open reverse search: ${reason}`, 'error');
        });
      editor.onInput = () => prediction?.abort();
      activeEditor = editor;
      return editor;
    });
  });
}
