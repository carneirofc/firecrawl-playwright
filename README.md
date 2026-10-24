# firecrawl-playwright

A drop-in replacement for Firecrawl's `playwright-service`
(`ghcr.io/firecrawl/playwright-service`), the headless-browser microservice
the self-hosted Firecrawl API renders pages with (`PLAYWRIGHT_MICROSERVICE_URL`).
Same HTTP contract (`POST /scrape`, `GET /health`), same SSRF guard, but built
so pages see an ordinary Chrome on Linux instead of an automation browser.

Image: `ghcr.io/carneirofc/firecrawl-playwright` (public, `linux/amd64`).
Upstream base: `firecrawl/firecrawl` `apps/playwright-service-ts` at
`e1dc7a43954b1dd61eb7c7230363c62539a652b2`. Licence: AGPL-3.0, as upstream.

## What changes from upstream

| Upstream | Here | Why |
| --- | --- | --- |
| `playwright`, headless Chromium (headless shell) | `patchright`, **headed Google Chrome** under Xvfb | Headless sends `HeadlessChrome` in the client hints; Playwright leaks `navigator.webdriver` and CDP `Runtime.enable` |
| Random UA per context (`user-agents`: iPhone Safari, Firefox, ...) | Chrome's own UA | A random UA contradicts the client hints and the TLS fingerprint, which is worse than no override |
| `--disable-gpu` and friends | `--enable-unsafe-swiftshader`, minimal flags | No WebGL at all is a tell; software WebGL is normal |
| Fixed 1280x800 viewport | Real 1920x1080 window, screen to match | |
| Locale forced per context | From `LANG` (`en-US,en;q=0.9`) unless set | Playwright's `locale` sends the bare tag, which no real browser does |
| One `PROXY_SERVER` | `PROXY_SERVERS`: several exits, round-robin per scrape, health-checked, per-exit timezone | Several VPN exits; the browser clock matches the exit's country |
| Direct connection when the proxy is down | **Kill switch**: 503 when no exit is healthy | Never leak the real egress IP |
| No pacing | Optional minimum gap between navigations to the same host | Bursts against one site are the easiest pattern to flag |

Measured against the pinned upstream image (same machine, same IP):

| Test | Upstream | This image |
| --- | --- | --- |
| deviceandbrowserinfo.com/are_you_a_bot | "You are a bot" (`hasWebdriverTrue`, `isAutomatedWithCDP`, `hasInconsistentTimingResolution`) | "You are human", every check false |
| browserscan.net/bot-detection | Robot (WebDriver) | Normal |
| `Sec-Ch-Ua` | `"HeadlessChrome";v="156"`, platform `"iOS"` with a Safari UA | `"Google Chrome";v="156"`, platform `"Linux"`, matching UA |

The egress IP is still the strongest signal, and nothing in the browser
changes it: that is what `PROXY_SERVERS` is for.

## Configuration

Upstream variables keep their meaning (`PORT`, `MAX_CONCURRENT_PAGES`,
`BLOCK_MEDIA`, `ALLOW_LOCAL_WEBHOOKS`, `PROXY_SERVER`, `PROXY_USERNAME`,
`PROXY_PASSWORD`). New ones:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PROXY_SERVERS` | unset | JSON list of exits: `[{"name":"br","url":"http://vpn-br:8888","timezone":"America/Sao_Paulo","locale":"pt-BR"}]`. `timezone`/`locale` optional. Wins over `PROXY_SERVER`. Malformed JSON is a startup error, never a silent direct connection. |
| `PROXY_TIMEZONE`, `PROXY_LOCALE` | unset | Same, for the single `PROXY_SERVER` |
| `EGRESS_HEALTH_INTERVAL_MS` | `15000` | TCP probe of each exit's proxy port; failing exits leave the rotation |
| `HEADLESS` | `false` | `true` skips Xvfb and runs Chrome's new headless mode (weaker) |
| `BROWSER_CHANNEL` | `chrome` | patchright channel |
| `WINDOW_WIDTH`, `WINDOW_HEIGHT` | `1920`, `1080` | Window and Xvfb screen size |
| `DEFAULT_TIMEZONE` | unset (container TZ, UTC) | Timezone without an exit, or for exits without one. Set it to the direct IP's zone. |
| `DEFAULT_LOCALE` | unset (from `LANG`) | Forces a locale |
| `HOST_MIN_INTERVAL_MS` | `0` (off) | Minimum gap between navigations to one host (`www.` folded) |
| `HOST_JITTER_MS` | `0` | Random extra gap, 0..N ms |
| `HOST_MAX_WAIT_MS` | `10000` | Cap on one pacing wait, so it never eats the scrape timeout |

`GET /health` reports `headless` and each exit's health. It stays 200 while
the exits are down (the browser is fine; restarting it would not help), and
`/scrape` answers 503 instead.

Runs as uid 1000 with every capability dropped. Chrome needs `--no-sandbox`
(no user namespaces in a pod), as upstream.

## Not covered

- **Screenshots.** Firecrawl's API only asks fire-engine for them; the
  `playwright` engine is flagged `screenshot: false` in the API itself, so no
  change here can enable the format.
- **Interactive challenges** (Turnstile, hCaptcha, DataDome sliders). Nothing
  here solves them.
- **IP reputation.** VPN and datacenter ranges are listed by every anti-bot
  vendor. A residential proxy is the only real fix for that.

## Development

```bash
corepack enable && corepack prepare pnpm@11.4.0 --activate
pnpm install && pnpm run build && pnpm test
podman build -t firecrawl-playwright:dev .
podman run --rm -p 3000:3000 --cap-drop=all firecrawl-playwright:dev
curl -s localhost:3000/scrape -H 'content-type: application/json' \
  -d '{"url":"https://httpbin.org/headers"}'
```

CI (`.github/workflows/image.yml`) type-checks, runs the unit tests and
hadolint, then pushes `latest` and `sha-<short>` to GHCR on every push to
`main`. Pin the digest, not the tag.

To rebase on a newer upstream, diff upstream's `apps/playwright-service-ts`
between the recorded commit and the new one and replay it onto `api.ts`
and `helpers/ssrf.ts`. The local changes are confined to `api.ts`,
`helpers/egress.ts`, `helpers/pacer.ts`, the Dockerfile and the entrypoint.
