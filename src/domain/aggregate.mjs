import { newId } from '../lib/canonical.mjs';
import { EVENT_TYPES, APPLICATION_STATUS, DECISIONS, ROLES } from './events.mjs';
import { MATERIAL_TYPES } from './rules.mjs';
import {
  DomainError,
  ValidationError,
  NotFoundError,
  ConflictError,
  AuthorizationError,
} from './errors.mjs';

const {
  APPLICATION_OPENED,
  MATERIAL_SUBMITTED,
  ANALYSIS_RECORDED,
  OPINION_SUBMITTED,
  SUPPLEMENT_REQUESTED,
  DECISION_CONFIRMED,
  APPLICATION_WITHDRAWN,
  EXTERNAL_SIGNAL_IGNORED,
} = EVENT_TYPES;

/** 进入分析所需的关键材料；缺失则“只能进入补件状态”。 */
export const REQUIRED_MATERIAL_TYPES = Object.freeze([
  MATERIAL_TYPES.FINANCIAL_REPORT,
  MATERIAL_TYPES.MANUAL_VERIFICATION,
]);

const VALID_MATERIAL_TYPES = new Set(Object.values(MATERIAL_TYPES));
const VALID_VERIFY_RESULTS = new Set(['PASS', 'FAIL', 'UNVERIFIED']);
const VALID_SEVERITIES = new Set(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
/** 审查意见只表达通过/拒绝；补件是独立的 SUPPLEMENT_REQUESTED 流程，不是结论。 */
const VALID_OPINION_DECISIONS = new Set([DECISIONS.APPROVE, DECISIONS.REJECT]);

function nowIso() {
  return new Date().toISOString();
}

function hasRole(actor, role) {
  return Array.isArray(actor?.roles) && actor.roles.includes(role);
}

function assertNotWithdrawn(state) {
  if (state.status === APPLICATION_STATUS.WITHDRAWN) {
    throw new ConflictError('申请已撤回，不再接受任何变更');
  }
}

function assertNotTerminal(state) {
  assertNotWithdrawn(state);
  if (state.status === APPLICATION_STATUS.CONFIRMED) {
    throw new ConflictError('申请已出具最终结论，结论不可更改');
  }
}

function currentVersion(state) {
  const v = state.versions.get(state.currentVersionId);
  if (!v) throw new NotFoundError('当前版本不存在');
  return v;
}

/* ------------------------------- 材料校验 ------------------------------- */

function validateMaterial(cmd) {
  const { materialType: type, content, dedupeKey } = cmd;
  if (!VALID_MATERIAL_TYPES.has(type)) {
    throw new ValidationError(`不支持的材料类型: ${type}`);
  }
  if (!content || typeof content !== 'object') {
    throw new ValidationError('材料内容必须是对象');
  }
  if (type === MATERIAL_TYPES.FINANCIAL_REPORT) {
    const ratio = content.debtToAssetRatio;
    const profit = content.netProfit;
    if (ratio !== undefined && (typeof ratio !== 'number' || ratio < 0 || ratio > 1)) {
      throw new ValidationError('debtToAssetRatio 必须是 0~1 之间的数字');
    }
    if (profit !== undefined && typeof profit !== 'number') {
      throw new ValidationError('netProfit 必须是数字');
    }
    if (ratio === undefined && profit === undefined) {
      throw new ValidationError('财报摘要至少包含 debtToAssetRatio 或 netProfit');
    }
  } else if (type === MATERIAL_TYPES.MANUAL_VERIFICATION) {
    if (typeof content.item !== 'string' || !content.item.trim()) {
      throw new ValidationError('人工核验项 item 不能为空');
    }
    if (!VALID_VERIFY_RESULTS.has(content.result)) {
      throw new ValidationError(`核验结果必须是 ${[...VALID_VERIFY_RESULTS].join('/')}`);
    }
  } else if (type === MATERIAL_TYPES.EXTERNAL_SIGNAL) {
    for (const field of ['source', 'signalType']) {
      if (typeof content[field] !== 'string' || !content[field].trim()) {
        throw new ValidationError(`外部信号 ${field} 不能为空`);
      }
    }
    if (!VALID_SEVERITIES.has(content.severity)) {
      throw new ValidationError(`外部信号 severity 必须是 ${[...VALID_SEVERITIES].join('/')}`);
    }
    if (typeof dedupeKey !== 'string' || !dedupeKey) {
      throw new ValidationError('外部信号必须提供 dedupeKey（来源+来源流水号）用于回调去重');
    }
  }
}

/* ----------------------------- 分析输入构建 ----------------------------- */

function stripInternal(value) {
  if (Array.isArray(value)) return value.map(stripInternal);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !key.startsWith('__'))
        .map(([key, val]) => [key, stripInternal(val)])
    );
  }
  return value;
}

