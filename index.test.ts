import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { initTheme, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
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
type Tool = {
  name: string;
  promptGuidelines?: string[];
  execute: (id: string, params: { name: string }) => Promise<unknown>;
  renderShell?: string;
  renderCall?: (...args: unknown[]) => Component;
  renderResult?: (...args: unknown[]) => Component;
};

function fakePi(sessionName?: string) {
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, Tool>();
  const names: string[] = [];
  const pi = {
    on: (event: string, h: Handler) => {
      handlers.set(event, h);
    },
    registerTool: (tool: Tool) => {
      tools.set(tool.name, tool);
    },
    setSessionName: (name: string) => {
      names.push(name);
    },
    getSessionName: () => sessionName,
  } as unknown as ExtensionAPI;
  extension(pi);
  return { handlers, tools, names };
}

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
  percent?: number;
  theme?: typeof theme;
}): string[] {
  const { handlers } = fakePi();

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
    getContextUsage: () => ({
      tokens: 50000,
      contextWindow: 200000,
      percent: options.percent ?? 25,
    }),
  };
  handlers.get('session_start')?.({ type: 'session_start' }, ctx);
  assert.ok(factory);

  const footerData = {
    getGitBranch: () => options.branch ?? null,
    getExtensionStatuses: () => options.statuses ?? new Map(),
    onBranchChange: () => () => {},
  };
  return factory({ requestRender: () => {} }, options.theme ?? theme, footerData).render(
    options.width ?? 80,
  );
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
const themed = (color: string, text: string) => `\x1b[${color === 'dim' ? 2 : 90}m${text}\x1b[39m`;

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

async function startEditor(cwd: string, sessionName?: string) {
  const { handlers } = fakePi(sessionName);

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
      theme: { fg: themed },
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

test('shows the working indicator in the editor border', async () => {
  const { editor } = await startEditor('/work/status');
  const indicator = { renderInBorder: () => 'Working', render: () => [], invalidate: () => {} };
  (
    editor as unknown as { setWorkingStatusIndicator: (i: unknown) => void }
  ).setWorkingStatusIndicator(indicator);
  assert.match(editor.render(80)[0] ?? '', /Working/);
});

test('dims the working indicator in the editor border', async () => {
  const { editor } = await startEditor('/work/status-dim');
  const indicator = {
    renderInBorder: () => '\x1b[36m\u280b\x1b[39m \x1b[90mWorking\x1b[39m',
    renderSpinnerInBorder: () => '\x1b[36m\u280b\x1b[39m',
    render: () => [],
    invalidate: () => {},
  };
  (
    editor as unknown as { setWorkingStatusIndicator: (i: unknown) => void }
  ).setWorkingStatusIndicator(indicator);
  assert.ok(editor.render(40)[0]?.includes(themed('dim', '\u280b Working')));
  assert.ok(editor.render(3)[0]?.includes(themed('dim', '\u280b')));
});

test('names the session with the set_session_name tool', async () => {
  const { tools, names } = fakePi();
  const tool = tools.get('set_session_name');
  assert.ok(tool);
  assert.match(tool.promptGuidelines?.join('\n') ?? '', /set_session_name.*first user prompt/);
  await tool.execute('call-1', { name: 'fix login bug' });
  assert.deepEqual(names, ['fix login bug']);
});

test('hides the set_session_name tool call and output', () => {
  const { tools } = fakePi();
  const tool = tools.get('set_session_name');
  assert.equal(tool?.renderShell, 'self');
  const call = tool?.renderCall?.({ name: 'fix login bug' }, theme, {});
  const result = { content: [{ type: 'text', text: 'Session named: fix login bug' }] };
  const output = tool?.renderResult?.(result, {}, theme, {});
  assert.deepEqual(call?.render(80), []);
  assert.deepEqual(output?.render(80), []);
});

test('shows the session name at the right of the editor border', async () => {
  const { editor } = await startEditor('/work/name', 'fix login bug');
  const top = editor.render(40)[0] ?? '';
  assert.ok(stripTerminalSequences(top).endsWith(' fix login bug ──'), top);
  assert.equal(visibleWidth(top), 40);
});

test('draws the editor border in the dim theme colour', async () => {
  const { editor } = await startEditor('/work/border');
  (editor as unknown as { borderColor: (t: string) => string }).borderColor = (t) =>
    `<thinkingMedium>${t}</thinkingMedium>`;
  const lines = editor.render(20);
  assert.equal(lines[0], themed('dim', '─'.repeat(20)));
  assert.equal(lines.at(-1), themed('dim', '─'.repeat(20)));
});

test('keeps the bash mode editor border colour', async () => {
  const { editor } = await startEditor('/work/bash');
  for (const key of '!ls') editor.handleInput(key);
  (editor as unknown as { borderColor: (t: string) => string }).borderColor = (t) =>
    `<bashMode>${t}</bashMode>`;
  assert.equal(editor.render(20)[0], `<bashMode>${'─'.repeat(20)}</bashMode>`);
});

test('shows the session name next to the working indicator', async () => {
  const { editor } = await startEditor('/work/name-working', 'fix login bug');
  const indicator = { renderInBorder: () => 'Working', render: () => [], invalidate: () => {} };
  (
    editor as unknown as { setWorkingStatusIndicator: (i: unknown) => void }
  ).setWorkingStatusIndicator(indicator);
  const top = editor.render(40)[0] ?? '';
  assert.match(top, /Working/);
  assert.ok(stripTerminalSequences(top).endsWith(' fix login bug ──'), top);
});

test('shortens the session name when the border is narrow', async () => {
  const { editor } = await startEditor('/work/name-narrow', 'a very long session name');
  const top = editor.render(14)[0] ?? '';
  assert.match(top, /a very.*…/);
  assert.ok(stripTerminalSequences(top).endsWith(' ──'), top);
  assert.equal(visibleWidth(top), 14);
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
        message: { role: 'assistant', usage: usage(8, 1400, 26000, 7000) },
      },
    ],
  })[0];
  assert.equal(line, 'project • opus:high • 25%/200k • ↑8 ↓1k R26k W7k CH79%');
});

