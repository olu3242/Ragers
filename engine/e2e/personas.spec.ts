import { expect, test } from '@playwright/test';

/**
 * Persona surfaces, in a browser, against the real engine.
 *
 * Four things are under test, and none of them is faked:
 *
 *   1. Navigation is scoped to the personas a viewer holds — and scoping is a
 *      courtesy, so the surfaces refuse a viewer who navigates to them anyway.
 *   2. The organization inbox shows cases about that entity and lets staff respond,
 *      with no control anywhere to hide, edit or resolve.
 *   3. A described fix reads as a *proposed resolution* until the people it
 *      happened to confirm it — the misreading with the most at stake.
 *   4. The operator queue shows why an item is there and offers real decisions,
 *      including deciding that nothing is wrong.
 */

const stamp = Date.now();
const RAGER = `p-rager-${stamp}@example.com`;
const STAFF = `p-staff-${stamp}@example.com`;
const OPERATOR = `p-op-${stamp}@example.com`;
const BODY = `Northwind Air lost my bag and never processed the refund (${stamp}).`;
const FLAGGED = `Gregory Fenwick pushed in front of the whole queue (${stamp}).`;

/**
 * Requests go through `page.request`, not the standalone `request` fixture.
 *
 * They are separate cookie jars: signing in through the fixture leaves the browser
 * context anonymous, so every page assertion would silently be testing a guest.
 * That is exactly the failure this comment exists to stop somebody reintroducing.
 */
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

