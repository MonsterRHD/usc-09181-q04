/**
 * 授信风险规则注册表。
 *
 * 铁律：规则发布即冻结。任何阈值或语义调整都必须以新 ruleVersion 发布，
 * 旧版本永久保留——历史预警要能按“当时的规则”重放，不得就地修改。
 */
export const MATERIAL_TYPES = Object.freeze({
  FINANCIAL_REPORT: 'FINANCIAL_REPORT', // 客户财报摘要
  MANUAL_VERIFICATION: 'MANUAL_VERIFICATION', // 人工核验结果
  EXTERNAL_SIGNAL: 'EXTERNAL_SIGNAL', // 外部风险信号
});

const RULES = [
  {
    ruleId: 'FIN_LEVERAGE_001',
    ruleVersion: '1.0.0',
    severity: 'HIGH',
    message: '资产负债率超过 0.80，偿债压力偏高',
    evaluate({ input, materialIdsByType }) {
      const ratio = input.financialSummary?.debtToAssetRatio;
      if (typeof ratio !== 'number' || ratio <= 0.8) return null;
      return {
        evidence: { metric: 'debtToAssetRatio', value: ratio, operator: '>', threshold: 0.8 },
        evidenceMaterialIds: materialIdsByType.FINANCIAL_REPORT,
      };
    },
  },
  {
    ruleId: 'FIN_PROFIT_001',
    ruleVersion: '1.0.0',
    severity: 'MEDIUM',
    message: '近一期净利润为负',
    evaluate({ input, materialIdsByType }) {
      const profit = input.financialSummary?.netProfit;
      if (typeof profit !== 'number' || profit >= 0) return null;
      return {
        evidence: { metric: 'netProfit', value: profit, operator: '<', threshold: 0 },
        evidenceMaterialIds: materialIdsByType.FINANCIAL_REPORT,
      };
    },
  },
  {
    ruleId: 'MANUAL_VERIFY_001',
    ruleVersion: '1.0.0',
    severity: 'MEDIUM',
    message: '存在未通过的人工核验项',
    evaluate({ input }) {
      const failed = input.manualVerifications.filter((v) => v.result === 'FAIL');
      if (failed.length === 0) return null;
      return {
        evidence: { failedItems: failed.map((v) => ({ item: v.item, note: v.note ?? null })) },
        evidenceMaterialIds: failed.map((v) => v.__materialId),
      };
    },
  },
  {
    ruleId: 'EXTERNAL_RISK_001',
    ruleVersion: '1.0.0',
    severity: 'HIGH',
    message: '外部来源出现高风险信号（制裁/黑名单/重大诉讼等）',
    evaluate({ input }) {
      const hit = input.externalSignals.filter(
        (s) => s.severity === 'HIGH' || s.severity === 'CRITICAL'
      );
      if (hit.length === 0) return null;
      return {
        evidence: {
          signals: hit.map((s) => ({
            source: s.source,
            signalType: s.signalType,
            severity: s.severity,
            reference: s.reference ?? null,
          })),
        },
        evidenceMaterialIds: hit.map((s) => s.__materialId),
      };
    },
  },
  {
    ruleId: 'MODEL_POLICY_001',
    ruleVersion: '1.0.0',
    severity: 'HIGH',
    message: '模型评级落在 REJECT 区间',
    evaluate({ model }) {
      if (!model || model.bucket !== 'REJECT') return null;
      return {
        evidence: {
          modelVersion: model.modelVersion,
          score: model.score,
          bucket: model.bucket,
          policy: 'score < 50 => REJECT',
        },
        evidenceMaterialIds: [],
      };
    },
  },
];

/**
 * 对一份已封存输入求值。返回的每条预警都带有规则版本，
 * 证据快照哈希由调用方（聚合）补齐，规则本身不接触快照存储。
 *
 * input 结构由聚合从材料快照统一构建：
 *   financialSummary、manualVerifications[*].__materialId、
 *   externalSignals[*].__materialId、__financialMaterialIds
 */
export function evaluateRules({ input, model }) {
  const materialIdsByType = {
    FINANCIAL_REPORT: input.__financialMaterialIds ?? [],
  };

  const warnings = [];
  for (const rule of RULES) {
    const outcome = rule.evaluate({ input, model, materialIdsByType });
    if (outcome) {
      warnings.push({
        ruleId: rule.ruleId,
        ruleVersion: rule.ruleVersion,
        severity: rule.severity,
        message: rule.message,
        evidence: outcome.evidence,
        evidenceMaterialIds: outcome.evidenceMaterialIds ?? [],
      });
    }
  }
  return warnings;
}

export const RULE_REGISTRY_VERSION = Object.freeze(
  Object.fromEntries(RULES.map((r) => [`${r.ruleId}@${r.ruleVersion}`, r]))
);
