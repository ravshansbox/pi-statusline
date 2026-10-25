import { basename } from 'node:path';
import {
  CustomEditor,
  getSelectListTheme,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from '@earendil-works/pi-coding-agent';
import {
  type Component,
  fuzzyFilter,
  matchesKey,
  SelectList,
  type SelectListTheme,
  Text,
  truncateToWidth,
  type TUI,
} from '@earendil-works/pi-tui';
import {
  type HistoryScope,
  isRecallablePrompt,
  loadPromptHistory,
  uniqueNewest,
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

function getUsage(ctx: ExtensionContext) {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let latestCacheHitRate: number | undefined;
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
      const u = entry.message.usage;
      add(u);
      const prompt = u.input + u.cacheRead + u.cacheWrite;
      latestCacheHitRate = prompt > 0 ? (u.cacheRead / prompt) * 100 : undefined;
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
  return { totals, latestCacheHitRate };
}

class HistoryEditor extends CustomEditor {
  private prompts: string[] = [];
  onReverseSearch?: () => void;

  setHistory(prompts: string[]): void {
    this.prompts = [];
    for (const prompt of prompts) this.addToHistory(prompt);
  }

  getHistory(): string[] {
    return this.prompts;
  }

  override addToHistory(text: string): void {
    const trimmed = text.trim();
    if (isRecallablePrompt(trimmed)) {
      this.prompts = [...this.prompts.filter((prompt) => prompt !== trimmed), trimmed];
    }
    super.addToHistory(text);
  }

  override handleInput(data: string): void {
    if (matchesKey(data, 'ctrl+r')) {
      this.onReverseSearch?.();
      return;
    }
    super.handleInput(data);
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
          this.refresh();
        });
    }
    this.refresh();
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'escape')) {
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
      this.query = this.query.slice(0, -1);
      this.refresh();
    } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
      this.query += data;
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

async function openReverseSearch(ctx: ExtensionContext, editor: HistoryEditor) {
  const listTheme = getSelectListTheme();
  const result = await ctx.ui.custom<string | null>(
    (tui, theme, _kb, done) =>
      new ReverseSearch(
        editor.getHistory(),
        ctx.ui.getEditorText(),
        async () => {
          const saved = await loadPromptHistory(ctx.cwd, 'all');
          const unsaved = editor.getHistory().filter((prompt) => !saved.includes(prompt));
          return uniqueNewest([...saved, ...unsaved]);
        },
        tui,
        theme,
        listTheme,
        done,
      ),
  );
  if (result) ctx.ui.setEditorText(result);
}

export default function (pi: ExtensionAPI) {
  pi.on('session_start', async (_event, ctx) => {
    if (ctx.mode !== 'tui') return;
    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsub = footerData.onBranchChange(() => tui.requestRender());
      return {
        dispose: unsub,
        invalidate() {},
        render(width: number): string[] {
          const model = ctx.model;
          const { totals, latestCacheHitRate } = getUsage(ctx);
          const contextUsage = ctx.getContextUsage();
          const contextWindow = contextUsage?.contextWindow ?? model?.contextWindow ?? 0;
          const contextPercentValue = contextUsage?.percent ?? 0;
          const contextPercent =
            contextUsage?.percent != null ? contextPercentValue.toFixed(0) : '?';

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
          if (contextPercentValue > 90) topParts.push(theme.fg('error', contextDisplay));
          else if (contextPercentValue > 70) topParts.push(theme.fg('warning', contextDisplay));
          else topParts.push(dim(contextDisplay));

          const statsParts: string[] = [];
          if (totals.input) statsParts.push(`↑${formatTokens(totals.input)}`);
          if (totals.output) statsParts.push(`↓${formatTokens(totals.output)}`);
          if (totals.cacheRead) statsParts.push(`R${formatTokens(totals.cacheRead)}`);
          if (totals.cacheWrite) statsParts.push(`W${formatTokens(totals.cacheWrite)}`);
          if ((totals.cacheRead > 0 || totals.cacheWrite > 0) && latestCacheHitRate !== undefined) {
            statsParts.push(`CH${latestCacheHitRate.toFixed(0)}%`);
          }

          if (statsParts.length > 0) topParts.push(dim(statsParts.join(' ')));

          if (process.env['PI_EXPERIMENTAL'] === '1') {
            topParts.push(theme.bold(theme.fg('warning', 'xp')));
          }

          const lines = [truncateToWidth(topParts.join(dim(' • ')), width, dim('...'))];

          const statuses = footerData.getExtensionStatuses();
          if (statuses.size > 0) {
            const line = Array.from(statuses.entries())
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([, text]) => sanitizeStatusText(text))
              .join(' ');
            lines.push(truncateToWidth(line, width, theme.fg('dim', '...')));
          }

          return lines;
        },
      };
    });

    const prompts = await loadPromptHistory(ctx.cwd, 'current');
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      const editor = new HistoryEditor(tui, theme, keybindings, { embedWorkingStatus: true });
      editor.setHistory(prompts);
      editor.onReverseSearch = () => void openReverseSearch(ctx, editor);
      return editor;
    });
  });
}
