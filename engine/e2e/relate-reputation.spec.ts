import { expect, test } from '@playwright/test';

/**
 * Relate and the reputation reads, in a browser.
 *
 * The properties under test are the ones a surface can most easily get wrong:
 *
 *   1. Relating two experiences moves no claim count, and the page says so.
 *   2. A dispute is offered separately from resolution reporting, and reads as a
 *      disagreement rather than a verdict.
 *   3. Responsiveness withholds timings below the sample floor and says how far off.
 *   4. No reputation surface shows a composite score.
 */

const stamp = Date.now();
const A = `rr-a-${stamp}@example.com`;
const B = `rr-b-${stamp}@example.com`;
const OBSERVER = `rr-o-${stamp}@example.com`;
const STAFF = `rr-s-${stamp}@example.com`;
const FIRST = `Northwind Air never processed my refund after three weeks (${stamp}-1).`;
const SECOND = `Northwind Air lost my bag and the refund never came (${stamp}-2).`;

type Req = {
  get: (url: string) => Promise<{ ok: () => boolean; status: () => number; json: () => Promise<unknown> }>;
  post: (
    url: string,
    options: { data: unknown },
  ) => Promise<{ ok: () => boolean; status: () => number; json: () => Promise<unknown> }>;
};

const signUp = async (request: Req, email: string): Promise<void> => {
  expect(
    (await request.post('/api/session', { data: { mode: 'signup', email, displayName: email.split('@')[0] } })).ok(),
  ).toBeTruthy();
};

const signIn = async (request: Req, email: string): Promise<void> => {
  expect((await request.post('/api/session', { data: { mode: 'signin', email } })).ok()).toBeTruthy();
};

const publishAndConfirm = async (request: Req, bodyText: string): Promise<string> => {
  const created = await request.post('/api/experiences', {
    data: { kind: 'rage', creationMode: 'text', category: 'Shopping & service', bodyText, visibility: 'public' },
  });
  expect(created.status()).toBe(201);
  const { experienceId } = (await created.json()) as { experienceId: string };

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
  return experienceId;
};

test('relating two experiences moves no claim count, and the page says so', async ({ page }) => {
  const request: Req = page.request;
  expect((await request.post('/api/test/seed', { data: {} })).ok()).toBeTruthy();

  await signUp(request, A);
  const first = await publishAndConfirm(request, FIRST);
  await signUp(request, B);
  const second = await publishAndConfirm(request, SECOND);

  // Somebody who experienced neither relates them.
  await signUp(request, OBSERVER);
  const related = await request.post(`/api/experiences/${first}/relations`, {
    data: { toExperienceId: second, assertion: 'same_pattern' },
  });
  expect(related.status()).toBe(201);
  const body = (await related.json()) as { assertedByCount: number; trustWeight: number };
  expect(body.assertedByCount).toBe(1);
  expect(body.trustWeight, 'relating carries no weight').toBe(0);

  // No corroboration count moved.
  const signal = (await (await request.get(`/api/experiences/${first}`)).json()) as {
    signal: { reRages: number; corroborators: number };
  };
  expect(signal.signal.reRages).toBe(0);
  expect(signal.signal.corroborators).toBe(0);

  await page.goto(`/experiences/${first}`);
  await expect(page.getByText('People say these are connected')).toBeVisible();
  await expect(
    page.getByText(
      'Saying two things are connected is not the same as saying either happened to you. These do not count as Re-Rages.',
    ),
  ).toBeVisible();
  // Re-Rage still reads zero next to it.
  await expect(page.getByRole('button', { name: 'Re-Rage 0' })).toBeVisible();

  // Relating the same pair the other way round is refused.
  const reversed = await request.post(`/api/experiences/${second}/relations`, {
    data: { toExperienceId: first },
  });
  expect(reversed.status()).toBe(409);
});

test('a dispute is separate from resolution reporting and reads as a disagreement', async ({ page }) => {
  const request: Req = page.request;
  expect((await request.post('/api/test/seed', { data: {} })).ok()).toBeTruthy();

  await signUp(request, `${A}.d`);
  const experienceId = await publishAndConfirm(request, `Northwind Air lost my bag (${stamp}-d).`);

  await page.goto(`/experiences/${experienceId}`);
  // Both controls are present and visibly different acts.
  await expect(page.getByRole('button', { name: 'Dispute this' })).toBeVisible();
  await expect(page.getByText('Was this resolved for you?')).toBeVisible();

  await page.getByRole('button', { name: 'Dispute this' }).click();
  await expect(
    page.getByText('A moderator reviews this. Neither side can decide it, and you can withdraw it at any time.'),
  ).toBeVisible();
  await page.getByLabel('What is wrong?').selectOption('account_inaccurate');
  await page.getByRole('button', { name: 'Raise dispute' }).click();

  await expect(page.getByText('This account is contested.')).toBeVisible();
  await expect(page.locator('.badge-contested')).toBeVisible();

  // Contested is not an outcome: the resolution state is untouched.
  const resolution = (await (await request.get(`/api/experiences/${experienceId}/resolution`)).json()) as {
    status: string;
    presentation: string;
  };
  expect(resolution.status).toBe('open');
  expect(resolution.presentation).toBe('unresolved_unreported');

  // And the experience is still published and unedited.
  expect((await request.get(`/api/experiences/${experienceId}`)).ok()).toBeTruthy();
});

