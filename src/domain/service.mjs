import { randomId, hashValue } from './canonical.mjs';
import {
  replayApplication,
  checkCompleteness,
  evidenceStateHash,
  buildInputSnapshot,
  buildRuleContext,
} from './aggregate.mjs';
import {
  evaluateRulePack,
  knownRulePack,
  MODEL_VERSIONS,
  DEFAULT_MODEL_VERSION,
  REQUIRED_MATERIAL_KINDS,
} from './rules.mjs';

/** 业务错误：携带 HTTP 状态与机器可读 code。 */
export class DomainError extends Error {
  constructor(code, message, status = 400, details = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const ROLES = {
  APPROVER: 'APPROVER', // 唯一可确认最终结论的角色
  REVIEWER: 'REVIEWER', // 可补证据、写意见、请求补件/重跑
  APPLICANT: 'APPLICANT', // 可撤回
  SYSTEM: 'SYSTEM', // 外部回调、外部信号接入
};

export class CreditEvidenceService {
  constructor(store) {
    this.store = store;
  }

  state(applicationId) {
    return replayApplication(this.store.stream(applicationId));
  }

  // ---------- 申请生命周期 ----------

  openApplication({ customerId, actor, idempotencyKey }) {
    customerId = requireString(customerId, 'customerId');
    const a = normalizeActor(actor);
    const applicationId = randomId('app');
    const key = idempotencyKey || applicationId;
    const openEventId = `open:${key}`;
    const existing = this.store.byEventId.get(openEventId);
    if (existing) {
      return { applicationId: existing.applicationId, duplicate: true };
    }
    this.store.append('APPLICATION_OPENED', {
      applicationId,
      eventId: openEventId,
      actor: a,
      data: { customerId },
    });
    // 开申请即开首版本 v1；补件才会产生后续版本
    this.store.append('VERSION_OPENED', {
      applicationId,
      eventId: `${applicationId}:version:init:${key}`,
      actor: a,
      data: { version: 'v1', parentVersion: null, reason: 'INITIAL' },
    });
    return { applicationId, duplicate: false };
  }

  withdraw(applicationId, { reason, actor, idempotencyKey }) {
    const state = this.requireState(applicationId);
    if (state.status === 'WITHDRAWN') {
      return { status: 'WITHDRAWN', duplicate: true, withdrawal: state.withdrawal };
    }
    if (state.status === 'DECIDED') {
      throw new DomainError('APPLICATION_DECIDED', '已出具最终结论的申请不能撤回', 409);
    }
    const a = normalizeActor(actor);
    if (![ROLES.APPROVER, ROLES.APPLICANT].includes(a.role)) {
      throw new DomainError('FORBIDDEN', '只有审批人或申请人可以撤回申请', 403);
    }
    this.store.append('APPLICATION_WITHDRAWN', {
      applicationId,
      eventId: `${applicationId}:withdraw:${idempotencyKey || randomId('w')}`,
      actor: a,
      data: { reason: reason || null },
    });
    // 撤回后不主动发起任何新计算；在途批次在重放时被标记为 ABANDONED。
    return { status: 'WITHDRAWN', duplicate: false };
  }

  // ---------- 版本与补件 ----------

  /**
   * 缺关键材料只能进入补件：开出新版本（沿父链沿用旧材料），
   * 不允许在旧版本上继续算。
   */
  requestSupplement(applicationId, { reason, missingKinds, actor, idempotencyKey }) {
    const state = this.requireState(applicationId);
    requireOpen(state);
    const a = normalizeActor(actor);
    if (![ROLES.APPROVER, ROLES.REVIEWER].includes(a.role)) {
      throw new DomainError('FORBIDDEN', '只有审批组可以发起补件', 403);
    }
    const parentVersion = state.currentVersion;
    const newVersion = `v${state.versionSeq + 1}`;
    const key = idempotencyKey || randomId('sup');
    const versionEventId = `${applicationId}:version:${key}`;
    // 重试必须在任何派生计算之前命中幂等，否则会错误地再开一个版本号。
    const existing = this.store.byEventId.get(versionEventId);
    if (existing) {
      return { version: existing.data.version, parentVersion: existing.data.parentVersion, duplicate: true };
    }
    const base = { applicationId, actor: a };
    this.store.append('VERSION_OPENED', {
      ...base,
      eventId: versionEventId,
      data: { version: newVersion, parentVersion, reason: reason || null },
    });
    this.store.append('SUPPLEMENT_REQUESTED', {
      ...base,
      eventId: `${applicationId}:supplement:${key}`,
      data: {
        version: newVersion,
        parentVersion,
        reason: reason || null,
        missingKinds: missingKinds || checkCompleteness(state, parentVersion).missing,
      },
    });
    return { version: newVersion, parentVersion, duplicate: false };
  }

  // ---------- 证据 ----------

  addEvidence(applicationId, body) {
    const { kind, actor, idempotencyKey } = body;
    const state = this.requireState(applicationId);
    const a = normalizeActor(actor);
    const key = idempotencyKey || randomId('ev');
    const eventId = `${applicationId}:evidence:${key}`;

    if (state.status === 'WITHDRAWN') {
      return this._lateFact(applicationId, a, 'EVIDENCE', eventId, body, '申请已撤回，证据不再进入计算');
    }

    requireOpen(state);
    if (![ROLES.APPROVER, ROLES.REVIEWER].includes(a.role)) {
      throw new DomainError('FORBIDDEN', '只有审批组成员可以补充证据', 403);
    }
    const version = body.version || state.currentVersion;
    if (!state.versions[version]) {
      throw new DomainError('UNKNOWN_VERSION', `版本不存在：${version}`, 404);
    }
    if (version !== state.currentVersion) {
      throw new DomainError('VERSION_SUPERSEDED', `只能向当前版本补充证据：${state.currentVersion}`, 409, {
        currentVersion: state.currentVersion,
      });
    }

    const evidence = this._buildEvidence(kind, body, eventId);
    const { duplicate } = this.store.append('EVIDENCE_ADDED', {
      applicationId,
      eventId,
      actor: a,
      data: { version, evidence },
    });
    return { evidenceId: evidence.evidenceId, version, duplicate };
  }

  _buildEvidence(kind, body, eventId) {
    const evidenceId = `ev_${eventId}`;
    if (kind === 'FINANCIAL_SUMMARY') {
      const fields = body.fields || {};
      for (const f of ['currentRatio', 'debtToEquity', 'netProfitMargin']) {
        if (fields[f] !== undefined && typeof fields[f] !== 'number') {
          throw new DomainError('BAD_FINANCIAL_FIELDS', `字段 ${f} 必须是数值`);
        }
      }
      return {
        evidenceId,
        kind,
        source: requireString(body.source, 'source'),
        fiscalPeriod: body.fiscalPeriod || null,
        currency: body.currency || null,
        fields,
        summary: body.summary || null,
        contentHash: hashValue(body),
      };
    }
    if (kind === 'MANUAL_VERIFICATION') {
      const result = String(body.result || '').toUpperCase();
      if (!['PASS', 'FAIL', 'INCONCLUSIVE'].includes(result)) {
        throw new DomainError('BAD_VERIFICATION_RESULT', 'result 必须为 PASS/FAIL/INCONCLUSIVE');
      }
      return {
        evidenceId,
        kind,
        item: requireString(body.item, 'item'),
        result,
        verifier: body.verifier || null,
        financialEvidenceId: requireString(body.financialEvidenceId, 'financialEvidenceId'),
        note: body.note || null,
        contentHash: hashValue(body),
      };
    }
    throw new DomainError('BAD_EVIDENCE_KIND', `不支持的材料类别：${kind}。关键材料：${REQUIRED_MATERIAL_KINDS.join('、')}`);
  }

  // ---------- 外部风险信号（可能迟到） ----------

  recordSignal(applicationId, body) {
    const state = this.requireState(applicationId);
    const signalId = requireString(body.signalId || body.signal?.signalId, 'signalId');
    const a = normalizeActor(body.actor ?? { role: ROLES.SYSTEM, id: body.source || 'external' });
    const eventId = `${applicationId}:signal:${signalId}`;

    if (state.status === 'WITHDRAWN') {
      return this._lateFact(applicationId, a, 'EXTERNAL_SIGNAL', eventId, body, '申请已撤回，外部信号不再进入计算');
    }

    const type = String(requireString(body.type || body.signal?.type, 'type')).toUpperCase();
    if (!['SANCTION', 'WATCHLIST', 'ADVERSE_MEDIA', 'COUNTRY_RISK'].includes(type)) {
      throw new DomainError('BAD_SIGNAL_TYPE', `不支持的信号类型：${type}`);
    }
    const signal = {
      signalId,
      type,
      source: requireString(body.source, 'source'),
      severity: body.severity || null,
      observedAt: body.observedAt || new Date().toISOString(),
      detail: body.detail || null,
      payloadHash: hashValue(body),
    };
    const { duplicate } = this.store.append('EXTERNAL_SIGNAL_RECORDED', {
      applicationId,
      eventId,
      actor: a,
      data: { signal },
    });
    // 已决定后到达的信号照常留痕：它不改变历史结论（结论指向自己的批次快照），
    // 但会让当前证据哈希变化——若将来翻案/重开版本，重跑自然会带上它。
    return { signalId, recorded: !duplicate, duplicate, afterDecision: state.status === 'DECIDED' };
  }

  // ---------- 模型批次 ----------

  /**
   * 请求模型重跑。冻结输入快照与证据哈希：
   * 之后到达的任何证据/信号都不会静默改变这批结果，只会要求再跑一批。
   */
  requestRun(applicationId, body = {}) {
    const state = this.requireState(applicationId);
    requireOpen(state);
    const a = normalizeActor(body.actor);
    if (![ROLES.APPROVER, ROLES.REVIEWER].includes(a.role)) {
      throw new DomainError('FORBIDDEN', '只有审批组可以发起模型计算', 403);
    }
    const version = body.version || state.currentVersion;
    if (version !== state.currentVersion) {
      throw new DomainError('VERSION_SUPERSEDED', '旧版本不能重跑，请在补件后的新版本上计算', 409);
    }
    const modelVersion = body.modelVersion || DEFAULT_MODEL_VERSION;
    if (!MODEL_VERSIONS.has(modelVersion)) {
      throw new DomainError('UNKNOWN_MODEL_VERSION', `未登记的模型版本：${modelVersion}`, 422, {
        allowed: [...MODEL_VERSIONS],
      });
    }
    const rulePackVersion = body.rulePackVersion || 'risk-rules-2026.01';
    if (!knownRulePack(rulePackVersion)) {
      throw new DomainError('UNKNOWN_RULE_PACK', `未知规则包版本：${rulePackVersion}`, 422);
    }
    const completeness = checkCompleteness(state, version);
    if (!completeness.complete) {
      throw new DomainError('MISSING_MATERIALS', '关键材料不完整，只能进入补件状态', 422, {
        completeness,
      });
    }

    const key = body.idempotencyKey || randomId('run');
    const eventId = `${applicationId}:run:${key}`;
    if (this.store.byEventId.has(eventId)) {
      return { batchId: this.store.byEventId.get(eventId).data.batchId, duplicate: true };
    }
    const runsOnVersion = Object.values(state.batches).filter((b) => b.version === version).length;
    const batchId = `${applicationId}:${version}:run-${runsOnVersion + 1}`;
    // 快照只纳入本事件之前已重放的事实；同步执行下不存在临界信号串批。
    const snapshot = buildInputSnapshot(state, version, { modelVersion, rulePackVersion });
    const stateHash = evidenceStateHash(state, version);
    this.store.append('MODEL_RUN_REQUESTED', {
      applicationId,
      eventId,
      actor: a,
      data: {
        batchId,
        version,
        modelVersion,
        rulePackVersion,
        inputSnapshot: { ...snapshot, batchId },
        evidenceStateHash: stateHash,
      },
    });
    return { batchId, version, modelVersion, rulePackVersion, evidenceStateHash: stateHash, duplicate: false };
  }

  /**
   * 模型回调。callbackId 幂等；同一 batchId 的重复投递直接返回旧结果。
   * 预警由服务端用冻结快照 + 固定规则版本确定性重算 —— 模型只给分数，
   * 因此每条预警都能回溯到「输入快照 + 规则版本」，且重放结果逐字节一致。
   */
  recordModelResult(applicationId, body) {
    const state = this.requireState(applicationId);
    const batchId = requireString(body.batchId, 'batchId');
    const callbackId = requireString(body.callbackId, 'callbackId');
    const a = normalizeActor(body.actor ?? { role: ROLES.SYSTEM, id: 'model-callback' });
    const eventId = `${applicationId}:result:${callbackId}`;
    const batch = state.batches[batchId];
    if (!batch) {
      return this._lateFact(applicationId, a, 'MODEL_RESULT', eventId, { batchId, score: body.score }, '未知批次的回调');
    }
    if (state.status === 'WITHDRAWN' || batch.status === 'ABANDONED') {
      return this._lateFact(applicationId, a, 'MODEL_RESULT', eventId, { batchId, score: body.score }, '申请已撤回，放弃在途计算结果');
    }
    if (state.status === 'DECIDED' && state.decision.batchId !== batchId) {
      // 决定已落锤，这是被新证据取代的在途批次的迟到回调：
      // 不补算预警、不影响结论，只留最小审计事实。
      return this._lateFact(applicationId, a, 'MODEL_RESULT', eventId, { batchId, score: body.score }, '最终结论已确认，迟到的批次结果不再进入证据包');
    }
    if (batch.status === 'COMPLETED') {
      // 重复回调（含换 callbackId 的重发）：原样返回，绝不二次落账
      return { batchId, duplicate: true, score: batch.score, warnings: batch.warnings };
    }
    if (typeof body.score !== 'number') {
      throw new DomainError('BAD_SCORE', '回调必须包含数值型 score');
    }

    const snapshot = { ...batch.inputSnapshot };
    const warnings = evaluateRulePack(
      batch.rulePackVersion,
      batchId,
      buildRuleContext(snapshot, body.score),
    );
    const { duplicate } = this.store.append('MODEL_RESULT_RECORDED', {
      applicationId,
      eventId,
      actor: a,
      data: { batchId, score: body.score, warnings },
    });
    return { batchId, duplicate, score: body.score, warnings };
  }

  // ---------- 人工意见与最终结论 ----------

  addWarningNote(applicationId, body) {
    const state = this.requireState(applicationId);
    const a = normalizeActor(body.actor);
    if (![ROLES.APPROVER, ROLES.REVIEWER].includes(a.role)) {
      throw new DomainError('FORBIDDEN', '只有审批组成员可以发表核验意见', 403);
    }
    const warningId = requireString(body.warningId, 'warningId');
    const key = body.idempotencyKey || randomId('note');
    const noteEventId = `${applicationId}:note:${key}`;
    const existing = this.store.byEventId.get(noteEventId);
    if (existing) {
      return { noteId: existing.data.noteId, warningId: existing.data.warningId, duplicate: true };
    }
    if (!state.warnings[warningId]) {
      throw new DomainError('UNKNOWN_WARNING', `预警不存在：${warningId}`, 404);
    }
    if (state.status === 'WITHDRAWN') {
      return this._lateFact(applicationId, a, 'WARNING_NOTE', noteEventId, { warningId }, '申请已撤回，意见不再附入证据包');
    }
    if (state.status === 'DECIDED') {
      throw new DomainError('APPLICATION_DECIDED', '最终结论已确认，意见不得追加（模型重跑也不会改写既有意见）', 409);
    }
    const noteId = `note_${key}`;
    this.store.append('WARNING_NOTE_ADDED', {
      applicationId,
      eventId: noteEventId,
      actor: a,
      data: { warningId, noteId, content: requireString(body.content, 'content') },
    });
    return { noteId, warningId, duplicate: false };
  }

  confirmDecision(applicationId, body) {
    const state = this.requireState(applicationId);
    const a = normalizeActor(body.actor);
    if (a.role !== ROLES.APPROVER) {
      // 不同审批人可并行补证据/写意见，但最终结论只能由 APPROVER 落锤
      throw new DomainError('FORBIDDEN', '最终结论只能由具备 APPROVER 角色的审批人确认', 403);
    }
    const key = body.idempotencyKey || randomId('dec');
    const decisionEventId = `${applicationId}:decision:${key}`;
    const existing = this.store.byEventId.get(decisionEventId);
    if (existing) {
      // 客户端重试：原样返回已确认结论，绝不产生第二条决定
      return { decision: existing.data.decision, duplicate: true };
    }
    requireOpen(state);
    const outcome = String(body.outcome || '').toUpperCase();
    if (!['APPROVE', 'REJECT'].includes(outcome)) {
      throw new DomainError('BAD_OUTCOME', 'outcome 必须为 APPROVE 或 REJECT');
    }
    const version = body.version || state.currentVersion;
    if (version !== state.currentVersion) {
      throw new DomainError('VERSION_SUPERSEDED', '只能对当前版本出具结论', 409);
    }
    const completeness = checkCompleteness(state, version);
    if (!completeness.complete) {
      throw new DomainError('MISSING_MATERIALS', '关键材料不完整，不能出具结论；请先走补件', 422, { completeness });
    }

    // 找到与「当前证据态」一致的最近完成批次；证据/信号一旦新增，旧批次即失效。
    const currentHash = evidenceStateHash(state, version);
    const batches = Object.values(state.batches)
      .filter((b) => b.version === version && b.status === 'COMPLETED')
      .sort((x, y) => y.resultEventSeq - x.resultEventSeq);
    const matched = batches.find((b) => b.evidenceStateHash === currentHash);
    if (!matched) {
      const stale = batches[0];
      throw new DomainError(
        'STALE_BATCH',
        stale
          ? '证据自上次计算后已变化（含迟到信号），必须重跑模型后再出具结论'
          : '当前版本尚无完成的模型批次，不能出具结论',
        409,
        { currentEvidenceStateHash: currentHash, latestBatch: stale ? { batchId: stale.batchId, evidenceStateHash: stale.evidenceStateHash } : null },
      );
    }

    const decision = {
      version,
      outcome,
      rationale: requireString(body.rationale, 'rationale'),
      batchId: matched.batchId,
      modelVersion: matched.modelVersion,
      rulePackVersion: matched.rulePackVersion,
      evidenceStateHash: currentHash,
      score: matched.score,
      warningIds: matched.warnings.map((w) => w.warningId),
    };
    this.store.append('DECISION_CONFIRMED', {
      applicationId,
      eventId: decisionEventId,
      actor: a,
      data: { decision },
    });
    return { decision, duplicate: false };
  }

  // ---------- 撤回后的最小审计事实 ----------

  _lateFact(applicationId, actor, kind, eventId, payload, reason) {
    const { duplicate } = this.store.append('LATE_FACT_RECORDED', {
      applicationId,
      eventId,
      actor,
      data: {
        kind,
        reference: payload.batchId || payload.signalId || payload.evidenceId || null,
        reason,
        payloadHash: hashValue(payload),
      },
    });
    return { accepted: 'LATE_FACT', kind, reason, duplicate };
  }

  // ---------- 查询 ----------

  requireState(applicationId) {
    const state = this.state(applicationId);
    if (!state.applicationId) {
      throw new DomainError('APPLICATION_NOT_FOUND', `申请不存在：${applicationId}`, 404);
    }
    return state;
  }
}

function requireOpen(state) {
  if (state.status === 'WITHDRAWN') {
    throw new DomainError('APPLICATION_WITHDRAWN', '申请已撤回：停止新的计算与变更', 409);
  }
  if (state.status === 'DECIDED') {
    throw new DomainError('APPLICATION_DECIDED', '申请已有最终结论且不可篡改', 409);
  }
}

function requireString(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new DomainError('BAD_REQUEST', `字段 ${field} 为必填非空字符串`);
  }
  return value;
}

function normalizeActor(actor) {
  if (!actor || typeof actor !== 'object') {
    throw new DomainError('BAD_ACTOR', '必须提供 actor {id, role}');
  }
  const role = String(actor.role || '').toUpperCase();
  if (!ROLES[role]) {
    throw new DomainError('BAD_ROLE', `未知角色：${role}；允许：${Object.keys(ROLES).join('、')}`, 403);
  }
  return { id: String(actor.id || role.toLowerCase()), role };
}

export { ROLES, REQUIRED_MATERIAL_KINDS };
