import express, { Request, Response } from 'express';
import {
  chromium,
  Browser,
  BrowserContext,
  Route,
  Request as PlaywrightRequest,
  Page,
} from 'patchright';
import dotenv from 'dotenv';
import { getError } from './helpers/get_error';
import { Server } from 'proxy-chain';
import { isInternalHost, ssrfPrepareRequest } from './helpers/ssrf';
import {
  Egress,
  EgressPool,
  parseEgressConfig,
  startHealthChecks,
} from './helpers/egress';
import { HostPacer } from './helpers/pacer';

dotenv.config();

const app = express();
const port = process.env.PORT || 3003;

app.use(express.json());

const BLOCK_MEDIA =
  (process.env.BLOCK_MEDIA || 'False').toUpperCase() === 'TRUE';
const MAX_CONCURRENT_PAGES = Math.max(
  1,
  Number.parseInt(process.env.MAX_CONCURRENT_PAGES ?? '10', 10) || 10,
);
const ALLOW_LOCAL_WEBHOOKS =
  (process.env.ALLOW_LOCAL_WEBHOOKS || 'False').toUpperCase() === 'TRUE';

const envInt = (name: string, fallback: number): number => {
  const v = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
};

// Fingerprint. Headed Chrome (under Xvfb in the image) through patchright:
// no HeadlessChrome brand in the UA or client hints, no navigator.webdriver,
// no CDP Runtime.enable leak, and the UA, client hints and TLS stack all
// come from the same real browser instead of a random UA string pasted on
// top of Chromium.
const HEADLESS = (process.env.HEADLESS || 'False').toUpperCase() === 'TRUE';
const BROWSER_CHANNEL = process.env.BROWSER_CHANNEL || 'chrome';
const WINDOW_WIDTH = envInt('WINDOW_WIDTH', 1920);
const WINDOW_HEIGHT = envInt('WINDOW_HEIGHT', 1080);
// Unset by default: Chrome then derives navigator.languages and
// Accept-Language from LANG ("en-US,en;q=0.9"), like a real install. An
// explicit locale makes Playwright send the bare tag ("en-US"), which no
// real browser does.
const DEFAULT_LOCALE = process.env.DEFAULT_LOCALE || undefined;
const DEFAULT_TIMEZONE = process.env.DEFAULT_TIMEZONE || undefined;

// Egress: PROXY_SERVERS (a JSON list of exits, rotated per scrape) or the
// upstream single PROXY_SERVER. When any exit is configured, scrapes never
// leave directly: with every exit down they fail instead.
const egressPool = new EgressPool(parseEgressConfig(process.env));
const EGRESS_HEALTH_INTERVAL_MS = envInt('EGRESS_HEALTH_INTERVAL_MS', 15000);

// Pacing: minimum gap between navigations to the same host.
const hostPacer = new HostPacer({
  minIntervalMs: envInt('HOST_MIN_INTERVAL_MS', 0),
  jitterMs: envInt('HOST_JITTER_MS', 0),
  maxWaitMs: envInt('HOST_MAX_WAIT_MS', 10000),
});

class NoEgressError extends Error {
  constructor() {
    super('No healthy egress proxy; refusing to connect directly');
    this.name = 'NoEgressError';
  }
}

class InsecureConnectionError extends Error {
  constructor(
    public readonly blockedUrl: string,
    reason: string,
  ) {
    super(`Blocked insecure target URL "${blockedUrl}": ${reason}`);
    this.name = 'InsecureConnectionError';
  }
}

const assertSafeTargetUrl = async (urlString: string): Promise<void> => {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(urlString);
  } catch {
    throw new InsecureConnectionError(urlString, 'URL is invalid');
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new InsecureConnectionError(
      urlString,
      `unsupported protocol "${parsedUrl.protocol}"`,
    );
  }
  if (!ALLOW_LOCAL_WEBHOOKS && (await isInternalHost(parsedUrl.hostname))) {
    throw new InsecureConnectionError(
      urlString,
      'resolves to a private/internal address',
    );
  }
};

