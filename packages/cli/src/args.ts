/**
 * Command-line flags (S3 plan 4): every command takes only the flags it reads. One table names
 * them; `parseFor` gives a command values typed to its own flags, so a block that reads a flag
 * missing from the table does not compile.
 */
import { parseArgs, type ParseArgsOptionDescriptor } from 'node:util';

export const OPTIONS = {
  'no-asr': { type: 'boolean', default: false },
  recheck: { type: 'boolean', default: false },
  retry: { type: 'string', multiple: true },
  draft: { type: 'boolean', default: false },
  'no-cache': { type: 'boolean', default: false },
  'frozen-audio': { type: 'boolean', default: false },
  video: { type: 'boolean', default: false },
  workers: { type: 'string' },
  write: { type: 'boolean', default: false },
  output: { type: 'string', default: 'youtube' },
  fps: { type: 'string', default: '30' },
  voice: { type: 'string' },
  lang: { type: 'string' },
  style: { type: 'string' },
  script: { type: 'string' },
  'no-play': { type: 'boolean', default: false },
  play: { type: 'boolean', default: false },
  candidates: { type: 'string' },
  out: { type: 'string' },
  name: { type: 'string' },
  'max-memory-gb': { type: 'string' },
  'dry-run': { type: 'boolean', default: false },
  'reset-derived': { type: 'boolean', default: false },
  all: { type: 'boolean', default: false },
  except: { type: 'string', multiple: true },
  seed: { type: 'string' },
  apply: { type: 'boolean', default: false },
  refresh: { type: 'boolean', default: false },
  json: { type: 'boolean', default: false },
  'hash-version': { type: 'string' },
  list: { type: 'boolean', default: false },
  'no-open': { type: 'boolean', default: false },
  'min-emotion': { type: 'string' },
  id: { type: 'string', multiple: true },
  idle: { type: 'string' },
  rhythm: { type: 'string' },
  'out-dir': { type: 'string' },
  frames: { type: 'boolean', default: false },
  watermark: { type: 'string' },
  text: { type: 'string' },
  'assets-dir': { type: 'string' },
  width: { type: 'string' },
  height: { type: 'string' },
  selector: { type: 'string' },
  'allow-host': { type: 'string', multiple: true },
  timeout: { type: 'string' },
} as const satisfies Record<string, ParseArgsOptionDescriptor>;

type Option = keyof typeof OPTIONS;

/** Command (and subcommand) → the flags it takes. The usage text lists the same (tested). */
export const FLAGS = {
  lint: [],
  check: [],
  sentences: ['json'],
  'export-script': [],
  doctor: [],
  pick: [],
  'tts-server start': [],
  'audio prune': [],
  dev: ['output', 'video', 'no-asr'],
  new: ['lang'],
  'import-recording': ['write'],
  inspect: ['json', 'hash-version'],
  takes: ['all', 'id', 'no-open', 'list', 'out-dir'],
  'takes pick': [],
  'takes unpick': [],
  'voice create': ['lang', 'candidates', 'play'],
  'voice pick': ['lang'],
  'voice check': ['lang'],
  'voice train': ['lang', 'min-emotion'],
  'voice refs': ['refresh'],
  'character setup': ['max-memory-gb'],
  'character create': ['candidates', 'max-memory-gb'],
  'character pick': [],
  'character build': ['dry-run', 'reset-derived', 'max-memory-gb'],
  'character review': [],
  'character approve': ['all', 'except', 'reset-derived'],
  'character redo': ['seed'],
  'character missing': ['apply'],
  'character import': ['out', 'name'],
  snapshot: ['output', 'draft', 'fps', 'rhythm', 'out-dir', 'frozen-audio', 'frames'],
  say: ['voice', 'lang', 'style', 'script', 'no-play'],
  tts: ['no-asr', 'recheck', 'retry'],
  direct: ['output', 'fps', 'rhythm', 'no-open', 'out-dir'],
  timeline: ['output', 'fps', 'rhythm'],
  render: [
    'output',
    'no-asr',
    'recheck',
    'draft',
    'no-cache',
    'frozen-audio',
    'workers',
    'idle',
    'rhythm',
    'fps',
    'out-dir',
    'watermark',
  ],
  capture: ['out', 'text', 'assets-dir', 'width', 'height', 'selector', 'allow-host', 'timeout'],
} as const satisfies Record<string, readonly Option[]>;

