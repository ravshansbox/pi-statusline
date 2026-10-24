import { basename } from 'node:path';
import { type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { truncateToWidth } from '@earendil-works/pi-tui';

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

export default function (pi: ExtensionAPI) {
  pi.on('session_start', (_event, ctx) => {
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
          const topParts = [basename(ctx.sessionManager.getCwd())];
          const branch = footerData.getGitBranch();
          if (branch) topParts.push(branch);
          topParts.push(modelName);
          if (model?.reasoning) {
            const level = ctx.thinkingLevel || 'off';
            topParts.push(level === 'off' ? 'thinking off' : level);
          }
          const top = topParts.join(' • ');

          const statsParts: string[] = [];
          const contextDisplay =
            contextPercent === '?'
              ? `?/${formatTokens(contextWindow)}`
              : `${contextPercent}%/${formatTokens(contextWindow)}`;
          if (contextPercentValue > 90) statsParts.push(theme.fg('error', contextDisplay));
          else if (contextPercentValue > 70) statsParts.push(theme.fg('warning', contextDisplay));
          else statsParts.push(contextDisplay);

          if (totals.input) statsParts.push(`↑${formatTokens(totals.input)}`);
          if (totals.output) statsParts.push(`↓${formatTokens(totals.output)}`);
          if (totals.cacheRead) statsParts.push(`R${formatTokens(totals.cacheRead)}`);
          if (totals.cacheWrite) statsParts.push(`W${formatTokens(totals.cacheWrite)}`);
          if ((totals.cacheRead > 0 || totals.cacheWrite > 0) && latestCacheHitRate !== undefined) {
            statsParts.push(`CH${latestCacheHitRate.toFixed(0)}%`);
          }

          if (process.env['PI_EXPERIMENTAL'] === '1') {
            statsParts.push(`${theme.fg('dim', '•')} ${theme.bold(theme.fg('warning', 'xp'))}`);
          }

          const statsLine = truncateToWidth(statsParts.join(' '), width, '...');
          const topLine = truncateToWidth(theme.fg('dim', top), width, theme.fg('dim', '...'));
          const lines = [topLine, theme.fg('dim', statsLine)];

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
  });
}
