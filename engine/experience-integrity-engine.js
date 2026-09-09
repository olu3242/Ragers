'use strict';

const crypto = require('crypto');

const clamp = (n, min = 0, max = 100) => Math.max(min, Math.min(max, n));
const nowIso = () => new Date().toISOString();
const id = (prefix) => `${prefix}_${crypto.randomUUID()}`;

function normalizeText(input = '') {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(input = '') {
  return new Set(normalizeText(input).split(' ').filter(Boolean));
}

function jaccard(a, b) {
  const A = tokens(a);
  const B = tokens(b);
  if (!A.size || !B.size) return 0;
  let intersection = 0;
  for (const token of A) if (B.has(token)) intersection += 1;
  const union = new Set([...A, ...B]).size;
  return union ? intersection / union : 0;
}

function fingerprint(experience) {
  const material = [
    experience.type,
    experience.entityId || '',
    experience.topicId || '',
    experience.location?.city || '',
    normalizeText(experience.text || experience.transcript || '')
  ].join('|');
  return crypto.createHash('sha256').update(material).digest('hex');
}

class ExperienceIntegrityEngine {
  constructor(options = {}) {
    this.policy = {
      duplicateSimilarity: options.duplicateSimilarity ?? 0.92,
      relatedSimilarity: options.relatedSimilarity ?? 0.45,
      coordinationWindowMs: options.coordinationWindowMs ?? 10 * 60 * 1000,
      emergingIndependentSignals: options.emergingIndependentSignals ?? 5,
      highConfidenceIndependentSignals: options.highConfidenceIndependentSignals ?? 20,
      quarantineRisk: options.quarantineRisk ?? 80,
      limitRisk: options.limitRisk ?? 55
    };

    this.experiences = new Map();
    this.clusters = new Map();
    this.validationEvents = [];
    this.riskAssessments = [];
    this.corroborations = [];
    this.accountHistory = new Map();
  }

  submit(input) {
    if (!input || !input.actorId || !['rage', 'rave'].includes(input.type)) {
      throw new Error('actorId and type (rage|rave) are required');
    }

    const body = String(input.text || input.transcript || '').trim();
    if (!body) throw new Error('text or transcript is required');

    const experience = {
      id: id('exp'),
      actorId: input.actorId,
      type: input.type,
      source: input.source || 'text',
      entityId: input.entityId || null,
      topicId: input.topicId || null,
      text: input.text || null,
      transcript: input.transcript || null,
      occurredAt: input.occurredAt || null,
      submittedAt: input.submittedAt || nowIso(),
      location: input.location || null,
      evidence: Array.isArray(input.evidence) ? input.evidence : [],
      metadata: input.metadata || {},
      fingerprint: null,
      status: 'received',
      scores: null,
      clusterId: null,
      distributionDecision: null,
      history: []
    };

    experience.fingerprint = fingerprint(experience);
    this.experiences.set(experience.id, experience);
    this.#transition(experience, 'processing', 'submission_received');
    this.#evaluate(experience);
    this.#assignCluster(experience);
    this.#recordAccountActivity(experience);
    this.#recalculateCluster(experience.clusterId);
    return this.getExperience(experience.id);
  }

  corroborate(experienceId, input) {
    const experience = this.#mustGet(experienceId);
    if (!input?.actorId) throw new Error('actorId is required');
    if (input.actorId === experience.actorId) throw new Error('actors cannot corroborate their own experience');

    const mode = input.mode || 'same_experience';
    if (!['same_experience', 'similar_experience', 'support'].includes(mode)) {
      throw new Error('invalid corroboration mode');
    }

    const existing = this.corroborations.find(
      (c) => c.experienceId === experienceId && c.actorId === input.actorId && c.mode === mode
    );
    if (existing) return { ...existing, deduplicated: true };

    const record = {
      id: id('cor'),
      experienceId,
      actorId: input.actorId,
      mode,
      createdAt: nowIso(),
      weight: mode === 'same_experience' ? 1 : mode === 'similar_experience' ? 0.5 : 0
    };
    this.corroborations.push(record);

    if (mode !== 'support') {
      this.#emitValidationEvent(experience, 'corroboration_added', experience.scores.experienceConfidence);
      this.#recalculateCluster(experience.clusterId);
    }

    return { ...record };
  }

  addEvidence(experienceId, evidence) {
    const experience = this.#mustGet(experienceId);
    if (!evidence || !evidence.type) throw new Error('evidence.type is required');
    experience.evidence.push({ ...evidence, addedAt: nowIso() });
    this.#evaluate(experience);
    this.#recalculateCluster(experience.clusterId);
    return this.getExperience(experienceId);
  }

  dispute(experienceId, input = {}) {
    const experience = this.#mustGet(experienceId);
    this.#transition(experience, 'disputed', input.reason || 'experience_disputed');
    this.#emitValidationEvent(experience, 'experience_disputed', experience.scores?.experienceConfidence ?? 0);
    return this.getExperience(experienceId);
  }

  resolve(experienceId, input = {}) {
    const experience = this.#mustGet(experienceId);
    this.#transition(experience, 'resolved', input.reason || 'experience_resolved');
    this.#emitValidationEvent(experience, 'experience_resolved', experience.scores?.experienceConfidence ?? 0);
    this.#recalculateCluster(experience.clusterId);
    return this.getExperience(experienceId);
  }

  getExperience(experienceId) {
    const experience = this.#mustGet(experienceId);
    return JSON.parse(JSON.stringify(experience));
  }

  getCluster(clusterId) {
    const cluster = this.clusters.get(clusterId);
    if (!cluster) throw new Error('cluster not found');
    return JSON.parse(JSON.stringify(cluster));
  }

  listClusters() {
    return [...this.clusters.values()].map((cluster) => JSON.parse(JSON.stringify(cluster)));
  }

  getPublicSummary(experienceId) {
    const exp = this.#mustGet(experienceId);
    const cluster = exp.clusterId ? this.clusters.get(exp.clusterId) : null;
    return {
      experienceId: exp.id,
      status: exp.status,
      type: exp.type,
      entityId: exp.entityId,
      distribution: exp.distributionDecision,
      confidenceBand: this.#confidenceBand(exp.scores.experienceConfidence),
      cluster: cluster
        ? {
            id: cluster.id,
            status: cluster.status,
            rawSignals: cluster.rawSignals,
            independentSignals: cluster.independentSignals,
            validatedSignals: cluster.validatedSignals,
            confidence: cluster.confidence,
            coordinationRisk: cluster.coordinationRisk
          }
        : null
    };
  }

  #evaluate(experience) {
    const previous = experience.scores?.experienceConfidence ?? 0;
    const body = experience.text || experience.transcript || '';
    const related = [...this.experiences.values()].filter((other) => other.id !== experience.id);

    let maxSimilarity = 0;
    let exactFingerprintMatches = 0;
    let sameActorRecent = 0;
    let sameDeviceRecent = 0;
    const submittedAt = new Date(experience.submittedAt).getTime();

    for (const other of related) {
      const similarity = jaccard(body, other.text || other.transcript || '');
      maxSimilarity = Math.max(maxSimilarity, similarity);
      if (other.fingerprint === experience.fingerprint) exactFingerprintMatches += 1;

      const delta = Math.abs(submittedAt - new Date(other.submittedAt).getTime());
      if (delta <= this.policy.coordinationWindowMs) {
        if (other.actorId === experience.actorId) sameActorRecent += 1;
        const a = other.metadata?.deviceId;
        const b = experience.metadata?.deviceId;
        if (a && b && a === b && other.actorId !== experience.actorId) sameDeviceRecent += 1;
      }
    }

    const accountEvents = this.accountHistory.get(experience.actorId) || [];
    const accountConfidence = clamp(45 + Math.min(accountEvents.length, 10) * 3 - sameActorRecent * 8);
    const evidenceStrength = clamp(experience.evidence.length * 20);
    const duplicateRisk = clamp(
      exactFingerprintMatches * 55 +
      (maxSimilarity >= this.policy.duplicateSimilarity ? 35 : 0)
    );
    const coordinationRisk = clamp(sameDeviceRecent * 30 + sameActorRecent * 15);
    const spamRisk = clamp(sameActorRecent * 20 + duplicateRisk * 0.55);
    const independenceScore = clamp(100 - Math.max(coordinationRisk, duplicateRisk * 0.8));
    const manipulationRisk = clamp((coordinationRisk * 0.6) + (spamRisk * 0.4));

    const experienceConfidence = clamp(
      30 +
      accountConfidence * 0.22 +
      evidenceStrength * 0.25 +
      independenceScore * 0.28 -
      duplicateRisk * 0.18 -
      coordinationRisk * 0.22
    );

    const maxRisk = Math.max(spamRisk, coordinationRisk, manipulationRisk, duplicateRisk);
    let distributionDecision = 'allow';
    let status = 'published_unverified';
    let distributionWeight = 1;
    let aggregationWeight = (experienceConfidence / 100) * (independenceScore / 100);

    if (maxRisk >= this.policy.quarantineRisk) {
      distributionDecision = 'quarantine';
      status = 'quarantined';
      distributionWeight = 0;
      aggregationWeight = 0;
    } else if (maxRisk >= this.policy.limitRisk) {
      distributionDecision = 'allow_reduced';
      status = 'limited';
      distributionWeight = 0.25;
      aggregationWeight *= 0.15;
    } else if (experienceConfidence >= 75) {
      status = 'published';
    }

    experience.scores = {
      accountConfidence: Math.round(accountConfidence),
      experienceConfidence: Math.round(experienceConfidence),
      evidenceStrength: Math.round(evidenceStrength),
      independenceScore: Math.round(independenceScore),
      duplicateRisk: Math.round(duplicateRisk),
      spamRisk: Math.round(spamRisk),
      coordinationRisk: Math.round(coordinationRisk),
      manipulationRisk: Math.round(manipulationRisk),
      distributionWeight: Number(distributionWeight.toFixed(3)),
      aggregationWeight: Number(aggregationWeight.toFixed(3))
    };
    experience.distributionDecision = distributionDecision;
    this.#transition(experience, status, `integrity_policy:${distributionDecision}`);

    this.riskAssessments.push({
      id: id('risk'),
      experienceId: experience.id,
      createdAt: nowIso(),
      detector: 'core_integrity_v1',
      scores: { duplicateRisk, spamRisk, coordinationRisk, manipulationRisk },
      decision: distributionDecision
    });

    this.#emitValidationEvent(experience, 'validation_completed', previous);
  }

  #assignCluster(experience) {
    const body = experience.text || experience.transcript || '';
    let bestCluster = null;
    let bestSimilarity = 0;

    for (const cluster of this.clusters.values()) {
      if ((cluster.entityId || null) !== (experience.entityId || null)) continue;
      if (cluster.type !== experience.type) continue;
      const representative = this.experiences.get(cluster.representativeExperienceId);
      const similarity = jaccard(body, representative?.text || representative?.transcript || '');
      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestCluster = cluster;
      }
    }

    if (!bestCluster || bestSimilarity < this.policy.relatedSimilarity) {
      bestCluster = {
        id: id('cluster'),
        type: experience.type,
        entityId: experience.entityId,
        topicId: experience.topicId,
        representativeExperienceId: experience.id,
        experienceIds: [],
        rawSignals: 0,
        independentSignals: 0,
        validatedSignals: 0,
        confidence: 0,
        coordinationRisk: 0,
        status: 'forming',
        createdAt: nowIso(),
        updatedAt: nowIso()
      };
      this.clusters.set(bestCluster.id, bestCluster);
    }

    bestCluster.experienceIds.push(experience.id);
    experience.clusterId = bestCluster.id;
  }

  #recalculateCluster(clusterId) {
    if (!clusterId) return;
    const cluster = this.clusters.get(clusterId);
    if (!cluster) return;

    const experiences = cluster.experienceIds
      .map((experienceId) => this.experiences.get(experienceId))
      .filter(Boolean);

    const actors = new Set();
    let validated = 0;
    let weighted = 0;
    let coordinationTotal = 0;

    for (const exp of experiences) {
      if (exp.scores.aggregationWeight > 0.05) actors.add(exp.actorId);
      if (exp.scores.experienceConfidence >= 60 && exp.scores.aggregationWeight > 0.15) validated += 1;
      weighted += exp.scores.aggregationWeight;
      coordinationTotal += exp.scores.coordinationRisk;
    }

    const corroboratingActors = new Set(
      this.corroborations
        .filter((c) => cluster.experienceIds.includes(c.experienceId) && c.mode === 'same_experience')
        .map((c) => c.actorId)
    );
    for (const actorId of corroboratingActors) actors.add(actorId);

    const independentSignals = actors.size;
    const averageCoordination = experiences.length ? coordinationTotal / experiences.length : 0;
    const corroborationBoost = Math.min(corroboratingActors.size * 3, 20);
    const confidence = clamp(
      30 +
      Math.min(independentSignals * 3, 45) +
      Math.min(weighted * 2, 20) +
      corroborationBoost -
      averageCoordination * 0.35
    );

    let status = 'forming';
    if (independentSignals >= this.policy.highConfidenceIndependentSignals && confidence >= 80) {
      status = 'high_confidence';
    } else if (independentSignals >= this.policy.emergingIndependentSignals && confidence >= 55) {
      status = 'emerging';
    } else if (independentSignals >= 2 && confidence >= 45) {
      status = 'established';
    }

    cluster.rawSignals = experiences.length;
    cluster.independentSignals = independentSignals;
    cluster.validatedSignals = validated;
    cluster.confidence = Math.round(confidence);
    cluster.coordinationRisk = Math.round(averageCoordination);
    cluster.status = status;
    cluster.updatedAt = nowIso();
  }

  #recordAccountActivity(experience) {
    const history = this.accountHistory.get(experience.actorId) || [];
    history.push({ experienceId: experience.id, submittedAt: experience.submittedAt });
    this.accountHistory.set(experience.actorId, history);
  }

  #transition(experience, to, reason) {
    const from = experience.status;
    if (from === to) return;
    experience.status = to;
    experience.history.push({ from, to, reason, at: nowIso() });
  }

  #emitValidationEvent(experience, eventType, scoreBefore) {
    this.validationEvents.push({
      id: id('ve'),
      experienceId: experience.id,
      eventType,
      scoreBefore: Math.round(scoreBefore || 0),
      scoreAfter: Math.round(experience.scores?.experienceConfidence || 0),
      detector: 'core_integrity_v1',
      policyVersion: 'v1',
      createdAt: nowIso()
    });
  }

  #confidenceBand(score) {
    if (score >= 80) return 'high';
    if (score >= 60) return 'medium';
    return 'low';
  }

  #mustGet(experienceId) {
    const experience = this.experiences.get(experienceId);
    if (!experience) throw new Error('experience not found');
    return experience;
  }
}

module.exports = {
  ExperienceIntegrityEngine,
  normalizeText,
  jaccard,
  fingerprint
};