const startSSRFProxy = async (upstreamProxyUrl?: string): Promise<number> => {
  const server = new Server({
    port: 0,
    host: '127.0.0.1',
    prepareRequestFunction: ssrfPrepareRequest({
      allowLocal: ALLOW_LOCAL_WEBHOOKS,
      upstreamProxyUrl,
    }),
  });
  await server.listen();
  return server.port;
};

// The direct SSRF proxy, used only when no egress is configured.
let directProxyPort: number | null = null;

/** The exit for one scrape; throws NoEgressError when every exit is down. */
const pickEgress = (
  forHealthCheck = false,
): { port: number; egress: Egress | null } => {
  if (egressPool.size === 0) return { port: directProxyPort!, egress: null };
  // The health check opens a context but never navigates, and must not fail
  // (and get Chrome restarted by the liveness probe) just because the VPN is
  // down; the egress state is reported in its body instead.
  if (forHealthCheck) {
    const first = egressPool.exits[0];
    return { port: first.localPort!, egress: first };
  }
  const egress = egressPool.pick();
  if (!egress || egress.localPort === undefined) throw new NoEgressError();
  return { port: egress.localPort, egress };
};

type ContextSecurityState = {
  blockedNavigationRequestUrl: string | null;
};
class Semaphore {
  private permits: number;
  private queue: (() => void)[] = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    this.permits++;
    if (this.queue.length > 0) {
      const nextResolve = this.queue.shift();
      if (nextResolve) {
        this.permits--;
        nextResolve();
      }
    }
  }

  getAvailablePermits(): number {
    return this.permits;
  }

  getQueueLength(): number {
    return this.queue.length;
  }
}
const pageSemaphore = new Semaphore(MAX_CONCURRENT_PAGES);

const AD_SERVING_DOMAINS = [
  'doubleclick.net',
  'adservice.google.com',
  'googlesyndication.com',
  'googletagservices.com',
  'googletagmanager.com',
  'google-analytics.com',
  'adsystem.com',
  'adservice.com',
  'adnxs.com',
  'ads-twitter.com',
  'facebook.net',
  'fbcdn.net',
  'amazon-adsystem.com',
];

interface UrlModel {
  url: string;
  wait_after_load?: number;
  timeout?: number;
  headers?: { [key: string]: string };
  check_selector?: string;
  skip_tls_verification?: boolean;
}

let browser: Browser;

const initializeBrowser = async () => {
  // Keep the flag list short: every unusual switch is something a
  // fingerprinting script can notice (--disable-gpu, for one, removes WebGL
  // entirely). --no-sandbox: no user namespaces in the pod. /dev/shm is 64 MiB
  // in a pod, hence --disable-dev-shm-usage. There is no GPU: without
  // --enable-unsafe-swiftshader Chrome refuses software WebGL, and a browser
  // with no WebGL at all stands out more than one rendering it in software.
  browser = await chromium.launch({
    channel: BROWSER_CHANNEL,
    headless: HEADLESS,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--enable-unsafe-swiftshader',
      `--window-size=${WINDOW_WIDTH},${WINDOW_HEIGHT}`,
    ],
  });
};

