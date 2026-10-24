import { isAbsolute, relative, resolve, sep } from 'node:path';
import { type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

type Usage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: { total: number };
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

function formatCwd(cwd: string, home: string | undefined): string {
  if (!home) return cwd;
  const rel = relative(resolve(home), resolve(cwd));
  const inside = rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  if (!inside) return cwd;
  return rel === '' ? '~' : `~${sep}${rel}`;
}

function getUsage(ctx: ExtensionContext) {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  let latestCacheHitRate: number | undefined;
  const add = (u: Usage) => {
    totals.input += u.input;
    totals.output += u.output;
    totals.cacheRead += u.cacheRead;
    totals.cacheWrite += u.cacheWrite;
    totals.cost += u.cost.total;
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

          let pwd = formatCwd(
            ctx.sessionManager.getCwd(),
            process.env['HOME'] || process.env['USERPROFILE'],
          );
          const branch = footerData.getGitBranch();
          if (branch) pwd = `${pwd} (${branch})`;
          const sessionName = ctx.sessionManager.getSessionName();
          if (sessionName) pwd = `${pwd} • ${sessionName}`;

          const statsParts: string[] = [];
          if (totals.input) statsParts.push(`↑${formatTokens(totals.input)}`);
          if (totals.output) statsParts.push(`↓${formatTokens(totals.output)}`);
          if (totals.cacheRead) statsParts.push(`R${formatTokens(totals.cacheRead)}`);
          if (totals.cacheWrite) statsParts.push(`W${formatTokens(totals.cacheWrite)}`);
          if ((totals.cacheRead > 0 || totals.cacheWrite > 0) && latestCacheHitRate !== undefined) {
            statsParts.push(`CH${latestCacheHitRate.toFixed(0)}%`);
          }

          const usingSubscription = model
            ? model.provider === 'kimi-coding' ||
              (ctx.modelRegistry.isUsingOAuth(model) &&
                ctx.modelRegistry.getProvider(model.provider)?.auth.oauth?.isSubscription === true)
            : false;
          if (totals.cost || usingSubscription) {
            statsParts.push(`$${totals.cost.toFixed(2)}${usingSubscription ? ' (sub)' : ''}`);
          }

          const contextDisplay =
            contextPercent === '?'
              ? `?/${formatTokens(contextWindow)}`
              : `${contextPercent}%/${formatTokens(contextWindow)}`;
          if (contextPercentValue > 90) statsParts.push(theme.fg('error', contextDisplay));
          else if (contextPercentValue > 70) statsParts.push(theme.fg('warning', contextDisplay));
          else statsParts.push(contextDisplay);

          if (process.env['PI_EXPERIMENTAL'] === '1') {
            statsParts.push(`${theme.fg('dim', '•')} ${theme.bold(theme.fg('warning', 'xp'))}`);
          }

          let statsLeft = statsParts.join(' ');
          let statsLeftWidth = visibleWidth(statsLeft);
          if (statsLeftWidth > width) {
            statsLeft = truncateToWidth(statsLeft, width, '...');
            statsLeftWidth = visibleWidth(statsLeft);
          }

          const minPadding = 2;
          const modelName = model?.id.replace(/^claude-/, '') || 'no-model';
          let right = modelName;
          if (model?.reasoning) {
            const level = ctx.thinkingLevel || 'off';
            right = level === 'off' ? `${modelName} • thinking off` : `${modelName} • ${level}`;
          }

          const rightWidth = visibleWidth(right);
          let statsLine: string;
          if (statsLeftWidth + minPadding + rightWidth <= width) {
            statsLine = statsLeft + ' '.repeat(width - statsLeftWidth - rightWidth) + right;
          } else {
            const available = width - statsLeftWidth - minPadding;
            if (available > 0) {
              const truncatedRight = truncateToWidth(right, available, '');
              const padding = ' '.repeat(
                Math.max(0, width - statsLeftWidth - visibleWidth(truncatedRight)),
              );
              statsLine = statsLeft + padding + truncatedRight;
            } else {
              statsLine = statsLeft;
            }
          }

          const remainder = statsLine.slice(statsLeft.length);
          const pwdLine = truncateToWidth(theme.fg('dim', pwd), width, theme.fg('dim', '...'));
          const lines = [pwdLine, theme.fg('dim', statsLeft) + theme.fg('dim', remainder)];

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
