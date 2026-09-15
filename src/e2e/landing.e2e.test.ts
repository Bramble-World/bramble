import { expect, test } from '@playwright/test';

// Smoke coverage for the two surfaces that exist today. Server Components can't
// be unit tested, so anything rendered on the server belongs here.

test('landing page renders', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/bramble/i);
  await expect(page.locator('body')).toBeVisible();
});

test('venture demo route loads', async ({ page }) => {
  const response = await page.goto('/venture-demo');
  expect(response?.status()).toBe(200);
  await expect(page.locator('body')).toBeVisible();
});