/**
 * 把一个版本下已封存的材料组装成模型/规则输入。
 * __ 前缀字段仅供规则反查证据材料，封存快照时统一剥离。
 * 外部风险信号是申请级事实：除版本内材料外，还并入其他版本已到达的全部信号。
 */
export function buildAnalysisInput(version, applicationSignals = new Map()) {
  const materials = [...version.materials.values()];
  const reports = materials.filter((m) => m.type === MATERIAL_TYPES.FINANCIAL_REPORT);
  const latestReport = reports.sort((a, b) => a.submittedAt.localeCompare(b.submittedAt)).at(-1);

  const versionSignals = materials.filter((m) => m.type === MATERIAL_TYPES.EXTERNAL_SIGNAL);
  const signals = new Map();
  for (const m of versionSignals) signals.set(m.dedupeKey, m);
  for (const m of applicationSignals.values()) signals.set(m.dedupeKey, m);
  const orderedSignals = [...signals.values()].sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));

  return {
    financialSummary: latestReport
      ? { ...latestReport.content, __materialId: latestReport.materialId }
      : null,
    manualVerifications: materials
      .filter((m) => m.type === MATERIAL_TYPES.MANUAL_VERIFICATION)
      .map((m) => ({ ...m.content, __materialId: m.materialId })),
    externalSignals: orderedSignals.map((m) => ({
      ...m.content,
      __materialId: m.materialId,
      __originVersionId: m.versionId,
    })),
    __financialMaterialIds: reports.map((m) => m.materialId),
  };
}

export function snapshotInput(markedInput) {
  return stripInternal(markedInput);
}

export function missingRequiredTypes(version) {
  const present = new Set([...version.materials.values()].map((m) => m.type));
  return REQUIRED_MATERIAL_TYPES.filter((t) => !present.has(t));
}

/* -------------------------------- 状态折叠 ------------------------------- */

export function initialState() {
  return {
    applicationId: null,
    customerId: null,
    defaultModelVersion: null,
    status: null,
    currentVersionId: null,
    openedAt: null,
    openedBy: null,
    withdrawnAt: null,
    withdrawnBy: null,
    withdrawReason: null,
    versions: new Map(),
    /** 申请级去重：外部信号在所有版本间只生效一次（迟到/重复回调）。 */
    signalDedupe: new Map(), // dedupeKey -> { versionId, materialId }
    /**
     * 申请级外部风险信号事实：信号不因补件开新版本而消失，
     * 任一版本分析时都纳入模型/规则输入（材料实体仍归属其首次到达的版本）。
     */
    applicationSignals: new Map(), // dedupeKey -> 材料记录
    /** 撤回/终结后到达的信号：只留最小审计事实。 */
    ignoredSignals: new Map(), // dedupeKey -> 事实
    revision: 0, // 已折叠事件数，用作乐观并发版本
  };
}

