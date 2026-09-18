import { stableStringify, sha256 } from '../lib/canonical.mjs';
import { DomainError, ValidationError } from '../domain/errors.mjs';
import { DEFAULT_MODEL_VERSION } from '../domain/model.mjs';
import { projectEvidencePackage, projectReplay } from './projection.mjs';

/**
 * 极简路由适配层。鉴权信息走请求头：
 *   x-user-id / x-user-roles（逗号分隔，如 ANALYST,APPROVER）
 * 外部系统回调走 /external-signals，调用方固定为 SYSTEM，以 x-callback-token 校验。
 */
export function createHttpApp({ service, snapshotStore, callbackToken = null }) {
  async function readJson(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (chunks.length === 0) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new ValidationError('请求体不是合法 JSON');
    }
  }

  function actorFromReq(req) {
    const userId = req.headers['x-user-id'];
    const roles = String(req.headers['x-user-roles'] ?? '')
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean);
    if (!userId) throw new DomainError('UNAUTHENTICATED', '缺少 x-user-id 请求头', { status: 401 });
    return { userId, roles };
  }

  function systemActorFromReq(req) {
    if (callbackToken && req.headers['x-callback-token'] !== callbackToken) {
      throw new DomainError('INVALID_CALLBACK_TOKEN', '外部回调令牌无效', { status: 401 });
    }
    return { userId: `callback:${req.headers['x-source-system'] ?? 'unknown'}`, roles: ['SYSTEM'] };
  }

  const contentHashOf = (content) => sha256(stableStringify(content));

  return async function app(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };

    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        return send(200, { status: 'ok' });
      }

      // POST /applications
      if (req.method === 'POST' && url.pathname === '/applications') {
        const actor = actorFromReq(req);
        const body = await readJson(req);
        if (!body.applicationId || !body.customerId) {
          throw new ValidationError('applicationId 与 customerId 必填');
        }
        const result = await service.openApplication({
          applicationId: body.applicationId,
          customerId: body.customerId,
          modelVersion: body.modelVersion || DEFAULT_MODEL_VERSION,
          actor,
        });
        return send(201, {
          applicationId: body.applicationId,
          initialVersionId: result.events[0].payload.initialVersionId,
          revision: result.state.revision,
        });
      }

      const appMatch = url.pathname.match(/^\/applications\/([^/]+)(?:\/([^/]+))?$/);
      if (!appMatch) return send(404, { code: 'NOT_FOUND', message: '路由不存在' });
      const applicationId = decodeURIComponent(appMatch[1]);
      const sub = appMatch[2] ?? '';
      const { state } = await service.loadState(applicationId);

      // GET /applications/:id —— 按版本排列的证据包
      if (req.method === 'GET' && sub === '') {
        const hashes = new Set();
        for (const v of state.versions.values()) {
          for (const a of v.analyses) hashes.add(a.snapshotHash);
        }
        const available = new Set();
        await Promise.all(
          [...hashes].map(async (h) => {
            if (await snapshotStore.get(h)) available.add(h);
          })
        );
        return send(200, projectEvidencePackage(state, { snapshotHashes: available }));
      }

      // GET /applications/:id/replay —— 当时为什么通过/拒绝
      if (req.method === 'GET' && sub === 'replay') {
        const replay = await projectReplay(state, {
          snapshotLookup: (hash) => snapshotStore.get(hash),
        });
        return send(200, replay);
      }

      // GET /applications/:id/events —— 审计事件流（含哈希链）
      if (req.method === 'GET' && sub === 'events') {
        const events = await service.eventStore.load(applicationId);
        return send(200, { applicationId, events });
      }

      if (req.method !== 'POST') return send(404, { code: 'NOT_FOUND', message: '路由不存在' });
      const body = await readJson(req);

      if (sub === 'materials') {
        const actor = actorFromReq(req);
        if (!body.materialType || !body.content) {
          throw new ValidationError('材料必须包含 materialType 与 content');
        }
        const result = await service.submit(applicationId, {
          type: 'submitMaterial',
          actor,
          materialType: body.materialType,
          content: body.content,
          dedupeKey: body.dedupeKey,
          contentHash: contentHashOf(body.content),
        });
        return send(201, {
          materialId: result.events[0]?.payload.materialId ?? null,
          revision: result.state.revision,
        });
      }

      if (sub === 'analyses') {
        const actor = actorFromReq(req);
        const result = await service.submit(applicationId, {
          type: 'recordAnalysis',
          actor,
          modelVersion: body.modelVersion,
        });
        const analysisId = result.events[0]?.payload.analysisId
          ?? (result.meta?.idempotent ? result.meta.analysisId : null);
        return send(201, {
          analysisId,
          idempotent: Boolean(result.meta?.idempotent),
          revision: result.state.revision,
        });
      }

      if (sub === 'opinions') {
        const actor = actorFromReq(req);
        const result = await service.submit(applicationId, {
          type: 'submitOpinion',
          actor,
          decision: body.decision,
          rationale: body.rationale,
          analysisId: body.analysisId,
        });
        return send(201, {
          opinionId: result.events[0]?.payload.opinionId ?? null,
          revision: result.state.revision,
        });
      }

      if (sub === 'supplement-requests') {
        const actor = actorFromReq(req);
        const result = await service.submit(applicationId, {
          type: 'requestSupplement',
          actor,
          requiredItems: body.requiredItems,
        });
        return send(201, {
          newVersionId: result.events[0]?.payload.newVersionId ?? null,
          carriedMaterials: result.events.length - 1,
          revision: result.state.revision,
        });
      }

      if (sub === 'confirmation') {
        const actor = actorFromReq(req);
        const result = await service.submit(applicationId, { type: 'confirmDecision', actor });
        const payload = result.events[0]?.payload ?? {};
        const confirmedVersion = result.state.versions.get(payload.versionId);
        return send(201, {
          decision: payload.decision ?? null,
          versionId: payload.versionId ?? null,
          confirmedAt: confirmedVersion?.decision?.confirmedAt ?? null,
          revision: result.state.revision,
        });
      }

      if (sub === 'withdrawal') {
        const actor = actorFromReq(req);
        const result = await service.submit(applicationId, {
          type: 'withdraw',
          actor,
          reason: body.reason,
        });
        return send(201, {
          status: result.state.status,
          withdrawnAt: result.state.withdrawnAt,
          revision: result.state.revision,
        });
      }

      if (sub === 'external-signals') {
        const actor = systemActorFromReq(req);
        const result = await service.submit(applicationId, {
          type: 'ingestExternalSignal',
          actor,
          dedupeKey: body.dedupeKey,
          content: body.content,
        });
        return send(200, {
          accepted: result.events.some((e) => e.type === 'MATERIAL_SUBMITTED'),
          deduped: Boolean(result.meta?.deduped),
          ignored: Boolean(result.meta?.ignored),
          autoAnalysisId: result.meta?.autoAnalysisId ?? null,
          existing: result.meta?.existing ?? null,
          appended: result.events.map((e) => ({ eventId: e.eventId, type: e.type })),
          revision: result.state.revision,
        });
      }

      return send(404, { code: 'NOT_FOUND', message: '路由不存在' });
    } catch (err) {
      if (err instanceof DomainError) {
        return send(err.status, { code: err.code, message: err.message, details: err.details });
      }
      if (err?.code === 'UNKNOWN_MODEL_VERSION') {
        return send(400, { code: 'UNKNOWN_MODEL_VERSION', message: err.message });
      }
      console.error('未处理错误:', err);
      return send(500, { code: 'INTERNAL_ERROR', message: '服务内部错误' });
    }
  };
}
