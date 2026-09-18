import { hashValue } from './canonical.mjs';
import { VERIFIABLE_FIELDS } from './rules.mjs';

/**
 * 申请聚合：纯事件重放。
 *
 * 所有状态都由事件流派生，不保存任何独立的可变状态 ——
 * 服务重启后重放日志即可复原；想知道「当时为什么通过/拒绝」，
 * 直接重放到 DECISION_CONFIRMED 事件即可得到完全一致的结论。
 */

export function replayApplication(events) {
  const state = {
    applicationId: null,
    customerId: null,
    openedAt: null,
    openedBy: null,
    status: 'OPEN', // OPEN | DECIDED | WITHDRAWN
    currentVersion: null,
    versionSeq: 0,
    versions: {}, // version -> versionState
    signals: [], // 已接收的外部信号（全申请级），按事件顺序
    batches: {}, // batchId -> batch
    warnings: {}, // warningId -> 预警（含 batchId）
    notes: {}, // warningId -> [note]
    decision: null,
    withdrawal: null,
    lateFacts: [], // 终态后到达、只保留最小审计事实的输入
  };

  for (const evt of events) apply(state, evt);
  return state;
}

function apply(state, evt) {
  const d = evt.data;
  switch (evt.type) {
    case 'APPLICATION_OPENED':
      state.applicationId = evt.applicationId;
      state.customerId = d.customerId;
      state.openedAt = evt.at;
      state.openedBy = evt.actor;
      break;

    case 'VERSION_OPENED': {
      state.versionSeq += 1;
      state.versions[d.version] = {
        version: d.version,
        parentVersion: d.parentVersion || null,
        openedAt: evt.at,
        openedBy: evt.actor,
        reason: d.reason || null,
        evidence: [], // 仅本版本新增材料（按提交顺序）
      };
      state.currentVersion = d.version;
      break;
    }

    case 'SUPPLEMENT_REQUESTED': {
      // 与 VERSION_OPENED 配对出现，原因已挂在新版本上；此处仅留显式索引便于审计
      const v = state.versions[d.version];
      if (v) v.supplementRequest = { at: evt.at, by: evt.actor, reason: d.reason, missingKinds: d.missingKinds };
      break;
    }

    case 'EVIDENCE_ADDED': {
      const v = state.versions[d.version];
      v.evidence.push({ ...d.evidence, addedAt: evt.at, addedBy: evt.actor });
      break;
    }

    case 'EXTERNAL_SIGNAL_RECORDED':
      state.signals.push({ ...d.signal, recordedAt: evt.at, recordedEventSeq: evt.seq });
      break;

    case 'MODEL_RUN_REQUESTED': {
      state.batches[d.batchId] = {
        batchId: d.batchId,
        version: d.version,
        modelVersion: d.modelVersion,
        rulePackVersion: d.rulePackVersion,
        requestedAt: evt.at,
        requestedBy: evt.actor,
        status: 'REQUESTED',
        evidenceStateHash: d.evidenceStateHash,
        inputSnapshot: d.inputSnapshot,
        warnings: null,
        score: null,
        completedAt: null,
      };
      break;
    }

    case 'MODEL_RESULT_RECORDED': {
      const b = state.batches[d.batchId];
      if (!b) break; // 理论不会发生（未知批次走 LATE_FACT）
      b.status = 'COMPLETED';
      b.score = d.score;
      b.warnings = d.warnings;
      b.completedAt = evt.at;
      b.resultEventSeq = evt.seq;
      for (const w of d.warnings) {
        state.warnings[w.warningId] = { ...w, batchId: b.batchId, version: b.version };
      }
      break;
    }

    case 'WARNING_NOTE_ADDED': {
      (state.notes[d.warningId] ??= []).push({
        noteId: d.noteId,
        author: evt.actor,
        at: evt.at,
        content: d.content,
      });
      break;
    }

    case 'DECISION_CONFIRMED':
      state.status = 'DECIDED';
      state.decision = { ...d.decision, confirmedEventSeq: evt.seq };
      break;

    case 'APPLICATION_WITHDRAWN':
      state.status = 'WITHDRAWN';
      state.withdrawal = { at: evt.at, by: evt.actor, reason: d.reason };
      // 撤回时仍在途的批次标记为废弃（其迟到回调将只留最小事实）
      for (const b of Object.values(state.batches)) {
        if (b.status === 'REQUESTED') b.status = 'ABANDONED';
      }
      break;

    case 'LATE_FACT_RECORDED':
      state.lateFacts.push({
        at: evt.at,
        kind: d.kind,
        reference: d.reference,
        payloadHash: d.payloadHash,
        actor: evt.actor,
      });
      break;

    default:
      // 未知事件类型忽略，保证老日志能被新代码读取（前向兼容）
      break;
  }
}

/** 沿 parent 链取版本的有效材料：最早的祖先在前，本版本最后（后提交优先）。 */
export function effectiveEvidence(state, version) {
  const chain = [];
  let cur = version;
  const seen = new Set();
  while (cur && state.versions[cur] && !seen.has(cur)) {
    seen.add(cur);
    chain.unshift(state.versions[cur]);
    cur = state.versions[cur].parentVersion;
  }
  return chain.flatMap((v) => v.evidence);
}

/** 当前生效财报：优先本版本，否则沿补件链向上找最近一份。 */
export function effectiveFinancial(state, version, evidence = effectiveEvidence(state, version)) {
  for (let i = evidence.length - 1; i >= 0; i -= 1) {
    if (evidence[i].kind === 'FINANCIAL_SUMMARY') return evidence[i];
  }
  return null;
}