function applyEvent(state, event) {
  const p = event.payload;
  switch (event.type) {
    case APPLICATION_OPENED: {
      state.applicationId = p.applicationId;
      state.customerId = p.customerId;
      state.defaultModelVersion = p.modelVersion;
      state.openedAt = event.occurredAt;
      state.openedBy = event.actor?.userId ?? null;
      state.status = APPLICATION_STATUS.OPEN;
      state.versions.set(p.initialVersionId, {
        versionId: p.initialVersionId,
        seq: 1,
        parentVersionId: null,
        status: 'OPEN',
        createdAt: event.occurredAt,
        materials: new Map(),
        materialDedupeKeys: new Set(),
        analyses: [],
        opinions: [],
        supplementRequests: [],
        decision: null,
      });
      state.currentVersionId = p.initialVersionId;
      break;
    }
    case MATERIAL_SUBMITTED: {
      const v = state.versions.get(p.versionId);
      const record = {
        materialId: p.materialId,
        versionId: p.versionId,
        type: p.type,
        content: p.content,
        contentHash: p.contentHash,
        dedupeKey: p.dedupeKey ?? null,
        carriedFromVersionId: p.carriedFromVersionId ?? null,
        submittedBy: event.actor?.userId ?? null,
        submittedAt: event.occurredAt,
      };
      v.materials.set(p.materialId, record);
      if (p.dedupeKey) v.materialDedupeKeys.add(p.dedupeKey);
      if (p.type === MATERIAL_TYPES.EXTERNAL_SIGNAL && p.dedupeKey) {
        state.signalDedupe.set(p.dedupeKey, {
          versionId: p.versionId,
          materialId: p.materialId,
        });
        // 结转材料的外部信号不进申请级事实（本实现不结转外部信号，此处双保险）。
        if (!p.carriedFromVersionId) state.applicationSignals.set(p.dedupeKey, record);
      }
      // 待确认期间出现新证据：既有意见锚定旧快照，申请自动退回待分析。
      // 旧意见原样保留在所属版本上（投影标记 superseded），绝不删除或改写。
      if (state.status === APPLICATION_STATUS.AWAITING_CONFIRMATION) {
        state.status = APPLICATION_STATUS.OPEN;
      }
      break;
    }
    case ANALYSIS_RECORDED: {
      const v = state.versions.get(p.versionId);
      v.analyses.push({
        analysisId: p.analysisId,
        modelVersion: p.modelVersion,
        snapshotHash: p.snapshotHash,
        score: p.score,
        bucket: p.bucket,
        warnings: p.warnings,
        completeness: p.completeness,
        recordedBy: event.actor?.userId ?? null,
        recordedAt: event.occurredAt,
        seq: v.analyses.length + 1,
      });
      break;
    }
    case OPINION_SUBMITTED: {
      const v = state.versions.get(p.versionId);
      v.opinions.push({
        opinionId: p.opinionId,
        analysisId: p.analysisId,
        snapshotHash: p.snapshotHash,
        decision: p.decision,
        rationale: p.rationale ?? '',
        submittedBy: event.actor?.userId ?? null,
        submittedAt: event.occurredAt,
      });
      state.status = APPLICATION_STATUS.AWAITING_CONFIRMATION;
      break;
    }
    case SUPPLEMENT_REQUESTED: {
      const old = state.versions.get(p.versionId);
      old.status = 'SUPPLEMENTED';
      old.supplementRequests.push({
        requestId: p.requestId,
        requiredItems: p.requiredItems,
        newVersionId: p.newVersionId,
        requestedBy: event.actor?.userId ?? null,
        requestedAt: event.occurredAt,
      });
      state.versions.set(p.newVersionId, {
        versionId: p.newVersionId,
        seq: old.seq + 1,
        parentVersionId: p.versionId,
        status: 'OPEN',
        createdAt: event.occurredAt,
        materials: new Map(),
        materialDedupeKeys: new Set(),
        analyses: [],
        opinions: [],
        supplementRequests: [],
        decision: null,
      });
      state.currentVersionId = p.newVersionId;
      // 补件开立新版本：待确认意见随旧版本封存，申请回到 OPEN。
      state.status = APPLICATION_STATUS.OPEN;
      break;
    }
    case DECISION_CONFIRMED: {
      const v = state.versions.get(p.versionId);
      v.status = 'CONFIRMED';
      v.decision = {
        opinionId: p.opinionId,
        analysisId: p.analysisId,
        decision: p.decision,
        snapshotHash: p.snapshotHash,
        confirmedBy: event.actor?.userId ?? null,
        confirmedAt: event.occurredAt,
      };
      state.status = APPLICATION_STATUS.CONFIRMED;
      break;
    }
    case APPLICATION_WITHDRAWN: {
      state.status = APPLICATION_STATUS.WITHDRAWN;
      state.withdrawnAt = event.occurredAt;
      state.withdrawnBy = event.actor?.userId ?? null;
      state.withdrawReason = p.reason ?? '';
      break;
    }
    case EXTERNAL_SIGNAL_IGNORED: {
      state.ignoredSignals.set(p.dedupeKey, {
        dedupeKey: p.dedupeKey,
        source: p.source,
        reason: p.reason,
        receivedAt: event.occurredAt,
      });
      break;
    }
    default:
      throw new Error(`未知事件类型: ${event.type}`);
  }
  state.revision += 1;
  return state;
}

export function fold(events, state = initialState()) {
  for (const event of events) applyEvent(state, event);
  return state;
}

/** 在状态副本上试投候选事件（decide 内部做前瞻判断时使用，不污染真实状态）。 */
function project(state, candidateEvents) {
  return fold(candidateEvents, structuredClone(state));
}