const createContext = async (
  skipTlsVerification: boolean = false,
  userAgentOverride?: string,
  forHealthCheck = false,
): Promise<{
  context: BrowserContext;
  securityState: ContextSecurityState;
  egress: Egress | null;
}> => {
  const securityState: ContextSecurityState = {
    blockedNavigationRequestUrl: null,
  };
  const { port, egress } = pickEgress(forHealthCheck);

  const contextOptions: any = {
    // Headed: the page gets the real window size. Headless has no window,
    // so give it the same size explicitly.
    viewport: HEADLESS ? { width: WINDOW_WIDTH, height: WINDOW_HEIGHT } : null,
    // The browser's own UA unless the caller sets one: a made-up UA that
    // disagrees with the client hints and TLS is worse than none.
    ...(userAgentOverride && { userAgent: userAgentOverride }),
    ...((egress?.locale ?? DEFAULT_LOCALE) && {
      locale: egress?.locale ?? DEFAULT_LOCALE,
    }),
    ...((egress?.timezone ?? DEFAULT_TIMEZONE) && {
      timezoneId: egress?.timezone ?? DEFAULT_TIMEZONE,
    }),
    ignoreHTTPSErrors: skipTlsVerification,
    serviceWorkers: 'block',
  };

  contextOptions.proxy = {
    server: `http://127.0.0.1:${port}`,
  };

  const newContext = await browser.newContext(contextOptions);

  if (BLOCK_MEDIA) {
    await newContext.route(
      '**/*.{png,jpg,jpeg,gif,svg,mp3,mp4,avi,flac,ogg,wav,webm}',
      async (route: Route, request: PlaywrightRequest) => {
        await route.abort();
      },
    );
  }

  // Intercept all requests to avoid loading ads
  await newContext.route(
    '**/*',
    async (route: Route, request: PlaywrightRequest) => {
      const requestUrlString = request.url();
      try {
        await assertSafeTargetUrl(requestUrlString);
      } catch (error) {
        if (error instanceof InsecureConnectionError) {
          if (request.isNavigationRequest()) {
            securityState.blockedNavigationRequestUrl = requestUrlString;
          }
          console.warn(`Blocked request: ${requestUrlString}`);
          return route.abort('blockedbyclient');
        }
        throw error;
      }

      const hostname = new URL(requestUrlString).hostname.toLowerCase();

      if (AD_SERVING_DOMAINS.some((domain) => hostname.includes(domain))) {
        console.log(hostname);
        return route.abort();
      }
      return route.continue();
    },
  );

  return { context: newContext, securityState, egress };
};

const shutdownBrowser = async () => {
  if (browser) {
    await browser.close();
  }
};

const isValidUrl = (urlString: string): boolean => {
  try {
    new URL(urlString);
    return true;
  } catch (_) {
    return false;
  }
};

const scrapePage = async (
  page: Page,
  url: string,
  waitUntil: 'load' | 'networkidle',
  waitAfterLoad: number,
  timeout: number,
  checkSelector: string | undefined,
  securityState: ContextSecurityState,
) => {
  const waited = await hostPacer.wait(new URL(url).hostname);
  console.log(
    `Navigating to ${url} with waitUntil: ${waitUntil} and timeout: ${timeout}ms` +
      (waited > 0 ? ` (paced ${waited}ms)` : ''),
  );
  let response;
  try {
    response = await page.goto(url, { waitUntil, timeout });
  } catch (error) {
    if (securityState.blockedNavigationRequestUrl) {
      throw new InsecureConnectionError(
        securityState.blockedNavigationRequestUrl,
        'navigation to private/internal resource is not allowed',
      );
    }
    throw error;
  }

  if (waitAfterLoad > 0) {
    await page.waitForTimeout(waitAfterLoad);
  }

  if (checkSelector) {
    try {
      await page.waitForSelector(checkSelector, { timeout });
    } catch (error) {
      throw new Error('Required selector not found');
    }
  }

  let headers = null,
    content = await page.content(),
    landedUrl = page.url();
  let ct: string | undefined = undefined;
  if (response) {
    headers = await response.allHeaders();
    ct = Object.entries(headers).find(
      ([key]) => key.toLowerCase() === 'content-type',
    )?.[1];
    if (
      ct &&
      (ct.toLowerCase().includes('application/json') ||
        ct.toLowerCase().includes('text/plain'))
    ) {
      content = (await response.body()).toString('utf8'); // TODO: determine real encoding
      landedUrl = response.url();
    }
  }

  return {
    content,
    // Where the returned content came from: page.url() for rendered HTML
    // (covers HTTP 3xx and client-side redirects), response.url() for raw
    // JSON/text bodies, which come from the page.goto response.
    url: landedUrl,
    status: response ? response.status() : null,
    headers,
    contentType: ct,
  };
};

