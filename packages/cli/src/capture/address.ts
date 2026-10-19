/**
 * What `s2v capture` may reach (S5 plan 2.2): named hosts only, each resolving to global unicast
 * addresses only, pinned for the browser by `--host-resolver-rules` so that every other name and
 * every IP literal does not resolve at all.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP, isIPv4 } from 'node:net';
import { domainToASCII } from 'node:url';
import { UsageError } from '../args.js';

/** IPv4 ranges that are not globally reachable (IANA special-purpose registry), multicast, reserved. */
const V4_DENY: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];
/** Inside 2000::/3, the blocks that are not plain global unicast (6to4 is judged by its IPv4). */
const V6_DENY: [string, number][] = [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['3fff::', 20],
];

const v4Deny = new BlockList();
for (const [net, bits] of V4_DENY) v4Deny.addSubnet(net, bits, 'ipv4');
const v6Allow = new BlockList();
v6Allow.addSubnet('2000::', 3, 'ipv6');
const v6Deny = new BlockList();
for (const [net, bits] of V6_DENY) v6Deny.addSubnet(net, bits, 'ipv6');
const sixToFour = new BlockList();
sixToFour.addSubnet('2002::', 16, 'ipv6');

/** The 8 groups of an IPv6 address (any valid textual form). */
function v6Groups(ip: string): number[] {
  let text = ip.toLowerCase();
  // a trailing dotted IPv4 becomes two groups
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const b = dotted[1]!.split('.').map(Number);
    text =
      text.slice(0, dotted.index) +
      `${((b[0]! << 8) | b[1]!).toString(16)}:${((b[2]! << 8) | b[3]!).toString(16)}`;
  }
  const [head, tail] = text.split('::') as [string, string | undefined];
  const parse = (s: string) => (s ? s.split(':').map((g) => parseInt(g, 16)) : []);
  const h = parse(head);
  if (tail === undefined) return h;
  const t = parse(tail);
  return [...h, ...Array<number>(8 - h.length - t.length).fill(0), ...t];
}

/** Whether `ip` is a global unicast address (S5 plan 2.2). Not an IP at all: false. */
export function isGlobalUnicast(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return !v4Deny.check(ip, 'ipv4') && ip !== '255.255.255.255';
  if (kind !== 6) return false;
  if (!v6Allow.check(ip, 'ipv6') || v6Deny.check(ip, 'ipv6')) return false;
  if (sixToFour.check(ip, 'ipv6')) {
    const g = v6Groups(ip);
    const v4 = [g[1]! >> 8, g[1]! & 0xff, g[2]! >> 8, g[2]! & 0xff].join('.');
    return isGlobalUnicast(v4);
  }
  return true;
}

/** A URL host that is an IP literal (after `new URL`, which already turned 0x7f.1 into 127.0.0.1). */
export function isIpLiteralHost(hostname: string): boolean {
  return hostname.startsWith('[') || isIP(hostname) !== 0;
}

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/**
 * An exact host name in plain ASCII (LDH labels, lower case, as `domainToASCII` gives it); not an
 * IP, a wildcard, a path, a port or a trailing dot. `null` when it is none of that.
 */
export function ldhHost(input: string): string | null {
  if (!input || input.length > 253 || domainToASCII(input) !== input) return null;
  const labels = input.split('.');
  if (!labels.every((l) => LABEL.test(l))) return null;
  // a last label of digits is an IPv4 shape (1.2.3, 0x7f is not LDH-only digits but parses too)
  if (/^(\d+|0x[0-9a-f]*)$/.test(labels.at(-1)!)) return null;
  return input;
}

/** `--allow-host` values (S5 plan 1): exact names only, anything else is a usage error. */
export function allowHostOf(input: string): string {
  const host = ldhHost(input);
  if (!host)
    throw new UsageError(
      `--allow-host takes an exact host name in lower-case ASCII (like cdn.example.com), not "${input}"`,
    );
  return host;
}

/** The page to capture (S5 plan 1): http(s), no user info, a host name (not an IP). */
export function targetOf(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new UsageError(`not a URL: ${input}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new UsageError(`capture takes http or https URLs, not ${url.protocol}`);
  if (url.username || url.password)
    throw new UsageError('the URL may not carry a user or password');
  if (isIpLiteralHost(url.hostname))
    throw new UsageError(`the URL must name a host, not an IP address (${url.hostname})`);
  if (!ldhHost(url.hostname))
    throw new UsageError(`the URL host must be a plain host name, not "${url.hostname}"`);
  return url;
}

/** A host that may not be reached: exit 1, with the host named. */
export class HostError extends Error {}

export type Lookup = (host: string) => Promise<{ address: string; family: number }[]>;
const systemLookup: Lookup = (host) => dnsLookup(host, { all: true, verbatim: true });

/**
 * Resolve every allowed host; each must resolve and every address it has must be global unicast.
 * The address the browser gets is the first IPv4 one (else the first IPv6).
 */
export async function pinHosts(
  hosts: string[],
  lookup: Lookup = systemLookup,
): Promise<Map<string, string>> {
  const pinned = new Map<string, string>();
  for (const host of hosts) {
    let addrs: { address: string; family: number }[];
    try {
      addrs = await lookup(host);
    } catch (e) {
      throw new HostError(`${host} does not resolve (${(e as Error).message})`);
    }
    if (addrs.length === 0) throw new HostError(`${host} does not resolve`);
    const bad = addrs.find((a) => !isGlobalUnicast(a.address));
    if (bad)
      throw new HostError(
        `${host} resolves to ${bad.address}, which is not a public address — capture reaches public hosts only`,
      );
    pinned.set(host, (addrs.find((a) => isIPv4(a.address)) ?? addrs[0]!).address);
  }
  return pinned;
}

/** `--host-resolver-rules`: the pinned hosts and nothing else (IP literals included). */
export function resolverRules(pinned: Map<string, string>): string {
  const rules = [...pinned].map(([h, ip]) => `MAP ${h} ${isIPv4(ip) ? ip : `[${ip}]`}`);
  return [...rules, 'MAP * ~NOTFOUND'].join(', ');
}
