import { readFile } from 'node:fs/promises';
import { SessionManager } from '@earendil-works/pi-coding-agent';

export type HistoryScope = 'current' | 'all';

const HISTORY_LIMIT = 500;

type RawEntry = {
  type?: string;
  message?: { role?: string; content?: unknown };
};

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n');
}

export function isRecallablePrompt(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && !trimmed.startsWith('/') && !trimmed.startsWith('!');
}

async function readPrompts(filePath: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch {
    return [];
  }
  const prompts: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry: RawEntry;
    try {
      entry = JSON.parse(line) as RawEntry;
    } catch {
      continue;
    }
    if (entry.type !== 'message' || entry.message?.role !== 'user') continue;
    const text = extractText(entry.message.content);
    if (isRecallablePrompt(text) && !text.startsWith('<skill name="')) prompts.push(text.trim());
  }
  return prompts;
}

export function uniqueNewest(prompts: string[], limit = Infinity): string[] {
  const seen = new Set<string>();
  const newestFirst: string[] = [];
  for (const prompt of [...prompts].reverse()) {
    if (seen.has(prompt)) continue;
    seen.add(prompt);
    newestFirst.push(prompt);
    if (newestFirst.length >= limit) break;
  }
  return newestFirst.reverse();
}

export async function loadPromptHistory(cwd: string, scope: HistoryScope): Promise<string[]> {
  let sessions: Awaited<ReturnType<typeof SessionManager.list>>;
  try {
    sessions = scope === 'all' ? await SessionManager.listAll() : await SessionManager.list(cwd);
  } catch {
    return [];
  }
  const ordered = [...sessions].sort((a, b) => a.modified.getTime() - b.modified.getTime());
  const all: string[] = [];
  for (const session of ordered) all.push(...(await readPrompts(session.path)));
  return uniqueNewest(all, HISTORY_LIMIT);
}
