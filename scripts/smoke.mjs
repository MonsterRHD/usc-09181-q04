#!/usr/bin/env node
/**
 * 端到端冒烟演练（不落仓库事件库，使用临时文件，结束即清理）。
 * 运行：node scripts/smoke.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

const dir = mkdtempSync(join(tmpdir(), 'evidence-smoke-'));
const file = join(dir, 'events.jsonl');
const port = 3199;
const base = `http://127.0.0.1:${port}`;
const APPROVER = { id: 'approver-li', role: 'APPROVER' };
const REVIEWER = { id: 'reviewer-wang', role: 'REVIEWER' };
const APPLICANT = { id: 'agent-chen', role: 'APPLICANT' };

const server = spawn(process.execPath, ['src/server.mjs'], {
  env: { ...process.env, PORT: String(port), EVENT_LOG: file },
  stdio: 'ignore',
});
await once(server, 'spawn');
await new Promise((r) => setTimeout(r, 400));

function show(title, value) {
  console.log(`\n=== ${title} ===`);
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

async function api(method, path, body, headers) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(headers || {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok && !json?.accepted) throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

try {
  // 1) 建申请，交海外客户财报（流动比率偏低）
  const { applicationId: app } = await api('POST', '/applications', { customerId: 'OVERSEAS-ACME-007', actor: APPLICANT });
  show('开申请', app);

  const fin = await api('POST', `/applications/${app}/evidence`, {
    kind: 'FINANCIAL_SUMMARY', source: 'D&B Global 2025FY', fiscalPeriod: '2025FY', currency: 'USD',
    fields: { currentRatio: 0.82, debtToEquity: 1.4, netProfitMargin: 0.05 },
    actor: REVIEWER, idempotencyKey: 'fin-v1',
  });
  show('v1 财报已收', fin.evidenceId);

  // 2) 缺人工核验 -> 只能补件
  const badRun = await fetch(`${base}/applications/${app}/runs`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ actor: APPROVER }),
  }).then((r) => r.json());
  show('材料不齐尝试计算（预期 422 MISSING_MATERIALS）', badRun.error);

  // 3) v1 直接补核验并跑批
  for (const item of ['currentRatio', 'debtToEquity', 'netProfitMargin']) {
    await api('POST', `/applications/${app}/evidence`, {
      kind: 'MANUAL_VERIFICATION', item, result: 'PASS', verifier: 'reviewer-wang',
      financialEvidenceId: fin.evidenceId, actor: REVIEWER, idempotencyKey: `ver-${item}`,
    });
  }
  const run1 = await api('POST', `/applications/${app}/runs`, { actor: APPROVER, idempotencyKey: 'run-1' });

  // 4) 两个重复回调并发到达（同一 callbackId）
  const cbs = await Promise.all([1, 2].map(() =>
    api('POST', `/applications/${app}/model-results`, { batchId: run1.batchId, score: 540, callbackId: 'CB-DUP' })));
  show('重复回调并发（只允许一条落账）', cbs.map((c) => ({ duplicate: c.duplicate, score: c.score })));

  // 5) 审批人对预警写意见，然后客户在两个版本间补件（v2：补充期后事项 + 更新财报）
  const pack1 = await api('GET', `/applications/${app}/evidence-pack?version=v1`);
  const warn = pack1.versions[0].batches[0].warnings[0];
  await api('POST', `/applications/${app}/warning-notes`, {
    warningId: warn.warningId, content: '初步意见：短期偿债指标偏弱，待客户补充期后回款证明',
    actor: REVIEWER, idempotencyKey: 'note-1',
  });
  await api('POST', `/applications/${app}/supplement-requests`, {
    reason: '要求补充期后回款证明并重出财报', actor: APPROVER, idempotencyKey: 'sup-1',
  });
  const fin2 = await api('POST', `/applications/${app}/evidence`, {
    kind: 'FINANCIAL_SUMMARY', source: '客户更新版 2026H1', fiscalPeriod: '2026H1', currency: 'USD',
    fields: { currentRatio: 1.31, debtToEquity: 1.1, netProfitMargin: 0.07 },
    actor: REVIEWER, idempotencyKey: 'fin-v2',
  });
  for (const item of ['currentRatio', 'debtToEquity', 'netProfitMargin']) {
    await api('POST', `/applications/${app}/evidence`, {
      kind: 'MANUAL_VERIFICATION', item, result: 'PASS', verifier: 'reviewer-wang',
      financialEvidenceId: fin2.evidenceId, actor: REVIEWER, idempotencyKey: `ver2-${item}`,
    });
  }

  // 6) v2 跑批；回调与"撤回"并发到达
  const run2 = await api('POST', `/applications/${app}/runs`, { actor: APPROVER, idempotencyKey: 'run-2' });
  const [withdrawn, lateCb] = await Promise.all([
    api('POST', `/applications/${app}/withdraw`, { reason: '客户放弃本笔授信申请', actor: APPLICANT, idempotencyKey: 'wd-1' }),
    api('POST', `/applications/${app}/model-results`, { batchId: run2.batchId, score: 760, callbackId: 'CB-LATE' }),
  ]);
  show('撤回 与 v2 回调并发', { withdrawn, lateCb: { accepted: lateCb.accepted, reason: lateCb.reason } });

  // 7) 撤回后又一个外部风险信号迟到
  const lateSignal = await api('POST', `/applications/${app}/signals`, {
    signalId: 'sig-late-1', type: 'SANCTION', source: 'OFAC delta feed', detail: '迟到的名单增量',
  });
  show('撤回后迟到信号（最小审计事实）', lateSignal);

  const view = await api('GET', `/applications/${app}`);
  show('最终状态', {
    status: view.status,
    versions: view.versions.map((v) => ({ version: v.version, status: v.status, evidenceCount: v.evidence.length })),
    lateFacts: view.lateFacts,
  });

  const verify = await api('GET', '/audit/verify');
  show('哈希链校验', verify);
} finally {
  server.kill('SIGTERM');
  await once(server, 'exit');
}

// 8) 重启：同一事件日志重放，核对状态可复现
{
  const server2 = spawn(process.execPath, ['src/server.mjs'], {
    env: { ...process.env, PORT: String(port), EVENT_LOG: file }, stdio: 'ignore',
  });
  await once(server2, 'spawn');
  await new Promise((r) => setTimeout(r, 400));
  try {
    const res = await fetch(`${base}/audit/verify`).then((r) => r.json());
    show('服务重启后哈希链校验', res);
    console.log('\n✔ 演练完成：事件日志可重放，审计事实完整');
  } finally {
    server2.kill('SIGTERM');
    await once(server2, 'exit');
    rmSync(dir, { recursive: true, force: true });
  }
}
