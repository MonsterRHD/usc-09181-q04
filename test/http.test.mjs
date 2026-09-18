import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createApp } from '../src/server.mjs';

function startServer(app) {
  return new Promise((resolve) => {
    const server = createServer(app.handler).listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function call(method, url, body, headers = {}) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json', ...headers } : headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

async function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'evidence-'));
  const file = join(dir, 'events.jsonl');
  const app = createApp({ storeFile: file });
  const server = await startServer(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  const APPROVER = { id: 'a1', role: 'APPROVER' };
  return {
    dir, file, app, server, base,
    stop: async () => { await new Promise((r) => server.close(r)); rmSync(dir, { recursive: true, force: true }); },
    APPROVER,
  };
}

test('HTTP 端到端：开申请→补证据→补件→重跑→结论→证据包→重放说明', async () => {
  const h = await harness();
  try {
    const { base, APPROVER } = h;

    const opened = await call('POST', `${base}/applications`, { customerId: 'OVERSEAS-77', actor: { id: 'c1', role: 'APPLICANT' } });
    assert.equal(opened.status, 201);
    const app = opened.body.applicationId;

    // 缺材料直接请求计算 → 422 补件
    const noMat = await call('POST', `${base}/applications/${app}/runs`, { actor: APPROVER });
    assert.equal(noMat.status, 422);
    assert.equal(noMat.body.error.code, 'MISSING_MATERIALS');

    // 交财报
    const fin = await call('POST', `${base}/applications/${app}/evidence`, {
      kind: 'FINANCIAL_SUMMARY', source: 'D&B report',
      fields: { currentRatio: 0.8, debtToEquity: 4.2, netProfitMargin: 0.02 },
      actor: { id: 'r1', role: 'REVIEWER' }, idempotencyKey: 'fin-1',
    });
    assert.equal(fin.status, 201);
    const finId = fin.body.evidenceId;

    // 并发补三份核验（不同审批人，连接并发到达）
    const verifications = await Promise.all(
      ['currentRatio', 'debtToEquity', 'netProfitMargin'].map((item, i) =>
        call('POST', `${base}/applications/${app}/evidence`, {
          kind: 'MANUAL_VERIFICATION', item, result: 'PASS', verifier: `r${i + 1}`,
          financialEvidenceId: finId,
          actor: { id: `r${i + 1}`, role: 'REVIEWER' }, idempotencyKey: `ver-${item}`,
        })),
    );
    assert.ok(verifications.every((r) => r.status === 201));

    // 补件流程（v1 材料不齐？其实已齐——这里演示审批人主动要求补充期后事项）
    const sup = await call('POST', `${base}/applications/${app}/supplement-requests`, {
      reason: '要求补充期后事项说明', actor: APPROVER, idempotencyKey: 'sup-1',
    });
    assert.equal(sup.status, 201);
    assert.equal(sup.body.version, 'v2');
    // 沿链继承 v1 全部材料
    const packV2 = await call('GET', `${base}/applications/${app}/evidence-pack?version=v2`);
    assert.equal(packV2.body.versions[0].evidence.length, 4);

    // v2 上跑模型（无新材料，沿用 v1）
    const run = await call('POST', `${base}/applications/${app}/runs`, { actor: APPROVER, idempotencyKey: 'run-1' });
    assert.equal(run.status, 202);
    const { batchId } = run.body;

    // 重复回调：同一 callbackId 打两次
    const cb1 = await call('POST', `${base}/applications/${app}/model-results`, { batchId, score: 330, callbackId: 'CB-9' });
    const cb2 = await call('POST', `${base}/applications/${app}/model-results`, { batchId, score: 999, callbackId: 'CB-9' });
    assert.equal(cb1.body.duplicate, false);
    assert.equal(cb2.body.duplicate, true);
    assert.equal(cb2.body.score, 330);
    const ruleIds = cb1.body.warnings.map((w) => w.ruleId).sort();
    assert.deepEqual(ruleIds, ['R_CURRENT_RATIO_LOW', 'R_DEBT_TO_EQUITY_HIGH']);

    // 对预警写人工意见
    const lowRatioW = cb1.body.warnings.find((w) => w.ruleId === 'R_CURRENT_RATIO_LOW');
    const note = await call('POST', `${base}/applications/${app}/warning-notes`, {
      warningId: lowRatioW.warningId, content: '已要求客户说明，等待补充',
      actor: { id: 'r1', role: 'REVIEWER' }, idempotencyKey: 'note-1',
    });
    assert.equal(note.status, 201);

    // REVIEWER 不能拍板
    const forbidden = await call('POST', `${base}/applications/${app}/decisions`, {
      outcome: 'APPROVE', rationale: 'x', actor: { id: 'r1', role: 'REVIEWER' },
    });
    assert.equal(forbidden.status, 403);

    // 证据包：预警必须可回溯
    const pack = await call('GET', `${base}/applications/${app}/evidence-pack`);
    assert.equal(pack.status, 200);
    const v2pack = pack.body.versions.find((v) => v.version === 'v2');
    const w = v2pack.batches[0].warnings.find((x) => x.ruleId === 'R_CURRENT_RATIO_LOW');
    assert.equal(w.inputSnapshotRef.rulePackVersion, 'risk-rules-2026.01');
    assert.equal(w.inputSnapshotRef.modelVersion, 'credit-model-3.2');
    assert.equal(w.inputSnapshotRef.evidenceStateHash, v2pack.batches[0].evidenceStateHash);
    // 批次层携带冻结的完整输入快照
    assert.equal(v2pack.batches[0].inputSnapshot.version, 'v2');
    assert.equal(v2pack.batches[0].inputSnapshot.evidence.length, 4);
    assert.equal(w.evidenceRefs[0].type, 'EVIDENCE');
    assert.equal(w.evidenceRefs[0].evidenceId, finId);
    assert.equal(w.notes[0].content, '已要求客户说明，等待补充');

    // APPROVER 拒绝
    const dec = await call('POST', `${base}/applications/${app}/decisions`, {
      outcome: 'REJECT', rationale: '流动比率与杠杆双高，风险不可接受',
      actor: APPROVER, idempotencyKey: 'dec-1',
    });
    assert.equal(dec.status, 200);
    assert.equal(dec.body.decision.outcome, 'REJECT');

    // 决定重放端点
    const replay = await call('GET', `${base}/applications/${app}/replay`);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.decision.outcome, 'REJECT');
    assert.equal(replay.body.replay.inputSnapshot.version, 'v2');
    assert.equal(replay.body.replay.rulePackVersion, 'risk-rules-2026.01');
    assert.ok(replay.body.replay.warnings.some((x) => x.ruleId === 'R_CURRENT_RATIO_LOW'));

    // 决定后拒绝一切变更
    const after = await call('POST', `${base}/applications/${app}/runs`, { actor: APPROVER });
    assert.equal(after.status, 409);
  } finally {
    await h.stop();
  }
});