const signIn = async (request: Req, email: string): Promise<void> => {
  const response = await request.post('/api/session', { data: { mode: 'signin', email } });
  expect(response.ok(), `sign in ${email}`).toBeTruthy();
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

test('a consumer is offered no operator or organization surface, and is refused if they try', async ({ page }) => {
  const request: Req = page.request;
  expect((await request.post('/api/test/seed', { data: {} })).ok()).toBeTruthy();
  await signUp(request, RAGER);

  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Main' });
  await expect(nav.getByRole('link', { name: 'Explore' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Create' })).toBeVisible();
  await expect(nav.getByRole('link', { name: /Review queue/ })).toHaveCount(0);
  await expect(nav.getByRole('link', { name: /Proposals/ })).toHaveCount(0);

  // Navigating there anyway is refused by the surface, not merely unlinked.
  await page.goto('/operate');
  await expect(page.getByRole('heading', { name: 'Not available' })).toBeVisible();
  await page.goto('/organizations/org_northwind');
  await expect(page.getByRole('heading', { name: 'Not available' })).toBeVisible();

  // And the API refuses too, which is the check that actually protects it.
  expect((await request.get('/api/moderation/queue')).status()).toBe(403);
  expect((await request.get('/api/organizations/org_northwind/cases')).status()).toBe(403);
});

test('organization staff see their cases, respond, and a described fix reads as proposed', async ({ page }) => {
  const request: Req = page.request;
  expect((await request.post('/api/test/seed', { data: {} })).ok()).toBeTruthy();

  // A Rager posts and confirms which company it was about.
  await signUp(request, `${RAGER}.b`);
  const experienceId = await publish(request, BODY);
  await expect
    .poll(async () => {
      const response = await request.get('/api/experiences');
      const body = (await response.json()) as { entries: { experienceId: string }[] };
      return body.entries.some((entry) => entry.experienceId === experienceId);
    }, { timeout: 20_000, intervals: [100, 200, 300, 500] })
    .toBe(true);
  expect(
    (
      await request.post(`/api/experiences/${experienceId}/normalization`, {
        data: { fields: { entity: 'ent_northwind', category: 'cat_shopping', issueType: 'iss_refund' } },
      })
    ).status(),
  ).toBe(200);

  // Staff sign in and get an organization tab named for the organization.
  await signUp(request, STAFF);
  expect(
    (await request.post('/api/test/seed', { data: { grantOrganizationMembership: true } })).ok(),
  ).toBeTruthy();

  await page.goto('/');
  await expect(
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /Northwind Air/ }),
  ).toBeVisible();

  await page.goto('/organizations/org_northwind');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Northwind Air');
  const kase = page.locator('article', { hasText: BODY });
  await expect(kase).toBeVisible();
  await expect(kase.getByText('One person says this happened to them.')).toBeVisible();

  // Nothing on this surface can hide, edit or delete the account it answers.
  for (const forbidden of ['Hide', 'Delete', 'Remove', 'Edit', 'Mark resolved']) {
    await expect(kase.getByRole('button', { name: forbidden })).toHaveCount(0);
  }

  // Describe a fix through the composer.
  await kase.getByRole('button', { name: 'Respond' }).click();
  await kase.getByLabel('How are you responding?').selectOption('publish_resolution');
  await expect(
    kase.getByText('Published as a proposed resolution. Only the people it happened to can confirm it.'),
  ).toBeVisible();
  await kase
    .getByLabel('What do you want to say?')
    .fill('The refund was issued and the handling process has changed.');
  await kase.getByRole('button', { name: 'Send response' }).click();

  // The row must not start reading as resolved.
  await expect(kase.getByText('Resolution proposed')).toBeVisible();
  await expect(kase.getByText('Resolved', { exact: true })).toHaveCount(0);

  // Nor may the API say it resolved anything.
  const summary = (await (await request.get(`/api/experiences/${experienceId}/resolution`)).json()) as {
    status: string;
    presentation: string;
    resolutionProposed: boolean;
    reporters: number;
  };
  expect(summary.resolutionProposed).toBe(true);
  expect(summary.presentation).toBe('proposed_resolution');
  expect(summary.status).not.toBe('resolved');
  expect(summary.reporters).toBe(0);

  // The Rager reviews the proposal and accepts it. Only then is it resolved.
  await signIn(request, `${RAGER}.b`);
  await page.goto('/');
  const card = page.locator('article', { hasText: BODY });
  await expect(
    card.getByText('The organization says this was fixed. The people it happened to have not confirmed that yet.'),
  ).toBeVisible();
  await expect(card.getByText('They say this was fixed. Was it?')).toBeVisible();
  await card.getByRole('button', { name: 'Accept — this was fixed' }).click();
  await expect(card.getByText('Resolved', { exact: true })).toBeVisible();

  const after = (await (await request.get(`/api/experiences/${experienceId}/resolution`)).json()) as {
    status: string;
    presentation: string;
  };
  expect(after.status).toBe('resolved');
  expect(after.presentation).toBe('resolved');
});

test('an operator sees why an item is queued and can decide nothing is wrong', async ({ page }) => {
  const request: Req = page.request;
  expect((await request.post('/api/test/seed', { data: {} })).ok()).toBeTruthy();

  // An account naming an unknown person routes to review.
  await signUp(request, `${RAGER}.c`);
  await publish(request, FLAGGED);

  await signUp(request, OPERATOR);
  expect((await request.post('/api/test/seed', { data: { grantModerator: true } })).ok()).toBeTruthy();

  await page.goto('/');
  await expect(
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /Review queue/ }),
  ).toBeVisible();

  // Screening runs as a consumer after publication, so the queue item appears
  // asynchronously. Wait for it rather than racing the pipeline.
  await expect
    .poll(async () => {
      const response = await request.get('/api/moderation/queue');
      if (!response.ok()) return 0;
      const body = (await response.json()) as { cases: { bodyText: string }[] };
      return body.cases.filter((row) => row.bodyText.includes(FLAGGED)).length;
    }, { timeout: 20_000, intervals: [200, 300, 500] })
    .toBe(1);

  await page.goto('/operate');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Review queue');
  const item = page.locator('article', { hasText: FLAGGED });
  await expect(item).toBeVisible();
  // Why it is here, stated rather than left to guesswork.
  await expect(item.getByText('may name a person')).toBeVisible();
  await expect(item.getByText('pending moderation')).toBeVisible();

  await item.getByRole('button', { name: 'Claim to review' }).click();
  await expect(item.getByLabel('Reason (recorded in the audit trail)')).toBeVisible();

  // Deciding nothing is wrong is offered as a real outcome.
  await expect(item.getByRole('button', { name: 'No action needed' })).toBeVisible();
  await expect(item.getByRole('button', { name: 'Remove' })).toBeVisible();
  await item.getByLabel('Reason (recorded in the audit trail)').fill('Names a public figure in a public role.');
  await item.getByRole('button', { name: 'No action needed' }).click();

  // Decided, so it leaves the queue.
  await expect(page.locator('article', { hasText: FLAGGED })).toHaveCount(0);
});

test('proposals are visibly proposals, with no approve control', async ({ page }) => {
  const request: Req = page.request;
  expect((await request.post('/api/test/seed', { data: {} })).ok()).toBeTruthy();
  await signUp(request, `${RAGER}.d`);
  const experienceId = await publish(request, `Northwind Air never processed my refund (${stamp}-d).`);
  await expect
    .poll(async () => {
      const response = await request.get(`/api/experiences/${experienceId}/normalization`);
      const body = (await response.json()) as { suggestions: unknown[] };
      return body.suggestions.length;
    }, { timeout: 20_000, intervals: [100, 200, 300, 500] })
    .toBeGreaterThan(0);

  await signUp(request, `${OPERATOR}.d`);
  expect((await request.post('/api/test/seed', { data: { grantModerator: true } })).ok()).toBeTruthy();

  await page.goto('/operate/proposals');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Proposals');
  await expect(
    page.getByText(
      'Nothing here has been applied. Until the person confirms it, matching treats each field as unknown — never as the proposed value.',
    ),
  ).toBeVisible();
  await expect(page.getByText('Awaiting confirmation from the person who posted it.').first()).toBeVisible();

  // A governed proposal offers no approve button to anyone but its owner.
  for (const forbidden of ['Approve', 'Apply', 'Accept', 'Confirm']) {
    await expect(page.getByRole('button', { name: forbidden })).toHaveCount(0);
  }
});
