import { stableStringify, sha256 } from '../lib/canonical.mjs';

/**
 * 模型注册表：每个模型版本是一份冻结的、确定性的评分函数。
 * 同一份输入快照在任何时候重跑都必须得到同一分数——这是“按申请重放”的前提。
 * 调参只能发布新版本，不得覆盖旧版本。
 */
const MODELS = {
  'cc-score-1.0.0': {
    modelVersion: 'cc-score-1.0.0',
    score(input) {
      let score = 100;
      const fin = input.financialSummary ?? {};
      if (typeof fin.debtToAssetRatio === 'number') {
        if (fin.debtToAssetRatio > 0.8) score -= 40;
        else if (fin.debtToAssetRatio > 0.7) score -= 25;
      }
      if (typeof fin.netProfit === 'number' && fin.netProfit < 0) score -= 20;
      for (const v of input.manualVerifications ?? []) {
        if (v.result === 'FAIL') score -= 10;
      }
      for (const s of input.externalSignals ?? []) {
        if (s.severity === 'CRITICAL') score -= 35;
        else if (s.severity === 'HIGH') score -= 25;
        else if (s.severity === 'MEDIUM') score -= 10;
      }
      return Math.max(0, Math.min(100, score));
    },
    bucketFor(score) {
      if (score < 50) return 'REJECT';
      if (score < 70) return 'MANUAL_REVIEW';
      return 'APPROVE';
    },
  },
};

export function getModel(modelVersion) {
  const model = MODELS[modelVersion];
  if (!model) {
    const err = new Error(`未知模型版本: ${modelVersion}`);
    err.code = 'UNKNOWN_MODEL_VERSION';
    throw err;
  }
  return model;
}

export const DEFAULT_MODEL_VERSION = 'cc-score-1.0.0';
export const KNOWN_MODEL_VERSIONS = Object.freeze(Object.keys(MODELS));

/** 计算模型输入快照哈希；预警与评分都锚定这个哈希。 */
export function hashModelInput(modelVersion, input) {
  return sha256(stableStringify({ modelVersion, input }));
}

export function runModel(modelVersion, input) {
  const model = getModel(modelVersion);
  const score = model.score(input);
  return { modelVersion, score, bucket: model.bucketFor(score) };
}
