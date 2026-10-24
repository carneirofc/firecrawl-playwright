import net from 'node:net';

/**
 * One upstream HTTP proxy the browser can leave through (e.g. a gluetun
 * container holding a VPN tunnel), plus the locale and timezone a visitor
 * from that exit would plausibly have. Sites compare the IP's geolocation
 * with Intl's timezone and Accept-Language; a Dutch IP with a Sao Paulo
 * clock is a cheap bot signal.
 */
export type EgressConfig = {
  name: string;
  url: string;
  timezone?: string;
  locale?: string;
};

export type Egress = EgressConfig & {
  healthy: boolean;
  /** Set by the caller once the local SSRF proxy for this exit listens. */
  localPort?: number;
};

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === 'string' && v.trim() !== '';

/**
 * Reads PROXY_SERVERS (a JSON array of EgressConfig) or, failing that, the
 * upstream single PROXY_SERVER/PROXY_USERNAME/PROXY_PASSWORD trio. Returns
 * an empty list when neither is set: the browser then goes out directly.
 * Throws on a malformed PROXY_SERVERS rather than silently going direct,
 * because a typo there would otherwise leak the real egress IP.
 */
export const parseEgressConfig = (
  env: NodeJS.ProcessEnv,
): EgressConfig[] => {
  const raw = env.PROXY_SERVERS;
  if (isNonEmptyString(raw)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new Error(`PROXY_SERVERS is not valid JSON: ${(e as Error).message}`);
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error('PROXY_SERVERS must be a non-empty JSON array');
    }
    const names = new Set<string>();
    return parsed.map((entry, i) => {
      if (typeof entry !== 'object' || entry === null) {
        throw new Error(`PROXY_SERVERS[${i}] must be an object`);
      }
      const e = entry as Record<string, unknown>;
      if (!isNonEmptyString(e.url)) {
        throw new Error(`PROXY_SERVERS[${i}].url is required`);
      }
      const url = e.url.includes('://') ? e.url : `http://${e.url}`;
      new URL(url); // throws on garbage
      const name = isNonEmptyString(e.name) ? e.name : `egress-${i}`;
      if (names.has(name)) {
        throw new Error(`PROXY_SERVERS has a duplicate name "${name}"`);
      }
      names.add(name);
      return {
        name,
        url,
        ...(isNonEmptyString(e.timezone) && { timezone: e.timezone }),
        ...(isNonEmptyString(e.locale) && { locale: e.locale }),
      };
    });
  }

  if (isNonEmptyString(env.PROXY_SERVER)) {
    const server = env.PROXY_SERVER.includes('://')
      ? env.PROXY_SERVER
      : `http://${env.PROXY_SERVER}`;
    const url = new URL(server);
    if (env.PROXY_USERNAME) url.username = env.PROXY_USERNAME;
    if (env.PROXY_PASSWORD) url.password = env.PROXY_PASSWORD;
    return [
      {
        name: 'proxy',
        url: url.toString(),
        ...(isNonEmptyString(env.PROXY_TIMEZONE) && {
          timezone: env.PROXY_TIMEZONE,
        }),
        ...(isNonEmptyString(env.PROXY_LOCALE) && { locale: env.PROXY_LOCALE }),
      },
    ];
  }

  return [];
};

/**
 * Round-robin over the exits that passed their last health check. Returns
 * null when every exit is down: the caller must then fail the scrape, never
 * fall back to a direct connection (that is the kill switch).
 */
export class EgressPool {
  readonly exits: Egress[];
  private next = 0;

  constructor(configs: EgressConfig[]) {
    // Start optimistic: the first health check runs right after startup,
    // and a scrape that races it fails at the proxy, not silently direct.
    this.exits = configs.map((c) => ({ ...c, healthy: true }));
  }

  get size(): number {
    return this.exits.length;
  }

  pick(): Egress | null {
    const n = this.exits.length;
    for (let i = 0; i < n; i++) {
      const candidate = this.exits[(this.next + i) % n];
      if (candidate.healthy) {
        this.next = (this.next + i + 1) % n;
        return candidate;
      }
    }
    return null;
  }

  status() {
    return this.exits.map(({ name, healthy, timezone, locale }) => ({
      name,
      healthy,
      timezone,
      locale,
    }));
  }
}

/** True if a TCP connection to the proxy's host:port opens in time. */
export const probeTcp = (
  proxyUrl: string,
  timeoutMs = 3000,
): Promise<boolean> =>
  new Promise((resolve) => {
    const u = new URL(proxyUrl);
    const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
    const socket = net.connect({ host: u.hostname, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });

/**
 * Re-probes every exit on an interval. An exit whose proxy port does not
 * answer (gluetun restarting, tunnel pod gone) leaves the rotation until it
 * answers again.
 */
export const startHealthChecks = (
  pool: EgressPool,
  intervalMs: number,
  probe: (url: string) => Promise<boolean> = probeTcp,
): (() => void) => {
  const run = async () => {
    await Promise.all(
      pool.exits.map(async (exit) => {
        const ok = await probe(exit.url);
        if (ok !== exit.healthy) {
          console.warn(
            `egress ${exit.name} is now ${ok ? 'healthy' : 'UNHEALTHY'}`,
          );
        }
        exit.healthy = ok;
      }),
    );
  };
  void run();
  const timer = setInterval(() => void run(), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
};
