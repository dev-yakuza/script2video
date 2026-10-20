/** `s2v capture` without a browser (S5 plan 4): addresses, flags, the pipe, the text, the hash. */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  allowHostOf,
  isGlobalUnicast,
  isIpLiteralHost,
  ldhHost,
  pinHosts,
  resolverRules,
  targetOf,
} from '../src/capture/address.js';
import { requestVerdict, stopOnSignal } from '../src/capture/capture.js';
import { FrameReader } from '../src/capture/cdp.js';
import {
  BR,
  buildJson,
  canonicalJson,
  contentHashOf,
  dataUrlBytes,
  normalizeText,
  type RawPage,
} from '../src/capture/extract.js';
import { writeAtomic } from '../src/capture/files.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('addresses', () => {
  it('allows global unicast only', () => {
    for (const ip of [
      '8.8.8.8',
      '1.1.1.1',
      '172.32.0.1',
      '100.128.0.1',
      '2606:4700::1111',
      '2002:808:808::1',
    ])
      expect([ip, isGlobalUnicast(ip)]).toEqual([ip, true]);
    for (const ip of [
      '0.1.2.3',
      '10.0.0.1',
      '100.64.0.1',
      '100.127.255.255',
      '127.0.0.1',
      '169.254.169.254',
      '172.16.0.1',
      '172.31.255.255',
      '192.0.0.8',
      '192.0.2.1',
      '192.88.99.1',
      '192.168.1.1',
      '198.18.0.1',
      '198.19.255.255',
      '198.51.100.1',
      '203.0.113.1',
      '224.0.0.1',
      '240.0.0.1',
      '255.255.255.255',
      '::1',
      '::',
      'fe80::1',
      'fc00::1',
      'fd12::1',
      'ff02::1',
      '::ffff:127.0.0.1',
      '::ffff:8.8.8.8',
      '64:ff9b::808:808',
      '2001::1',
      '2001:1ff::1',
      '2001:db8::1',
      '3fff::1',
      '2002:a00:1::1',
      '2002:7f00:1::',
      'not an ip',
    ])
      // prettier-ignore
      expect([ip, isGlobalUnicast(ip)]).toEqual([ip, false]);
    // just outside the blocks
    expect(isGlobalUnicast('2001:200::1')).toBe(true);
    expect(isGlobalUnicast('172.15.255.255')).toBe(true);
    expect(isGlobalUnicast('198.20.0.1')).toBe(true);
  });

  it('knows an IP literal in a URL, however it was written', () => {
    for (const u of [
      'http://127.0.0.1/',
      'http://2130706433/',
      'http://0x7f.1/',
      'http://0177.0.0.1/',
      'http://[::1]/',
      'http://[::ffff:127.0.0.1]/',
    ])
      expect([u, isIpLiteralHost(new URL(u).hostname)]).toEqual([u, true]);
    expect(isIpLiteralHost('example.com')).toBe(false);
  });

  it('takes exact lower-case host names only', () => {
    for (const h of ['example.com', 'a-b.c.example', 'xn--bcher-kva.example', 'localhost'])
      expect(ldhHost(h)).toBe(h);
    for (const h of [
      '',
      'Example.com',
      '*.example.com',
      'a.com/x',
      'a.com:80',
      'host.',
      '8.8.8.8',
      '1.2.3',
      '0x7f',
      'a..b',
      '-a.com',
      'a-.com',
      'bücher.example',
      'a_b.com',
      '[::1]',
      `${'a'.repeat(64)}.com`,
    ])
      // prettier-ignore
      expect([h, ldhHost(h)]).toEqual([h, null]);
    expect(() => allowHostOf('*.a.com')).toThrow(/exact host name/);
    expect(allowHostOf('cdn.a.com')).toBe('cdn.a.com');
  });

  it('takes an http(s) URL naming a host', () => {
    expect(targetOf('https://example.com/a?b').hostname).toBe('example.com');
    for (const [u, why] of [
      ['ftp://example.com/', /http or https/],
      ['file:///etc/passwd', /http or https/],
      ['https://u:p@example.com/', /user/],
      ['http://127.0.0.1/', /IP address/],
      ['http://0x7f.1/', /IP address/],
      ['http://[::1]/', /IP address/],
      ['http://a_b.example/', /plain host name/],
      ['nope', /not a URL/],
    ] as const)
      expect(() => targetOf(u)).toThrow(why);
  });

  it('pins each host to its first IPv4 address, refusing a host with any address not public', async () => {
    const table: Record<string, string[]> = {
      both: ['2606:4700::1', '1.1.1.1'],
      six: ['2606:4700::1'],
      mixed: ['8.8.8.8', '10.0.0.1'],
      local: ['127.0.0.1'],
    };
    const lookup = async (h: string) => {
      if (!table[h]) throw new Error('ENOTFOUND');
      return table[h]!.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    };
    const pinned = await pinHosts(['both', 'six'], lookup);
    expect([...pinned]).toEqual([
      ['both', '1.1.1.1'],
      ['six', '2606:4700::1'],
    ]);
    expect(resolverRules(pinned)).toBe('MAP both 1.1.1.1, MAP six [2606:4700::1], MAP * ~NOTFOUND');
    await expect(pinHosts(['mixed'], lookup)).rejects.toThrow(/mixed resolves to 10\.0\.0\.1/);
    await expect(pinHosts(['local'], lookup)).rejects.toThrow(/not a public address/);
    await expect(pinHosts(['gone'], lookup)).rejects.toThrow(/gone does not resolve/);
  });

  it('lets a request out only to an allowed host by name', () => {
    const allowed = new Set(['example.com']);
    expect(requestVerdict('https://example.com/a', allowed)).toBeNull();
    expect(requestVerdict('http://example.com:8080/a', allowed)).toBeNull();
    expect(requestVerdict('data:image/png;base64,AA==', allowed)).toBeNull();
    expect(requestVerdict('blob:https://example.com/1', allowed)).toBeNull();
    expect(requestVerdict('https://other.com/a', allowed)).toBe('host not allowed');
    expect(requestVerdict('https://sub.example.com/a', allowed)).toBe('host not allowed');
    expect(requestVerdict('https://127.0.0.1/a', allowed)).toBe('ip literal');
    expect(requestVerdict('http://[::ffff:7f00:1]/', allowed)).toBe('ip literal');
    for (const u of [
      'file:///etc/passwd',
      'filesystem:https://example.com/x',
      'chrome://version',
      'ws://example.com/',
    ])
      expect([u, requestVerdict(u, allowed)]).toEqual([u, 'scheme']);
  });
});