/**
 * 材料完整性核对。缺少关键材料时不允许进入计算/决定。
 * 核验记录必须显式指向被核验的财报（financialEvidenceId），
 * 因此换了财报版本后，旧核验不会被错误地当作新财报的证据。
 */
export function checkCompleteness(state, version) {
  const evidence = effectiveEvidence(state, version);
  const financial = effectiveFinancial(state, version, evidence);
  const missing = [];
  const failedChecks = [];

  if (!financial) {
    missing.push('FINANCIAL_SUMMARY');
  } else {
    const absentFields = VERIFIABLE_FIELDS.filter(
      (f) => typeof financial.fields?.[f] !== 'number',
    );
    if (absentFields.length > 0) {
      missing.push(`FINANCIAL_SUMMARY.fields.${absentFields.join(',')}`);
    }
    const verifications = evidence.filter((e) => e.kind === 'MANUAL_VERIFICATION');
    for (const field of VERIFIABLE_FIELDS) {
      if (typeof financial.fields?.[field] !== 'number') continue;
      const v = verifications.find(
        (x) => x.item === field && x.financialEvidenceId === financial.evidenceId,
      );
      if (!v) missing.push(`MANUAL_VERIFICATION(${field})`);
      else if (v.result !== 'PASS') failedChecks.push({ field, result: v.result, evidenceId: v.evidenceId });
    }
  }

  const complete = missing.length === 0 && failedChecks.length === 0;
  return {
    complete,
    status: complete ? 'READY_TO_REVIEW' : 'AWAITING_MATERIALS',
    missing,
    failedChecks,
    financialEvidenceId: financial?.evidenceId || null,
  };
}

/**
 * 证据状态哈希：版本有效材料 + 申请级全部已知信号。
 * 调用均为同步、且在追加新事件之前完成重放，所以 state 中内容
 * 恰好是「本时刻之前」的事实，无需再按时间过滤。
 * 一旦有新证据/信号进入，哈希立即变化，旧批次随之失效（必须重跑）。
 */
export function evidenceStateHash(state, version) {
  const evidence = effectiveEvidence(state, version).map(stripRuntime);
  const signals = state.signals.map(stripSignalRuntime);
  return hashValue({ version, evidence, signals });
}

function stripRuntime(e) {
  const { addedAt, addedBy, ...rest } = e;
  return rest;
}

function stripSignalRuntime(s) {
  const { recordedAt, recordedEventSeq, ...rest } = s;
  return rest;
}

/** 供模型批次冻结的输入快照（完整内容，回调到达时据此确定性计算预警）。 */
export function buildInputSnapshot(state, version, { modelVersion, rulePackVersion }) {
  const evidence = effectiveEvidence(state, version).map(stripRuntime);
  const signals = state.signals.map(stripSignalRuntime);
  return {
    capturedAt: new Date().toISOString(),
    version,
    modelVersion,
    rulePackVersion,
    evidence,
    signals,
  };
}

/** 由冻结快照构造规则引擎上下文。 */
export function buildRuleContext(snapshot, score) {
  const financial = [...snapshot.evidence]
    .reverse()
    .find((e) => e.kind === 'FINANCIAL_SUMMARY');
  const verifications = snapshot.evidence
    .filter((e) => e.kind === 'MANUAL_VERIFICATION')
    .map((e) => ({
      evidenceId: e.evidenceId,
      item: e.item,
      result: e.result,
      financialEvidenceId: e.financialEvidenceId,
    }));
  return {
    batchId: snapshot.batchId,
    modelScore: score,
    financial: financial
      ? { evidenceId: financial.evidenceId, fields: financial.fields, summary: financial.summary }
      : null,
    verifications,
    signals: snapshot.signals,
  };
}

/** 版本状态（派生）。 */
export function versionStatus(state, version) {
  if (state.decision?.version === version) return 'DECIDED';
  if (state.currentVersion !== version) return 'SUPERSEDED';
  if (state.status === 'WITHDRAWN') return 'WITHDRAWN';
  return checkCompleteness(state, version).status;
}

/** 当前版本上最近一个完成的批次。 */
export function latestCompletedBatch(state, version = state.currentVersion) {
  const batches = Object.values(state.batches)
    .filter((b) => b.version === version && b.status === 'COMPLETED')
    .sort((a, b) => (a.completedAt < b.completedAt ? 1 : -1));
  return batches[0] || null;
}

/** 序列化成对外视图（GET）。 */
export function toView(state) {
  const versions = Object.values(state.versions).map((v) => {
    const completeness = checkCompleteness(state, v.version);
    const batches = Object.values(state.batches)
      .filter((b) => b.version === v.version)
      .map((b) => ({
        batchId: b.batchId,
        status: b.status,
        modelVersion: b.modelVersion,
        rulePackVersion: b.rulePackVersion,
        requestedAt: b.requestedAt,
        completedAt: b.completedAt,
        score: b.score,
        evidenceStateHash: b.evidenceStateHash,
        warnings: (b.warnings || []).map((w) => ({ ...w, notes: state.notes[w.warningId] || [] })),
      }));
    return {
      version: v.version,
      parentVersion: v.parentVersion,
      reason: v.reason,
      openedAt: v.openedAt,
      status: versionStatus(state, v.version),
      completeness,
      evidence: effectiveEvidence(state, v.version),
      batches,
    };
  });
  return {
    applicationId: state.applicationId,
    customerId: state.customerId,
    status: state.status,
    currentVersion: state.currentVersion,
    openedAt: state.openedAt,
    withdrawal: state.withdrawal,
    versions,
    signals: state.signals,
    decision: state.decision,
    lateFacts: state.lateFacts,
  };
}
