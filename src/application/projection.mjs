import { APPLICATION_STATUS, DECISIONS } from '../domain/events.mjs';
import { MATERIAL_TYPES } from '../domain/rules.mjs';

/**
 * 读模型：从折叠状态投影出“按申请版本排列的证据包”。
 * 只读，不产生任何状态；所有字段都可回溯到事件与快照。
 * @param snapshotHashes 可选 Set：调用方预取到的快照哈希，用于标注快照是否可取回。
 */
export function projectEvidencePackage(state, { snapshotHashes = null } = {}) {
  const versions = [...state.versions.values()]
    .sort((a, b) => a.seq - b.seq)
    .map((version) => projectVersion(version, { snapshotHashes }));

  return {
    applicationId: state.applicationId,
    customerId: state.customerId,
    defaultModelVersion: state.defaultModelVersion,
    status: state.status,
    currentVersionId: state.currentVersionId,
    openedAt: state.openedAt,
    openedBy: state.openedBy,
    withdrawn:
      state.status === APPLICATION_STATUS.WITHDRAWN
        ? { withdrawnAt: state.withdrawnAt, withdrawnBy: state.withdrawnBy, reason: state.withdrawReason }
        : null,
    versions,
    /**
     * 申请级外部风险信号：跨版本可见的风险事实。
     * 某条信号实体属于首次到达的版本，但之后每个版本的分析都会纳入它。
     */
    applicationExternalSignals: [...state.applicationSignals.values()]
      .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt))
      .map((m) => ({
        materialId: m.materialId,
        versionId: m.versionId,
        dedupeKey: m.dedupeKey,
        source: m.content.source,
        signalType: m.content.signalType,
        severity: m.content.severity,
        reference: m.content.reference ?? null,
        submittedAt: m.submittedAt,
      })),
    /** 撤回/终结后到达的外部信号：最小审计事实（不参与任何评分）。 */
    ignoredExternalSignals: [...state.ignoredSignals.values()],
  };
}

function projectVersion(version, { snapshotHashes }) {
  const latestAnalysis = version.analyses.at(-1) ?? null;
  const activeOpinion =
    [...version.opinions].reverse().find((o) => o.analysisId === latestAnalysis?.analysisId) ?? null;

  return {
    versionId: version.versionId,
    seq: version.seq,
    parentVersionId: version.parentVersionId,
    status: version.status,
    createdAt: version.createdAt,
    materials: [...version.materials.values()].map((m) => ({
      materialId: m.materialId,
      type: m.type,
      content: m.content,
      contentHash: m.contentHash,
      dedupeKey: m.dedupeKey,
      carriedFromVersionId: m.carriedFromVersionId,
      submittedBy: m.submittedBy,
      submittedAt: m.submittedAt,
    })),
    analyses: version.analyses.map((a) => ({
      analysisId: a.analysisId,
      seq: a.seq,
      modelVersion: a.modelVersion,
      snapshotHash: a.snapshotHash,
      score: a.score,
      bucket: a.bucket,
      completeness: a.completeness,
      recordedBy: a.recordedBy,
      recordedAt: a.recordedAt,
      // 每条预警都指向输入快照与规则版本，以及触发它的具体材料。
      warnings: a.warnings.map((w) => ({
        ruleId: w.ruleId,
        ruleVersion: w.ruleVersion,
        severity: w.severity,
        message: w.message,
        evidence: w.evidence,
        evidenceMaterialIds: w.evidenceMaterialIds,
        snapshotHash: w.snapshotHash,
        snapshotAvailable: snapshotHashes ? snapshotHashes.has(w.snapshotHash) : true,
      })),
    })),
    opinions: version.opinions.map((o) => ({
      ...o,
      // 新证据到达后旧分析失效，锚定它的意见标记 superseded，但永不删除。
      supersededByNewEvidence: latestAnalysis ? o.analysisId !== latestAnalysis.analysisId : false,
      active: activeOpinion ? o.opinionId === activeOpinion.opinionId : false,
    })),
    supplementRequests: version.supplementRequests,
    decision: version.decision,
  };
}

/**
 * 重放：还原“当时为什么通过/拒绝”。
 * 结论锚定的快照、模型版本、规则版本、触发材料全部列出；
 * snapshotLookup 负责把快照哈希还原成模型当时的输入。
 */
export async function projectReplay(state, { snapshotLookup = async () => null } = {}) {
  const timeline = [];
  const confirmedVersion = [...state.versions.values()].find((v) => v.decision) ?? null;
  let decisionExplanation = null;
  if (confirmedVersion?.decision) {
    const d = confirmedVersion.decision;
    const analysis = confirmedVersion.analyses.find((a) => a.analysisId === d.analysisId) ?? null;
    const snapshot = analysis ? await snapshotLookup(analysis.snapshotHash) : null;
    decisionExplanation = {
      decision: d.decision,
      versionId: confirmedVersion.versionId,
      versionSeq: confirmedVersion.seq,
      confirmedBy: d.confirmedBy,
      confirmedAt: d.confirmedAt,
      basedOn: analysis
        ? {
            analysisId: analysis.analysisId,
            modelVersion: analysis.modelVersion,
            score: analysis.score,
            bucket: analysis.bucket,
            snapshotHash: analysis.snapshotHash,
            // 模型当时看到的输入——审批人点开即见，而不是一个黑盒分数。
            snapshotInput: snapshot?.input ?? null,
            warnings: analysis.warnings.map((w) => ({
              ruleId: w.ruleId,
              ruleVersion: w.ruleVersion,
              severity: w.severity,
              message: w.message,
              evidence: w.evidence,
              evidenceMaterialIds: w.evidenceMaterialIds,
            })),
          }
        : null,
      opinion: confirmedVersion.opinions.find((o) => o.opinionId === d.opinionId) ?? null,
    };
  }

  for (const v of [...state.versions.values()].sort((a, b) => a.seq - b.seq)) {
    timeline.push({
      versionId: v.versionId,
      seq: v.seq,
      parentVersionId: v.parentVersionId,
      status: v.status,
      materialCount: v.materials.size,
      analysisCount: v.analyses.length,
      opinion: v.opinions.at(-1)
        ? {
            opinionId: v.opinions.at(-1).opinionId,
            decision: v.opinions.at(-1).decision,
            submittedAt: v.opinions.at(-1).submittedAt,
          }
        : null,
      supplementRequests: v.supplementRequests.map((s) => ({
        requiredItems: s.requiredItems,
        requestedAt: s.requestedAt,
      })),
    });
  }

  return {
    applicationId: state.applicationId,
    customerId: state.customerId,
    finalStatus: state.status,
    withdrawn:
      state.status === APPLICATION_STATUS.WITHDRAWN
        ? { withdrawnAt: state.withdrawnAt, withdrawnBy: state.withdrawnBy, reason: state.withdrawReason }
        : null,
    timeline,
    decisionExplanation,
    ignoredExternalSignals: [...state.ignoredSignals.values()],
  };
}

export { MATERIAL_TYPES, DECISIONS };
