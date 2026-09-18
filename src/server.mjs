import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { EventStore } from './domain/eventStore.mjs';
import { CreditEvidenceService, DomainError } from './domain/service.mjs';
import { toView, effectiveEvidence } from './domain/aggregate.mjs';
import { listRulePacks } from './domain/rules.mjs';

/**
 * 组装应用。storeFile 为 null 时使用纯内存日志（测试用）；
 * 生产/重启恢复传入 JSONL 路径，服务启动即重放全量事件。
 */
export function createApp({ storeFile = process.env.EVENT_LOG || 'data/events.jsonl' } = {}) {
  if (storeFile) mkdirSync(dirname(storeFile), { recursive: true });
  const store = new EventStore(storeFile || null);
  const service = new CreditEvidenceService(store);
  return { store, service, handler: makeHandler(store, service) };
}

function makeHandler(store, service) {
  return async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        return send(res, 200, { status: 'ok' });
      }
      if (req.method === 'GET' && url.pathname === '/rule-packs') {
        return send(res, 200, { rulePacks: listRulePacks() });
      }
      if (req.method === 'POST' && url.pathname === '/applications') {
        const body = await readJson(req);
        mergeActorFromHeaders(body, req.headers);
        return send(res, 201, service.openApplication(body));
      }
      if (req.method === 'GET' && url.pathname === '/audit/verify') {
        return send(res, 200, store.verify());
      }

      const m = url.pathname.match(/^\/applications\/([^/]+)(\/(.+))?$/);
      if (!m) return send(res, 404, { error: { code: 'NOT_FOUND', message: '未知路径' } });
      const applicationId = decodeURIComponent(m[1]);
      const sub = m[3] || '';

      if (req.method === 'GET' && sub === '') {
        return send(res, 200, toView(service.requireState(applicationId)));
      }
      if (req.method === 'GET' && sub === 'events') {
        const events = store.stream(applicationId);
        return send(res, 200, {
          applicationId,
          count: events.length,
          events,
          replayChecksum: store.verify().ok ? store.tailHash : null,
        });
      }
      if (req.method === 'GET' && sub === 'evidence-pack') {
        return send(res, 200, buildEvidencePack(service, applicationId, url.searchParams.get('version')));
      }
      if (req.method === 'GET' && sub === 'replay') {
        return send(res, 200, buildReplay(service, applicationId));
      }

      const body = await readJson(req);
      mergeActorFromHeaders(body, req.headers);

      switch (`${req.method} ${sub}`) {
        case 'POST withdraw':
          return send(res, 200, service.withdraw(applicationId, body));
        case 'POST supplement-requests':
          return send(res, 201, service.requestSupplement(applicationId, body));
        case 'POST evidence':
          return send(res, 201, service.addEvidence(applicationId, body));
        case 'POST signals':
          return send(res, 201, service.recordSignal(applicationId, body));
        case 'POST runs':
          return send(res, 202, service.requestRun(applicationId, body));
        case 'POST model-results':
          return send(res, 200, service.recordModelResult(applicationId, body));
        case 'POST warning-notes':
          return send(res, 201, service.addWarningNote(applicationId, body));
        case 'POST decisions':
          return send(res, 200, service.confirmDecision(applicationId, body));
        default:
          return send(res, 404, { error: { code: 'NOT_FOUND', message: '未知路径' } });
      }
    } catch (err) {
      if (err instanceof DomainError) {
        return send(res, err.status, { error: { code: err.code, message: err.message, ...err.details } });
      }
      if (err instanceof SyntaxError) {
        return send(res, 400, { error: { code: 'BAD_JSON', message: '请求体不是合法 JSON' } });
      }
      console.error('unhandled error', err);
      return send(res, 500, { error: { code: 'INTERNAL', message: '内部错误' } });
    }
  };
}

/**
 * 证据包：按申请版本排列；每条预警指向冻结的输入快照与规则版本，
 * 并解析出可点开的证据引用。
 */
