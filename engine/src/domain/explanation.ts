import { floorFor, type Measure, type MeasureKind } from './sampling.ts';

/**
 * The explainability contract — Phase 92.
 *
 * Eight `explain*` functions already exist — `explainOrder`, `explainRelevance`,
 * `explainConfidence`, `explainQuality`, `explainResolutionQuality`, `explainEligibility`,
 * `explainProfile`, `explainDecision` — and every one of them is correct. The problem is that no
 * two share a shape, so **no surface can render "why" generically and no test can assert that a
 * new measure is explainable at all.** A ninth measure added next month would be explainable or
 * not depending on whether its author happened to write a function, and nothing would catch it.
 *
 * So this is a contract over what exists rather than a rewrite of it. Each of the eight keeps its
 * own prose — the words are the useful part and a generic renderer would flatten them — and gains
 * a structural form that a surface, a test or an auditor can rely on.
 *
 * ## The seven fields, and why each is not optional
 *
 * **conclusion** — what is being said. Without it the rest is a justification for nothing.
 *
 * **factors** — named, in the order that decided it. A factor list whose order means nothing is a
 * word cloud; the whole repair of Phase 73 was that precedence is the argument.
 *
 * **basis** — rows a reader can open. "Because the data says so" is not an explanation, and
 * Phase 57 already refuses a conclusion with no openable reference.
 *
 * **confidence** — present or explicitly absent. `undefined` is a real answer and is different
 * from zero: several reads here have no notion of confidence, and a zero would read as certainty
 * about the negative.
 *
 * **sample** — how many, against the floor. A band from four people and a band from four hundred
 * are different claims, and a surface that shows only the band cannot tell them apart.
 *
 * **staleness** — when the inputs were last current. Phase 54 made a signal able to stop being
 * current; an explanation that omits this presents history as news.
 *
 * **withheld** — the reason, when there is nothing to say. This is the field that makes the
 * contract honest: a measure below its floor must explain **why it is withheld**, rather than
 * omitting itself and leaving the surface to invent a reason or show a blank.
 */

/** One named input and which way it pushed. */
export interface ExplanationFactor {
  readonly name: string;
  readonly direction: 'raises' | 'lowers' | 'neutral';
  /** In words, for a reader. Never a number on its own. */
  readonly detail: string;
}

/** A row a reader can open. Deliberately the same shape Phase 57 already requires. */
export interface ExplanationBasis {
  readonly kind: string;
  readonly id: string;
}

export interface ExplanationSample {
  readonly size: number;
  readonly floor: number;
  readonly clears: boolean;
}

export interface Explanation {
  readonly conclusion: string;
  readonly factors: readonly ExplanationFactor[];
  readonly basis: readonly ExplanationBasis[];
  /** `undefined` when this read has no notion of confidence. Not zero. */
  readonly confidence: number | undefined;
  readonly sample: ExplanationSample | undefined;
  /** When the inputs were last current, and whether that is still recent enough to state. */
  readonly staleness: { readonly asOf: number; readonly current: boolean } | undefined;
  /** Set exactly when there is no conclusion to state, and it says why. */
  readonly withheld: string | undefined;
}

/**
 * The floors, as a sample fact.
 *
 * Composes `floorFor` rather than restating a number, so a floor changed in one place changes
 * here too. A sample that does not clear its floor is the normal case for a young pattern and is
 * not an error.
 */
export const sampleFrom = (kind: MeasureKind, size: number): ExplanationSample => {
  const floor = floorFor(kind);
  return { size, floor, clears: size >= floor };
};

/**
 * Build the explanation for a withheld measure.
 *
 * **This is the case the contract exists for.** A measure below its floor has no conclusion, and
 * the tempting shape is to return nothing — at which point the surface shows a blank and the
 * reader concludes whatever they like. Instead it returns an explanation whose `withheld` says
 * how short the sample is, with `conclusion` stating the only honest thing available.
 */
