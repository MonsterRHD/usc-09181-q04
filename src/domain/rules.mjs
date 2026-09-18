/**
 * 版本化风险规则引擎。
 *
 * 预警（warning）永远是「规则版本 × 模型版本 × 输入快照」的确定性产物：
 *   - rulePackVersion 固定使用的规则集；
 *   - evaluate 对同一输入快照必须产出同一结果（纯函数，禁止读时钟/外部状态）；
 *   - 迟到的外部信号不会回溯改动历史批次，只会在重跑时进入新批次。
 */

export const MODEL_VERSIONS = new Set(['credit-model-3.1', 'credit-model-3.2']);
export const DEFAULT_MODEL_VERSION = 'credit-model-3.2';

/** 财报中需要被人工核验覆盖的字段。 */
export const VERIFIABLE_FIELDS = ['currentRatio', 'debtToEquity', 'netProfitMargin'];

/** 申请进入审批前必须具备的材料类别。外部风险信号不在其列（异步、可能迟到）。 */
export const REQUIRED_MATERIAL_KINDS = ['FINANCIAL_SUMMARY', 'MANUAL_VERIFICATION'];

const RULE_PACKS = {
  'risk-rules-2026.01': {
    releasedAt: '2026-01-15',
    rules: [
      {
        id: 'R_CURRENT_RATIO_LOW',
        severity: 'HIGH',
        description: '流动比率低于 1.0，短期偿债能力不足',
        evaluate(ctx) {
          const v = ctx.financial?.fields?.currentRatio;
          if (typeof v === 'number' && v < 1) {
            return {
              detail: `流动比率 ${v} < 1.0`,
              evidenceRefs: [ctx.financial.evidenceId],
            };
          }
          return null;
        },
      },
      {
        id: 'R_DEBT_TO_EQUITY_HIGH',
        severity: 'MEDIUM',
        description: '资产负债结构激进（产权比率高于 3）',
        evaluate(ctx) {
          const v = ctx.financial?.fields?.debtToEquity;
          if (typeof v === 'number' && v > 3) {
            return {
              detail: `产权比率 ${v} > 3`,
              evidenceRefs: [ctx.financial.evidenceId],
            };
          }
          return null;
        },
      },
      {
        id: 'R_UNVERIFIED_FINANCIALS',
        severity: 'MEDIUM',
        description: '财报关键字段缺少通过的人工核验',
        evaluate(ctx) {
          if (!ctx.financial) return null;
          const passed = new Set(
            ctx.verifications.filter((x) => x.result === 'PASS').map((x) => x.item),
          );
          const present = VERIFIABLE_FIELDS.filter(
            (f) => typeof ctx.financial.fields?.[f] === 'number',
          );
          const missing = present.filter((f) => !passed.has(f));
          if (missing.length === 0) return null;
          return {
            detail: `以下字段尚无 PASS 人工核验：${missing.join('、')}`,
            evidenceRefs: [
              ctx.financial.evidenceId,
              ...ctx.verifications.map((x) => x.evidenceId),
            ],
            missingFields: missing,
          };
        },
      },
      {
        id: 'R_SANCTION_MATCH',
        severity: 'CRITICAL',
        description: '外部信号命中制裁名单',
        evaluate(ctx) {
          const hit = ctx.signals.find((s) => String(s.type).toUpperCase() === 'SANCTION');
          if (!hit) return null;
          return {
            detail: `外部来源 ${hit.source} 于 ${hit.observedAt || '未知时间'} 提示制裁命中`,
            evidenceRefs: [`signal:${hit.signalId}`],
            signalId: hit.signalId,
          };
        },
      },
      {
        id: 'R_WATCHLIST_HIT',
        severity: 'HIGH',
        description: '外部信号命中观察名单',
        evaluate(ctx) {
          const hit = ctx.signals.find((s) => String(s.type).toUpperCase() === 'WATCHLIST');
          if (!hit) return null;
          return {
            detail: `外部来源 ${hit.source} 于 ${hit.observedAt || '未知时间'} 提示观察名单`,
            evidenceRefs: [`signal:${hit.signalId}`],
            signalId: hit.signalId,
          };
        },
      },
    ],
  },
};

export function knownRulePack(version) {
  return Boolean(RULE_PACKS[version]);
}

export function assertRulePack(version) {
  if (!RULE_PACKS[version]) {
    const err = new Error(`未知规则包版本：${version}`);
    err.code = 'UNKNOWN_RULE_PACK';
    throw err;
  }
}

/**
 * 对某一版本的证据快照执行规则。
 * @returns {{ warningId, ruleId, severity, ruleVersion, detail, evidenceRefs, extra }[]}
 * warningId 只在批次内唯一（batchId 由调用方拼入），重跑得到新批次，
 * 历史预警及其上的人工意见因此不会被覆盖。
 */
export function evaluateRulePack(rulePackVersion, batchId, ctx) {
  assertRulePack(rulePackVersion);
  const warnings = [];
  for (const rule of RULE_PACKS[rulePackVersion].rules) {
    const hit = rule.evaluate(ctx);
    if (hit) {
      warnings.push({
        warningId: `${batchId}:${rule.id}`,
        ruleId: rule.id,
        severity: rule.severity,
        rulePackVersion,
        detail: hit.detail,
        evidenceRefs: hit.evidenceRefs ?? [],
        ...(hit.signalId ? { signalId: hit.signalId } : {}),
        ...(hit.missingFields ? { missingFields: hit.missingFields } : {}),
      });
    }
  }
  return warnings;
}

export function listRulePacks() {
  return Object.fromEntries(
    Object.entries(RULE_PACKS).map(([version, pack]) => [
      version,
      {
        releasedAt: pack.releasedAt,
        rules: pack.rules.map((r) => ({ id: r.id, severity: r.severity, description: r.description })),
      },
    ]),
  );
}