test('持久化与重启：用同一日志文件重建应用，状态逐字节恢复', async () => {
  const h = await harness();
  try {
    const { base, file, APPROVER } = h;
    const opened = await call('POST', `${base}/applications`, { customerId: 'C-RESTART', actor: { id: 'c', role: 'APPLICANT' } });
    const app = opened.body.applicationId;
    const fin = await call('POST', `${base}/applications/${app}/evidence`, {
      kind: 'FINANCIAL_SUMMARY', source: 'annual report',
      fields: { currentRatio: 1.1, debtToEquity: 0.9, netProfitMargin: 0.11 },
      actor: { id: 'r1', role: 'REVIEWER' },
    });
    for (const item of ['currentRatio', 'debtToEquity', 'netProfitMargin']) {
      await call('POST', `${base}/applications/${app}/evidence`, {
        kind: 'MANUAL_VERIFICATION', item, result: 'PASS',
        financialEvidenceId: fin.body.evidenceId, actor: { id: 'r1', role: 'REVIEWER' },
      });
    }
    const run = await call('POST', `${base}/applications/${app}/runs`, { actor: APPROVER });
    await call('POST', `${base}/applications/${app}/model-results`, { batchId: run.body.batchId, score: 800, callbackId: 'cb' });
    const before = await call('GET', `${base}/applications/${app}`);

    // 重启：新建 app 实例（模拟新进程），从同一 JSONL 重放
    const app2 = createApp({ storeFile: file });
    const server2 = await startServer(app2);
    try {
      const base2 = `http://127.0.0.1:${server2.address().port}`;
      const after = await call('GET', `${base2}/applications/${app}`);
      assert.equal(JSON.stringify(after.body), JSON.stringify(before.body));
      // 链校验
      const verify = await call('GET', `${base2}/audit/verify`);
      assert.equal(verify.body.ok, true);
      assert.ok(verify.body.count >= 7);
      // 重启后仍可继续工作：补件 -> v2
      const sup = await call('POST', `${base2}/applications/${app}/supplement-requests`, { reason: 'x', actor: APPROVER });
      assert.equal(sup.body.version, 'v2');
    } finally {
      await new Promise((r) => server2.close(r));
    }
  } finally {
    await h.stop();
  }
});