app.get('/health', async (req: Request, res: Response) => {
  try {
    if (!browser) {
      await initializeBrowser();
    }

    const { context: testContext } = await createContext(
      false,
      undefined,
      true,
    );
    const testPage = await testContext.newPage();
    await testPage.close();
    await testContext.close();

    res.status(200).json({
      status: 'healthy',
      maxConcurrentPages: MAX_CONCURRENT_PAGES,
      activePages: MAX_CONCURRENT_PAGES - pageSemaphore.getAvailablePermits(),
      headless: HEADLESS,
      egress: egressPool.size === 0 ? 'direct' : egressPool.status(),
    });
  } catch (error) {
    console.error('Health check failed:', error);
    res.status(503).json({
      status: 'unhealthy',
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    });
  }
});

app.post('/scrape', async (req: Request, res: Response) => {
  const {
    url,
    wait_after_load = 0,
    timeout = 15000,
    headers,
    check_selector,
    skip_tls_verification = false,
  }: UrlModel = req.body;

  console.log(`================= Scrape Request =================`);
  console.log(`URL: ${url}`);
  console.log(`Wait After Load: ${wait_after_load}`);
  console.log(`Timeout: ${timeout}`);
  console.log(`Headers: ${headers ? JSON.stringify(headers) : 'None'}`);
  console.log(`Check Selector: ${check_selector ? check_selector : 'None'}`);
  console.log(`Skip TLS Verification: ${skip_tls_verification}`);
  console.log(`==================================================`);

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  if (!isValidUrl(url)) {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  try {
    await assertSafeTargetUrl(url);
  } catch (error) {
    if (error instanceof InsecureConnectionError) {
      return res.json({
        content: '',
        pageStatusCode: 403,
        pageError: error.message,
      });
    }
    throw error;
  }

  if (!browser) {
    await initializeBrowser();
  }

  await pageSemaphore.acquire();

  let requestContext: BrowserContext | null = null;
  let securityState: ContextSecurityState | null = null;
  let page: Page | null = null;

  try {
    // Extract user-agent from request headers (case-insensitive) so it can
    // be applied at the context level.  Playwright ignores user-agent in
    // setExtraHTTPHeaders when the context already defines one (#2802).
    const userAgentOverride = headers
      ? Object.entries(headers).find(
          ([k]) => k.toLowerCase() === 'user-agent',
        )?.[1]
      : undefined;

    const contextBundle = await createContext(
      skip_tls_verification,
      userAgentOverride,
    );
    requestContext = contextBundle.context;
    securityState = contextBundle.securityState;
    if (contextBundle.egress) {
      console.log(`Egress: ${contextBundle.egress.name}`);
    }
    page = await requestContext.newPage();

    if (headers) {
      // A Cookie header passed through setExtraHTTPHeaders is sent on the first
      // request but DROPPED on any redirect hop (the browser regenerates the
      // redirected request from its cookie jar, which is empty). Authenticated
      // sites that 302 (e.g. to /signin when the session looks absent) then
      // land on the login page. Seed the cookie jar instead so Chromium re-sends
      // it on every request, including redirects — matching what a raw HTTP
      // client does.
      const cookieHeader = Object.entries(headers).find(
        ([k]) => k.toLowerCase() === 'cookie',
      )?.[1];
      if (cookieHeader) {
        // Scope cookies to the registrable domain (e.g. ".example.com"), not
        // host-only. Authenticated pages often 302 across sibling subdomains
        // (example.com -> app.example.com); a host-only cookie set for the
        // original host would not be sent to the redirect target, leaving the
        // request unauthenticated. The Cookie header carries no domain info, so
        // we apply the eTLD+1 — broad enough to follow the redirect, and these
        // are first-party cookies being returned to their own origin anyway.
        let cookieDomain: string | undefined;
        try {
          const host = new URL(url).hostname;
          const labels = host.split('.');
          cookieDomain = labels.length > 2 ? labels.slice(-2).join('.') : host;
        } catch {
          cookieDomain = undefined;
        }
        type SeedCookie = {
          name: string;
          value: string;
          url?: string;
          domain?: string;
          path?: string;
        };
        const cookies = cookieHeader
          .split(';')
          .map((pair) => pair.trim())
          .filter(Boolean)
          .map((pair): SeedCookie | null => {
            const eq = pair.indexOf('=');
            if (eq === -1) return null;
            const name = pair.slice(0, eq).trim();
            const value = pair.slice(eq + 1).trim();
            return cookieDomain
              ? { name, value, domain: `.${cookieDomain}`, path: '/' }
              : { name, value, url };
          })
          .filter((c): c is SeedCookie => c !== null);
        if (cookies.length > 0) {
          try {
            await requestContext.addCookies(cookies);
          } catch (error) {
            console.warn('Failed to seed cookies from Cookie header:', error);
          }
        }
      }

      // Remove user-agent (already applied at the context level) and cookie
      // (now seeded into the jar) before forwarding the rest verbatim.
      const filteredHeaders = Object.fromEntries(
        Object.entries(headers).filter(([k]) => {
          const lower = k.toLowerCase();
          return lower !== 'user-agent' && lower !== 'cookie';
        }),
      );
      if (Object.keys(filteredHeaders).length > 0) {
        await page.setExtraHTTPHeaders(filteredHeaders);
      }
    }

    const result = await scrapePage(
      page,
      url,
      'load',
      wait_after_load,
      timeout,
      check_selector,
      securityState,
    );
    const pageError =
      result.status !== 200 ? getError(result.status) : undefined;

    if (!pageError) {
      console.log(`✅ Scrape successful!`);
    } else {
      console.log(
        `🚨 Scrape failed with status code: ${result.status} ${pageError}`,
      );
    }

    res.json({
      content: result.content,
      pageStatusCode: result.status,
      contentType: result.contentType,
      url: result.url,
      ...(pageError && { pageError }),
    });
  } catch (error) {
    if (error instanceof InsecureConnectionError) {
      return res.json({
        content: '',
        pageStatusCode: 403,
        pageError: error.message,
      });
    }
    if (error instanceof NoEgressError) {
      console.error(error.message);
      return res.status(503).json({ error: error.message });
    }
    console.error('Scrape error:', error);
    res
      .status(500)
      .json({ error: 'An error occurred while fetching the page.' });
  } finally {
    if (page) await page.close();
    if (requestContext) await requestContext.close();
    pageSemaphore.release();
  }
});

const start = async () => {
  if (egressPool.size === 0) {
    directProxyPort = await startSSRFProxy();
    console.warn(
      '⚠️ WARNING: No proxy server provided. Your IP address may be blocked.',
    );
  } else {
    for (const exit of egressPool.exits) {
      exit.localPort = await startSSRFProxy(exit.url);
    }
    startHealthChecks(egressPool, EGRESS_HEALTH_INTERVAL_MS);
    console.log(
      `Egress rotation over ${egressPool.size} exit(s): ` +
        egressPool.exits.map((e) => e.name).join(', '),
    );
  }
  console.log(
    `Browser: channel=${BROWSER_CHANNEL} headless=${HEADLESS} ` +
      `window=${WINDOW_WIDTH}x${WINDOW_HEIGHT}; host pacing ` +
      (hostPacer.enabled ? 'on' : 'off'),
  );
  await initializeBrowser();
  app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
  });
};
start().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});

if (require.main === module) {
  process.on('SIGINT', () => {
    shutdownBrowser().then(() => {
      console.log('Browser closed');
      process.exit(0);
    });
  });
}
