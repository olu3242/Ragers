'use strict';

const assert = require('assert');
const { ExperienceIntegrityEngine } = require('./engine/experience-integrity-engine');

function submit(engine, actorId, text, overrides = {}) {
  return engine.submit({
    actorId,
    type: overrides.type || 'rage',
    entityId: overrides.entityId || 'isp-demo',
    topicId: overrides.topicId || 'connectivity',
    text,
    metadata: overrides.metadata || {},
    evidence: overrides.evidence || [],
    submittedAt: overrides.submittedAt,
    location: overrides.location || { city: 'Dallas', region: 'TX', country: 'US' }
  });
}

(function run() {
  const engine = new ExperienceIntegrityEngine({
    emergingIndependentSignals: 5,
    highConfidenceIndependentSignals: 12
  });

  // A. Legitimate independent reports cluster and become high-confidence.
  const phrases = [
    'Internet service drops every evening around eight pm',
    'Internet service drops every evening around 8 pm',
    'My internet service drops every evening around eight',
    'Internet connection drops every evening around eight pm',
    'Every evening around eight pm the internet service drops',
    'Internet service keeps dropping every evening around eight pm',
    'Internet drops every evening around eight pm for us',
    'Around eight pm every evening our internet service drops',
    'Internet service drops every evening close to eight pm',
    'Our internet connection drops every evening around eight pm',
    'Internet service goes down every evening around eight pm',
    'Internet service drops each evening around eight pm'
  ];

  const legitimate = phrases.map((text, index) =>
    submit(engine, `legit-${index + 1}`, text, { metadata: { deviceId: `device-${index + 1}` } })
  );

  const cluster = engine.getCluster(legitimate[0].clusterId);
  assert(cluster.rawSignals >= 12, 'legitimate signals should cluster');
  assert(cluster.independentSignals >= 12, 'independent actors should count independently');
  assert.strictEqual(cluster.status, 'high_confidence');
  assert(cluster.confidence >= 80, 'legitimate cluster should reach high confidence');

  // B. Support is engagement only; same_experience is corroboration.
  const target = legitimate[0];
  engine.corroborate(target.id, { actorId: 'supporter-1', mode: 'support' });
  const beforeSame = engine.getCluster(target.clusterId).independentSignals;
  engine.corroborate(target.id, { actorId: 'witness-1', mode: 'same_experience' });
  const afterSame = engine.getCluster(target.clusterId).independentSignals;
  assert.strictEqual(afterSame, beforeSame + 1, 'same experience should add an independent signal');

  // C. Evidence strengthens an experience without being mandatory.
  const weak = submit(engine, 'evidence-user', 'Internet service drops every evening around eight pm', {
    metadata: { deviceId: 'evidence-device' }
  });
  const confidenceBeforeEvidence = weak.scores.experienceConfidence;
  const strengthened = engine.addEvidence(weak.id, { type: 'service_ticket', ref: 'TICKET-123' });
  assert(
    strengthened.scores.experienceConfidence >= confidenceBeforeEvidence,
    'evidence should not reduce experience confidence'
  );

  // D. Coordinated duplicate attack from many accounts sharing a device is contained.
  const attackEngine = new ExperienceIntegrityEngine();
  const attack = [];
  const attackStart = Date.now();
  for (let index = 0; index < 25; index += 1) {
    attack.push(submit(attackEngine, `bot-${index}`, 'This company stole my money exactly the same way', {
      entityId: 'target-company',
      topicId: 'billing',
      metadata: { deviceId: 'shared-attack-device' },
      submittedAt: new Date(attackStart + index * 1000).toISOString()
    }));
  }

  const blocked = attack.filter((exp) => ['quarantine', 'allow_reduced'].includes(exp.distributionDecision));
  assert(blocked.length >= 20, 'most coordinated submissions should be reduced or quarantined');

  const attackCluster = attackEngine.getCluster(attack[0].clusterId);
  assert(
    attackCluster.independentSignals < attackCluster.rawSignals,
    'raw volume must not equal validated independent signal volume during an attack'
  );

  // E. Rage and Rave use the same integrity rules.
  const raveEngine = new ExperienceIntegrityEngine();
  const raves = [];
  for (let index = 0; index < 15; index += 1) {
    raves.push(submit(raveEngine, `promo-${index}`, 'Absolutely perfect service best ever', {
      type: 'rave',
      entityId: 'self-promoting-business',
      topicId: 'service',
      metadata: { deviceId: 'promo-device' },
      submittedAt: new Date(attackStart + index * 1000).toISOString()
    }));
  }
  assert(
    raves.filter((exp) => ['quarantine', 'allow_reduced'].includes(exp.distributionDecision)).length >= 10,
    'manufactured Raves must be treated like manufactured Rages'
  );

  // F. Dispute/resolution lifecycle is explicit and auditable.
  const lifecycle = legitimate[1];
  const disputed = engine.dispute(lifecycle.id, { reason: 'entity challenged factual context' });
  assert.strictEqual(disputed.status, 'disputed');
  const resolved = engine.resolve(lifecycle.id, { reason: 'provider fixed outage' });
  assert.strictEqual(resolved.status, 'resolved');
  assert(resolved.history.some((transition) => transition.to === 'disputed'));
  assert(resolved.history.some((transition) => transition.to === 'resolved'));

  console.log('PASS integrity-engine e2e');
  console.log(JSON.stringify({
    legitimateCluster: engine.getCluster(target.clusterId),
    coordinatedAttack: attackCluster,
    validationEvents: engine.validationEvents.length,
    riskAssessments: engine.riskAssessments.length
  }, null, 2));
})();
