import { gunzipSync } from 'node:zlib';
import { expect, test } from '@playwright/test';

// Smoke coverage for the public surfaces. Server Components can't be unit
// tested, so anything rendered on the server belongs here.

// PostHog drops events from automated browsers, which is what keeps crawlers out
// of the numbers, so the analytics spec has to stop looking like one. Top-level
// because launch options cannot be set per test; it changes nothing for the rest.
test.use({ launchOptions: { args: ['--disable-blink-features=AutomationControlled'] } });

/** Matches `IOS_TESTFLIGHT_URL` in `playwright.config.ts`. */
const TESTFLIGHT_URL = 'https://testflight.example.test/join/TEST';

test('landing page renders', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/bramble/i);
  await expect(page.locator('body')).toBeVisible();
});

/** New users go to the iPhone. */
test('/ does not mention the Mac app', async ({ page }) => {
  await page.goto('/');

  await expect(page.locator('body')).not.toContainText(/mac/i);
});

/**
 * The link is read per request rather than baked in at build time. When that
 * breaks the page still renders — the button is just missing — so this is the
 * only thing that would notice.
 */
test('/ offers the iPhone beta', async ({ page }) => {
  await page.goto('/');

  const beta = page.getByRole('link', { name: /get the iPhone beta/i });
  await expect(beta).toHaveAttribute('href', TESTFLIGHT_URL);
  await expect(page.getByText(/on TestFlight · iOS 18 or later/)).toBeVisible();
});

test('/download, the link testers were given, lands on the home page', async ({ page }) => {
  await page.goto('/download');

  await expect(page).toHaveURL('/');
  await expect(page.getByRole('link', { name: /get the iPhone beta/i })).toBeVisible();
});

test('/ can be shared: absolute Open Graph tags and a real image', async ({ page, request }) => {
  await page.goto('/');

  const meta = (selector: string) => page.locator(selector).getAttribute('content');
  expect(await meta('meta[property="og:title"]')).toBe('Bramble');
  expect(await meta('meta[property="og:description"]')).toMatch(/infinitely playable/);
  expect(await meta('meta[name="twitter:card"]')).toBe('summary_large_image');

  const image = await meta('meta[property="og:image"]');
  // Absolute, or a crawler cannot fetch it. The dev server writes its own origin
  // here; a production build writes `metadataBase`.
  const { pathname, search } = new URL(image ?? '');

  const file = await request.get(pathname + search);
  expect(file.status()).toBe(200);
  expect(file.headers()['content-type']).toBe('image/png');
});

/**
 * PostHog's two wire formats: gzip for a batch, and base64 in a form body for the
 * beacon a link press sends.
 */
function decodeEvents(body: Buffer): TrackedEvent[] {
  const text =
    body[0] === 0x1f && body[1] === 0x8b
      ? gunzipSync(body).toString()
      : Buffer.from(decodeURIComponent(body.toString().replace(/^data=/, '')), 'base64').toString();
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : (parsed.batch ?? [parsed]);
}

type TrackedEvent = { event: string; properties: Record<string, unknown> };

test.describe('analytics', () => {
  /**
   * Every assertion here is a sentence in the privacy policy: pageviews and named
   * events only, no cookies, nothing autocaptured.
   */
  test('/ reports the visit and the press, and nothing else', async ({ page, context }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(navigator, 'userAgentData', { get: () => undefined });
    });

    const events: TrackedEvent[] = [];
    await page.route('https://posthog.example.test/**', async (route) => {
      const body = route.request().postDataBuffer();
      if (body && new URL(route.request().url()).pathname === '/e/') {
        events.push(...decodeEvents(body));
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    // Stay on the page: the press is what is under test, not TestFlight.
    await page.route(TESTFLIGHT_URL, (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '' })
    );

    await page.goto('/');
    await expect.poll(() => events.map((e) => e.event)).toContain('$pageview');

    await page.getByRole('link', { name: /get the iPhone beta/i }).click();
    await expect.poll(() => events.map((e) => e.event)).toContain('landing_cta_clicked');

    const press = events.find((e) => e.event === 'landing_cta_clicked');
    expect(press?.properties.cta).toBe('iphone_beta');
    expect(events.map((e) => e.event)).not.toContain('$autocapture');
    expect(await context.cookies()).toEqual([]);
  });
});

test('venture demo route loads', async ({ page }) => {
  const response = await page.goto('/venture-demo');
  expect(response?.status()).toBe(200);
  await expect(page.locator('body')).toBeVisible();
});