/* -------------------------------- 命令决策 ------------------------------- */

function eventOut(type, payload, actor, occurredAt = nowIso()) {
  return { type, payload, actor, occurredAt };
}

/**
 * 命令处理器：decide 返回待追加事件数组（纯函数），或 { events, ...meta }。
 * 哈希与模型计算通过 deps.runAnalysis 注入，聚合只封存结果，保证可单测、可重放。
 */
export function decide(state, command, deps = {}) {
  if (!state.applicationId && command.type !== 'openApplication') {
    throw new NotFoundError('授信申请不存在');
  }
  switch (command.type) {
    case 'openApplication':
      return [openApplication(state, command)];
    case 'submitMaterial':
      return [submitMaterial(state, command)];
    case 'recordAnalysis':
      return recordAnalysis(state, command, deps);
    case 'submitOpinion':
      return [submitOpinion(state, command)];
    case 'requestSupplement':
      return requestSupplement(state, command);
    case 'confirmDecision':
      return [confirmDecision(state, command)];
    case 'withdraw':
      return [withdraw(state, command)];
    case 'ingestExternalSignal':
      return ingestExternalSignal(state, command);
    default:
      throw new ValidationError(`未知命令: ${command.type}`);
  }
}

function openApplication(state, cmd) {
  if (state.applicationId) {
    throw new ConflictError('授信申请已存在，不能重复开立');
  }
  const { applicationId, customerId, modelVersion } = cmd;
  if (!applicationId || typeof applicationId !== 'string') {
    throw new ValidationError('applicationId 不能为空');
  }
  if (!customerId || typeof customerId !== 'string') {
    throw new ValidationError('customerId 不能为空');
  }
  if (!modelVersion || typeof modelVersion !== 'string') {
    throw new ValidationError('modelVersion 不能为空');
  }
  return eventOut(
    APPLICATION_OPENED,
    { applicationId, customerId, modelVersion, initialVersionId: newId('ver_') },
    cmd.actor
  );
}

function submitMaterial(state, cmd) {
  assertNotTerminal(state);
  validateMaterial(cmd);
  const version = currentVersion(state);

  if (version.status === 'SUPPLEMENTED') {
    throw new ConflictError('该版本已补件结转到新版本，请向当前版本提交材料');
  }
  // 人工提交的财报/核验材料，审查岗与审批岗均可并行补充。
  if (cmd.materialType !== MATERIAL_TYPES.EXTERNAL_SIGNAL) {
    if (!hasRole(cmd.actor, ROLES.ANALYST) && !hasRole(cmd.actor, ROLES.APPROVER)) {
      throw new AuthorizationError('仅审查岗/审批岗可补充证据材料');
    }
  }
  if (version.materialDedupeKeys.has(cmd.dedupeKey)) {
    throw new ConflictError('同一材料已在当前版本提交（dedupeKey 重复）');
  }
  if (cmd.materialType === MATERIAL_TYPES.EXTERNAL_SIGNAL) {
    if (state.signalDedupe.has(cmd.dedupeKey)) {
      throw new ConflictError('外部信号已在本申请其他版本生效，不重复计入');
    }
  }

  return eventOut(
    MATERIAL_SUBMITTED,
    {
      versionId: version.versionId,
      materialId: newId('mat_'),
      type: cmd.materialType,
      content: cmd.content,
      contentHash: cmd.contentHash ?? null,
      dedupeKey: cmd.dedupeKey ?? null,
      carriedFromVersionId: cmd.carriedFromVersionId ?? null,
    },
    cmd.actor
  );
}

