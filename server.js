'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { DurableIntegrityRuntime } = require('./engine/durable-runtime');

const PORT = Number(process.env.PORT || 8080);
const runtime = new DurableIntegrityRuntime({ file: process.env.RAGERS_DATA_FILE });
const root = process.cwd();

const mime = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg'
};

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(payload);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; if (body.length > 1_000_000) req.destroy(new Error('payload_too_large')); });
    req.on('end', () => { if (!body) return resolve({}); try { resolve(JSON.parse(body)); } catch { reject(new Error('invalid_json')); } });
    req.on('error', reject);
  });
}

function publicFeed() {
  return [...runtime.engine.experiences.values()]
    .filter((exp) => exp.distributionDecision !== 'quarantine')
    .sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt))
    .map((exp) => {
      const summary = runtime.engine.getPublicSummary(exp.id);
      return { id: exp.id, actorId: exp.actorId, type: exp.type, body: exp.text || exp.transcript, category: exp.topicId || 'General', entityId: exp.entityId,
        createdAt: exp.submittedAt, status: exp.status, confidence: exp.scores?.experienceConfidence ?? 0, confidenceBand: summary.confidenceBand,
        distribution: exp.distributionDecision, cluster: summary.cluster };
    });
}

async function api(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { ok: true, service: 'ragers-integrity-runtime', experiences: runtime.engine.experiences.size, outboxPending: runtime.outbox.filter((e) => e.status === 'pending').length });
  if (req.method === 'GET' && url.pathname === '/api/experiences') return send(res, 200, { experiences: publicFeed() });
  if (req.method === 'GET' && url.pathname === '/api/trends') return send(res, 200, { clusters: runtime.engine.listClusters() });

  if (req.method === 'POST' && url.pathname === '/api/experiences') {
    const input = await readJson(req);
    const experience = runtime.submit(input);
    return send(res, 201, { experience, publicSummary: runtime.engine.getPublicSummary(experience.id) });
  }

  const expMatch = url.pathname.match(/^\/api\/experiences\/([^/]+)(?:\/(corroborate|evidence|dispute|resolve|summary))?$/);
  if (expMatch) {
    const experienceId = decodeURIComponent(expMatch[1]);
    const action = expMatch[2];
    if (req.method === 'GET' && !action) return send(res, 200, runtime.engine.getExperience(experienceId));
    if (req.method === 'GET' && action === 'summary') return send(res, 200, runtime.engine.getPublicSummary(experienceId));
    if (req.method === 'POST' && action) {
      const input = await readJson(req);
      if (action === 'corroborate') return send(res, 200, runtime.corroborate(experienceId, input));
      if (action === 'evidence') return send(res, 200, runtime.addEvidence(experienceId, input));
      if (action === 'dispute') return send(res, 200, runtime.dispute(experienceId, input));
      if (action === 'resolve') return send(res, 200, runtime.resolve(experienceId, input));
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/internal/revalidate') return send(res, 202, runtime.requestRevalidation());
  if (req.method === 'POST' && url.pathname === '/api/internal/outbox/drain') {
    const delivered = [];
    const result = runtime.drainOutbox((event) => delivered.push(event.id));
    return send(res, 200, { ...result, eventIds: delivered });
  }
  return false;
}

function staticFile(req, res, url) {
  let requested = url.pathname === '/' ? '/index.html' : url.pathname;
  if (requested === '/app') requested = '/app.html';
  const target = path.resolve(root, `.${requested}`);
  if (!target.startsWith(root)) return send(res, 403, { error: 'forbidden' });
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return send(res, 404, { error: 'not_found' });
  res.writeHead(200, { 'content-type': mime[path.extname(target)] || 'application/octet-stream' });
  fs.createReadStream(target).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      const handled = await api(req, res, url);
      if (handled !== false || res.writableEnded) return;
    }
    return staticFile(req, res, url);
  } catch (error) {
    const status = error.message === 'invalid_json' ? 400 : error.message === 'experience not found' ? 404 : 500;
    return send(res, status, { error: error.message });
  }
});

if (require.main === module) server.listen(PORT, () => console.log(`Ragers running at http://localhost:${PORT}`));
module.exports = { server, runtime };