test('hides cache hit rate when it rounds to 80% or above', () => {
  const line = render({
    entries: [
      {
        type: 'message',
        message: { role: 'assistant', usage: usage(8, 1400, 7960, 2040) },
      },
    ],
  })[0];
  assert.equal(line, 'project • opus:high • 25%/200k • ↑8 ↓1k R8k W2k');
});

test('shows extension statuses sorted by key at the end of the line', () => {
  const statuses = new Map([
    ['b', 'second'],
    ['a', 'first\nline'],
  ]);
  assert.deepEqual(render({ statuses }), ['project • opus:high • 25%/200k • first line • second']);
});

test('moves extension statuses to a second line when the line does not fit', () => {
  const statuses = new Map([
    ['a', 'quota 42%'],
    ['b', 'second'],
  ]);
  assert.deepEqual(render({ statuses, width: 40 }), [
    'project • opus:high • 25%/200k',
    'quota 42% • second',
  ]);
  assert.deepEqual(render({ statuses, width: 12 }).map(stripTerminalSequences), [
    'project •...',
    'quota 42%...',
  ]);
});

test('keeps stats dim after a highlighted context usage', () => {
  const tagTheme = {
    fg: (color: string, text: string) => `<${color}>${text}</>`,
    bold: (text: string) => text,
  };
  const line = render({
    percent: 95,
    width: 200,
    theme: tagTheme,
    entries: [{ type: 'message', message: { role: 'assistant', usage: usage(8, 0) } }],
  })[0];
  assert.ok(line);
  let colour = '';
  const colours: string[] = [];
  for (const part of line.split(/(<\w+>|<\/>)/)) {
    if (part === '</>') colour = '';
    else if (/^<\w+>$/.test(part)) colour = part.slice(1, -1);
    else colours.push(...[...part].map(() => colour));
  }
  const plain = line.replace(/<\w+>|<\/>/g, '');
  assert.equal(plain, 'project • opus:high • 95%/200k • ↑8');
  assert.equal(colours[plain.indexOf('95%')], 'error');
  assert.equal(colours[plain.indexOf('↑8')], 'dim');
});

test('orders all-folder reverse search by recency', async () => {
  writeSession('/work/order-a', ['older here']);
  writeSession('/work/order-b', ['newer elsewhere']);
  const { editor, getSearch, editorTextSet } = await startEditor('/work/order-a');
  editor.handleInput('\x12');
  const search = getSearch();
  assert.ok(search);
  search.handleInput('\t');
  await new Promise((resolve) => setTimeout(resolve, 100));
  search.handleInput('\r');
  assert.equal(await editorTextSet, 'newer elsewhere');
});
