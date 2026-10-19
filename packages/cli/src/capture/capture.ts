/**
 * `s2v capture` (S5 plan): one web page, its picture and what it says, with requests held to the
 * allowed hosts. The browser resolves only the pinned hosts; every request it makes is checked
 * again here before it goes out (Fetch), and picture bytes are hashed on the way in.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { isIpLiteralHost, resolverRules } from './address.js';
import { writeAtomic } from './files.js';
import { launchBrowser, type Browser, type Cdp, type Json } from './cdp.js';
import {
  buildJson,
  dataUrlBytes,
  emptyJson,
  EXTRACT,
  type Box,
  type CaptureJson,
  type RawPage,
} from './extract.js';

export const IMAGE_MAX = 20 * 1024 * 1024;
export const IMAGE_BUDGET = 200 * 1024 * 1024;
const GRACE_MS = 5000;
const IDLE_MS = 500;
const MAX_SIDE = 16384;
export const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

export interface CaptureOptions {
  url: URL;
  /** Allowed host → the address the browser uses for it. */
  pinned: Map<string, string>;
  width: number;
  height: number;
  selector?: string;
  timeoutMs: number;
  assetsDir?: string;
  browserPath: string;
  sandbox: boolean;
  log: (m: string) => void;
  /** Tests only (not reachable from the command line): more browser switches. */
  extraArgs?: string[];
  /** Tests only: leave WebRTC to the browser flag alone (to show the flag does the work). */
  keepRtcObjects?: boolean;
  /** Tests only: no WebRTC flag (the positive control). */
  noWebrtcFlag?: boolean;
  /** Tests only: a smaller budget for picture bytes. */
  imageBudget?: number;
  /** Tests only: runs just before the page is read and pictured (`page` runs script in it). */
  beforeStep?: (
    step: 'extract' | 'shot',
    page: (expression: string) => Promise<unknown>,
  ) => Promise<void>;
}

export interface CaptureOutcome {
  /** Null when the capture failed (exit 1); the JSON still says what is known. */
  png: Buffer | null;
  json: CaptureJson;
  error: string | null;
  warnings: string[];
}

const AUTO_ATTACH = {
  autoAttach: true,
  waitForDebuggerOnStart: true,
  flatten: true,
  filter: [
    { type: 'page' },
    { type: 'iframe' },
    { type: 'worker' },
    { type: 'shared_worker' },
    { type: 'service_worker' },
  ],
};
const PATTERNS = [
  { urlPattern: '*', requestStage: 'Request' },
  { urlPattern: '*', resourceType: 'Image', requestStage: 'Response' },
];
const NO_RTC = `for (const k of ['RTCPeerConnection', 'webkitRTCPeerConnection']) { try { delete window[k]; } catch (e) {} }`;
const DROP_HEADERS = new Set(['content-encoding', 'content-length', 'transfer-encoding']);

const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LATE = Symbol('late');
/** `p`, or LATE when `ms` passes first. */
function within<T>(p: Promise<T>, ms: number): Promise<T | typeof LATE> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p,
    new Promise<typeof LATE>((r) => {
      timer = setTimeout(() => r(LATE), Math.max(0, ms));
    }),
  ]).finally(() => clearTimeout(timer));
}

const withoutFragment = (u: string) => {
  const at = u.indexOf('#');
  return at === -1 ? u : u.slice(0, at);
};
const hostOf = (u: string) => {
  try {
    return new URL(u).host || u;
  } catch {
    return u;
  }
};

/** Why a request may not go out, or null when it may (S5 plan 2.3). */
export function requestVerdict(url: string, allowed: ReadonlySet<string>): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'scheme';
  }
  if (u.protocol === 'data:' || u.protocol === 'blob:') return null;
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'scheme';
  if (isIpLiteralHost(u.hostname)) return 'ip literal';
  return allowed.has(u.hostname) ? null : 'host not allowed';
}