function recordAnalysis(state, cmd, deps) {
  assertNotTerminal(state);
  if (!hasRole(cmd.actor, ROLES.ANALYST) && !hasRole(cmd.actor, ROLES.SYSTEM)) {
    throw new AuthorizationError('仅审查岗可触发风险分析');
  }
  if (state.status !== APPLICATION_STATUS.OPEN) {
    // 待确认期间禁止重算：模型重跑不得静默扰动已提交、待确认的意见。
    throw new ConflictError('申请存在待确认意见，新证据到达后才能重新分析');
  }
  const version = currentVersion(state);

  const missing = missingRequiredTypes(version);
  if (missing.length > 0) {
    throw new DomainError('MISSING_REQUIRED_MATERIALS', '缺少关键材料，只能进入补件状态', {
      status: 422,
      details: { missing, required: [...REQUIRED_MATERIAL_TYPES] },
    });
  }

  const markedInput = buildAnalysisInput(version, state.applicationSignals);
  const cleanInput = snapshotInput(markedInput);
  const modelVersion = cmd.modelVersion || state.defaultModelVersion;
  if (!deps.runAnalysis) throw new Error('缺少分析计算依赖 runAnalysis');
  const result = deps.runAnalysis({ modelVersion, input: cleanInput, markedInput, version });

  // 幂等重放：同一模型版本 + 同一快照已分析过，不产生新事件。
  const latest = version.analyses.at(-1);
  if (latest && latest.snapshotHash === result.snapshotHash && latest.modelVersion === modelVersion) {
    return { events: [], idempotent: true, analysisId: latest.analysisId, snapshotRecord: result.snapshotRecord };
  }

  const warnings = result.warnings.map((w) => ({ ...w, snapshotHash: result.snapshotHash }));
  return {
    events: [
      eventOut(
        ANALYSIS_RECORDED,
        {
          versionId: version.versionId,
          analysisId: newId('ana_'),
          modelVersion: result.modelVersion,
          snapshotHash: result.snapshotHash,
          score: result.score,
          bucket: result.bucket,
          warnings,
          completeness: {
            required: [...REQUIRED_MATERIAL_TYPES],
            satisfied: true,
            checkedAt: nowIso(),
          },
        },
        cmd.actor
      ),
    ],
    // 服务层据此把“模型当时看到的输入”写入快照库；事件本身只存哈希。
    snapshotRecord: result.snapshotRecord,
  };
}

function submitOpinion(state, cmd) {
  assertNotTerminal(state);
  if (!hasRole(cmd.actor, ROLES.ANALYST)) {
    throw new AuthorizationError('仅审查岗可提交审查意见');
  }
  if (state.status !== APPLICATION_STATUS.OPEN) {
    throw new ConflictError('已有待确认意见；新证据到达后须重新分析并提交新意见');
  }
  const version = currentVersion(state);
  const latestAnalysis = version.analyses.at(-1);
  if (!latestAnalysis) {
    throw new ConflictError('提交意见前必须先形成一版风险分析');
  }
  if (!VALID_OPINION_DECISIONS.has(cmd.decision)) {
    throw new ValidationError(`decision 必须是 ${[...VALID_OPINION_DECISIONS].join('/')}；补件请走补件流程`);
  }
  if (cmd.analysisId && cmd.analysisId !== latestAnalysis.analysisId) {
    throw new ConflictError('意见必须锚定当前版本最新一版分析');
  }

  return eventOut(
    OPINION_SUBMITTED,
    {
      versionId: version.versionId,
      opinionId: newId('opi_'),
      analysisId: latestAnalysis.analysisId,
      snapshotHash: latestAnalysis.snapshotHash,
      decision: cmd.decision,
      rationale: typeof cmd.rationale === 'string' ? cmd.rationale : '',
    },
    cmd.actor
  );
}

/**
 * 发起补件：当前版本封存为 SUPPLEMENTED，开立下一版本；
 * 既有非外部材料以“结转证据”复制进新版本（carriedFromVersionId 标注来源），
 * 外部信号属申请级事实、不重复结转。关键材料缺失时这是唯一允许的出路。
 */
function requestSupplement(state, cmd) {
  assertNotTerminal(state);
  if (!hasRole(cmd.actor, ROLES.ANALYST)) {
    throw new AuthorizationError('仅审查岗可发起补件');
  }
  const version = currentVersion(state);
  if (version.status === 'SUPPLEMENTED') {
    throw new ConflictError('该版本已结转');
  }
  const items = Array.isArray(cmd.requiredItems)
    ? cmd.requiredItems.filter((i) => typeof i === 'string' && i.trim())
    : [];
  if (items.length === 0) {
    throw new ValidationError('requiredItems 至少列出一项待补材料');
  }

  const baseOccurredAt = nowIso();
  const events = [
    eventOut(
      SUPPLEMENT_REQUESTED,
      {
        versionId: version.versionId,
        requestId: newId('sup_'),
        requiredItems: items,
        newVersionId: newId('ver_'),
      },
      cmd.actor,
      baseOccurredAt
    ),
  ];
  const newVersionId = events[0].payload.newVersionId;

  for (const m of version.materials.values()) {
    if (m.type === MATERIAL_TYPES.EXTERNAL_SIGNAL) continue;
    events.push(
      eventOut(
        MATERIAL_SUBMITTED,
        {
          versionId: newVersionId,
          materialId: newId('mat_'),
          type: m.type,
          content: m.content,
          contentHash: m.contentHash,
          dedupeKey: null,
          carriedFromVersionId: version.versionId,
        },
        { userId: 'SYSTEM', roles: [ROLES.SYSTEM] },
        baseOccurredAt
      )
    );
  }
  return events;
}

