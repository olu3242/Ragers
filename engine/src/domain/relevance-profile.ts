/**
 * Phase 74 — the relevance profile, and why it is so small.
 *
 * ## The finding this phase is built on
 *
 * The gate analysis expected to have to *restrain* a relevance profile — to look at what
 * signals were available and rule out the invasive ones. It turned out there is nothing to
 * rule out: **this codebase records no views, no dwell time, no scroll depth, no click
 * history and no session activity of any kind.** A grep for any of them finds nothing.
 *
 * That absence is not a gap. It is the most valuable thing in this phase, and it happened
 * because nothing ever needed it — which is exactly how surveillance infrastructure usually
 * *does* arrive, one reasonable-seeming metric at a time, each one added for a purpose
 * nobody would argue with.
 *
 * So the phase's job is not to build a profile carefully. It is to make the absence
 * **permanent**: to state which inputs are allowed, name the forbidden ones with their
 * reasons, and put a discovery guard behind it so the first person to add view tracking has
 * to argue with a test rather than with a convention.
 *
 * ## What a profile is here
 *
 * Only what somebody declared or did deliberately, and every entry is something they could
 * be shown without surprise:
 *
 *   - **Followed subjects** — they tapped follow.
 *   - **Watched experiences** — they tapped watch (Phase 78).
 *   - **Categories they have posted in** — they wrote something and chose a category.
 *   - **Locality they stated** — they typed it into an experience.
 *
 * Not "categories they read", because nothing knows what they read. Not "similar to people
 * like you", because that requires knowing what people like them did. The profile is a list
 * of things this person did on purpose, and the strongest argument for it is that a person
 * reading their own profile would recognise every line as their own action.
 *
 * ## Derived on read, stored nowhere
 *
 * There is no `relevance_profiles` table and no migration for one. The profile is computed
 * from rows that already exist for their own reasons, which means there is nothing to leak,
 * nothing to keep in sync, and nothing to forget to delete when somebody leaves — their
 * follows and experiences go, and the profile goes with them because it never existed
 * apart from them.
 */

/** The only inputs a relevance profile may draw on. The list is closed. */
export type ProfileInput =
  | 'followed_subjects'
  | 'watched_experiences'
  | 'authored_categories'
  | 'stated_locality';

export const PROFILE_INPUTS: readonly ProfileInput[] = [
  'followed_subjects',
  'watched_experiences',
  'authored_categories',
  'stated_locality',
];

/**
 * Inputs that may never enter a profile, each with its reason.
 *
 * None of these exists in the codebase today. They are listed so that adding one has to
 * pass a test that names the objection, rather than passing review because the person
 * reviewing it had a plausible reason to want it.
 */
export const FORBIDDEN_PROFILE_INPUTS: Readonly<Record<string, string>> = {
  view_history:
    'Nothing records what somebody read, and reading is not a declaration. Somebody who opens an experience about a hospital has told you nothing except that they were curious, and treating it as a preference is treating curiosity as a disclosure.',
  dwell_time:
    'How long somebody looked at something is the most invasive signal in this class and the easiest to collect. On a platform whose content is what happened to people, dwell time on distressing material is a health inference.',
  scroll_depth: 'The same objection as dwell time, with a worse ratio of usefulness to intrusion.',
  inferred_demographics:
    'Age, gender, income or location inferred from behaviour is a claim about somebody they never made, used to decide what they see.',
  similar_users:
    'Collaborative filtering requires modelling what people like this person did. Nobody consented to being a member of a cohort.',
  read_content_terms:
    'Extracting terms from what somebody read builds a topic profile out of their curiosity. The terms they *wrote* are theirs; the terms they read are not.',
  sentiment: 'Inferring how somebody feels from what they engage with is a mood profile.',
};

/**
 * A profile: four lists and nothing else.
 *
 * Every field is a set of ids the person themselves put there. There is no score, no
 * weight and no ranking — the profile *narrows* discovery, and the ordering within it is
 * Phase 73's job. A weighted profile would be a second ranking function competing with the
 * explainable one.
 */
export interface RelevanceProfile {
  readonly actorId: string;
  readonly followedSubjectIds: readonly string[];
  readonly watchedExperienceIds: readonly string[];
  readonly authoredCategories: readonly string[];
  readonly statedLocalityIds: readonly string[];
}

/** An empty profile — what a brand-new account has, and what a signed-out visitor gets. */
export const emptyProfile = (actorId: string): RelevanceProfile => ({
  actorId,
  followedSubjectIds: [],
  watchedExperienceIds: [],
  authoredCategories: [],
  statedLocalityIds: [],
});

/**
 * Whether this profile has anything in it.
 *
 * Load-bearing, because of what an empty profile must *not* do: an empty profile produces
 * **unfiltered discovery**, never an empty feed. A new account seeing nothing because it has
 * not declared anything yet is the worst possible first impression, and the failure is easy
 * to write by accident — filter by an empty set and you get an empty result.
 */
export const profileIsEmpty = (profile: RelevanceProfile): boolean =>
  profile.followedSubjectIds.length === 0 &&
  profile.watchedExperienceIds.length === 0 &&
  profile.authoredCategories.length === 0 &&
  profile.statedLocalityIds.length === 0;

/**
 * The profile's own account of itself, for a person who asks what it knows.
 *
 * Four sentences a person can check against their own memory. This exists because a profile
 * nobody can inspect is one nobody can correct, and "we personalise using your activity" is
 * not an answer.
 */
export const explainProfile = (profile: RelevanceProfile): readonly string[] => {
  const lines: string[] = [];
  if (profile.followedSubjectIds.length > 0) {
    lines.push(`${profile.followedSubjectIds.length} subject(s) you chose to follow`);
  }
  if (profile.watchedExperienceIds.length > 0) {
    lines.push(`${profile.watchedExperienceIds.length} experience(s) you chose to watch`);
  }
  if (profile.authoredCategories.length > 0) {
    lines.push(`the categories you have posted in: ${profile.authoredCategories.join(', ')}`);
  }
  if (profile.statedLocalityIds.length > 0) {
    lines.push(`${profile.statedLocalityIds.length} place(s) you named in your own accounts`);
  }
  if (lines.length === 0) {
    lines.push('nothing yet — you will see everything until you follow, watch or post something');
  }
  return lines;
};

/**
 * The absences, as code.
 *
 * `profileIsStored` — there is no table, so there is nothing to leak and nothing to forget
 * to delete. `profileRanksAnything` — the profile narrows and never orders, so it cannot
 * become a second ranking function beside the explainable one. `profileIsReadableByOthers`
 * — a profile is a list of somebody's own deliberate actions, and it is theirs.
 */
export const profileIsStored = (): false => false;
export const profileRanksAnything = (): false => false;
export const profileIsReadableByOthers = (): false => false;
