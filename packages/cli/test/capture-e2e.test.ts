/**
 * `s2v capture` against a real browser (S5 plan 4): a local https server stands in for
 * example.test (allowed) and other.test (not), both pinned to loopback for the test only. Every
 * blocking check has a positive control: the same request to an allowed host does arrive.
 * Runs when CAPTURE_E2E=1 (CI's render job); a missing browser is then a failure, not a skip.
 */
import { execFileSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { createSocket, type Socket } from 'node:dgram';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { headlessBrowserPath } from '@script2video/renderer-remotion';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { capture, IMAGE_MAX, type CaptureOptions } from '../src/capture/capture.js';

const E2E = process.env.CAPTURE_E2E === '1';
const ff = (args: string[]) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

describe.skipIf(!E2E)('capture in a browser', { timeout: 120_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 's2v-capture-e2e-'));
  let server: Server;
  let port = 0;
  let browserPath = '';
  let spki = '';
  let red: Buffer;
  let blue: Buffer;
  const hits: { host: string; path: string }[] = [];
  const routes = new Map<string, Handler>();
  const E = () => `https://example.test:${port}`;
  const O = () => `https://other.test:${port}`;
  const reached = (host: string, path?: string) =>
    hits.filter((h) => h.host === host && (path === undefined || h.path === path)).length;
  const html =
    (body: string): Handler =>
    (_req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><html lang="ko"><meta charset="utf-8">${body}`);
    };
  const png =
    (bytes: () => Buffer, headers: Record<string, string> = {}): Handler =>
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'image/png', ...headers });
      res.end(bytes());
    };
  const page = (path: string, body: string) => routes.set(path, html(body));

  const run = (path: string, more: Partial<CaptureOptions> = {}, allow: string[] = []) =>
    capture({
      url: new URL(`${E()}${path}`),
      pinned: new Map(['example.test', ...allow].map((h) => [h, '127.0.0.1'])),
      width: 1280,
      height: 800,
      timeoutMs: 8000,
      browserPath,
      sandbox: process.env.S2V_CAPTURE_NO_SANDBOX !== '1',
      log: () => {},
      extraArgs: [`--ignore-certificate-errors-spki-list=${spki}`],
      ...more,
    });

  beforeAll(async () => {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
      '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '2',
      '-subj', '/CN=example.test',
      '-addext', 'subjectAltName=DNS:example.test,DNS:other.test,IP:127.0.0.1',
    ], { stdio: 'pipe' }); // prettier-ignore
    const cert = readFileSync(join(dir, 'cert.pem'));
    spki = createHash('sha256')
      .update(new X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' }))
      .digest('base64');
    for (const [name, color] of [
      ['red', 'red'],
      ['blue', 'blue'],
    ] as const)
      ff([
        '-f',
        'lavfi',
        '-i',
        `color=c=${color}:s=40x40`,
        '-frames:v',
        '1',
        join(dir, `${name}.png`),
      ]);
    red = readFileSync(join(dir, 'red.png'));
    blue = readFileSync(join(dir, 'blue.png'));
    server = createServer({ key: readFileSync(join(dir, 'key.pem')), cert }, (req, res) => {
      const host = (req.headers.host ?? '').replace(/:\d+$/, '');
      const path = req.url ?? '/';
      hits.push({ host, path });
      const route = routes.get(path.split('?')[0]!);
      if (route) route(req, res);
      else {
        res.statusCode = 404;
        res.end();
      }
    });
    server.on('upgrade', (req, socket) => {
      hits.push({
        host: (req.headers.host ?? '').replace(/:\d+$/, ''),
        path: `upgrade ${req.url}`,
      });
      socket.destroy();
    });
    // both stacks, so an IPv4-mapped address would land here too
    await new Promise<void>((r) => server.listen(0, '::', r));
    port = (server.address() as { port: number }).port;
    browserPath = await headlessBrowserPath();
  });
  afterAll(() => server?.close());

  const size = (p: Buffer) => [p.readUInt32BE(16), p.readUInt32BE(20)];
  /** Mean red and blue of a region of a PNG. */
  const meanRB = (file: Buffer, crop: string) => {
    const f = join(dir, `shot-${Date.now()}.png`);
    writeFileSync(f, file);
    const out = execFileSync('ffmpeg', ['-v', 'error', '-i', f, '-vf', `crop=${crop},scale=1:1`,
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']); // prettier-ignore
    return { r: out[0]!, b: out[2]! };
  };

  it('blocks every way out to a host not allowed or an IP literal; the same to an allowed host arrives', async () => {
    const ip = `https://127.0.0.1:${port}`;
    const ip6 = `https://[::ffff:127.0.0.1]:${port}`;
    routes.set('/s.css', (_q, s) => s.end('body{}'));
    routes.set('/i.css', (_q, s) => s.end('body{}'));
    routes.set('/f.woff2', (_q, s) => s.end(''));
    routes.set(
      '/a.png',
      png(() => red),
    );
    routes.set(
      '/r.png',
      png(() => red),
    );
    routes.set('/fetch', (_q, s) => s.end('ok'));
    routes.set('/wfetch', (_q, s) => s.end('ok'));
    routes.set('/swfetch', (_q, s) => s.end('ok'));
    routes.set('/beacon', (_q, s) => s.end());
    routes.set('/hold', (_q, s) => {
      const until = Date.now() + 4000;
      const t = setInterval(() => {
        if (Date.now() > until || reached('example.test', '/swfetch') > 0) {
          clearInterval(t);
          s.end();
        }
      }, 50);
    });
    routes.set('/redir', (_q, s) => {
      s.writeHead(302, { location: `${O()}/r.png` });
      s.end();
    });
    page('/frame', '<p>frame</p>');
    page('/pop', '<p>pop</p>');
    routes.set('/w.js', (_q, s) => {
      s.setHeader('content-type', 'text/javascript');
      s.end(
        `for (const u of ['${O()}/wfetch', '${ip}/wfetch', '${E()}/wfetch']) fetch(u).catch(() => {});`,
      );
    });
    routes.set('/sh.js', (_q, s) => {
      s.setHeader('content-type', 'text/javascript');
      s.end(`fetch('${ip}/shfetch').catch(() => {});`);
    });
    routes.set('/sw.js', (_q, s) => {
      s.setHeader('content-type', 'text/javascript');
      s.end(`self.addEventListener('install', (e) => e.waitUntil(Promise.allSettled(
        ['${O()}/swfetch', '${ip}/swfetch', '${E()}/swfetch'].map((u) => fetch(u)))));`);
    });
    const both = (path: string) => [`${O()}${path}`, `${E()}${path}`];
    page(
      '/block',
      `<title>block</title>
      ${both('/s.css')
        .map((u) => `<link rel="stylesheet" href="${u}">`)
        .join('')}
      <style>@import url("${O()}/i.css"); @import url("${E()}/i.css");</style>
      <style>@font-face { font-family: F; src: url("${O()}/f.woff2"); }
        @font-face { font-family: G; src: url("${E()}/f.woff2"); } .f { font-family: F } .g { font-family: G }</style>
      <p class="f">f</p><p class="g">g</p>
      ${[...both('/a.png'), `${ip}/a.png`, `${ip6}/a.png`, `${E()}/redir`].map((u) => `<img src="${u}">`).join('')}
      ${both('/frame')
        .map((u) => `<iframe src="${u}"></iframe>`)
        .join('')}
      <script>
        for (const u of ['${O()}/fetch', '${ip}/fetch', '${ip6}/fetch', '${E()}/fetch']) fetch(u).catch(() => {});
        for (const u of ['wss://other.test:${port}/ws', 'wss://127.0.0.1:${port}/ws', 'wss://example.test:${port}/ws'])
          try { new WebSocket(u); } catch (e) {}
        new Worker('/w.js');
        new SharedWorker('/sh.js');
        navigator.serviceWorker.register('/sw.js');
        fetch('/hold'); // answered once the service worker has fetched (or after 4 s)
        for (const u of ['${O()}/pop', '${E()}/pop']) document.body.append(' open:' + window.open(u));
        navigator.sendBeacon('${O()}/beacon');
        navigator.sendBeacon('${E()}/beacon');
      </script>`,
    );
    const paths = ['/s.css', '/i.css', '/f.woff2', '/a.png', '/frame', '/fetch', '/wfetch',
      '/swfetch', '/beacon', 'upgrade /ws']; // prettier-ignore

    // positive control: with other.test allowed, every one of these reaches it
    hits.length = 0;
    const open = await run('/block', {}, ['other.test']);
    expect(open.error).toBeNull();
    for (const p of [...paths, '/r.png']) expect([p, reached('other.test', p)]).not.toEqual([p, 0]);

    hits.length = 0;
    const r = await run('/block');
    expect(r.error).toBeNull();
    // workers and all, the page settles
    expect(r.json.idle).toBe(true);
    // the allowed host got each of them (the page did make them)
    for (const p of [...paths, '/redir'])
      expect([p, reached('example.test', p)]).not.toEqual([p, 0]);
    // nothing else got anything (a popup never runs, whichever host)
    expect(hits.filter((h) => h.host !== 'example.test')).toEqual([]);
    expect(reached('example.test', '/pop')).toBe(0);
    expect(r.json.text.some((t) => t.text.includes('open:null open:null'))).toBe(true);
    const reasons = new Map(r.json.blocked.map((b) => [b.url, b.reason]));
    expect(reasons.get(`${O()}/a.png`)).toBe('host not allowed');
    expect(reasons.get(`${ip}/fetch`)).toBe('ip literal');
    expect(reasons.get(`${O()}/r.png`)).toBe('host not allowed');
    // workers' requests are checked too, not only held by the resolver
    expect(reasons.get(`${ip}/wfetch`)).toBe('ip literal');
    expect(reasons.get(`${ip}/swfetch`)).toBe('ip literal');
    expect(reasons.get(`${ip}/shfetch`)).toBe('ip literal');
    expect(r.json.websockets.map((w) => w.host).sort()).toEqual(
      ['127.0.0.1', 'example.test', 'other.test'].sort(),
    );
  });

  it('turns WebRTC off (the flag, not only the missing objects) and WebTransport reaches allowed hosts only', async () => {
    const udp = async () => {
      const s: Socket = createSocket('udp4');
      let n = 0;
      s.on('message', () => n++);
      await new Promise<void>((r) => s.bind(0, '127.0.0.1', r));
      return { port: s.address().port, count: () => n, close: () => s.close() };
    };
    const rtc = await udp();
    const fp = Array.from({ length: 32 }, () => 'AB').join(':');
    page(
      '/rtc',
      `<script>
      (async () => {
        const pc = new RTCPeerConnection();
        await pc.setRemoteDescription({ type: 'offer', sdp: [
          'v=0', 'o=- 1 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'a=group:BUNDLE 0',
          'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0',
          'a=ice-ufrag:abcd', 'a=ice-pwd:abcdefghijklmnopqrstuvwx', 'a=fingerprint:sha-256 ${fp}',
          'a=setup:actpass', 'a=mid:0', 'a=sctp-port:5000',
          'a=candidate:1 1 udp 2130706431 127.0.0.1 ${rtc.port} typ host', ''].join('\\r\\n') });
        await pc.setLocalDescription(await pc.createAnswer());
        window.pc = pc;
      })();
      </script><p>rtc</p>`,
    );
    const slow = { timeoutMs: 3000 };
    // control: without the flag the browser does send to the candidate
    await run('/rtc', { ...slow, keepRtcObjects: true, noWebrtcFlag: true });
    const control = rtc.count();
    expect(control).toBeGreaterThan(0);
    await run('/rtc', { ...slow, keepRtcObjects: true });
    expect(rtc.count() - control).toBe(0);
    rtc.close();

    const [allowed, other, literal] = [await udp(), await udp(), await udp()];
    page(
      '/wt',
      `<script>
      for (const u of ['https://example.test:${allowed.port}/', 'https://other.test:${other.port}/',
        'https://127.0.0.1:${literal.port}/'])
        try { new WebTransport(u).ready.catch(() => {}); } catch (e) {}
      </script><p>wt</p>`,
    );
    await run('/wt', slow);
    expect(allowed.count()).toBeGreaterThan(0);
    expect([other.count(), literal.count()]).toEqual([0, 0]);
    for (const s of [allowed, other, literal]) s.close();
  });

  it('takes the picture and the text: size, selector, blocks, ruby, shadow DOM, frames, pictures', async () => {
    page('/inner', '<p>안쪽 문서</p>');
    routes.set(
      '/red.png',
      png(() => red),
    );
    routes.set(
      '/blue.png',
      png(() => blue),
    );
    page(
      '/text',
      `<title> 시험  페이지 </title>
      <style>#bg { width: 30px; height: 30px; background-image: url("/blue.png") }
        #ps::before { content: url("/red.png") }</style>
      <h1>제목 <ruby>漢字<rp>(</rp><rt>かんじ</rt><rp>)</rp></ruby></h1>
      <div>바깥 글 <p>안쪽&nbsp;문단<br>둘째   줄</p> 꼬리</div>
      <ul><li>하나</li><li>둘<div>속</div></li></ul>
      <p style="display:none">숨김</p><p aria-hidden="true">숨김</p><span style="visibility:hidden">숨김</span>
      <div id="host"></div>
      <script>document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = '<p>그림자 안</p>';</script>
      <iframe src="/inner" style="border:0"></iframe><iframe src="${O()}/x"></iframe><canvas width="20" height="20"></canvas>
      <picture><source srcset="/blue.png"><img src="/red.png" alt=" 그림 "></picture>
      <div id="bg"></div><div id="ps"></div>
      <svg width="20" height="20"><image href="/red.png" width="20" height="20"/></svg>
      <video poster="/blue.png" width="20" height="20"></video>
      <section id="box" style="position:absolute;left:300px;top:20px;width:200px;height:100px">상자</section>`,
    );
    const assets = join(dir, 'assets');
    const r = await run('/text', { assetsDir: assets });
    expect(r.error).toBeNull();
    expect(size(r.png!)).toEqual([1280, 800]);
    const j = r.json;
    expect([j.title, j.lang, j.status, j.idle]).toEqual(['시험 페이지', 'ko', 200, true]);
    expect(j.text.map((t) => [t.kind, t.text])).toEqual([
      ['heading', '제목 漢字'],
      ['paragraph', '바깥 글'],
      ['paragraph', '안쪽 문단\n둘째 줄'],
      ['paragraph', '꼬리'],
      ['list-item', '하나'],
      ['list-item', '둘'],
      ['list-item', '속'],
      ['paragraph', '그림자 안'],
      ['paragraph', '안쪽 문서'],
      ['paragraph', '상자'],
    ]);
    expect(j.text[0]!.ruby).toEqual([{ base: '漢字', reading: 'かんじ' }]);
    const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
    expect(j.images.map((i) => [i.kind, i.sha256])).toEqual([
      ['picture', sha(blue)],
      ['background', sha(blue)],
      ['pseudo', sha(red)],
      ['svg-image', sha(red)],
      ['video-poster', sha(blue)],
    ]);
    expect(j.images[0]!.alt).toBe('그림');
    expect(j.images.every((i) => i.inCapture && i.bbox.every(Number.isInteger))).toBe(true);
    expect(readdirSync(assets).sort()).toEqual([`${sha(blue)}.png`, `${sha(red)}.png`].sort());
    expect(j.opaque.map((o) => o.kind)).toEqual(['iframe', 'canvas', 'video']);
    // the img's own src was not used (the picture chose its source)
    expect(j.notShown).toEqual([]);
    expect(j.contentHash).toMatch(/^[0-9a-f]{64}$/);

    const sel = await run('/text', { selector: '#box' });
    expect(size(sel.png!)).toEqual([200, 100]);
    expect(sel.json.contentHash).toBeNull();
    expect((await run('/text', { selector: '#nothing' })).error).toMatch(/matches/);
  });

  it('reads picture bytes whatever their transfer, gives them back to the page, and leaves out what it cannot', async () => {
    const chunked: Handler = (_q, s) => {
      s.writeHead(200, { 'content-type': 'image/png' });
      s.write(red.subarray(0, 10));
      s.end(red.subarray(10));
    };
    routes.set('/chunked.png', chunked);
    routes.set(
      '/gzip.png',
      png(() => gzipSync(blue), { 'content-encoding': 'gzip' }),
    );
    // compressed with its length on the wire (gzip_static): the length is not the bytes read
    const zipped = gzipSync(red);
    // and one that grows when decoded (an SVG): the decoded bytes are more than the length
    const svg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40">${'<rect width="40" height="40" fill="red"/>'.repeat(200)}</svg>`,
    );
    const svgz = gzipSync(svg);
    routes.set('/gzip-len.svg', (_q, res) => {
      res.writeHead(200, {
        'content-type': 'image/svg+xml',
        'content-encoding': 'gzip',
        'content-length': String(svgz.length),
      });
      res.end(svgz);
    });
    routes.set(
      '/gzip-len.png',
      png(() => zipped, { 'content-encoding': 'gzip', 'content-length': String(zipped.length) }),
    );
    routes.set('/big-chunked.png', (_q, s) => {
      s.writeHead(200, { 'content-type': 'image/png' });
      s.write(red);
      s.end(Buffer.alloc(IMAGE_MAX + 1024));
    });
    const big = Buffer.concat([blue, Buffer.alloc(IMAGE_MAX + 1024)]);
    routes.set(
      '/big-known.png',
      png(() => big, { 'content-length': String(big.length) }),
    );
    routes.set(
      '/cors.png',
      png(() => red, { 'access-control-allow-origin': '*' }),
    );
    const watch = `<p id="w"></p><script>
      for (const img of document.images) {
        const say = (m) => document.getElementById('w').append(img.id + ':' + m + ' ');
        img.onload = () => say(img.naturalWidth); img.onerror = () => say('error');
      }</script>`;
    page(
      '/bytes',
      `<img id="c" src="/chunked.png" style="position:absolute;left:0;top:0">
      <img id="g" src="/gzip.png" style="position:absolute;left:100px;top:0"><img id="z" src="/gzip-len.png"><img id="v" src="/gzip-len.svg">
      <img id="b" src="/big-chunked.png"><img id="k" src="/big-known.png">
      <img id="x" crossorigin="anonymous" src="${O()}/cors.png">${watch}`,
    );
    const r = await run('/bytes', {}, ['other.test']);
    expect(r.error).toBeNull();
    const said = r.json.text
      .find((t) => t.text.includes(':'))!
      .text.split(' ')
      .sort();
    expect(said).toEqual(['b:error', 'c:40', 'g:40', 'k:40', 'v:40', 'x:40', 'z:40']);
    expect(r.json.images.find((i) => i.src.endsWith('/gzip-len.svg'))!.sha256).toBe(
      createHash('sha256').update(svg).digest('hex'),
    );
    expect(r.json.images.find((i) => i.src.endsWith('/gzip-len.png'))!.sha256).toBe(
      createHash('sha256').update(red).digest('hex'),
    );
    const by = (s: string) => r.json.images.find((i) => i.src.endsWith(s))!.sha256;
    const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
    expect([by('/chunked.png'), by('/gzip.png'), by('/cors.png')]).toEqual([
      sha(red),
      sha(blue),
      sha(red),
    ]);
    expect([by('/big-chunked.png'), by('/big-known.png')]).toEqual([null, null]);
    expect(r.warnings.some((w) => /left out.*20 MB.*big-chunked/.test(w))).toBe(true);
    // the given-back bytes are what shows
    expect(meanRB(r.png!, '20:20:10:10').r).toBeGreaterThan(200);
    expect(meanRB(r.png!, '20:20:110:10').b).toBeGreaterThan(200);
  });

  it('a stream that never ends, a page that never settles, a font that never comes: captured by the deadline', async () => {
    routes.set('/mjpeg', (_q, s) => {
      s.writeHead(200, { 'content-type': 'multipart/x-mixed-replace; boundary=f' });
      const frame = () =>
        s.write(
          Buffer.concat([
            Buffer.from('--f\r\ncontent-type: image/png\r\n\r\n'),
            red,
            Buffer.from('\r\n'),
          ]),
        );
      frame();
      const t = setInterval(frame, 200);
      s.on('close', () => clearInterval(t));
    });
    routes.set('/hang', () => {}); // never answers
    page('/stream', '<img src="/mjpeg"><p>흐름</p>');
    page(
      '/fonts',
      `<style>@font-face { font-family: H; src: url("/hang") } p { font-family: H }</style><p>글꼴</p>`,
    );
    for (const path of ['/stream', '/fonts']) {
      const t = Date.now();
      const r = await run(path, { timeoutMs: 2000 });
      expect(r.error).toBeNull();
      expect(r.png).not.toBeNull();
      expect(Date.now() - t).toBeLessThan(2000 + 3 * 5000);
      if (path === '/stream') {
        // not read at all (not cut at the deadline): no picture is left out
        expect(r.json.images[0]!.sha256).toBeNull();
        expect(r.warnings.filter((w) => /left out/.test(w))).toEqual([]);
      } else {
        expect([r.json.idle, r.json.contentHash]).toEqual([false, null]);
        expect(r.warnings.some((w) => /fonts/.test(w))).toBe(true);
      }
    }
  });

  it('a tall selector loads its lazy pictures; one that comes after the deadline still shows', async () => {
    routes.set(
      '/lazy.png',
      png(() => red),
    );
    routes.set('/hang', () => {});
    const tall = (extra: string) =>
      `<div id="tall" style="width:600px;height:6000px">위<img loading="lazy" src="/lazy.png" style="margin-top:5600px">
      </div>${extra}<p id="w"></p><script>document.images[0].onload = () => document.getElementById('w').textContent = 'loaded';</script>`;
    page('/tall', tall(''));
    page('/tall-late', tall('<script>fetch("/hang");</script>'));
    const r = await run('/tall', { selector: '#tall' });
    expect(size(r.png!)).toEqual([600, 6000]);
    expect(r.json.images[0]!.sha256).toBe(createHash('sha256').update(red).digest('hex'));
    expect(r.json.contentHash).toBeNull();
    // the page never settles: the window grows after the deadline
    const late = await run('/tall-late', { selector: '#tall', timeoutMs: 1500 });
    expect(late.error).toBeNull();
    expect(late.json.text.some((t) => t.text === 'loaded')).toBe(true);
    expect(late.json.images[0]!.sha256).toBeNull();
  });

  it('the same page twice has the same contentHash, whatever changes each time', async () => {
    let n = 0;
    routes.set(
      '/same.png',
      png(() => red),
    );
    routes.set('/px', (_q, s) => {
      s.writeHead(200, { 'content-type': 'image/png' });
      s.end(++n % 2 ? red : blue); // a tracking pixel: different bytes each time
    });
    routes.set('/hop', (_q, s) => {
      s.writeHead(302, { location: '/blue.png' });
      s.end();
    });
    routes.set(
      '/blue.png',
      png(() => blue),
    );
    page(
      '/twice',
      `<p>같은 글</p><img src="/same.png" id="v">
      <script>document.getElementById('v').src = '/same.png?v=' + Date.now();
        fetch('/blue.png').then((r) => r.blob()).then((b) => { const i = new Image(); i.src = URL.createObjectURL(b); document.body.append(i); });
        const p = new Image(1, 1); p.src = '/px?t=' + Date.now(); p.width = 1; p.height = 1; document.body.append(p);</script>
      <img src="/hop">`,
    );
    const a = await run('/twice');
    const b = await run('/twice');
    expect(a.json.contentHash).not.toBeNull();
    expect(a.json.contentHash).toBe(b.json.contentHash);
    expect(a.json.images.find((i) => i.src.endsWith('/hop'))!.sha256).toBe(
      createHash('sha256').update(blue).digest('hex'),
    );
  });

  it('a picture still arriving at the deadline, or past the byte budget, is cut and said so', async () => {
    routes.set('/drip.png', (_q, s) => {
      s.writeHead(200, { 'content-type': 'image/png' });
      s.write(red.subarray(0, 20)); // and never the rest
    });
    page('/drip', '<img src="/drip.png"><p>물방울</p>');
    const r = await run('/drip', { timeoutMs: 2000 });
    expect(r.error).toBeNull();
    expect(r.warnings.some((w) => /left out.*time ran out.*drip/.test(w))).toBe(true);
    routes.set('/c1.png', (_q, s) => {
      s.writeHead(200, { 'content-type': 'image/png' });
      s.end(red);
    });
    page('/budget', '<img src="/c1.png"><p>예산</p>');
    const b = await run('/budget', { imageBudget: red.length - 1 });
    expect(b.warnings.some((w) => /byte budget.*c1/.test(w))).toBe(true);
    expect(b.json.images[0]!.sha256).toBeNull();
    expect((await run('/budget')).json.images[0]!.sha256).not.toBeNull(); // control
  });

  it('a page with workers settles; one that moves away after loading is judged by where it went', async () => {
    routes.set('/idle-w.js', (_q, s) => {
      s.setHeader('content-type', 'text/javascript');
      s.end('onconnect = () => {};');
    });
    page(
      '/workers',
      `<p>일</p><script>new Worker('/idle-w.js'); new SharedWorker('/idle-w.js');</script>`,
    );
    const w = await run('/workers', { timeoutMs: 6000 });
    expect([w.error, w.json.idle]).toEqual([null, true]);
    expect(w.json.contentHash).not.toBeNull();

    page(
      '/move-out',
      `<p>처음</p><script>addEventListener('load', () => { location = '${O()}/x'; });</script>`,
    );
    page(
      '/move-404',
      `<p>처음</p><script>addEventListener('load', () => { location = '/missing'; });</script>`,
    );
    page('/landing', '<p>도착</p>');
    page(
      '/move-ok',
      `<p>처음</p><script>addEventListener('load', () => { location = '/landing'; });</script>`,
    );
    const out = await run('/move-out');
    expect(out.png).toBeNull();
    expect(out.error).toMatch(/did not load after moving.*other\.test/);
    const missing = await run('/move-404');
    expect([missing.png, missing.json.status]).toEqual([null, 404]);
    const ok = await run('/move-ok');
    expect(ok.error).toBeNull();
    expect(ok.json.url).toBe(`${E()}/landing`);
    expect(ok.json.text.map((t) => t.text)).toEqual(['도착']);
  });

  it('reads the page with its own builtins, and gets the awkward addresses right', async () => {
    routes.set(
      '/one.png',
      png(() => red),
    );
    routes.set(
      '/two.png',
      png(() => blue),
    );
    page('/inner-img', '<body style="margin:0"><img src="/one.png" style="display:block"></body>');
    const svg = `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='100%' height='100%'><rect width='100%' height='100%' fill='red'/></svg>`;
    page(
      '/awkward',
      `<style>#set { width: 20px; height: 20px; background-image: image-set(url("/one.png") 2x, url("/two.png") 1x) }
        #svg { width: 20px; height: 20px; background-image: url("${svg}") }</style>
      <div id="set"></div><div id="svg"></div><img src="/one.png#frag">
      <iframe src="/inner-img" style="position:absolute;left:100px;top:300px;border:5px solid;padding:20px"></iframe>
      <div id="wide" style="width:20000px;height:20px"></div>
      <p>글 하나</p><p>글 둘</p>
      <script>Array.prototype.push = function () { return 0; }; NodeList.prototype[Symbol.iterator] = function* () {};
        Object.defineProperty(document, 'title', { get: () => 'fake' });</script>`,
    );
    const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
    const r = await run('/awkward');
    expect(r.error).toBeNull();
    const j = r.json;
    expect(j.text.map((t) => t.text)).toEqual(['글 하나', '글 둘']);
    expect(j.title).toBe('');
    const set = j.images.find((i) => i.kind === 'background' && !i.src.startsWith('data:'))!;
    expect([set.src.endsWith('/two.png'), set.sha256]).toEqual([true, sha(blue)]);
    expect(j.images.find((i) => i.src.startsWith('data:'))!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(j.images.find((i) => i.src.endsWith('#frag'))!.sha256).toBe(sha(red));
    expect(j.notShown).toEqual([]);
    // inside the frame: its edge + border 5 + padding 20
    const inner = j.images.filter((i) => i.kind === 'img' && i.bbox[1] >= 300)[0]!;
    expect(inner.bbox.slice(0, 2)).toEqual([125, 325]);
    const wide = await run('/awkward', { selector: '#wide' });
    expect(size(wide.png!)[0]).toBe(16384 - 8);
    expect(wide.warnings.some((w) => /across/.test(w))).toBe(true);
  });

  it('a page that changes its address in place is captured; one that moves when resized is judged', async () => {
    const rows = Array.from({ length: 3000 }, (_, i) => `<tr><td>줄 ${i}</td></tr>`).join('');
    routes.set('/no-content', (_q, s) => {
      s.statusCode = 204;
      s.end();
    });
    page(
      '/busy',
      `<table>${rows}</table><script>let n = 0;
      setInterval(() => { history.replaceState(null, '', '?n=' + ++n); location.hash = 'h' + n; }, 20);</script>`,
    );
    page(
      '/busy-204',
      `<table>${rows}</table><script>setInterval(() => { location = '/no-content'; }, 200);</script>`,
    );
    for (const path of ['/busy', '/busy', '/busy-204', '/busy-204']) {
      const r = await run(path);
      expect([path, r.error]).toEqual([path, null]);
      expect(r.json.text.length).toBe(3000);
    }
    page('/landing2', '<p>도착</p>');
    page(
      '/resize-away',
      `<div id="tall" style="height:3000px">긴 것</div>
      <script>addEventListener('resize', () => { location = '/landing2'; });</script>`,
    );
    const t = Date.now();
    const away = await run('/resize-away', { selector: '#tall' });
    expect(away.png).toBeNull();
    expect(away.error).toMatch(/landing2.*resized/);
    expect(Date.now() - t).toBeLessThan(6000);
  });

  it('a page that moves while it is read or pictured fails; one still moving at the deadline says where', async () => {
    page('/moving', '<p>처음</p>');
    page('/moved-here', '<p>다른 곳</p>');
    for (const step of ['extract', 'shot'] as const) {
      const r = await run('/moving', {
        beforeStep: async (s, go) => {
          if (s !== step) return;
          await go("location = '/moved-here'");
          await new Promise((w) => setTimeout(w, 1500));
        },
      });
      // never the first page's words with the other page's picture
      expect([step, r.png, r.error]).toEqual([
        step,
        null,
        expect.stringMatching(/moved-here.*while it was captured/),
      ]);
    }
    routes.set('/never', () => {}); // answers nothing
    page('/leaving', `<p>곧 떠남</p><script>onload = () => { location = '/never'; };</script>`);
    const t = Date.now();
    const r = await run('/leaving', { timeoutMs: 2000 });
    expect(r.error).toMatch(/still moving to \S*\/never/);
    // no grace spent waiting on a page that is not there yet
    expect(Date.now() - t).toBeLessThan(5000);
  });

  it('shares the byte budget fairly and keeps going when --assets-dir cannot be written', async () => {
    const mb = 1024 * 1024;
    const x = Buffer.concat([red, Buffer.alloc(2 * mb - red.length)]);
    routes.set('/x.png', (_q, s) => {
      s.writeHead(200, { 'content-type': 'image/png', 'content-length': String(x.length) });
      s.write(x.subarray(0, mb));
      setTimeout(() => s.end(x.subarray(mb)), 600);
    });
    routes.set('/y.png', (_q, s) => {
      s.writeHead(200, { 'content-type': 'image/png' });
      setTimeout(() => s.end(Buffer.concat([blue, Buffer.alloc(1.5 * mb)])), 100);
    });
    const watch = `<p id="w"></p><script>
      for (const img of document.images) {
        const say = (m) => document.getElementById('w').append(img.id + ':' + m + ' ');
        img.onload = () => say('ok'); img.onerror = () => say('error');
      }</script>`;
    page('/share', `<img id="x" src="/x.png"><img id="y" src="/y.png">${watch}`);
    const r = await run('/share', { imageBudget: 3 * mb });
    const said = r.json.text
      .find((t) => t.text.includes(':'))!
      .text.split(' ')
      .sort();
    // the one within its own reservation stays; the one that ran the budget out goes
    expect(said).toEqual(['x:ok', 'y:error']);

    const file = join(dir, 'not-a-folder');
    writeFileSync(file, '');
    routes.set(
      '/kept.png',
      png(() => red),
    );
    page(
      '/keep',
      `<img src="/kept.png"><img src="data:image/png;base64,${blue.toString('base64')}">`,
    );
    const k = await run('/keep', { assetsDir: join(file, 'assets') });
    expect(k.error).toBeNull();
    expect(k.json.images.every((i) => i.sha256 !== null)).toBe(true);
    // one warning for both pictures, naming the folder
    expect(k.warnings.filter((w) => /could not keep/.test(w))).toEqual([
      expect.stringContaining(join(file, 'assets')),
    ]);
  });

  it('a page that is not there, or blocked, is exit 1 with what is known', async () => {
    const r = await run('/missing');
    expect([r.png, r.json.status]).toEqual([null, 404]);
    expect(r.error).toMatch(/404/);
    routes.set('/away', (_q, s) => {
      s.writeHead(302, { location: `${O()}/x` });
      s.end();
    });
    const away = await run('/away');
    expect(away.png).toBeNull();
    expect(away.error).toMatch(/other\.test.*--allow-host/);
  });
});
