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

  // Scoped to the section it is about. Governed recommendations live on the same
  // page and *are* a reviewer's to decide, so a page-wide "no approve button"
  // assertion would be asserting the wrong rule in the wrong place.
  const unconfirmed = page.getByRole('region', { name: 'Structure only its author can confirm' });
  await expect(
    unconfirmed.getByText(
      'Nothing here has been applied. Until the person confirms it, matching treats each field as unknown — never as the proposed value.',
    ),
  ).toBeVisible();
  await expect(
    unconfirmed.getByText('Awaiting confirmation from the person who posted it.').first(),
  ).toBeVisible();

  // Structure read out of somebody's own account is theirs to confirm: an
  // operator gets no control here to do it on their behalf.
  for (const forbidden of ['Approve', 'Apply', 'Accept', 'Confirm']) {
    await expect(unconfirmed.getByRole('button', { name: forbidden })).toHaveCount(0);
  }
});

test('a reviewer decides a recommendation, and a refused approval never reads as done', async ({ page }) => {
  const request: Req = page.request;
  expect((await request.post('/api/test/seed', { data: {} })).ok()).toBeTruthy();

  // Somebody else's account, so removing it is a legitimate moderator action.
  await signUp(request, `${RAGER}.e`);
  const theirs = await publish(request, `Northwind Air never processed my refund (${stamp}-e).`);

  await signUp(request, `${OPERATOR}.e`);
  expect((await request.post('/api/test/seed', { data: { grantModerator: true } })).ok()).toBeTruthy();
  // The reviewer's own account. `moderation.action` forbids acting on your own
  // content, so approving a recommendation about this one must be refused
  // downstream — which is the case the surface has to report honestly.
  const mine = await publish(request, `Northwind Air rebooked me onto a worse flight (${stamp}-e2).`);

  const propose = async (subjectId: string, summary: string): Promise<void> => {
    const created = await request.post('/api/proposals', {
      data: {
        proposalType: 'remove_content',
        sourceEngine: 'E4',
        targetEngine: 'E9',
        subjectId,
        summary,
        rationale: 'Filed for review by a reviewer; the account is the only basis.',
        confidence: 0.9,
        evidenceRefs: [{ kind: 'experience', id: subjectId }],
        proposedCommand: 'safety.applyModerationAction',
        proposedInput: {
          targetType: 'experience',
          targetId: subjectId,
          action: 'remove',
          reason: 'reviewed under the community principles',
        },
      },
    });
    expect(created.status(), summary).toBe(201);
  };

  await propose(theirs, `Remove the account about the refund (${stamp}-e)`);
  await propose(mine, `Remove the account about the rebooking (${stamp}-e2)`);

  await page.goto('/operate/proposals');
  const recommendations = page.getByRole('region', { name: 'Recommendations for you to decide' });

  // The action is named, so approval authorises a specific thing.
  const theirCard = recommendations
    .locator('.recommendation')
    .filter({ hasText: `Remove the account about the refund (${stamp}-e)` });
  await expect(theirCard.getByText('safety.applyModerationAction').first()).toBeVisible();
  await expect(theirCard.getByText('Awaiting a decision. Nothing has been applied.')).toBeVisible();

  // Approving runs the governed engine's own command.
  await theirCard.getByRole('radio', { name: 'Approve' }).check();
  await theirCard.getByRole('button', { name: 'Approve' }).click();
  await expect(theirCard.getByText('Approved, and safety carried it out.')).toBeVisible();

  // The same approval on the reviewer's own account is refused by that engine,
  // and the card says so instead of claiming the removal happened.
  const myCard = recommendations
    .locator('.recommendation')
    .filter({ hasText: `Remove the account about the rebooking (${stamp}-e2)` });
  await myCard.getByRole('radio', { name: 'Approve' }).check();
  await myCard.getByRole('button', { name: 'Approve' }).click();
  await expect(myCard.getByText(/Approved, but safety refused it/)).toBeVisible();
  await expect(myCard.getByText(/Nothing was applied/)).toBeVisible();

  // And it is still there, unremoved. Read through the projection the reader
  // surfaces use: a removal suppresses the entry, so this staying available is the
  // invariant — polled because projection is asynchronous, not because it is flaky.
  await expect
    .poll(async () => (await request.get(`/api/experiences/${mine}`)).status(), {
      timeout: 20_000,
      intervals: [100, 200, 300, 500],
    })
    .toBe(200);
});

test('rejecting a recommendation requires a reason', async ({ page }) => {
  const request: Req = page.request;
  expect((await request.post('/api/test/seed', { data: {} })).ok()).toBeTruthy();
  await signUp(request, `${RAGER}.f`);
  const subject = await publish(request, `Northwind Air lost my bag again (${stamp}-f).`);

  await signUp(request, `${OPERATOR}.f`);
  expect((await request.post('/api/test/seed', { data: { grantModerator: true } })).ok()).toBeTruthy();
  const created = await request.post('/api/proposals', {
    data: {
      proposalType: 'remove_content',
      sourceEngine: 'E4',
      targetEngine: 'E9',
      subjectId: subject,
      summary: `Remove the account about the bag (${stamp}-f)`,
      rationale: 'Filed for review; the account is the only basis.',
      confidence: 0.4,
      evidenceRefs: [{ kind: 'experience', id: subject }],
      proposedCommand: 'safety.applyModerationAction',
      proposedInput: {
        targetType: 'experience',
        targetId: subject,
        action: 'remove',
        reason: 'reviewed under the community principles',
      },
    },
  });
  expect(created.status()).toBe(201);

  await page.goto('/operate/proposals');
  const card = page
    .locator('.recommendation')
    .filter({ hasText: `Remove the account about the bag (${stamp}-f)` });

  // An unexplained rejection teaches the proposing engine nothing and leaves the
  // subject with no account of what happened, so the control refuses to submit.
  await card.getByRole('radio', { name: 'Reject' }).check();
  await expect(card.getByRole('button', { name: 'Reject' })).toBeDisabled();

  await card.getByRole('textbox').fill('The account describes a delay, not something to remove.');
  await card.getByRole('button', { name: 'Reject' }).click();
  await expect(card.getByText('Rejected. Nothing was applied.')).toBeVisible();
});