test('responsiveness withholds timings below the sample floor and says how far off', async ({ page }) => {
  const request: Req = page.request;
  expect((await request.post('/api/test/seed', { data: {} })).ok()).toBeTruthy();

  await signUp(request, `${A}.r`);
  const experienceId = await publishAndConfirm(request, `Northwind Air never refunded me (${stamp}-r).`);

  await signUp(request, STAFF);
  expect(
    (await request.post('/api/test/seed', { data: { grantOrganizationMembership: true } })).ok(),
  ).toBeTruthy();
  expect(
    (
      await request.post('/api/organizations/org_northwind/responses', {
        data: { experienceId, kind: 'acknowledge', body: 'We have seen this.' },
      })
    ).status(),
  ).toBe(201);

  // The snapshot is recomputed by a consumer, so wait for it rather than racing.
  await expect
    .poll(async () => {
      const response = await request.get('/api/organizations/org_northwind/responsiveness');
      const body = (await response.json()) as { casesAnswered: number };
      return body.casesAnswered;
    }, { timeout: 20_000, intervals: [200, 300, 500] })
    .toBeGreaterThan(0);

  const record = (await (await request.get('/api/organizations/org_northwind/responsiveness')).json()) as {
    casesAnswered: number;
    casesConfirmedResolved: number;
    insufficientSample: boolean;
    medianFirstResponseMs?: number;
    caption: string;
  };
  expect(record.casesConfirmedResolved, 'answering is not resolving').toBe(0);
  expect(record.insufficientSample).toBe(true);
  expect(record.medianFirstResponseMs, 'a median from one case is withheld').toBeUndefined();
  expect(record.caption).toContain('Too few cases');

  await page.goto('/organizations/org_northwind');
  await expect(page.getByText('Confirmed resolved')).toBeVisible();
  await expect(page.getByText(/Too few cases to describe a pattern yet/)).toBeVisible();
  // Nothing on this surface calls itself an SLA, and no timing is shown.
  await expect(page.getByText(/Typically first replies/)).toHaveCount(0);
});

test('no reputation surface shows a composite score', async ({ page }) => {
  const request: Req = page.request;
  expect((await request.post('/api/test/seed', { data: {} })).ok()).toBeTruthy();
  await signUp(request, `${A}.c`);
  const created = await request.post('/api/experiences', {
    data: {
      kind: 'rage', creationMode: 'text', category: 'Shopping & service',
      bodyText: `Northwind Air never refunded me (${stamp}-c).`, visibility: 'public',
    },
  });
  const { experienceId } = (await created.json()) as { experienceId: string };
  await expect
    .poll(async () => {
      const response = await request.get('/api/experiences');
      const body = (await response.json()) as { entries: { experienceId: string }[] };
      return body.entries.some((entry) => entry.experienceId === experienceId);
    }, { timeout: 20_000, intervals: [100, 200, 300, 500] })
    .toBe(true);

  const session = (await (await request.post('/api/session', { data: { mode: 'signin', email: `${A}.c` } })).json()) as {
    actorId: string;
  };
  const contribution = (await (await request.get(`/api/actors/${session.actorId}/contribution`)).json()) as
    Record<string, unknown>;

  for (const key of Object.keys(contribution)) {
    expect(key.toLowerCase()).not.toMatch(/score|rating|rank|grade|trust|risk/);
  }
  // Withheld below the floor rather than shown small.
  expect(contribution['approvalRate']).toBeUndefined();
  expect(contribution['insufficientSample']).toBe(true);

  await signIn(request, `${A}.c`);
  await page.goto(`/experiences/${experienceId}`);
  // The detail page shows named counts and nothing that reads as a verdict.
  await expect(page.getByRole('button', { name: /Re-Rage/ })).toBeVisible();
  await expect(page.getByText(/Fair Rager\?/)).toBeVisible();
});