describe('the pipe', () => {
  it('cuts messages at NUL, across and within chunks, without breaking a character', () => {
    const r = new FrameReader();
    const msg = Buffer.from('{"a":"한글"}');
    // split inside the 3-byte 한
    expect(r.push(msg.subarray(0, 7))).toEqual([]);
    expect(r.push(Buffer.concat([msg.subarray(7), Buffer.from([0])]))).toEqual(['{"a":"한글"}']);
    expect(r.push(Buffer.from('1\u00002\u00003'))).toEqual(['1', '2']);
    expect(r.push(Buffer.from('\u0000'))).toEqual(['3']);
  });

  it('takes a 27 MB message (a 20 MB picture in base64) in small chunks', () => {
    const r = new FrameReader();
    const body = Buffer.alloc(27 * 1024 * 1024, 0x41);
    const out: string[] = [];
    for (let i = 0; i < body.length; i += 65536) out.push(...r.push(body.subarray(i, i + 65536)));
    out.push(...r.push(Buffer.from([0])));
    expect(out).toHaveLength(1);
    expect(out[0]!.length).toBe(body.length);
  });
});

describe('the text', () => {
  it('folds whitespace, keeps <br> as a line, no-break spaces as spaces, NFC', () => {
    expect(normalizeText('  a \n\t b  ')).toBe('a b');
    expect(normalizeText(`첫${BR}  둘째 ${BR}${BR}`)).toBe('첫\n둘째');
    expect(normalizeText('a  b')).toBe('a b');
    expect(normalizeText('가')).toBe('가');
    expect(normalizeText('ＡＢ')).toBe('ＡＢ'); // NFC, not NFKC
  });

  it('hashes JSON the same whatever the key order', () => {
    expect(canonicalJson({ b: [1, { d: 1, c: 'x' }], a: null })).toBe(
      '{"a":null,"b":[1,{"c":"x","d":1}]}',
    );
    const base = { title: 't', lang: 'ko', text: [] };
    const a = contentHashOf(base, [{ src: 'https://a/x.png?v=1', sha256: null }]);
    expect(contentHashOf(base, [{ src: 'https://a/x.png?v=2#f', sha256: null }])).toBe(a);
    expect(contentHashOf(base, [{ src: 'https://a/y.png', sha256: null }])).not.toBe(a);
    // the bytes, not the address, when known; blob addresses never
    const s = contentHashOf(base, [{ src: 'https://a/1.png', sha256: 'ab' }]);
    expect(contentHashOf(base, [{ src: 'https://b/2.png', sha256: 'ab' }])).toBe(s);
    expect(
      contentHashOf(base, [
        { src: 'https://a/1.png', sha256: 'ab' },
        { src: 'blob:https://a/1', sha256: null },
      ]),
    ).toBe(s);
  });

  it('builds the JSON: what is in the capture, what was never shown, what counts for the hash', () => {
    const raw: RawPage = {
      url: 'https://a/',
      title: ' T ',
      lang: 'ko',
      scroll: [0, 0],
      text: [
        { kind: 'heading', raw: ' 漢字 ', ruby: [{ base: '漢字', reading: ' かんじ ' }] },
        { kind: 'paragraph', raw: '  ', ruby: [] },
      ],
      images: [
        {
          src: 'https://a/in.png',
          kind: 'img',
          bbox: [0, 0, 10, 10],
          alt: ' x ',
          natural: [10, 10],
        },
        {
          src: 'https://a/out.png',
          kind: 'img',
          bbox: [0, 900, 10, 10],
          alt: '',
          natural: [10, 10],
        },
        { src: 'https://a/px', kind: 'img', bbox: [0, 0, 1, 1], alt: '', natural: [1, 1] },
        { src: 'https://a/big1.png', kind: 'img', bbox: [0, 0, 40, 40], alt: '', natural: [1, 1] },
        {
          src: 'data:image/png;base64,AAEC',
          kind: 'background',
          bbox: [0, 0, 5, 5],
          alt: '',
          natural: null,
        },
      ],
      opaque: [{ kind: 'canvas', src: null, bbox: [5, 5, 10, 10] }],
    };
    const bytes = new Map([
      ['https://a/in.png', 'aa'],
      ['https://a/px', 'p1'],
    ]);
    const opts = {
      status: 200,
      idle: true,
      region: [0, 0, 100, 100] as [number, number, number, number],
      bytes: (s: string) => bytes.get(s) ?? null,
      received: [
        ['https://a/in.png'],
        ['https://a/final.png', 'https://a/out.png'],
        ['https://a/gone.png'],
      ],
      blocked: [],
      websockets: [],
      hashable: true,
    };
    const j = buildJson(raw, opts);
    expect([j.title, j.text]).toEqual([
      'T',
      [{ kind: 'heading', text: '漢字', ruby: [{ base: '漢字', reading: 'かんじ' }] }],
    ]);
    expect(j.images.map((i) => [i.inCapture, i.sha256])).toEqual([
      [true, 'aa'],
      [false, null],
      [true, 'p1'],
      [true, null],
      [true, 'ae4b3280e56e2faf83f414a6e3dabe9d5fbe18976544c05fed121accb85b53fc'],
    ]);
    expect(j.images[0]!.alt).toBe('x');
    expect(j.opaque[0]!.inCapture).toBe(true);
    // a response is shown when either of its addresses (final, first) is on the page
    expect(j.notShown).toEqual(['https://a/gone.png']);
    // a different tracking pixel does not change the hash; another picture does
    bytes.set('https://a/px', 'p2');
    expect(buildJson(raw, opts).contentHash).toBe(j.contentHash);
    bytes.set('https://a/in.png', 'bb');
    expect(buildJson(raw, opts).contentHash).not.toBe(j.contentHash);
    expect(buildJson(raw, { ...opts, hashable: false }).contentHash).toBeNull();
    expect(dataUrlBytes('data:,a%20b')!.toString()).toBe('a b');
    expect(dataUrlBytes('https://a')).toBeNull();
  });
});