export function browserArgs(o: CaptureOptions): string[] {
  return [
    '--no-proxy-server',
    `--host-resolver-rules=${resolverRules(o.pinned)}`,
    ...(o.noWebrtcFlag ? [] : ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp']),
    // no popups at all (measured: window.open gives null). A popup paused for the debugger
    // pauses its same-origin opener too, and a frame committing then crashes the renderer.
    '--block-new-web-contents',
    '--mute-audio',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    ...(o.sandbox ? [] : ['--no-sandbox']),
    ...(o.extraArgs ?? []),
  ];
}

export async function capture(o: CaptureOptions): Promise<CaptureOutcome> {
  const browser = launchBrowser(o.browserPath, browserArgs(o));
  const stop = () => {
    void browser.close().then(() => process.exit(130));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    return await run(browser, o);
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await browser.close();
  }
}

async function run(browser: Browser, o: CaptureOptions): Promise<CaptureOutcome> {
  const cdp: Cdp = browser.cdp;
  const allowed = new Set(o.pinned.keys());
  const warnings: string[] = [];
  const warn = (m: string) => {
    warnings.push(m);
    o.log(`warning: ${m}`);
  };
  const json = emptyJson(o.url.href);
  const fail = (error: string): CaptureOutcome => ({ png: null, json, error, warnings });

  let deadline = Infinity;
  const left = () => deadline - Date.now();
  // in-flight requests (requestId → the session that started it), for "idle". A worker's script
  // starts in its page's session and finishes in the worker's: the id alone is the key.
  const inflight = new Map<string, string>();
  let lastChange = Date.now();
  const firstUrl = new Map<string, string>();
  const docs = new Map<string, { status: number; url: string }>();
  // address → sha256 of what the browser got (null: unknown, or two different bodies)
  const bytes = new Map<string, string | null>();
  const received: string[][] = [];
  let budget = o.imageBudget ?? IMAGE_BUDGET;
  // the main frame's current document (it may move after the first one)
  let mainFrame = '';
  let mainLoader = '';
  let mainUrl = '';
  // called when another document commits in the main frame
  let onMove: (() => void) | null = null;
  // documents the main page asked for and has not finished getting (by request)
  const docRequests = new Map<string, { frame: string; loader: string; url: string }>();
  let main: string | null = null;
  const popups = new Set<string>();
  // one session per target: the first one to attach, the others wait for it
  const targets = new Map<string, Promise<void>>();
  let mainFailed: Error | null = null;
  let markReady!: () => void;
  const ready = new Promise<void>((r) => (markReady = r));
  let markLoaded!: () => void;
  const loaded = new Promise<void>((r) => (markLoaded = r));

  let keepFailed = false;
  /** A picture's bytes into --assets-dir, by content; a failure is a warning. */
  const keep = (sha: string, type: string, body: Buffer) => {
    if (!o.assetsDir) return;
    const path = join(o.assetsDir, `${sha}.${EXT[type] ?? 'bin'}`);
    try {
      mkdirSync(o.assetsDir, { recursive: true });
      if (!existsSync(path)) writeAtomic(path, body);
    } catch (e) {
      // one warning, not one per picture; the temporary file's name says nothing useful
      if (!keepFailed)
        warn(
          `could not keep pictures in --assets-dir ${o.assetsDir} (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`,
        );
      keepFailed = true;
    }
  };
  const record = (urls: string[], sha: string | null) => {
    const bare = urls.map(withoutFragment);
    received.push(bare);
    for (const u of bare) bytes.set(u, bytes.has(u) && bytes.get(u) !== sha ? null : sha);
  };

  const attach = async (p: Json, parent?: string) => {
    const sid: string = p.sessionId;
    const type: string = p.targetInfo.type;
    const send = (m: string, params: Json = {}) => cdp.send(m, params, sid);
    // a worker can come both from the browser and from its page: one session checks it, and
    // the other lets it run (each session holds it) once that one's checks are on
    const first = targets.get(p.targetInfo.targetId);
    if (first) {
      await first;
      await send('Runtime.runIfWaitingForDebugger').catch(() => {});
      await cdp.send('Target.detachFromTarget', { sessionId: sid }, parent).catch(() => {});
      return;
    }
    let settled!: () => void;
    targets.set(p.targetInfo.targetId, new Promise<void>((r) => (settled = r)));
    try {
      await setUp(p, sid, type, send, settled);
    } finally {
      settled();
    }
  };

  const setUp = async (
    p: Json,
    sid: string,
    type: string,
    send: (m: string, params?: Json) => Promise<Json>,
    checked: () => void,
  ) => {
    if (type === 'page') {
      if (main !== null) {
        // a popup despite --block-new-web-contents: everything it asks for fails, then it
        // closes (it must not stay paused: that holds its same-origin opener too)
        popups.add(sid);
        await send('Fetch.enable', {
          patterns: [{ urlPattern: '*', requestStage: 'Request' }],
        }).catch(() => {});
        await send('Runtime.runIfWaitingForDebugger').catch(() => {});
        await cdp.send('Target.closeTarget', { targetId: p.targetInfo.targetId }).catch(() => {});
        return;
      }
      main = sid;
    }
    const framed = type === 'page' || type === 'iframe';
    if (!framed) {
      // a worker's session handles commands in order, and a new service worker answers
      // Network.enable only once it runs (measured: sent first, it holds everything behind
      // it). So: Fetch (handled in the browser, answered at once) before the worker is let go,
      // Network after. A dedicated worker has no Fetch: its page's checks its requests.
      const [fetch] = await Promise.allSettled([
        send('Fetch.enable', { patterns: PATTERNS }),
        send('Target.setAutoAttach', AUTO_ATTACH),
      ]);
      if (fetch.status === 'rejected' && type !== 'worker') {
        // a service or shared worker can be checked: one that cannot be does not run
        await cdp.send('Target.closeTarget', { targetId: p.targetInfo.targetId }).catch(() => {});
        return;
      }
      checked();
      await Promise.allSettled([send('Runtime.runIfWaitingForDebugger'), send('Network.enable')]);
      return;
    }
    try {
      // requests are checked before anything in the target runs
      await send('Network.enable');
      await send('Fetch.enable', { patterns: PATTERNS });
      await send('Page.enable');
      if (!o.keepRtcObjects)
        await send('Page.addScriptToEvaluateOnNewDocument', { source: NO_RTC });
      if (sid === main)
        await send('Emulation.setDeviceMetricsOverride', {
          width: o.width,
          height: o.height,
          deviceScaleFactor: 1,
          mobile: false,
        });
      await send('Target.setAutoAttach', AUTO_ATTACH);
    } catch (e) {
      if (sid === main) mainFailed = e as Error;
      else {
        // a frame that cannot be checked does not run
        await cdp.send('Target.closeTarget', { targetId: p.targetInfo.targetId }).catch(() => {});
        return;
      }
    }
    if (sid === main) markReady();
    checked();
    await send('Runtime.runIfWaitingForDebugger').catch(() => {});
  };

  const image = async (p: Json, sid: string) => {
    const send = (m: string, params: Json = {}) => cdp.send(m, params, sid);
    const id: string = p.requestId;
    const urls = [p.request.url as string];
    const first = firstUrl.get(p.networkId);
    if (first && first !== urls[0]) urls.push(first);
    const status: number = p.responseStatusCode;
    if (p.responseErrorReason || (status >= 300 && status < 400)) {
      await send('Fetch.continueRequest', { requestId: id }).catch(() => {});
      return;
    }
    const headers: { name: string; value: string }[] = p.responseHeaders ?? [];
    const header = (n: string) => headers.find((h) => h.name.toLowerCase() === n)?.value;
    const length = header('content-length');
    // the length on the wire; with a content coding the bytes read are the decoded ones
    const coding = (header('content-encoding') ?? 'identity').trim().toLowerCase();
    const known =
      coding === 'identity' && length !== undefined && /^\d+$/.test(length.trim())
        ? Number(length)
        : null;
    if (
      left() <= 0 ||
      /^multipart\//i.test(header('content-type') ?? '') ||
      (known !== null && (known > IMAGE_MAX || known > budget))
    ) {
      // its bytes are not read: it still shows
      record(urls, null);
      await send('Fetch.continueRequest', { requestId: id }).catch(() => {});
      return;
    }
    // a known length is set aside now (before any await), so pictures read side by side cannot
    // all pass on the same remaining budget; what is not used goes back at the end
    const reserved = known ?? 0;
    budget -= reserved;
    let size = 0;
    const settleBudget = () => {
      budget += reserved - Math.min(size, reserved);
    };
    let handle: string;
    try {
      handle = (await send('Fetch.takeResponseBodyAsStream', { requestId: id })).stream;
    } catch {
      settleBudget();
      record(urls, null);
      await send('Fetch.continueRequest', { requestId: id }).catch(() => {});
      return;
    }
    const parts: Buffer[] = [];
    let cut: string | null = null;
    for (;;) {
      const r = await within(send('IO.read', { handle, size: 1 << 20 }), left()).catch(() => null);
      if (r === LATE) {
        cut = 'the time ran out';
        break;
      }
      if (r === null) {
        cut = 'its body could not be read';
        break;
      }
      const chunk = Buffer.from(r.data as string, r.base64Encoded ? 'base64' : 'utf8');
      size += chunk.length;
      // the budget counts bytes read, so a picture cut later still spends what it took
      budget -= Math.max(0, Math.min(chunk.length, size - reserved));
      if (size > IMAGE_MAX) {
        cut = 'over 20 MB';
        break;
      }
      // only bytes beyond its own reservation can run the shared budget out
      if (size > reserved && budget < 0) {
        cut = 'over the byte budget for all pictures';
        break;
      }
      parts.push(chunk);
      if (r.eof) break;
    }
    await send('IO.close', { handle }).catch(() => {});
    settleBudget();
    if (cut) {
      record(urls, null);
      warn(`a picture is left out of the capture (${cut}): ${urls[0]}`);
      await send('Fetch.failRequest', { requestId: id, errorReason: 'Failed' }).catch(() => {});
      return;
    }
    const body = Buffer.concat(parts);
    const sha = createHash('sha256').update(body).digest('hex');
    record(urls, sha);
    // the page still gets its picture whatever happens to the copy
    keep(sha, (header('content-type') ?? '').split(';')[0]!.trim().toLowerCase(), body);
    // a taken body can only be given back whole (measured: continuing leaves it hanging)
    const phrase: string = p.responseStatusText ?? '';
    await send('Fetch.fulfillRequest', {
      requestId: id,
      responseCode: status,
      ...(phrase ? { responsePhrase: phrase } : {}),
      responseHeaders: headers.filter((h) => !DROP_HEADERS.has(h.name.toLowerCase())),
      body: body.toString('base64'),
    }).catch(() => {});
  };

  const paused = async (p: Json, sid: string) => {
    if (p.responseStatusCode !== undefined || p.responseErrorReason !== undefined)
      return image(p, sid);
    const why = popups.has(sid) ? 'popup' : requestVerdict(p.request.url, allowed);
    if (why === null) {
      await cdp.send('Fetch.continueRequest', { requestId: p.requestId }, sid).catch(() => {});
      return;
    }
    json.blocked.push({ url: p.request.url, reason: why });
    await cdp
      .send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' }, sid)
      .catch(() => {});
  };

  cdp.on((e) => {
    const p = e.params;
    switch (e.method) {
      case 'Target.attachedToTarget':
        void attach(p, e.sessionId);
        break;
      case 'Target.detachedFromTarget':
        // what a closed worker or frame had open never finishes
        for (const [k, sid] of inflight) if (sid === p.sessionId) inflight.delete(k);
        lastChange = Date.now();
        break;
      case 'Fetch.requestPaused':
        void paused(p, e.sessionId!);
        break;
      case 'Network.requestWillBeSent':
        if (!firstUrl.has(p.requestId)) firstUrl.set(p.requestId, p.request.url);
        if (!inflight.has(p.requestId)) inflight.set(p.requestId, e.sessionId ?? '');
        if (e.sessionId === main && p.type === 'Document')
          docRequests.set(p.requestId, {
            frame: p.frameId,
            loader: p.loaderId,
            url: p.request.url,
          });
        lastChange = Date.now();
        break;
      case 'Network.loadingFinished':
      case 'Network.loadingFailed':
        inflight.delete(p.requestId);
        docRequests.delete(p.requestId);
        lastChange = Date.now();
        break;
      case 'Network.responseReceived':
        if (e.sessionId === main && p.type === 'Document')
          docs.set(p.requestId, { status: p.response.status, url: p.response.url });
        break;
      case 'Network.webSocketCreated': {
        let host = '';
        try {
          host = new URL(p.url).hostname;
        } catch {
          /* not a URL: host stays empty */
        }
        json.websockets.push({ url: p.url, host });
        break;
      }
      case 'Page.frameNavigated':
        if (e.sessionId === main && !p.frame.parentId) {
          // a new document committed (not a same-document move: pushState, a hash, a 204);
          // a load still on its way leaves the old one read and pictured as one
          const changed = p.frame.loaderId !== mainLoader;
          mainFrame = p.frame.id;
          mainLoader = p.frame.loaderId;
          mainUrl = p.frame.url;
          if (changed) onMove?.();
        }
        break;
      case 'Page.loadEventFired':
        if (e.sessionId === main) markLoaded();
        break;
    }
  });

  try {
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'deny' });
    await cdp.send('Target.setDiscoverTargets', { discover: true });
    await cdp.send('Target.setAutoAttach', AUTO_ATTACH);
    await cdp.send('Target.createTarget', { url: 'about:blank' });
  } catch (e) {
    const more = browser.stderr();
    return fail(`the browser did not start: ${(e as Error).message}${more ? `\n${more}` : ''}`);
  }
  if ((await within(ready, 15_000)) === LATE) return fail('the browser did not open a page');
  if (mainFailed) return fail(`the page could not be set up: ${(mainFailed as Error).message}`);
  const send = (m: string, params: Json = {}) => cdp.send(m, params, main!);

  deadline = Date.now() + o.timeoutMs;
  const nav = await within(send('Page.navigate', { url: o.url.href }), left());
  if (nav === LATE) return fail(`the page did not start loading within ${o.timeoutMs / 1000} s`);
  const blockedNote = () =>
    json.blocked.length
      ? ` — blocked: ${[...new Set(json.blocked.map((b) => hostOf(b.url)))].join(', ')} (add with --allow-host if it is the same site)`
      : '';
  if (nav.errorText) return fail(`the page did not load (${nav.errorText})${blockedNote()}`);
  let idle = (await within(loaded, left())) !== LATE;
  if (!idle) warn('the page did not finish loading within --timeout; captured as it was');
  const settle = async (ms: number) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (inflight.size === 0 && Date.now() - lastChange >= IDLE_MS) return true;
      await sleep(50);
    }
    return false;
  };
  if (idle && !(await settle(left()))) {
    idle = false;
    warn('the page kept loading until --timeout; captured as it was');
  }
  // the document now shown: the first one, or where the page went (a script, a refresh, a form)
  const shown = () => {
    const loader = mainLoader || nav.loaderId;
    return { loader, doc: docs.get(loader), url: mainUrl };
  };
  const judge = (): string | null => {
    const { loader, doc, url } = shown();
    json.status = doc?.status ?? null;
    if (doc) json.url = doc.url;
    const moved = loader !== nav.loaderId ? ` after moving to ${url || 'another page'}` : '';
    if (url.startsWith('chrome-error:') || !doc)
      return `the page did not load${moved}${blockedNote()}`;
    if (doc.status < 200 || doc.status > 299)
      return `the page answered HTTP ${doc.status}${moved}${blockedNote()}`;
    return null;
  };
  const wrong = judge();
  if (wrong) return fail(wrong);
  const loaderAtStart = shown().loader;
  // where the main frame is still on its way to, if anywhere (the browser holds the page's
  // commands until it gets there, so there is nothing to read in the meantime)
  const goingTo = () =>
    [...docRequests.values()].find(
      (d) => d.frame === (mainFrame || nav.frameId) && d.loader !== shown().loader,
    )?.url;
  const going = !idle && goingTo();
  if (going) return fail(`the page was still moving to ${going} when --timeout came`);
  // past the deadline, each later step gets a grace
  const stepMs = () => (left() > 0 ? left() : GRACE_MS);
  // s2v's own reading runs in a world of its own: the page's scripts cannot change the builtins
  // it uses (a polyfill that replaces Array.prototype.push would empty the text)
  let world: number;
  try {
    const w = await within(
      send('Page.createIsolatedWorld', { frameId: mainFrame || nav.frameId, worldName: 's2v' }),
      stepMs(),
    );
    if (w === LATE) {
      const to = goingTo();
      return fail(to ? `the page was still moving to ${to}` : 'the page did not answer in time');
    }
    world = w.executionContextId;
  } catch (e) {
    return fail(`could not read the page: ${(e as Error).message}`);
  }
  const fonts = async () => {
    const r = await within(
      send('Runtime.evaluate', {
        expression: 'document.fonts.ready.then(() => true)',
        awaitPromise: true,
        contextId: world,
      }),
      stepMs(),
    ).catch(() => null);
    if (r === LATE || r === null) warn('web fonts were not ready; captured without waiting');
  };
  await fonts();

  const evaluate = async (expression: string): Promise<Json> => {
    const r = await within(
      send('Runtime.evaluate', { expression, returnByValue: true, contextId: world }),
      stepMs(),
    );
    if (r === LATE) throw new Error('the page did not answer in time');
    if (r.exceptionDetails)
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  let clip: Box | null = null;
  if (o.selector !== undefined) {
    const measure = async (): Promise<Box | null> => {
      const r = await evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(o.selector)});
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return [b.left + scrollX, b.top + scrollY, b.right + scrollX, b.bottom + scrollY];
      })()`);
      if (!r) return null;
      const [x0, y0, x1, y1] = r as number[];
      const x = Math.floor(x0!);
      const y = Math.floor(y0!);
      return [x, y, Math.ceil(x1!) - x, Math.ceil(y1!) - y];
    };
    try {
      clip = await measure();
    } catch (e) {
      return fail(`--selector: ${(e as Error).message}`);
    }
    if (!clip) return fail(`nothing on the page matches --selector ${o.selector}`);
    if (clip[0] + clip[2] > MAX_SIDE) {
      warn(
        `--selector reaches ${clip[0] + clip[2]} px across; the capture stops at ${MAX_SIDE} px`,
      );
      clip[2] = Math.max(0, MAX_SIDE - clip[0]);
    }
    if (clip[3] + clip[1] > o.height) {
      // taller than the window: grow it so lazy pictures below load, then wait again
      let height = clip[1] + clip[3];
      if (height > MAX_SIDE) {
        warn(`--selector reaches ${height} px down; the capture stops at ${MAX_SIDE} px`);
        height = MAX_SIDE;
      }
      await send('Emulation.setDeviceMetricsOverride', {
        width: o.width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      lastChange = Date.now();
      if (!(await settle(stepMs()))) {
        if (idle) warn('the page kept loading after growing to fit --selector; captured as it was');
        idle = false;
      }
      // a page may answer the new size by going elsewhere: judged like any move
      if (shown().loader !== loaderAtStart)
        return fail(
          judge() ?? `the page moved to ${mainUrl || 'another page'} when it was resized`,
        );
      await fonts();
      clip = (await measure().catch(() => null)) ?? clip;
      clip[2] = Math.min(clip[2], MAX_SIDE - clip[0]);
      clip[3] = Math.min(clip[3], MAX_SIDE - clip[1]);
    }
    if (clip[2] <= 0 || clip[3] <= 0) return fail(`--selector ${o.selector} has no size`);
  }

  // from here on, the page going elsewhere ends the run at once (not at the deadline)
  const MOVED = Symbol('moved');
  const moved = new Promise<typeof MOVED>((r) => (onMove = () => r(MOVED)));
  const movedFail = () => {
    judge();
    return fail(`the page moved to ${mainUrl || 'another page'} while it was captured`);
  };
  // a command the browser refused because of a move can come back before the move itself
  const movedAfterAll = async () =>
    shown().loader !== loaderAtStart || (await within(moved, 1000)) === MOVED;
  const page = (expression: string) => send('Runtime.evaluate', { expression });
  await o.beforeStep?.('extract', page);
  let raw: RawPage;
  try {
    const r = await Promise.race([evaluate(EXTRACT), moved]);
    if (r === MOVED) return movedFail();
    raw = r as RawPage;
  } catch (e) {
    if (await movedAfterAll()) return movedFail();
    return fail(`could not read the page: ${(e as Error).message}`);
  }
  await o.beforeStep?.('shot', page);
  const taken = send('Page.captureScreenshot', {
    format: 'png',
    ...(clip
      ? {
          clip: { x: clip[0], y: clip[1], width: clip[2], height: clip[3], scale: 1 },
          captureBeyondViewport: true,
        }
      : {}),
  });
  const shot = await within(Promise.race([taken, moved]), stepMs()).catch((e: Error) => e);
  if (shot === MOVED) return movedFail();
  if (shot === LATE) return fail('the page did not give its picture in time');
  if (shot instanceof Error) {
    if (await movedAfterAll()) return movedFail();
    return fail(`could not take the picture: ${shot.message}`);
  }
  // what was read and what was pictured must be the same document
  if (shown().loader !== loaderAtStart) return movedFail();
  const region: Box = clip ?? [raw.scroll[0], raw.scroll[1], o.width, o.height];
  const full = buildJson(raw, {
    status: json.status,
    idle,
    region,
    bytes: (src) => bytes.get(withoutFragment(src)) ?? null,
    received,
    blocked: json.blocked,
    websockets: json.websockets,
    hashable:
      idle &&
      o.selector === undefined &&
      o.width === DEFAULT_VIEWPORT.width &&
      o.height === DEFAULT_VIEWPORT.height,
  });
  if (o.assetsDir)
    for (const i of full.images)
      if (i.src.startsWith('data:') && i.sha256) {
        // a data: picture is saved like a fetched one
        keep(i.sha256, /^data:([^;,]*)/.exec(i.src)![1]!.toLowerCase(), dataUrlBytes(i.src)!);
      }
  return { png: Buffer.from(shot.data as string, 'base64'), json: full, error: null, warnings };
}
