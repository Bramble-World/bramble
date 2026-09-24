import { expect, test } from '@playwright/test';

/**
 * Plays a storyline through the harness.
 *
 * This is the only test that exercises the server actions, and therefore the
 * only one that proves the pipeline is reachable from a browser at all — the
 * integration suite calls the services directly and would pass just as happily
 * with the actions unwired.
 *
 * It needs a seeded database and the dev server. No key is required: with none
 * set the generator resolves to the fake, so this never spends anything.
 */
test.describe('the lab', () => {
  test('lists seeded storylines', async ({ page }) => {
    await page.goto('/lab');

    await expect(page.getByRole('heading', { name: 'Lab' })).toBeVisible();
    const links = page.locator('a[href^="/lab/"]');
    expect(await links.count()).toBeGreaterThan(0);
  });

  test('plays a turn and grows canon', async ({ page }) => {
    await page.goto('/lab');
    await page.locator('a[href^="/lab/"]').first().click();

    await expect(page.getByRole('heading', { name: 'Canon' })).toBeVisible();

    const beatsBefore = await page.locator('ol > li').count();

    // Three states are reachable depending on what the seed left behind, and the
    // page has to be walked through whichever one it is in:
    //   - no session at all
    //   - a session whose last turn offered no choices, so it is finished
    //   - a session with no open turn, waiting for one to be generated
    // Every step is a get-or-create, so clicking through in order is safe.
    for (const name of ['Start a session', 'Start another session']) {
      const button = page.getByRole('button', { name, exact: true });
      if (await button.isVisible().catch(() => false)) {
        await button.click();
        await expect(button).toBeHidden({ timeout: 30_000 });
      }
    }

    const generate = page.getByRole('button', { name: 'Generate the next beat' });
    await expect(generate).toBeVisible({ timeout: 30_000 });
    await generate.click();
    await expect(generate).toBeHidden({ timeout: 60_000 });

    // Whatever route got us here, there should now be a decision on screen.
    // A generated turn always offers between two and four choices — the schema
    // requires it — so unlike the seeded ones there is always something to click.
    const play = page
      .locator('section')
      .filter({ has: page.getByText('Play') })
      .last();
    const choices = play.getByRole('button');
    await expect(choices.first()).toBeVisible({ timeout: 30_000 });
    expect(await choices.count()).toBeGreaterThanOrEqual(2);

    await choices.first().click();

    // Asserted on state rather than on the action's message. A successful action
    // calls revalidatePath, which re-renders this section and unmounts the button
    // along with the message it was holding — so the report is only durable on
    // failure, when no revalidation happens. That is fine for a harness, but it
    // makes the message useless to assert on.
    //
    // What is durable: the turn is now answered, so the session has no open turn
    // and the page offers to generate the next beat again. A count assertion
    // would not do here — most decisions change nothing permanent, so the number
    // of beats legitimately may not move, and the check would pass whether the
    // click did anything or not.
    await expect(page.getByRole('button', { name: 'Generate the next beat' })).toBeVisible({
      timeout: 60_000,
    });

    // Canon only ever grows.
    expect(await page.locator('ol > li').count()).toBeGreaterThanOrEqual(beatsBefore);
  });

  // The file picker is the only path that carries real data in, so it is worth
  // driving rather than trusting. Uploaded from a buffer so nothing touches disk.
  test('extracts a storyline from an uploaded CSV', async ({ page }) => {
    await page.goto('/lab');

    const csv = [
      'date,is_from_me,text,handle',
      '2026-03-02 19:04,0,"you said it in front of everyone",+15550104477',
      '2026-03-02 19:41,1,"I know. I was tired and I took it out on you.",+15550104477',
      '2026-03-02 19:42,0,"it is fine",+15550104477',
    ].join('\n');

    await page.locator('input[type="file"]').setInputFiles({
      name: 'messages.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(csv, 'utf8'),
    });

    await page.getByRole('button', { name: 'Extract from this file' }).click();

    // The report names the columns it detected, because a misdetected direction
    // column is otherwise invisible — every message would look like one person.
    const report = page.getByText(/Extracted ".*" from 3 of 3 rows/);
    await expect(report).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(/direction=is_from_me/)).toBeVisible();
  });

  test('marks beats the reader caused', async ({ page }) => {
    await page.goto('/lab');
    await page.locator('a[href^="/lab/"]').first().click();

    // The seed ships one generated beat sitting in a gap between two extracted
    // ones, which is the convention the whole timeline depends on.
    const caused = page.getByText('you caused this').first();
    await expect(caused).toBeVisible();
  });
});