export type CommandKey = keyof typeof FLAGS;

/** Commands whose first positional is a subcommand. */
const WITH_SUB: Record<string, readonly string[]> = {
  voice: ['create', 'pick', 'check', 'train', 'refs'],
  character: ['setup', 'create', 'pick', 'build', 'review', 'approve', 'redo', 'missing', 'import'],
  audio: ['prune'],
  'tts-server': ['start'],
};

/** A command-line mistake: printed as is, exit 2. */
export class UsageError extends Error {}

/**
 * Pass 1: the positionals, whatever the flags (a flag may come before the subcommand, as in
 * `s2v voice --lang ko create v.yaml`; the subcommand stays the first positional), and the
 * command key. An option no command knows is
 * reported here, before it can be taken for a subcommand.
 */
export function commandOf(
  command: string,
  args: string[],
): { key: CommandKey; positionals: string[] } | null {
  const { positionals, tokens } = parseArgs({
    args,
    options: OPTIONS,
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  // reported once the key is known, in the same words as pass 2
  const unknown = tokens.find((t) => t.kind === 'option' && !Object.hasOwn(OPTIONS, t.name));
  let key: string = command;
  if (Object.hasOwn(WITH_SUB, command)) {
    const sub = positionals[0];
    key = sub && WITH_SUB[command]!.includes(sub) ? `${command} ${sub}` : '';
  } else if (command === 'takes' && (positionals[0] === 'pick' || positionals[0] === 'unpick'))
    key = `takes ${positionals[0]}`;
  if (!Object.hasOwn(FLAGS, key)) {
    // a command with subcommands names a bad option before a bad subcommand; an unknown command
    // is just that
    if (unknown?.kind === 'option' && Object.hasOwn(WITH_SUB, command))
      throw new UsageError(`s2v ${command}: unknown option ${unknown.rawName}`);
    return null;
  }
  if (unknown?.kind === 'option') throw unknownOption(key as CommandKey, unknown.rawName);
  return { key: key as CommandKey, positionals };
}

type OptionsOf<K extends CommandKey> = Pick<typeof OPTIONS, (typeof FLAGS)[K][number]>;
type Config<K extends CommandKey> = {
  args: string[];
  options: OptionsOf<K>;
  allowPositionals: true;
  strict: true;
};

function unknownOption(key: CommandKey, raw: string): UsageError {
  const names = FLAGS[key] as readonly string[];
  const takes = names.length
    ? `takes: ${names.map((n) => `--${n}`).join(', ')}`
    : 'takes no options';
  return new UsageError(`s2v ${key}: unknown option ${raw} (${takes})`);
}

/** Pass 2: the command's own flags only; anything else is a UsageError. */
export function parseFor<K extends CommandKey>(
  key: K,
  args: string[],
): ReturnType<typeof parseArgs<Config<K>>> {
  const names = FLAGS[key] as readonly Option[];
  const options = Object.fromEntries(names.map((n) => [n, OPTIONS[n]])) as OptionsOf<K>;
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true }) as ReturnType<
      typeof parseArgs<Config<K>>
    >;
  } catch (e) {
    const err = e as Error & { code?: string };
    if (err.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
      throw unknownOption(key, /'([^']+)'/.exec(err.message)?.[1] ?? '?');
    }
    if (err.code?.startsWith('ERR_PARSE_ARGS_')) throw new UsageError(`s2v ${key}: ${err.message}`);
    throw e;
  }
}

