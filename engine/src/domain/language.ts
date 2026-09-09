import type { ExperienceKind } from './types.ts';

/**
 * Language Safety Engine — guidance, never rewriting.
 *
 * Ragers is about behaviour, not people: "critique the behaviour, protect the
 * human". This module helps someone say what happened without turning it into an
 * attack on a person, and it does that by *offering* an observation, never by
 * substituting one. Nothing here edits the person's text.
 *
 * Why guidance rather than enforcement: a rule that silently rewrote an account
 * would put words in someone's mouth, and one that blocked publication over
 * wording would fall hardest on people writing in a second language, or writing
 * while upset — which is most people, most of the time, when something has gone
 * wrong. The two things that *do* block publication are unchanged and live
 * elsewhere: identifying details, and naming a private individual.
 */

export type GuidanceKind =
  | 'names_a_person'
  | 'attacks_the_person'
  | 'absolute_claim'
  | 'threat'
  | 'no_specifics';

export interface Guidance {
  readonly kind: GuidanceKind;
  /** Shown to the person. Plain, non-scolding, and about the writing. */
  readonly message: string;
  /** True when publication is blocked rather than merely advised. */
  readonly blocking: boolean;
  /** The span this is about, so the composer can point at it. */
  readonly excerpt?: string;
}

/**
 * Words that characterise a person rather than describe what they did.
 *
 * Kept short and specific on purpose. A long list of banned words becomes a
 * filter people learn to route around, and it starts flagging ordinary accounts
 * of genuinely bad behaviour.
 */
const PERSON_ATTACK_TERMS: readonly string[] = [
  'idiot',
  'idiots',
  'moron',
  'morons',
  'stupid',
  'scum',
  'trash',
  'worthless',
  'disgusting',
  'pathetic',
];

/** Language that reads as intent to harm. This is the one that blocks. */
const THREAT_PATTERNS: readonly RegExp[] = [
  /\bi(?:'ll| will| am going to| gonna)\s+(?:find|hurt|kill|destroy|end)\b/i,
  /\bshould be (?:shot|beaten|hurt|killed)\b/i,
  /\bsomeone should\s+(?:hurt|beat|attack)\b/i,
];

/** Absolutes that overstate what one experience can establish. */
const ABSOLUTE_PATTERNS: readonly RegExp[] = [
  /\b(?:always|never)\s+(?:does|do|deliver|delivers|answer|answers|help|helps)\b/i,
  /\bevery single (?:time|one|person|customer)\b/i,
  /\ball of them\b/i,
];

export interface GuidanceInput {
  readonly text: string;
  readonly kind: ExperienceKind;
  /** Findings from the privacy layer, which is where names are actually detected. */
  readonly namesPerson: boolean;
}

const excerptFor = (text: string, match: string): string | undefined => {
  const index = text.toLowerCase().indexOf(match.toLowerCase());
  if (index === -1) return undefined;
  return text.slice(Math.max(0, index - 15), Math.min(text.length, index + match.length + 15)).trim();
};

/**
 * Guidance for a draft. Advisory unless `blocking` is set.
 *
 * Order matters: the blocking finding comes first, so a composer that shows only
 * one message shows the one that stops publication.
 */
export const guidanceFor = (input: GuidanceInput): readonly Guidance[] => {
  const guidance: Guidance[] = [];
  const text = input.text;

  for (const pattern of THREAT_PATTERNS) {
    const match = pattern.exec(text);
    if (!match) continue;
    guidance.push({
      kind: 'threat',
      message: 'This reads as a threat. Ragers is for what happened, not for what should happen to someone.',
      blocking: true,
      ...(match[0] === undefined ? {} : { excerpt: match[0] }),
    });
    break;
  }

  if (input.namesPerson) {
    guidance.push({
      kind: 'names_a_person',
      // Not a refusal: it goes to review, and the person is told why.
      message: 'This looks like it names someone. Describing what happened works better than naming who.',
      blocking: false,
    });
  }

  const lowered = text.toLowerCase();
  const attack = PERSON_ATTACK_TERMS.find((term) =>
    new RegExp(`\\b${term}\\b`).test(lowered),
  );
  if (attack) {
    guidance.push({
      kind: 'attacks_the_person',
      message: 'That describes the person rather than what they did. What did they actually do?',
      blocking: false,
      ...(excerptFor(text, attack) === undefined ? {} : { excerpt: excerptFor(text, attack) as string }),
    });
  }

  for (const pattern of ABSOLUTE_PATTERNS) {
    const match = pattern.exec(text);
    if (!match) continue;
    guidance.push({
      kind: 'absolute_claim',
      message:
        input.kind === 'rage'
          ? 'One experience is strong on its own. Saying what happened to you is harder to argue with than “always”.'
          : 'Saying what happened to you carries further than “always”.',
      blocking: false,
      ...(match[0] === undefined ? {} : { excerpt: match[0] }),
    });
    break;
  }

  // Not a judgement about length: an account with no concrete detail is one
  // nobody else can recognise, which is what makes corroboration possible.
  const words = text.trim().split(/\s+/).filter((word) => word.length > 0);
  if (words.length > 0 && words.length < 8) {
    guidance.push({
      kind: 'no_specifics',
      message: 'A little more detail helps other people recognise the same thing happening to them.',
      blocking: false,
    });
  }

  return guidance;
};

/** True when guidance stops publication. Only a threat does. */
export const isBlocked = (guidance: readonly Guidance[]): boolean =>
  guidance.some((entry) => entry.blocking);
