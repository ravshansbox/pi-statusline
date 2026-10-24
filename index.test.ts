import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import extension from './index.ts';

type Component = { render(width: number): string[] };
type Factory = (tui: unknown, theme: unknown, footerData: unknown) => Component;
type Handler = (event: unknown, ctx: unknown) => unknown;

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

function usage(input: number, output: number, cacheRead = 0, cacheWrite = 0) {
  return { input, output, cacheRead, cacheWrite };
}

function render(options: {
  entries?: unknown[];
  branch?: string | null;
  statuses?: Map<string, string>;
  width?: number;
}): string[] {
  const handlers = new Map<string, Handler>();
  const pi = {
    on: (event: string, h: Handler) => {
      handlers.set(event, h);
    },
  } as unknown as ExtensionAPI;
  extension(pi);

  let factory: Factory | undefined;
  const model = {
    id: 'claude-opus',
    provider: 'anthropic',
    reasoning: true,
    contextWindow: 200000,
  };
  const ctx = {
    mode: 'tui',
    cwd: '/tmp',
    model,
    thinkingLevel: 'high',
    ui: {
      setFooter: (f: Factory) => {
        factory = f;
      },
    },
    sessionManager: {
      getEntries: () => options.entries ?? [],
      getCwd: () => '/tmp/project',
      getSessionName: () => undefined,
    },
    modelRegistry: {
      isUsingOAuth: () => false,
      getProvider: () => undefined,
    },
    getContextUsage: () => ({ tokens: 50000, contextWindow: 200000, percent: 25 }),
  };
  handlers.get('session_start')?.({ type: 'session_start' }, ctx);
  assert.ok(factory);

  const footerData = {
    getGitBranch: () => options.branch ?? null,
    getExtensionStatuses: () => options.statuses ?? new Map(),
    onBranchChange: () => () => {},
  };
  return factory({ requestRender: () => {} }, theme, footerData).render(options.width ?? 80);
}

test('shows the directory name, git branch, model and thinking level', () => {
  assert.equal(render({ branch: 'main' })[0], 'project • main • opus • high');
});

test('leaves out the git branch outside a repository', () => {
  assert.equal(render({})[0], 'project • opus • high');
});

test('shows token usage and context', () => {
  const line = render({
    entries: [
      {
        type: 'message',
        message: { role: 'assistant', usage: usage(8, 1400, 26000, 6400) },
      },
    ],
  })[1];
  assert.equal(line, '25%/200k ↑8 ↓1k R26k W6k CH80%');
});

test('shows extension statuses sorted by key', () => {
  const statuses = new Map([
    ['b', 'second'],
    ['a', 'first\nline'],
  ]);
  assert.equal(render({ statuses })[2], 'first line second');
});
