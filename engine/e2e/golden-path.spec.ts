import { expect, test } from '@playwright/test';

/**
 * Browser E2E over the shipped build. These assertions are about the surfaces a
 * person actually touches: the feed renders without JavaScript-dependent
 * content, the composer is operable, and the API refuses unauthenticated writes.
 */

/**
 * Publication is asynchronous by design: screening runs as a consumer after the
 * create command returns. Tests therefore wait for the projection rather than
 * assuming a write is immediately readable.
 */
const waitForFeedEntry = async (
  request: { get: (url: string) => Promise<{ json: () => Promise<unknown> }> },
  experienceId: string,
): Promise<void> => {
  await expect
    .poll(
      async () => {
        const response = await request.get('/api/experiences');
        const body = (await response.json()) as { entries: { experienceId: string }[] };
        return body.entries.some((entry) => entry.experienceId === experienceId);
      },
      { timeout: 15_000, intervals: [100, 200, 300, 500] },
    )
    .toBe(true);
};

test('the feed page renders and states the product in plain language', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('What people noticed');
  await expect(page.getByText('Critique the behavior. Protect the human.')).toBeVisible();
  // Empty state, since a fresh process starts with no content.
  await expect(page.getByRole('heading', { name: 'No moments here yet.' })).toBeVisible();
});

test('the composer offers both creation modes and all three identity modes', async ({ page }) => {
  await page.goto('/compose');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Rager it or Rave it');

  await expect(page.getByRole('radio', { name: /Rager/ })).toBeVisible();
  await expect(page.getByRole('radio', { name: /Rave/ })).toBeVisible();
  await expect(page.getByRole('radio', { name: /Write it/ })).toBeVisible();
  await expect(page.getByRole('radio', { name: /Say it/ })).toBeVisible();

  for (const identity of ['Public', 'Alias', 'Anonymous']) {
    await expect(page.getByRole('radio', { name: new RegExp(identity) })).toBeVisible();
  }
});

test('choosing voice reveals the recorder, and it can fall back to text', async ({ page }) => {
  await page.goto('/compose');
  await page.getByText('Say it', { exact: true }).click();

  await expect(page.getByRole('button', { name: 'Use microphone' })).toBeVisible();
  await expect(page.getByText('Ragers protects identifying details in your audio before it is shared.')).toBeVisible();
  // Recording cannot start before permission is granted.
  await expect(page.getByRole('button', { name: 'Start recording' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Type instead' }).click();
  await expect(page.getByRole('radio', { name: /Write it/ })).toBeChecked();
});

test('the recorder walks the capture flow in the browser', async ({ page }) => {
  await page.goto('/compose');
  await page.getByText('Say it', { exact: true }).click();
  await page.getByRole('button', { name: 'Use microphone' }).click();

  await expect(page.getByRole('button', { name: 'Start recording' })).toBeVisible();
  await page.getByRole('button', { name: 'Start recording' }).click();

  await expect(page.getByRole('status')).toHaveText('Recording');
  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(page.getByRole('status')).toHaveText('Paused');
  await page.getByRole('button', { name: 'Resume' }).click();

  await page.waitForTimeout(1_200);
  await page.getByRole('button', { name: 'Stop' }).click();

  // Stopping leads to a preview, and submission is only offered from there.
  await expect(page.getByRole('button', { name: 'Use this recording' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Record again' })).toBeVisible();
});

test('the submit button stays disabled until there is something to post', async ({ page }) => {
  await page.goto('/compose');
  await expect(page.getByRole('button', { name: 'Publish Rager' })).toBeDisabled();
  await page.getByLabel('What happened?').fill('Someone held the door for a whole queue.');
  await expect(page.getByRole('button', { name: 'Publish Rager' })).toBeEnabled();
});

test('a full text post round-trips through the API and appears on the feed', async ({ page, request }) => {
  const signUp = await request.post('/api/session', {
    data: { mode: 'signup', email: `e2e-${Date.now()}@example.com`, displayName: 'E2E Actor' },
  });
  expect(signUp.ok()).toBeTruthy();

  const created = await request.post('/api/experiences', {
    data: {
      kind: 'rave',
      creationMode: 'text',
      category: 'Everyday courtesy',
      bodyText: 'Someone returned a lost wallet today.',
      visibility: 'public',
    },
  });
  expect(created.status()).toBe(201);
  const body = (await created.json()) as { experienceId: string; status: string };
  expect(body.status).toBe('pending_moderation');

  await waitForFeedEntry(request, body.experienceId);

  // Only once the projection exists is the page expected to show the card.
  await page.goto('/');
  await expect(page.getByText('Someone returned a lost wallet today.')).toBeVisible();
  await expect(page.getByText('Rave', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Been There/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Fair Point/ })).toBeVisible();
});

test('the API refuses writes from an unauthenticated caller', async ({ request }) => {
  const attempt = await request.post('/api/experiences', {
    data: {
      kind: 'rage',
      creationMode: 'text',
      category: 'Other',
      bodyText: 'Trying to post without signing in.',
      visibility: 'public',
    },
  });
  expect(attempt.status()).toBe(403);
  const body = (await attempt.json()) as { error: { code: string } };
  expect(body.error.code).toMatch(/policy_/);
});

test('health reports per-dependency state', async ({ request }) => {
  const response = await request.get('/api/health');
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as { state: string; dependencies: { name: string }[] };
  expect(body.state).toBe('healthy');
  expect(body.dependencies.map((d) => d.name).sort()).toEqual(['dead_letters', 'outbox']);
});

test('generic engagement mechanics are refused by the API', async ({ request }) => {
  await request.post('/api/session', {
    data: { mode: 'signup', email: `mech-${Date.now()}@example.com`, displayName: 'Mech' },
  });
  const created = await request.post('/api/experiences', {
    data: { kind: 'rage', creationMode: 'text', category: 'Other', bodyText: 'A thing.', visibility: 'public' },
  });
  const { experienceId } = (await created.json()) as { experienceId: string };
  // Reactions are only permitted on published content, so wait for screening
  // rather than racing it — a 403 here would be correct, just not the point.
  await waitForFeedEntry(request, experienceId);

  const attempt = await request.post(`/api/experiences/${experienceId}/reactions`, {
    data: { reactionType: 'like' },
  });
  expect(attempt.status()).toBe(400);
  const body = (await attempt.json()) as { error: { code: string } };
  expect(body.error.code).toBe('reaction_mechanic_not_supported');
});

test('the page has no horizontal overflow at a phone width', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto('/compose');
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );
  expect(overflow).toBe(false);
});
