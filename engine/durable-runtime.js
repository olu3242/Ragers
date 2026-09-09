'use strict';

const fs = require('fs');
const path = require('path');
const { ExperienceIntegrityEngine } = require('./experience-integrity-engine');

class DurableIntegrityRuntime {
  constructor(options = {}) {
    this.file = options.file || path.join(process.cwd(), '.data', 'ragers-integrity.json');
    this.engine = new ExperienceIntegrityEngine(options.policy || {});
    this.outbox = [];
    this.processedEvents = new Set();
    this.load();
  }

  load() {
    if (!fs.existsSync(this.file)) return;
    const snapshot = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    this.engine.experiences = new Map(snapshot.experiences || []);
    this.engine.clusters = new Map(snapshot.clusters || []);
    this.engine.validationEvents = snapshot.validationEvents || [];
    this.engine.riskAssessments = snapshot.riskAssessments || [];
    this.engine.corroborations = snapshot.corroborations || [];
    this.engine.accountHistory = new Map(snapshot.accountHistory || []);
    this.outbox = snapshot.outbox || [];
    this.processedEvents = new Set(snapshot.processedEvents || []);
  }

  persist() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    const snapshot = {
      version: 1,
      savedAt: new Date().toISOString(),
      experiences: [...this.engine.experiences.entries()],
      clusters: [...this.engine.clusters.entries()],
      validationEvents: this.engine.validationEvents,
      riskAssessments: this.engine.riskAssessments,
      corroborations: this.engine.corroborations,
      accountHistory: [...this.engine.accountHistory.entries()],
      outbox: this.outbox,
      processedEvents: [...this.processedEvents]
    };
    fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2));
    fs.renameSync(tmp, this.file);
  }

  transact(eventType, payload, operation) {
    const result = operation();
    this.outbox.push({
      id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      eventType,
      payload,
      status: 'pending',
      createdAt: new Date().toISOString()
    });
    this.persist();
    return result;
  }

  submit(input) {
    return this.transact('experience.created', { actorId: input.actorId, type: input.type }, () => this.engine.submit(input));
  }

  corroborate(experienceId, input) {
    return this.transact('experience.corroborated', { experienceId, actorId: input.actorId, mode: input.mode }, () => this.engine.corroborate(experienceId, input));
  }

  addEvidence(experienceId, evidence) {
    return this.transact('experience.evidence_added', { experienceId, type: evidence.type }, () => this.engine.addEvidence(experienceId, evidence));
  }

  dispute(experienceId, input) {
    return this.transact('experience.disputed', { experienceId }, () => this.engine.dispute(experienceId, input));
  }

  resolve(experienceId, input) {
    return this.transact('experience.resolved', { experienceId }, () => this.engine.resolve(experienceId, input));
  }

  revalidateAll() {
    const ids = [...this.engine.experiences.keys()];
    for (const experienceId of ids) {
      const exp = this.engine.experiences.get(experienceId);
      if (!exp || ['removed', 'resolved'].includes(exp.status)) continue;
      this.engine.addEvidence(experienceId, { type: 'system_revalidation', internal: true });
      exp.evidence = exp.evidence.filter((item) => item.type !== 'system_revalidation');
    }
    this.outbox.push({
      id: `evt_${Date.now()}_revalidate`,
      eventType: 'integrity.revalidated',
      payload: { count: ids.length },
      status: 'pending',
      createdAt: new Date().toISOString()
    });
    this.persist();
    return { revalidated: ids.length };
  }

  drainOutbox(handler = () => {}) {
    let delivered = 0;
    for (const event of this.outbox) {
      if (event.status === 'delivered' || this.processedEvents.has(event.id)) continue;
      handler(event);
      event.status = 'delivered';
      event.deliveredAt = new Date().toISOString();
      this.processedEvents.add(event.id);
      delivered += 1;
    }
    this.persist();
    return { delivered };
  }
}

module.exports = { DurableIntegrityRuntime };
