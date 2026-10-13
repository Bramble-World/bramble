import { expect, test } from '@playwright/test';

// Smoke coverage for the public surfaces. Server Components can't be unit
// tested, so anything rendered on the server belongs here.

/** Matches `MACOS_DOWNLOAD_URL` in `playwright.config.ts`. */
const BUILD_URL = 'https://downloads.example.test/Bramble-test.dmg';

test('landing page renders', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/bramble/i);
  await expect(page.locator('body')).toBeVisible();
});

/**
 * The download is public, and the link is read per request rather than baked in
 * at build time. When that breaks the page still renders — the button is just
 * missing — so this is the only thing that would notice.
 */
for (const path of ['/', '/download']) {
  test(`${path} offers the macOS build`, async ({ page }) => {
    await page.goto(path);

    const download = page.getByRole('link', { name: /download for macOS/i });
    await expect(download).toHaveAttribute('href', BUILD_URL);
    await expect(page.getByText(/0\.0\.0 \(test\) · macOS 14 or later/)).toBeVisible();
  });
}

test('venture demo route loads', async ({ page }) => {
  const response = await page.goto('/venture-demo');
  expect(response?.status()).toBe(200);
  await expect(page.locator('body')).toBeVisible();
});
