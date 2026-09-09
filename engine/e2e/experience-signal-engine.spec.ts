import { expect, test } from '@playwright/test';

/**
 * The Experience Signal Engine certification boundary, in a browser.
 *
 * One flow, through the surfaces a person actually touches:
 *
 *   create a Rage → publish → confirm what it was about → another person
 *   Re-Rages → the corroboration count rises → the experience joins a pattern →
 *   the pattern's signal updates → the organization responds → the people it
 *   happened to report the outcome → the aggregate figures update.
 *
 * It also asserts what must *not* happen: a share never becomes a corroboration,
 * an organization's response never becomes a resolution, an organization cannot
 * remove what it is answering, and somebody who did not experience it cannot
 * report on its outcome.
 */

const stamp = Date.now();
const AUTHOR = `ese-author-${stamp}@example.com`;
const CLAIMANT = `ese-claimant-${stamp}@example.com`;
const STAFF = `ese-staff-${stamp}@example.com`;
const BODY = `Northwind Air never processed my refund after three weeks of chasing it (${stamp}).`;

type Req = {
  get: (url: string) => Promise<{ ok: () => boolean; status: () => number; json: () => Promise<unknown> }>;
  post: (
    url: string,
    options: { data: unknown },
  ) => Promise<{ ok: () => boolean; status: () => number; json: () => Promise<unknown> }>;
  delete: (url: string) => Promise<{ status: () => number }>;
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

test('the full signal flow: claim, corroborate, cluster, respond, resolve', async ({ page, request }) => {
  // Fixtures: a known entity, so naming the company does not route the report to
  // human review, plus a claimed organization to answer with.
  expect((await request.post('/api/test/seed', { data: {} })).ok()).toBeTruthy();

  // ── The author posts ────────────────────────────────────────────────────
  await signUp(request, AUTHOR);
  const created = await request.post('/api/experiences', {
    data: {
      kind: 'rage',
      creationMode: 'text',
      category: 'Shopping & service',
      bodyText: BODY,
      visibility: 'public',
    },
  });
  expect(created.status()).toBe(201);
  const { experienceId } = (await created.json()) as { experienceId: string };

  await expect
    .poll(
      async () => {
        const response = await request.get('/api/experiences');
        const body = (await response.json()) as { entries: { experienceId: string }[] };
        return body.entries.some((entry) => entry.experienceId === experienceId);
      },
      { timeout: 20_000, intervals: [100, 200, 300, 500] },
    )
    .toBe(true);

  // ── Extraction proposed; confirmation decides ───────────────────────────
  const suggested = await request.get(`/api/experiences/${experienceId}/normalization`);
  const suggestions = (await suggested.json()) as { suggestions: { field: string; value: string }[] };
  expect(
    suggestions.suggestions.some((s) => s.field === 'entity' && s.value === 'ent_northwind'),
    'the entity was read from the text',
  ).toBeTruthy();

  // Before confirmation it belongs to no pattern, however clear the wording.
  expect((await request.get(`/api/experiences/${experienceId}/cluster`)).status()).toBe(404);

  const confirmed = await request.post(`/api/experiences/${experienceId}/normalization`, {
    data: { fields: { entity: 'ent_northwind', category: 'cat_shopping', issueType: 'iss_refund' } },
  });
  expect(confirmed.status()).toBe(200);

  // ── Somebody else says it happened to them too ──────────────────────────
  await signUp(request, CLAIMANT);
  const claim = await request.post(`/api/experiences/${experienceId}/corroborations`, {
    data: { type: 're_rage' },
  });
  expect(claim.status()).toBe(200);
  expect(((await claim.json()) as { corroborationCount: number }).corroborationCount).toBe(1);

  // Sharing is unlimited and lands in a different count entirely.
  for (let index = 0; index < 4; index += 1) {
    expect((await request.post(`/api/experiences/${experienceId}/shares`, { data: { destination: 'copy_link' } })).status()).toBe(200);
  }

  await expect
    .poll(
      async () => {
        const response = await request.get(`/api/experiences/${experienceId}`);
        const body = (await response.json()) as { signal: { corroborators: number; shares: number } };
        return `${body.signal.corroborators}/${body.signal.shares}`;
      },
      { timeout: 20_000, intervals: [100, 200, 300, 500] },
    )
    // One person claimed it; the link went out four times. Never one number.
    .toBe('1/4');

  // ── It joins a pattern, and the signal counts people ────────────────────
  const clusterId = await expect
    .poll(
      async () => {
        const response = await request.get(`/api/experiences/${experienceId}/cluster`);
        if (!response.ok()) return '';
        return ((await response.json()) as { clusterId: string }).clusterId;
      },
      { timeout: 20_000, intervals: [200, 300, 500] },
    )
    .not.toBe('')
    .then(async () => {
      const response = await request.get(`/api/experiences/${experienceId}/cluster`);
      return ((await response.json()) as { clusterId: string }).clusterId;
    });

  await expect
    .poll(
      async () => {
        const response = await request.get(`/api/clusters/${clusterId}`);
        const body = (await response.json()) as { cluster: { uniqueExperiencers: number } };
        return body.cluster.uniqueExperiencers;
      },
      { timeout: 20_000, intervals: [200, 300, 500] },
    )
    // The author plus the corroborator, each counted once.
    .toBe(2);

  const clusterBody = (await (await request.get(`/api/clusters/${clusterId}`)).json()) as {
    cluster: { corroborations: number };
    signal: Record<string, unknown> | null;
  };
  expect(clusterBody.cluster.corroborations).toBe(1);
  for (const key of Object.keys(clusterBody.signal ?? {})) {
    // Named metrics only. A single composite score is what must not exist.
    expect(key.toLowerCase()).not.toMatch(/outrage|rankscore|totalscore/);
  }

  // ── The organization answers ────────────────────────────────────────────
  await signUp(request, STAFF);
  expect((await request.post('/api/test/seed', { data: { grantOrganizationMembership: true } })).ok()).toBeTruthy();

  const responded = await request.post('/api/organizations/org_northwind/responses', {
    data: {
      experienceId,
      kind: 'publish_resolution',
      body: 'The refund was issued and the process has changed.',
    },
  });
  expect(responded.status()).toBe(201);
  expect(
    ((await responded.json()) as { resolutionStatus?: string }).resolutionStatus,
    'an organization saying it fixed something must not resolve it',
  ).not.toBe('resolved');

  // It cannot remove what it is answering.
  expect([403, 404, 422]).toContain((await request.delete(`/api/experiences/${experienceId}`)).status());
  expect((await request.get(`/api/experiences/${experienceId}`)).ok(), 'the experience survives').toBeTruthy();

  // Nor report on an outcome it did not experience.
  const notAnExperiencer = await request.post(`/api/experiences/${experienceId}/resolution`, {
    data: { kind: 'resolved_for_me' },
  });
  expect([403, 422]).toContain(notAnExperiencer.status());

  const afterResponse = (await (await request.get(`/api/experiences/${experienceId}/resolution`)).json()) as {
    status: string;
    organizationResponded: boolean;
    reporters: number;
  };
  expect(afterResponse.organizationResponded).toBe(true);
  expect(afterResponse.status).not.toBe('resolved');
  expect(afterResponse.reporters, 'nobody it happened to has spoken yet').toBe(0);

  // ── The people it happened to report the outcome ────────────────────────
  await signIn(request, AUTHOR);
  const authorReport = await request.post(`/api/experiences/${experienceId}/resolution`, {
    data: { kind: 'resolved_for_me' },
  });
  expect(authorReport.status()).toBe(200);
  expect(
    ((await authorReport.json()) as { status: string }).status,
    'one of two experiencers is partial, not resolved',
  ).toBe('partially_resolved');

  await signIn(request, CLAIMANT);
  const claimantReport = await request.post(`/api/experiences/${experienceId}/resolution`, {
    data: { kind: 'resolved_for_me' },
  });
  expect(claimantReport.status()).toBe(200);
  const finalReport = (await claimantReport.json()) as { status: string; reporters: number; resolvedShare: number };
  expect(finalReport.status, 'everyone who claims it says it was fixed').toBe('resolved');
  expect(finalReport.reporters).toBe(2);
  expect(finalReport.resolvedShare).toBe(1);

  // ── The aggregate figures follow ────────────────────────────────────────
  await expect
    .poll(
      async () => {
        const response = await request.get(`/api/clusters/${clusterId}`);
        const body = (await response.json()) as { signal: { resolutionRate: number } | null };
        return body.signal?.resolutionRate ?? -1;
      },
      { timeout: 20_000, intervals: [200, 300, 500] },
    )
    .toBe(1);

  // ── And the pages say all of it in plain language ───────────────────────
  await page.goto('/');
  const card = page.locator('article', { hasText: BODY });
  await expect(card.getByRole('button', { name: 'Re-Rage 1' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Share 4' })).toBeVisible();
  // By this point everyone who claims the experience has confirmed the fix, so the
  // card reports the outcome rather than the response. Earlier in the flow — before
  // anyone confirmed — it read as a proposal; `personas.spec.ts` covers that state.
  await expect(card.getByText('Resolved', { exact: true })).toBeVisible();
  await expect(
    card.getByText('Everyone who said this happened to them reports it was resolved.'),
  ).toBeVisible();
  await expect(card.getByText('2 people have reported')).toBeVisible();

  await page.goto(`/clusters/${clusterId}`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Northwind Air');
  await expect(page.getByText('People affected')).toBeVisible();
  await expect(
    page.getByText(
      '“Reported resolved” counts only what the people it happened to said. An organization responding is not the same thing.',
    ),
  ).toBeVisible();
});

test('the fixture route exists only on the server that was given the flag', async ({ request, playwright }) => {
  // On this server the flag is set, so it works.
  expect((await request.post('/api/test/seed', { data: {} })).ok()).toBeTruthy();

  // The golden-path server is started without it and must answer as though the
  // route does not exist — which is what a deployment gets.
  const plain = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:3101' });
  try {
    const refused = await plain.post('/api/test/seed', { data: {} });
    expect(refused.status(), 'no flag, no route').toBe(404);
  } finally {
    await plain.dispose();
  }
});