function confirmDecision(state, cmd) {
  if (!hasRole(cmd.actor, ROLES.APPROVER)) {
    throw new AuthorizationError('最终结论只能由有审批权限的角色确认');
  }
  if (state.status === APPLICATION_STATUS.WITHDRAWN) {
    throw new ConflictError('申请已撤回，不能确认结论');
  }
  if (state.status === APPLICATION_STATUS.CONFIRMED) {
    throw new ConflictError('最终结论已确认，不可更改');
  }
  if (state.status !== APPLICATION_STATUS.AWAITING_CONFIRMATION) {
    throw new ConflictError('只有待确认状态的申请可以确认最终结论');
  }
  const version = currentVersion(state);
  const latestAnalysis = version.analyses.at(-1);
  const opinion = [...version.opinions].reverse().find((o) =>
    VALID_OPINION_DECISIONS.has(o.decision)
  );
  if (!opinion || opinion.analysisId !== latestAnalysis.analysisId) {
    throw new ConflictError('待确认意见与最新分析不一致，需重新提交意见');
  }
  return eventOut(
    DECISION_CONFIRMED,
    {
      versionId: version.versionId,
      opinionId: opinion.opinionId,
      analysisId: opinion.analysisId,
      decision: opinion.decision,
      snapshotHash: opinion.snapshotHash,
    },
    cmd.actor
  );
}

function withdraw(state, cmd) {
  if (!hasRole(cmd.actor, ROLES.APPROVER)) {
    throw new AuthorizationError('仅审批岗可撤回申请');
  }
  if (state.status === APPLICATION_STATUS.WITHDRAWN) {
    throw new ConflictError('申请已处于撤回状态');
  }
  if (state.status === APPLICATION_STATUS.CONFIRMED) {
    throw new ConflictError('已确认最终结论的申请不能撤回');
  }
  return eventOut(
    APPLICATION_WITHDRAWN,
    { reason: typeof cmd.reason === 'string' ? cmd.reason : '' },
    cmd.actor
  );
}

/**
 * 外部信号回调入口，覆盖迟到、重复、撤回后到达：
 *  - dedupeKey 在申请级已生效/已记录忽略：幂等返回，不产生事件；
 *  - 撤回/已终结：不做任何计算，只追加 EXTERNAL_SIGNAL_IGNORED 最小审计事实；
 *  - 其余：作为材料入当前版本；材料关键项齐全则提示服务层自动分析。
 */
function ingestExternalSignal(state, cmd) {
  const content = cmd.content;
  const dedupeKey = cmd.dedupeKey;
  validateMaterial({ materialType: MATERIAL_TYPES.EXTERNAL_SIGNAL, content, dedupeKey });

  if (state.signalDedupe.has(dedupeKey)) {
    return { events: [], deduped: true, existing: state.signalDedupe.get(dedupeKey) };
  }
  if (state.ignoredSignals.has(dedupeKey)) {
    return { events: [], deduped: true, ignored: true };
  }

  const ignoreReason =
    state.status === APPLICATION_STATUS.WITHDRAWN
      ? 'WITHDRAWN'
      : state.status === APPLICATION_STATUS.CONFIRMED
        ? 'CONFIRMED'
        : null;
  if (ignoreReason) {
    return {
      events: [
        eventOut(
          EXTERNAL_SIGNAL_IGNORED,
          { dedupeKey, source: content.source, reason: ignoreReason },
          { userId: 'SYSTEM', roles: [ROLES.SYSTEM] }
        ),
      ],
      ignored: true,
    };
  }

  const materialEvent = submitMaterial(
    state,
    {
      ...cmd,
      materialType: MATERIAL_TYPES.EXTERNAL_SIGNAL,
      actor: cmd.actor ?? { userId: 'SYSTEM', roles: [ROLES.SYSTEM] },
    }
  );
  const projected = project(state, [materialEvent]);
  const version = projected.versions.get(projected.currentVersionId);
  const autoAnalyze =
    projected.status === APPLICATION_STATUS.OPEN && missingRequiredTypes(version).length === 0;
  return { events: [materialEvent], autoAnalyze: Boolean(autoAnalyze) };
}
