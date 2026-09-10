import { eq } from '../ports/store.ts';
import {
  emptyProfile,
  profileIsEmpty,
  type RelevanceProfile,
} from '../domain/relevance-profile.ts';
import { discover, type DiscoveryQuery, type DiscoveryResult } from './discovery.engine.ts';
import type { Experience } from '../domain/experience.ts';
import type { ExperienceSubject, WatchRow } from '../ports/store.ts';
import type { EngineDeps } from './deps.ts';

/**
 * The relevance profile, and personalised discovery — Phase 74.
 *
 * The profile is **derived on read and stored nowhere**. There is no
 * `relevance_profiles` table and no migration for one, which means there is nothing to
 * leak, nothing to keep in sync, and nothing to forget to delete when somebody leaves —
 * their watches and experiences go, and the profile goes with them because it never
 * existed apart from them.
 *
 * Every input is something the person did on purpose. See
 * `src/domain/relevance-profile.ts` for the forbidden list and the reasons; the short
 * version is that nothing in this codebase records what anybody *read*, and this phase's
 * job is to make that permanent rather than incidental.
 */

/**
 * Build somebody's profile from their own deliberate actions.
 *
 * Takes the actor id it is building for and returns only that person's profile. There is
 * deliberately no "viewer" parameter and no authorization branch, because there is no
 * legitimate call that builds one person's profile for another to read — the shape of the
 * function is the enforcement.
 */
export const profileFor = async (deps: EngineDeps, actorId: string): Promise<RelevanceProfile> => {
  const watches = await deps.store.watches.query([eq<WatchRow>('actorId', actorId)]);
  const watchedExperienceIds = watches
    .filter((row) => row.targetType === 'experience')
    .map((row) => row.targetId);
  const followedSubjectIds = watches
    .filter((row) => row.targetType === 'subject')
    .map((row) => row.targetId);

  // Their own experiences: the categories they chose and the places they named. Not "the
  // categories they browsed", because nothing knows what they browsed.
  const own = await deps.store.experiences.query([eq<Experience>('actorId', actorId)]);
  const authoredCategories = [...new Set(own.map((row) => row.category))];
  const statedLocalityIds = [
    ...new Set(own.map((row) => row.locationId).filter((id): id is string => id !== undefined)),
  ];

  return {
    actorId,
    followedSubjectIds,
    watchedExperienceIds,
    authoredCategories,
    statedLocalityIds,
  };
};

/**
 * Discovery narrowed by a profile.
 *
 * **An empty profile produces unfiltered discovery, never an empty feed.** That branch is
 * the one worth writing carefully: filter by an empty set of subjects and you get nothing,
 * so a brand-new account would open the app to a blank page. The failure is one line of
 * plausible-looking code away, which is why `profileIsEmpty` is a named function rather
 * than an inline length check.
 *
 * The profile **narrows and never orders**. Ordering is Phase 73's, over the same named
 * factors for everybody — so two people looking at the same set see it in the same order,
 * and nobody's feed is quietly ranked by a model of them. A weighted profile would be a
 * second ranking function competing with the explainable one, and the explainable one would
 * lose because nobody would be able to tell.
 */
export const discoverForActor = async (
  deps: EngineDeps,
  actorId: string,
  query: DiscoveryQuery = {},
): Promise<readonly DiscoveryResult[]> => {
  const profile = await profileFor(deps, actorId);
  // Phase 86: the viewer travels with every arm, the fallbacks included. A fallback that
  // dropped it would be precisely the path a block leaks through — and it is the path taken
  // most often, because most profiles are empty.
  const scoped: DiscoveryQuery = { ...query, viewerId: actorId };
  if (profileIsEmpty(profile)) return discover(deps, scoped);

  // A union across the profile's declared interests, deduplicated. Each arm is an ordinary
  // discovery read, so every result has already been status-checked and has its factors.
  const seen = new Set<string>();
  const results: DiscoveryResult[] = [];

  const take = (found: readonly DiscoveryResult[]): void => {
    for (const result of found) {
      if (seen.has(result.experienceId)) continue;
      seen.add(result.experienceId);
      results.push(result);
    }
  };

  for (const subjectId of profile.followedSubjectIds) {
    take(await discover(deps, { ...scoped, subjectId }));
  }
  for (const category of profile.authoredCategories) {
    take(await discover(deps, { ...scoped, category }));
  }

  // Watched experiences are included as themselves — somebody who asked to follow an
  // outcome should see it — but only if they are still discoverable, which `discover`
  // decides.
  for (const experienceId of profile.watchedExperienceIds) {
    const links = await deps.store.experienceSubjects.query([
      eq<ExperienceSubject>('experienceId', experienceId),
    ]);
    for (const link of links) take(await discover(deps, { ...scoped, subjectId: link.subjectId }));
  }

  // A profile that matched nothing is not a reason to show nothing. Somebody who follows a
  // subject that has gone quiet still gets a feed.
  if (results.length === 0) return discover(deps, scoped);

  return results.slice(0, query.limit ?? 25);
};

/**
 * A signed-out visitor's profile: empty, by construction.
 *
 * Exported so the surface does not have to decide what a guest's profile is. A guest has
 * declared nothing, so they see everything — which is both the honest answer and the one
 * that avoids a signed-out visitor being profiled by session.
 */
export const guestProfile = (): RelevanceProfile => emptyProfile('guest');
