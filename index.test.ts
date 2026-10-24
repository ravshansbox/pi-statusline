import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { initTheme, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import extension from './index.ts';

const agentDir = mkdtempSync(join(tmpdir(), 'pi-statusline-'));
process.env['PI_CODING_AGENT_DIR'] = agentDir;
initTheme('dark');

type Component = {
  render(width: number): string[];
  handleInput(data: string): void;
  getText(): string;
};
type Factory = (tui: unknown, theme: unknown, footerData: unknown) => Component;
type CustomFactory = (
  tui: unknown,
  theme: unknown,
  keybindings: unknown,
  done: (value: string | null) => void,
) => Component;
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
  thinkingLevel?: string;
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
    thinkingLevel: options.thinkingLevel ?? 'high',
    ui: {
      setFooter: (f: Factory) => {
        factory = f;
      },
      setEditorComponent: () => {},
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

const tui = { terminal: { rows: 40, columns: 80 }, requestRender: () => {} };
const editorTheme = {
  borderColor: (text: string) => text,
  selectList: {
    selectedPrefix: (text: string) => text,
    selectedText: (text: string) => text,
    description: (text: string) => text,
    scrollInfo: (text: string) => text,
    noMatch: (text: string) => text,
  },
};
const keybindings = { matches: () => false };

let sessionCount = 0;
function writeSession(cwd: string, prompts: string[]) {
  const dir = join(agentDir, 'sessions', `--${cwd.replace(/^\//, '').replace(/\//g, '-')}--`);
  mkdirSync(dir, { recursive: true });
  sessionCount++;
  const timestamp = new Date(Date.UTC(2026, 0, 1, 0, sessionCount)).toISOString();
  const lines = [
    { type: 'session', version: 3, id: `s${sessionCount}`, timestamp, cwd },
    ...prompts.map((content, i) => ({
      type: 'message',
      id: `m${i}`,
      parentId: i === 0 ? null : `m${i - 1}`,
      timestamp,
      message: { role: 'user', content, timestamp: 0 },
    })),
  ];
  const file = join(dir, `${sessionCount}.jsonl`);
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
}

async function startEditor(cwd: string) {
  const handlers = new Map<string, Handler>();
  const pi = {
    on: (event: string, h: Handler) => {
      handlers.set(event, h);
    },
  } as unknown as ExtensionAPI;
  extension(pi);

  let editorFactory: ((tui: unknown, theme: unknown, kb: unknown) => Component) | undefined;
  let search: Component | undefined;
  let editorText: (text: string) => void = () => {};
  const editorTextSet = new Promise<string>((resolve) => {
    editorText = resolve;
  });
  const ctx = {
    mode: 'tui',
    hasUI: true,
    cwd,
    sessionManager: { getEntries: () => [], getCwd: () => cwd },
    getContextUsage: () => undefined,
    ui: {
      setFooter: () => {},
      setEditorComponent: (f: typeof editorFactory) => {
        editorFactory = f;
      },
      getEditorText: () => editor.getText(),
      setEditorText: (text: string) => editorText(text),
      custom: (f: CustomFactory) =>
        new Promise((resolve) => {
          search = f(tui, theme, keybindings, resolve);
        }),
    },
  };
  await handlers.get('session_start')?.({ type: 'session_start' }, ctx);
  assert.ok(editorFactory);
  const editor = editorFactory(tui, editorTheme, keybindings);
  return { editor, getSearch: () => search, editorTextSet };
}

test('recalls prompts from earlier sessions in the same folder with up', async () => {
  writeSession('/work/recall', ['first', '/model', '!ls', 'second']);
  writeSession('/work/other', ['elsewhere']);
  const { editor } = await startEditor('/work/recall');
  editor.handleInput('\x1b[A');
  assert.equal(editor.getText(), 'second');
  editor.handleInput('\x1b[A');
  assert.equal(editor.getText(), 'first');
  editor.handleInput('\x1b[A');
  assert.equal(editor.getText(), 'first');
});

test('loads a prompt chosen in reverse search with ctrl+r', async () => {
  writeSession('/work/search', ['fix the build', 'write the docs']);
  const { editor, getSearch, editorTextSet } = await startEditor('/work/search');
  editor.handleInput('\x12');
  const search = getSearch();
  assert.ok(search);
  for (const key of 'build') search.handleInput(key);
  search.handleInput('\r');
  assert.equal(await editorTextSet, 'fix the build');
});

test('shows the directory name, git branch, model and thinking level', () => {
  assert.equal(render({ branch: 'main' })[0], 'project • main • opus:high • 25%/200k');
});

test('shows off when thinking is off', () => {
  assert.equal(render({ thinkingLevel: 'off' })[0], 'project • opus:off • 25%/200k');
});

test('leaves out the git branch outside a repository', () => {
  assert.equal(render({})[0], 'project • opus:high • 25%/200k');
});

test('shows token usage and context', () => {
  const line = render({
    entries: [
      {
        type: 'message',
        message: { role: 'assistant', usage: usage(8, 1400, 26000, 6400) },
      },
    ],
  })[0];
  assert.equal(line, 'project • opus:high • 25%/200k • ↑8 ↓1k R26k W6k CH80%');
});

test('shows extension statuses sorted by key', () => {
  const statuses = new Map([
    ['b', 'second'],
    ['a', 'first\nline'],
  ]);
  assert.equal(render({ statuses })[1], 'first line second');
});
