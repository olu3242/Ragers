import process from 'node:process';
import { createDb, type Db } from '../src/adapters/postgres/client.ts';

/**
 * The persistence a deployment actually gets — the fix for a P1 found on PR #5.
 *
 * ## What was wrong
 *
 * `lib/engine-instance.ts` called `createEngine()` with no options, and its own comment said
 * *"a deployment swaps the in-memory adapters for the Postgres/Supabase ones by passing `store`
 * here"*. **Nothing ever passed it.** So every API request used the in-memory adapters even with
 * `DATABASE_URL` configured: accounts and experiences vanished on restart, two web processes saw
 * different data, and `scripts/worker.ts` — which repeated the same no-argument construction —
 * drained its own empty outbox rather than the web tier's.
 *
 * The whole hexagonal apparatus was correct and certified against Postgres by the live suite, and
 * the one line that connects it to a running application was missing. A comment asserting a
 * property the code does not have, which is the defect class this codebase has found most often.
 *
 * ## Why this returns a `Db` and not an `EngineStore`
 *
 * The first version of this module returned a store, and that would have been a *second* half-fix.
 * `createEngine` derives more than the domain store from a database: the idempotency store, the
 * outbox, the delivery ledger, the dead-letter store, the worker registry, the job history, and
 * the transaction boundary that makes a command's rows and its events commit together. Passing
 * `store` alone would have persisted the domain rows and left every one of those in process
 * memory — so a restart would still lose undelivered events, and the standalone worker would
 * still drain an empty outbox while the web tier's filled up. The `db` option is the one that
 * makes all of it Postgres.
 *
 * ## Why this is its own module
 *
 * Both entry points need the identical decision — the web tier and the standalone worker must
 * agree about which database they are draining, or the worker drains nothing. One function,
 * imported twice, so they cannot drift.
 */

/**
 * The configured database, or `undefined` to mean the in-memory adapters.
 *
 * `undefined` rather than throwing, because in-memory is the correct choice for local development
 * and for the test harness, and a composition root that refused to start without a database would
 * make `npm run dev` need one. `/api/readiness` reports which it is, so the fact is visible
 * rather than assumed.
 *
 * **`DATABASE_URL` only.** `RAGERS_TEST_DATABASE_URL` is the certification harness's variable and
 * is deliberately not read here: it is exported whenever a live suite can run, so honouring it
 * would silently change which backend the browser gate exercises depending on whether a database
 * happened to be available. An application tier configured by a variable named `TEST` is a
 * conflation, not a convenience.
 */
export const configuredDb = (): Db | undefined => {
  const url = configuredDatabaseUrl();
  if (url === undefined) {
    /**
     * **Fail closed, and here rather than at a request.**
     *
     * In-memory is right for `npm run dev` and for the tests, and it is catastrophic in a
     * deployment: state vanishes on restart, two instances disagree, and the *symptom* is not an
     * error — it is a person's account seeming not to exist any more. There is no error path that
     * reports that, which is why it has to be refused at construction.
     *
     * A deployment that has not declared itself is treated as hosted for this check while being
     * treated as local for the cookie's `Secure` attribute. Those defaults point in opposite
     * directions deliberately: each fails towards refusing rather than towards serving.
     */
    if (isHostedDeployment()) {
      throw new Error(
        'DATABASE_URL is required: a hosted deployment refuses to start on the in-memory adapters, '
          + 'because losing state on restart is not an error any request could report. '
          + 'Set DATABASE_URL, or set RAGERS_DEPLOYMENT=local if this really is a local process.',
      );
    }
    return undefined;
  }
  return createDb({ connectionString: url });
};

/** Whether this process is persisting anything, for the readiness and health reads to report. */
export const isPersistent = (): boolean => configuredDatabaseUrl() !== undefined;

/** The configured URL's presence, never its value — a connection string is a credential. */
export const configuredDatabaseUrl = (): string | undefined => {
  const url = process.env['DATABASE_URL'];
  return url === undefined || url.trim().length === 0 ? undefined : url;
};

/**
 * Whether this process may issue a session from an email address alone.
 *
 * Gated on `RAGERS_TEST_SEED=enabled` rather than on a flag of its own, and that is the whole
 * point: the fixture route is already gated on it, `tests/unit/host.surfaces.test.ts` already
 * asserts that gate exists, and the release contract already records that the seed flag must never
 * be set in a deployment. **One switch that is already certified off beats two that each need
 * their own proof.** A second variable would be a second thing to leave on.
 *
 * The browser suite needs this because four of its specs sign in as personas they registered in an
 * earlier step; the engine's default is to refuse, which is what closed the hole.
 */
export const passwordlessSignInAllowed = (): boolean => process.env['RAGERS_TEST_SEED'] === 'enabled';

/**
 * Whether this process is running as a hosted deployment rather than a local one.
 *
 * Not `NODE_ENV`. `next build` sets `NODE_ENV=production` on a laptop, so a check on it would call
 * a local production build "hosted" and, worse, would call a real deployment that forgot to set it
 * "local" — failing open in exactly the case that matters. `RAGERS_DEPLOYMENT` is explicit: a
 * deployment declares itself, and anything that has not declared itself is treated as local for
 * *convenience* decisions and as hosted for *safety* decisions. Those two defaults point in
 * opposite directions on purpose.
 */
export const isHostedDeployment = (): boolean => {
  const declared = process.env['RAGERS_DEPLOYMENT'];
  if (declared !== undefined && declared.trim().length > 0) return declared.trim() !== 'local';
  // Vercel sets this on every deployment, including previews. Treated as a hosted signal because
  // being wrong in this direction costs a developer one environment variable, and being wrong in
  // the other direction ships a session cookie in clear.
  return process.env['VERCEL'] === '1' || process.env['VERCEL_ENV'] !== undefined;
};

/**
 * Cookie attributes for the session cookie.
 *
 * `HttpOnly` always: the session must be unreachable from page scripts whatever the environment.
 * `Secure` on every hosted deployment, and deliberately **not** on plain local HTTP — a browser
 * silently drops a Secure cookie over `http://localhost`, so forcing it there would make sign-in
 * appear to fail with nothing in any log to explain it.
 *
 * `SameSite=Lax` rather than `Strict`: `Strict` drops the cookie on a cross-site navigation, which
 * means following a link to a Rager from anywhere else would land the reader signed out. `Lax`
 * still refuses the cookie on cross-site POSTs, which is the CSRF-relevant half.
 */
export const cookieAttributes = (): string =>
  isHostedDeployment() ? 'HttpOnly; Secure; SameSite=Lax' : 'HttpOnly; SameSite=Lax';