function buildEvidencePack(service, applicationId, version) {
  const state = service.requireState(applicationId);
  const view = toView(state);
  const versions = version ? view.versions.filter((v) => v.version === version) : view.versions;
  if (version && versions.length === 0) {
    throw new DomainError('UNKNOWN_VERSION', `版本不存在：${version}`, 404);
  }

  const evidenceById = new Map();
  for (const v of view.versions) for (const e of v.evidence) evidenceById.set(e.evidenceId, e);

  return {
    applicationId,
    customerId: state.customerId,
    status: state.status,
    currentVersion: state.currentVersion,
    versions: versions.map((v) => ({
      version: v.version,
      parentVersion: v.parentVersion,
      status: v.status,
      completeness: v.completeness,
      evidence: v.evidence.map((e) => ({
        evidenceId: e.evidenceId,
        kind: e.kind,
        source: e.source,
        contentHash: e.contentHash,
        addedAt: e.addedAt,
      })),
      // 批次层给出冻结的完整输入快照：审批人不必翻事件流即可回溯
      batches: v.batches.map((b) => {
        const batchState = state.batches[b.batchId];
        return {
          batchId: b.batchId,
          status: b.status,
          modelVersion: b.modelVersion,
          rulePackVersion: b.rulePackVersion,
          evidenceStateHash: b.evidenceStateHash,
          score: b.score,
          inputSnapshot: batchState?.inputSnapshot || null,
          warnings: b.warnings.map((w) => ({
            warningId: w.warningId,
            ruleId: w.ruleId,
            severity: w.severity,
            rulePackVersion: w.rulePackVersion,
            detail: w.detail,
            // 预警可回溯锚点：规则版本 + 输入快照定位（全文在批次 inputSnapshot）
            inputSnapshotRef: {
              batchId: b.batchId,
              modelVersion: b.modelVersion,
              rulePackVersion: b.rulePackVersion,
              evidenceStateHash: b.evidenceStateHash,
            },
            evidenceRefs: w.evidenceRefs.map((ref) => {
              if (ref.startsWith('signal:')) {
                const signalId = ref.slice('signal:'.length);
                return {
                  type: 'EXTERNAL_SIGNAL',
                  signalId,
                  signal: state.signals.find((s) => s.signalId === signalId) || null,
                };
              }
              const ev = evidenceById.get(ref);
              return { type: 'EVIDENCE', evidenceId: ref, kind: ev?.kind || null, contentHash: ev?.contentHash || null };
            }),
            notes: w.notes,
          })),
        };
      }),
    })),
  };
}

/**
 * 按申请重放「当时为什么通过/拒绝」：
 * 定位决定事件 -> 其绑定的批次快照 -> 当时的预警与意见、证据哈希。
 */
function buildReplay(service, applicationId) {
  const state = service.requireState(applicationId);
  if (!state.decision) {
    return { applicationId, status: state.status, decided: false, message: '尚无最终结论，可重放当前派生状态', current: toView(state) };
  }
  const d = state.decision;
  const batch = state.batches[d.batchId];
  return {
    applicationId,
    decided: true,
    status: state.status,
    decision: d,
    replay: {
      rulePackVersion: d.rulePackVersion,
      modelVersion: d.modelVersion,
      evidenceStateHash: d.evidenceStateHash,
      inputSnapshot: batch?.inputSnapshot || null,
      score: d.score,
      warnings: d.warningIds.map((id) => {
        const w = state.warnings[id];
        return w ? { warningId: w.warningId, ruleId: w.ruleId, severity: w.severity, detail: w.detail, evidenceRefs: w.evidenceRefs, notes: state.notes[id] || [] } : null;
      }).filter(Boolean),
      effectiveEvidence: effectiveEvidence(state, d.version).map((e) => ({
        evidenceId: e.evidenceId,
        kind: e.kind,
        source: e.source,
        contentHash: e.contentHash,
      })),
    },
  };
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

/** 也接受 X-Actor-Id / X-Actor-Role 请求头（便于网关透传身份）。 */
function mergeActorFromHeaders(body, headers) {
  if (body.actor) return;
  const id = headers['x-actor-id'];
  const role = headers['x-actor-role'];
  if (id || role) body.actor = { id: id ? String(id) : undefined, role: role ? String(role) : undefined };
}

function send(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

const port = process.env.PORT || 3000;
// 直接启动时监听；被测试 import 时不监听。
if (import.meta.url === `file://${process.argv[1]}`) {
  const app = createApp();
  createServer(app.handler).listen(port, () => {
    console.log(`智能授信证据台已启动：http://localhost:${port}（事件日志：${app.store.file || '内存'}）`);
  });
}