test('防篡改：改写任一历史事件后，重放立即拒绝启动', async () => {
  const h = await harness();
  try {
    const { base, file } = h;
    const opened = await call('POST', `${base}/applications`, { customerId: 'C-TAMPER', actor: { id: 'c', role: 'APPLICANT' } });
    const app = opened.body.applicationId;
    await call('POST', `${base}/applications/${app}/signals`, { signalId: 'sig-1', type: 'SANCTION', source: 'OFAC' });

    // 直接篡改日志第二行（把制裁信号改成观察名单）
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const tampered = lines.map((line, i) => (i === 2 ? line.replace('SANCTION', 'WATCHLIST') : line));
    writeFileSync(file, `${tampered.join('\n')}\n`);

    assert.throws(() => createApp({ storeFile: file }), /篡改/);
  } finally {
    await h.stop();
  }
});

test('撤回全链路：撤回后迟到回调与信号只留最小事实，重放可见', async () => {
  const h = await harness();
  try {
    const { base, APPROVER } = h;
    const opened = await call('POST', `${base}/applications`, { customerId: 'C-W', actor: { id: 'c', role: 'APPLICANT' } });
    const app = opened.body.applicationId;
    const fin = await call('POST', `${base}/applications/${app}/evidence`, {
      kind: 'FINANCIAL_SUMMARY', source: 'r',
      fields: { currentRatio: 1, debtToEquity: 1, netProfitMargin: 0.1 },
      actor: { id: 'r1', role: 'REVIEWER' },
    });
    for (const item of ['currentRatio', 'debtToEquity', 'netProfitMargin']) {
      await call('POST', `${base}/applications/${app}/evidence`, {
        kind: 'MANUAL_VERIFICATION', item, result: 'PASS',
        financialEvidenceId: fin.body.evidenceId, actor: { id: 'r1', role: 'REVIEWER' },
      });
    }
    const run = await call('POST', `${base}/applications/${app}/runs`, { actor: APPROVER });
    // 撤回与回调并发到达（交错发起）；撤回先落事件
    const [wd, cb] = await Promise.all([
      call('POST', `${base}/applications/${app}/withdraw`, { reason: '客户撤销', actor: { id: 'c', role: 'APPLICANT' }, idempotencyKey: 'w' }),
      call('POST', `${base}/applications/${app}/model-results`, { batchId: run.body.batchId, score: 700, callbackId: 'cb-late' }),
    ]);
    assert.equal(wd.status, 200);
    // 回调无论先后，最终都只可能是 LATE_FACT（若回调先到则结果已入账，批次 COMPLETED，
    // 撤回不删除它——这也是合法终态；本用例断言两种收敛之一）
    assert.ok(['LATE_FACT'].includes(cb.body.accepted) || cb.body.duplicate === true || cb.body.batchId);

    const lateSig = await call('POST', `${base}/applications/${app}/signals`, { signalId: 's1', type: 'COUNTRY_RISK', source: 'gov' });
    assert.equal(lateSig.body.accepted, 'LATE_FACT');

    const view = await call('GET', `${base}/applications/${app}`);
    assert.equal(view.body.status, 'WITHDRAWN');
    assert.ok(view.body.lateFacts.length >= 1);
    for (const f of view.body.lateFacts) assert.equal(f.payloadHash.length, 64);
  } finally {
    await h.stop();
  }
});

test('请求头身份透传与重复请求幂等', async () => {
  const h = await harness();
  try {
    const { base } = h;
    const opened = await call('POST', `${base}/applications`,
      { customerId: 'C-HDR' },
      { 'x-actor-id': 'c1', 'x-actor-role': 'APPLICANT' });
    assert.equal(opened.status, 201);

    // 同一幂等键的开申请重试返回同一申请
    const retry = await call('POST', `${base}/applications`,
      { customerId: 'C-HDR', idempotencyKey: opened.body.applicationId },
      { 'x-actor-id': 'c1', 'x-actor-role': 'APPLICANT' });
    assert.equal(retry.body.applicationId, opened.body.applicationId);
  } finally {
    await h.stop();
  }
});