describe('the command', { timeout: 30_000 }, () => {
  it('writes through a fresh file and leaves no temporary file behind', () => {
    const dir = mkdtempSync(join(tmpdir(), 's2v-atomic-'));
    writeAtomic(join(dir, 'a.png'), 'x');
    expect(readFileSync(join(dir, 'a.png'), 'utf8')).toBe('x');
    // renaming over a directory fails: the temporary file goes
    mkdirSync(join(dir, 'd.png'));
    expect(() => writeAtomic(join(dir, 'd.png'), 'y')).toThrow();
    expect(readdirSync(dir).sort()).toEqual(['a.png', 'd.png']);
  });

  const cli = (args: string[]) => {
    try {
      execFileSync(
        process.execPath,
        [join(REPO, 'packages/cli/dist/main.js'), 'capture', ...args],
        {
          cwd: REPO,
          stdio: 'pipe',
        },
      );
      return { status: 0, err: '' };
    } catch (e) {
      const x = e as { status: number; stderr: Buffer };
      return { status: x.status, err: x.stderr.toString() };
    }
  };

  it('refuses before any browser starts', () => {
    const dir = mkdtempSync(join(tmpdir(), 's2v-capture-cli-'));
    const out = join(dir, 'o.png');
    for (const [args, code, why] of [
      [['http://127.0.0.1/', '--out', out], 2, /IP address/],
      [['ftp://example.com/', '--out', out], 2, /http or https/],
      [['https://u:p@example.com/', '--out', out], 2, /user/],
      [['https://example.com/'], 2, /--out/],
      [['https://example.com/', '--out', out, '--text', out], 2, /different/],
      [['https://example.com/', '--out', out, '--allow-host', '*.example.com'], 2, /exact host/],
      [['https://example.com/', '--out', out, '--width', '0'], 2, /--width/],
      [['https://example.com/', '--out', out, '--timeout', '1.5'], 2, /--timeout/],
      [['https://example.com/', '--out', out, '--bogus'], 2, /unknown option/],
      [
        ['https://localhost/', '--out', out, '--text', join(dir, 't.json')],
        1,
        /not a public address/,
      ],
    ] as const) {
      const r = cli([...args]);
      expect([args.join(' '), r.status]).toEqual([args.join(' '), code]);
      expect(r.err).toMatch(why);
    }
    // exit 1 still writes the JSON, never a picture
    expect(existsSync(out)).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, 't.json'), 'utf8'))).toMatchObject({
      url: 'https://localhost/',
      status: null,
      contentHash: null,
    });
  });
});

describe('capture on a signal and at exit (final review 18)', () => {
  it('closes the browser, then ends as signalled: 130, 143, 129', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      for (const [sig, code] of [
        ['SIGINT', 130],
        ['SIGTERM', 143],
        ['SIGHUP', 129],
      ] as const) {
        let closed = false;
        stopOnSignal(async () => {
          closed = true;
        })(sig);
        await new Promise((r) => setImmediate(r));
        expect(closed).toBe(true);
        expect(exit).toHaveBeenLastCalledWith(code);
      }
    } finally {
      exit.mockRestore();
    }
  });

  it('loading the file writer adds no exit listener (every command loads it)', () => {
    const files = join(REPO, 'packages/cli/dist/capture/files.js');
    const out = execFileSync(process.execPath, [
      '--input-type=module',
      '-e',
      `const n = process.listenerCount('exit'); await import(${JSON.stringify(files)}); console.log(process.listenerCount('exit') - n);`,
    ]).toString();
    expect(out.trim()).toBe('0');
  });
});