export const withheldExplanation = (
  what: string,
  kind: MeasureKind,
  size: number,
): Explanation => {
  const sample = sampleFrom(kind, size);
  return {
    conclusion: `There is not enough here to say anything about ${what}.`,
    factors: [],
    basis: [],
    confidence: undefined,
    sample,
    staleness: undefined,
    withheld: `${size} of the ${sample.floor} needed. Below the floor this is withheld rather than estimated, because "we do not know" and a low number are different statements.`,
  };
};

/** Lift a `Measure<T>` into the contract, so the withheld branch cannot be forgotten. */
export const explainMeasure = <T>(
  what: string,
  kind: MeasureKind,
  measure: Measure<T>,
  whenReported: (value: T) => Omit<Explanation, 'sample' | 'withheld'>,
): Explanation => {
  // `sampleSize` travels on both branches of `Measure`, so the real size is used rather than
  // reconstructed from `shortBy` — a reconstruction would be right today and wrong the moment a
  // floor changed between the measurement and the explanation.
  if (measure.withheld) return withheldExplanation(what, kind, measure.sampleSize);
  return {
    ...whenReported(measure.value),
    sample: sampleFrom(kind, measure.sampleSize),
    withheld: undefined,
  };
};

/**
 * Whether an explanation is well-formed.
 *
 * Used by the Phase 92 guard rather than at runtime, because a malformed explanation is a bug in
 * the read that produced it and should fail a test rather than be repaired on the way out.
 *
 * The two rules that do real work: a conclusion must either be stated **or** withheld with a
 * reason — never neither, and never both — and a stated conclusion must name at least one factor.
 * A conclusion with no factors is the opaque composite this whole codebase refuses, wearing a
 * sentence.
 */
export const explanationProblems = (explanation: Explanation): readonly string[] => {
  const problems: string[] = [];
  if (explanation.conclusion.trim().length === 0) problems.push('no conclusion');
  if (explanation.withheld !== undefined && explanation.withheld.trim().length === 0) {
    problems.push('withheld with no reason');
  }
  if (explanation.withheld === undefined && explanation.factors.length === 0) {
    problems.push('a stated conclusion with no named factors is an opaque composite with a sentence on it');
  }
  if (explanation.withheld !== undefined && explanation.factors.length > 0) {
    problems.push('withheld but carrying factors, which would invite reading the factors as the answer');
  }
  if (explanation.confidence !== undefined && (explanation.confidence < 0 || explanation.confidence > 1)) {
    problems.push('confidence outside 0..1');
  }
  return problems;
};

export const isWellFormed = (explanation: Explanation): boolean =>
  explanationProblems(explanation).length === 0;

/**
 * The reads that decide something and must therefore be explainable.
 *
 * Enumerated here by the *module* that owns each, so the Phase 92 guard can walk `src/domain` and
 * assert each one exports an `explain*`. A hand-maintained list of function names would go stale;
 * a list of modules whose contents are then discovered does not, because adding a decision to an
 * already-listed module is covered automatically and adding a new module is the one thing a
 * reviewer will notice.
 */
export const EXPLAINABLE_MODULES: readonly string[] = [
  'confidence.ts',
  'quality.ts',
  'relevance.ts',
  'priority.ts',
  'personalization.ts',
  'notification-pipeline.ts',
  'reputation.ts',
];

/**
 * The absences, as code.
 *
 * `opaqueCompositeIsAuthoritative` — false. A read that cannot produce an explanation is not
 * allowed to decide anything, which is the rule the guard enforces by discovery.
 *
 * `explanationOmitsAWithheldMeasure` — false, and it is the subtle one. The failure mode is not a
 * lie; it is silence. A withheld measure that simply does not appear leaves the surface to show a
 * blank, and a reader fills a blank with a guess.
 */
export const opaqueCompositeIsAuthoritative = (): false => false;
export const explanationOmitsAWithheldMeasure = (): false => false;
