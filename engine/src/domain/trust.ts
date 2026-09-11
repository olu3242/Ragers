import type { CorroborationType } from './corroboration.ts';

/**
 * Trust — internal only.
 *
 * There is deliberately **no public trust score**. A number next to a person's
 * name would turn every contribution into a referendum on the contributor, and
 * would fall hardest on new accounts and on people posting anonymously — which is
 * to say, on exactly the people the product exists to make safe. Trust exists to
 * help the system weigh signals and spot manufactured ones, and it is visible to
 * moderators, never to the public.
 *
 * Three separate confidences rather than one: they answer different questions and
 * have different remedies. A brand-new account with a careful, well-corroborated
 * report is low on account confidence and high on contribution confidence, and
 * flattening that into one figure would lose the only part that matters.
 */

export type RiskKind =
  | 'burst_posting'
  | 'coordinated_corroboration'
  | 'duplicate_content'
  | 'retraction_churn'
  | 'evidence_reuse'
  | 'report_abuse';

export const RISK_KINDS: readonly RiskKind[] = [
  'burst_posting',
  'coordinated_corroboration',
  'duplicate_content',
  'retraction_churn',
  'evidence_reuse',
  'report_abuse',
];

export interface TrustInputs {
  readonly accountAgeMs: number;
  readonly publishedExperiences: number;
  readonly activeCorroborations: number;
  readonly retractedCorroborations: number;
  readonly upheldReports: number;
  readonly dismissedReports: number;
  readonly moderationRemovals: number;
  readonly evidenceAttached: number;
  readonly evidenceContradicted: number;
  readonly riskFlags: readonly RiskKind[];
}

export interface TrustAssessment {
  readonly accountConfidence: number;
  readonly contributionConfidence: number;
  readonly evidenceConfidence: number;
  readonly riskFlags: readonly RiskKind[];
  /** Why each confidence landed where it did, for a moderator to read. */
  readonly rationale: readonly string[];
}

const ACCOUNT_MATURITY_MS = 30 * 24 * 60 * 60 * 1_000;
const clamp = (value: number): number => Number(Math.min(1, Math.max(0, value)).toFixed(3));

/**
 * Compute an assessment.
 *
 * Everything here derives from durable facts — account age, published
 * experiences, upheld reports, moderation outcomes — never from sentiment, tone,
 * or how angry a person sounded. A furious, accurate report must not cost its
 * author trust.
 */
export const assessTrust = (inputs: TrustInputs): TrustAssessment => {
  const rationale: string[] = [];

  // Account: age and a track record, nothing else. New is not suspicious.
  const maturity = Math.min(1, inputs.accountAgeMs / ACCOUNT_MATURITY_MS);
  const removalPenalty = Math.min(0.4, inputs.moderationRemovals * 0.1);
  const accountConfidence = clamp(0.4 + maturity * 0.4 + Math.min(0.2, inputs.publishedExperiences * 0.04) - removalPenalty);
  if (maturity < 1) rationale.push('account is newer than the maturity window');
  if (inputs.moderationRemovals > 0) rationale.push(`${inputs.moderationRemovals} moderation removal(s)`);

  // Contribution: does what this person claims hold up? Retraction churn matters
  // because retracting is legitimate once and a pattern when repeated.
  const totalClaims = inputs.activeCorroborations + inputs.retractedCorroborations;
  const churn = totalClaims === 0 ? 0 : inputs.retractedCorroborations / totalClaims;
  const reportTotal = inputs.upheldReports + inputs.dismissedReports;
  const reportQuality = reportTotal === 0 ? 0.5 : inputs.upheldReports / reportTotal;
  const contributionConfidence = clamp(0.35 + reportQuality * 0.35 + Math.min(0.3, inputs.publishedExperiences * 0.05) - churn * 0.3);
  if (churn > 0.5) rationale.push('most corroborations from this actor were retracted');
  if (reportTotal > 0 && reportQuality < 0.3) rationale.push('most reports from this actor were dismissed');

  // Evidence: contradicted evidence is the strongest single negative signal here,
  // because it is a checkable disagreement rather than an inference.
  const evidenceConfidence = clamp(
    0.5 + Math.min(0.3, inputs.evidenceAttached * 0.06) - Math.min(0.5, inputs.evidenceContradicted * 0.25),
  );
  if (inputs.evidenceContradicted > 0) rationale.push(`${inputs.evidenceContradicted} piece(s) of contradicted evidence`);

  for (const flag of inputs.riskFlags) rationale.push(`risk flag: ${flag}`);

  return {
    accountConfidence,
    contributionConfidence,
    evidenceConfidence,
    riskFlags: [...new Set(inputs.riskFlags)].sort(),
    rationale,
  };
};

/**
 * Coordinated corroboration detection.
 *
 * The pattern of concern is a set of accounts corroborating the same experience
 * inside a very short window, which is what a bought or brigaded signal looks
 * like. Genuine bursts happen too — a story spreads — so this raises a *flag for
 * review*, never an automatic removal, and never a change to anyone's claim.
 */
export const BURST_WINDOW_MS = 5 * 60 * 1_000;
export const BURST_THRESHOLD = 5;

export const detectCoordinatedBurst = (
  corroborations: readonly { readonly corroboratorId: string; readonly createdAt: number; readonly type: CorroborationType }[],
): { readonly detected: boolean; readonly windowStart?: number; readonly count: number } => {
  if (corroborations.length < BURST_THRESHOLD) return { detected: false, count: corroborations.length };
  const sorted = [...corroborations].sort((a, b) => a.createdAt - b.createdAt);

  let best = { detected: false, count: 0, windowStart: 0 };
  for (let start = 0; start < sorted.length; start += 1) {
    const from = sorted[start]?.createdAt ?? 0;
    const inWindow = sorted.filter(
      (row) => row.createdAt >= from && row.createdAt <= from + BURST_WINDOW_MS,
    );
    // Distinct people: one person cannot burst, the unique key already prevents it.
    const distinct = new Set(inWindow.map((row) => row.corroboratorId)).size;
    if (distinct > best.count) best = { detected: distinct >= BURST_THRESHOLD, count: distinct, windowStart: from };
  }
  return best.detected ? { detected: true, count: best.count, windowStart: best.windowStart } : { detected: false, count: best.count };
};