/** `--rhythm on|off` (5d plan 2) or undefined. */
export function onOff(flag: string, value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value !== 'on' && value !== 'off')
    throw new UsageError(`--${flag} must be on or off, not "${value}"`);
  return value === 'on';
}

/** One line per command with every flag it takes (S3 plan 4.3; a test holds it to FLAGS). */
export const USAGE = [
  's2v --version [--json]   (the version a tool pins)',
  's2v lint <script.md>',
  's2v check <script.md>   (subtitles fit their boxes)',
  's2v sentences <script.md> [--json]   (sentence ids to retry; with lock state as JSON)',
  's2v tts <script.md> [--no-asr] [--recheck] [--retry <scene[:paragraph[:sentence]]>]...',
  's2v takes <script.md> [--all] [--id <id>]... [--no-open] [--out-dir <dir>] | --list [--id <id>]...   (listening page | takes of each line)',
  's2v takes pick <script.md> <id>=<take> ...   (choose a take)',
  's2v takes unpick <script.md> <id> ...',
  's2v inspect <script.md> --json [--hash-version 1]   (what the script is made of, hashed by kind)',
  's2v direct <script.md> [--output youtube] [--fps 30] [--rhythm on|off] [--no-open] [--out-dir <dir>]   (direction plan and notes)',
  's2v timeline <script.md> [--output youtube] [--fps 30] [--rhythm on|off]',
  's2v snapshot <script.md> [--output youtube] [--draft] [--fps 30] [--rhythm on|off] [--out-dir <dir>] [--frozen-audio] [--frames]',
  's2v render <script.md> [--output youtube] [--no-asr] [--recheck] [--draft] [--no-cache] [--frozen-audio] [--workers N] [--idle on|off] [--rhythm on|off] [--fps 30] [--out-dir <dir>] [--watermark proxy]',
  's2v capture <url> --out <png> [--text <json>] [--assets-dir <dir>] [--width 1280] [--height 800] [--selector <css>] [--allow-host <host>]... [--timeout 30]   (a web page: its picture and what it says)',
  's2v audio prune <script.md>   (drop locked audio the script no longer uses)',
  's2v export-script <script.md>   (reading script for a recording session)',
  's2v import-recording <script.md> <take.wav> [--write]',
  's2v dev <script.md> [--output youtube] [--video] [--no-asr]   (edit loop)',
  's2v say [--voice qwen:Sohee] [--lang ko] [--style ...] [--script script.md] [--no-play] [--] "<sentence>"   (a sentence starting with - goes after the bare double dash)',
  's2v voice create <voices/id.yaml> [--lang ko] [--candidates 3] [--play]',
  's2v voice pick <voices/id.yaml> <n> [--lang ko]',
  "s2v voice check <voices/id.yaml> [--lang ko]   (judge a persona's reference clip)",
  's2v voice train <voices/id.yaml> [--lang ko] [--min-emotion 150]   (its trained speaker, about 3 h)',
  's2v voice refs <script.md> [--refresh]   (reference voices for the consistency checks)',
  's2v character setup [--max-memory-gb N]   (optional image generation; Apple silicon)',
  's2v character create <dir> [--candidates 4] [--max-memory-gb N]',
  's2v character pick <dir> <n>',
  's2v character build <dir> [--dry-run] [--reset-derived] [--max-memory-gb N]',
  's2v character review <dir>',
  's2v character approve <dir> <item>... | --all [--except <item>...] [--reset-derived]',
  's2v character redo <dir> <item>... [--seed N]',
  's2v character missing <script.md> [--apply]',
  's2v character import <ymm4 folder|zip> --out <characters/id> [--name <character>]',
  's2v new <dir> [--lang ko|ja|en]   (a new video folder with a starter script)',
  's2v pick <image>   (mark a spot on an image)',
  's2v doctor   (is this machine ready?)',
  's2v tts-server start   (keep the TTS server running)',
];
