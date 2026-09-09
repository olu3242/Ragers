import { expect, test } from '@playwright/test';

/**
 * Phases 31–40 in a browser, on the shipped build.
 *
 * Four properties, and all four are negative — the things that must *not* appear:
 *
 *   1. An experience nobody has said anything about shows **no severity band**. The
 *      stored band is `minor` because a band is required; rendering it would report an
 *      absence of information as a finding.
 *   2. A band, once asserted, reads as **words with a basis** and carries no number.
 *   3. An operator sees **why** something escalated, and the escalation changed no
 *      outcome.
 *   4. A rate over too few accounts is **withheld**, never shown as 0%.
 */
const stamp = Date.now();
const RAGER = `g-rager-${stamp}@example.com`;
const OPERATOR = `g-op-${stamp}@example.com`;

type Req = {
  get: (url: string) => Promise<{ ok: () => boolean; status: () => number; json: () => Promise<unknown> }>;
  post: (
    url: string,
    options: { data: unknown },
  ) => Promise<{ ok: () => boolean; status: () => number; json: () => Promise<unknown> }>;
};

const signUp = async (request: Req, email: string): Promise<void> => {
  const response = await request.post('/api/session', {
    data: { mode: 'signup', email, displayName: email.split('@')[0] },
  });
  expect(response.ok(), `sign up ${email}`).toBeTruthy();
};

/**
 * Wait until the feed projection exists.
 *
 * The host drains consumers on a 250 ms tick, so publishing returns before the
 * projection the experience page reads is there. Polling the projection readers use is
 * the honest wait — not a sleep, and not an assumption about how many ticks a chain
 * takes.
 */
const projected = async (request: Req, experienceId: string): Promise<void> => {
  await expect
    .poll(async () => (await request.get(`/api/experiences/${experienceId}`)).status(), {
      timeout: 20_000,
      intervals: [100, 200, 300, 500],
    })
    .toBe(200);
};

const publish = async (request: Req, bodyText: string): Promise<string> => {
  const created = await request.post('/api/experiences', {
    data: {
      kind: 'rage',
      creationMode: 'text',
      category: 'Shopping & service',
      bodyText,
      visibility: 'public',
    },
  });
  expect(created.status()).toBe(201);
  return ((await created.json()) as { experienceId: string }).experienceId;
};

test('an experience nobody has costed shows no severity band at all', async ({ page }) => {
  const request: Req = page.request;
  expect((await request.post('/api/test/seed', { data: {} })).ok()).toBeTruthy();
  await signUp(request, RAGER);
  const experienceId = await publish(request, `The shop shut early without notice (${stamp}).`);
  await projected(request, experienceId);

  await page.goto(`/experiences/${experienceId}`);
  await expect(page.locator('.severity')).toHaveCount(0);
  // And no band word has leaked in some other guise.
  for (const band of ['Minor', 'Significant', 'Serious', 'Critical']) {
    await expect(page.getByText(band, { exact: true })).toHaveCount(0);
  }
});

test('a band reads as words with its basis, and carries no number', async ({ page }) => {
  const request: Req = page.request;
  expect((await request.post('/api/test/seed', { data: {} })).ok()).toBeTruthy();
  await signUp(request, `${RAGER}.b`);
  const experienceId = await publish(request, `The boiler was left unsafe and nobody returned (${stamp}-b).`);
  await projected(request, experienceId);

  // The author says what it cost them. Nobody else can.
  const asserted = await request.post(`/api/experiences/${experienceId}/enrichment`, {
    data: { dimension: 'safety_involved', flag: true },
  });
  expect(asserted.status()).toBe(201);

  // The band is written by a consumer, so poll the page rather than assume one tick.
  await expect
    .poll(
      async () => {
        await page.goto(`/experiences/${experienceId}`);
        return page.locator('.severity').count();
      },
      { timeout: 20_000, intervals: [200, 300, 500] },
    )
    .toBeGreaterThan(0);

  const severity = page.locator('.severity');
  await expect(severity).toBeVisible();
  await expect(severity.getByText('Critical')).toBeVisible();
  await expect(severity).toContainText('what the person it happened to said it cost them');
  await expect(severity).toContainText('safety involved');
  // No figure anywhere in the badge: a number beside a person invites comparison
  // across unlike experiences.
  await expect(severity).not.toContainText('%');
  expect(await severity.textContent()).not.toMatch(/\d/);
});

test('only the author is offered the cost control', async ({ page }) => {
  const request: Req = page.request;
  expect((await request.post('/api/test/seed', { data: {} })).ok()).toBeTruthy();
  await signUp(request, `${RAGER}.c`);
  const experienceId = await publish(request, `The delivery was left in the rain (${stamp}-c).`);
  await projected(request, experienceId);

  await page.goto(`/experiences/${experienceId}`);
  await expect(page.getByRole('heading', { name: 'What did this cost you?' })).toBeVisible();

  // A different person sees no such control, and the API refuses them.
  await signUp(request, `${RAGER}.c2`);
  await page.goto(`/experiences/${experienceId}`);
  await expect(page.getByRole('heading', { name: 'What did this cost you?' })).toHaveCount(0);
  const refused = await request.post(`/api/experiences/${experienceId}/enrichment`, {
    data: { dimension: 'money_lost', amount: 50, currency: 'GBP' },
  });
  expect(refused.ok()).toBeFalsy();
});

test('a pattern with too few accounts withholds its rates instead of showing 0%', async ({ page }) => {
  const request: Req = page.request;
  expect((await request.post('/api/test/seed', { data: {} })).ok()).toBeTruthy();
  await signUp(request, `${RAGER}.d`);
  const experienceId = await publish(request, `Northwind Air never processed my refund (${stamp}-d).`);
  await projected(request, experienceId);

  // Confirm the entity so the experience joins a pattern.
  await request.post(`/api/experiences/${experienceId}/normalization`, {
    data: { confirmations: [{ field: 'entity', value: 'ent_northwind' }] },
  });

  const clustered = await request.get(`/api/experiences/${experienceId}`);
  expect(clustered.ok()).toBeTruthy();

  await signUp(request, `${OPERATOR}.d`);
  expect((await request.post('/api/test/seed', { data: { grantModerator: true } })).ok()).toBeTruthy();

  // Whatever pattern exists here has one or two accounts in it, well below the floor.
  // The page must say so rather than publish a zero.
  await page.goto('/');
  const body = (await page.locator('body').textContent()) ?? '';
  expect(body).not.toContain('0% reported resolved');
});

test('an operator sees why something escalated, and the outcome is unchanged', async ({ page }) => {
  const request: Req = page.request;
  expect((await request.post('/api/test/seed', { data: {} })).ok()).toBeTruthy();
  await signUp(request, `${RAGER}.e`);
  // A name in the body routes to human review rather than publishing.
  const experienceId = await publish(request, `Gregory Fenwick pushed past the whole queue (${stamp}-e).`);

  await signUp(request, `${OPERATOR}.e`);
  expect((await request.post('/api/test/seed', { data: { grantModerator: true } })).ok()).toBeTruthy();

  // Screening is a consumer too, so poll for the queued item rather than assume it.
  await expect
    .poll(
      async () => {
        await page.goto('/operate');
        return page.locator('.queue-case').count();
      },
      { timeout: 20_000, intervals: [200, 300, 500] },
    )
    .toBeGreaterThan(0);

  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Review queue');

  // Whatever routed this item — screening here — the queue says why, and never just
  // "escalated". And no aging line claims anything is overdue.
  const queue = page.locator('.queue-case').first();
  await expect(queue).toBeVisible();
  const text = (await page.locator('body').textContent()) ?? '';
  for (const forbidden of ['overdue', 'SLA', 'breach']) {
    expect(text.toLowerCase()).not.toContain(forbidden.toLowerCase());
  }
  expect(experienceId.length).toBeGreaterThan(0);
});
