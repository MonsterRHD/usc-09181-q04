import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { createApp } from '../src/main.mjs';

const ANALYST_HEADERS = { 'x-user-id': 'ana', 'x-user-roles': 'ANALYST' };
const APPROVER_HEADERS = { 'x-user-id': 'app', 'x-user-roles': 'APPROVER' };

async function startHarness() {
  const dir = await mkdtemp(path.join(tmpdir(), 'http-'));
  const { app } = await createApp({ dataDir: dir });
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const stop = () => new Promise((resolve) => server.close(resolve));
  return { base, stop };
}

async function jsonFetch(base, pathname, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

async function seed(base, id) {
  await jsonFetch(base, '/applications', {
    method: 'POST',
    headers: ANALYST_HEADERS,
    body: { applicationId: id, customerId: 'C1' },
  });
  await jsonFetch(base, `/applications/${id}/materials`, {
    method: 'POST',
    headers: ANALYST_HEADERS,
    body: { materialType: 'FINANCIAL_REPORT', content: { debtToAssetRatio: 0.91, netProfit: -5 } },
  });
  await jsonFetch(base, `/applications/${id}/materials`, {
    method: 'POST',
    headers: ANALYST_HEADERS,
    body: { materialType: 'MANUAL_VERIFICATION', content: { item: '背景核验', result: 'FAIL' } },
  });
}

test('健康检查', async () => {
  const { base, stop } = await startHarness();
  try {
    const { status, data } = await jsonFetch(base, '/health');
    assert.equal(status, 200);
    assert.equal(data.status, 'ok');
  } finally {
    await stop();
  }
});

test('端到端：开案→证据→分析（预警带来源）→意见→审批确认→重放', async () => {
  const { base, stop } = await startHarness();
  try {
    const id = 'HTTP-E2E-1';
    await seed(base, id);

    const ana = await jsonFetch(base, `/applications/${id}/analyses`, {
      method: 'POST',
      headers: ANALYST_HEADERS,
      body: {},
    });
    assert.equal(ana.status, 201);
    assert.ok(ana.data.analysisId);

    const pkg1 = await jsonFetch(base, `/applications/${id}`);
    assert.equal(pkg1.status, 200);
    const warning = pkg1.data.versions[0].analyses[0].warnings[0];
    assert.ok(warning.ruleVersion);
    assert.ok(warning.snapshotHash);
    assert.ok(warning.snapshotAvailable);

    const op = await jsonFetch(base, `/applications/${id}/opinions`, {
      method: 'POST',
      headers: ANALYST_HEADERS,
      body: { decision: 'REJECT', rationale: '双红灯' },
    });
    assert.equal(op.status, 201);

    // 分析员无权确认
    const bad = await jsonFetch(base, `/applications/${id}/confirmation`, {
      method: 'POST',
      headers: ANALYST_HEADERS,
      body: {},
    });
    assert.equal(bad.status, 403);

    const conf = await jsonFetch(base, `/applications/${id}/confirmation`, {
      method: 'POST',
      headers: APPROVER_HEADERS,
      body: {},
    });
    assert.equal(conf.status, 201);
    assert.equal(conf.data.decision, 'REJECT');

    const replay = await jsonFetch(base, `/applications/${id}/replay`);
    assert.equal(replay.status, 200);
    assert.equal(replay.data.decisionExplanation.decision, 'REJECT');
    assert.ok(replay.data.decisionExplanation.basedOn.snapshotInput);
    assert.equal(replay.data.decisionExplanation.basedOn.warnings.length >= 3, true);

    const events = await jsonFetch(base, `/applications/${id}/events`);
    assert.equal(events.status, 200);
    assert.ok(events.data.events.every((e) => e.hash && e.prevHash !== undefined));
  } finally {
    await stop();
  }
});

test('缺关键材料时分析返回 422，随后可发起补件并在新版本补件', async () => {
  const { base, stop } = await startHarness();
  try {
    const id = 'HTTP-SUP-1';
    await jsonFetch(base, '/applications', {
      method: 'POST',
      headers: ANALYST_HEADERS,
      body: { applicationId: id, customerId: 'C1' },
    });
    const ana = await jsonFetch(base, `/applications/${id}/analyses`, {
      method: 'POST',
      headers: ANALYST_HEADERS,
      body: {},
    });
    assert.equal(ana.status, 422);
    assert.equal(ana.data.code, 'MISSING_REQUIRED_MATERIALS');
    assert.deepEqual(ana.data.details.missing, ['FINANCIAL_REPORT', 'MANUAL_VERIFICATION']);

    const sup = await jsonFetch(base, `/applications/${id}/supplement-requests`, {
      method: 'POST',
      headers: ANALYST_HEADERS,
      body: { requiredItems: ['财报', '核验'] },
    });
    assert.equal(sup.status, 201);
    assert.ok(sup.data.newVersionId);
    assert.equal(sup.data.carriedMaterials, 0);
  } finally {
    await stop();
  }
});

test('外部信号重复回调幂等；撤回后到达只记审计事实', async () => {
  const { base, stop } = await startHarness();
  try {
    const id = 'HTTP-EXT-1';
    await seed(base, id);

    const signal = {
      dedupeKey: 'DOWJONES|20260918|001',
      content: { source: 'DOWJONES', signalType: 'SANCTION_HIT', severity: 'CRITICAL', reference: 'r1' },
    };
    const first = await jsonFetch(base, `/applications/${id}/external-signals`, {
      method: 'POST',
      body: signal,
    });
    assert.equal(first.status, 200);
    assert.equal(first.data.accepted, true);
    assert.ok(first.data.autoAnalysisId, '关键材料齐全，自动分析');

    const second = await jsonFetch(base, `/applications/${id}/external-signals`, {
      method: 'POST',
      body: signal,
    });
    assert.equal(second.status, 200);
    assert.equal(second.data.deduped, true);
    assert.equal(second.data.accepted, false);
    assert.equal(second.data.revision, first.data.revision);

    // 撤回
    const wd = await jsonFetch(base, `/applications/${'HTTP-EXT-2'}/withdrawal`, {
      method: 'POST',
      headers: APPROVER_HEADERS,
      body: { reason: 'x' },
    });
    assert.equal(wd.status, 404, '申请不存在');

    const id2 = 'HTTP-EXT-2';
    await seed(base, id2);
    const withdrawn = await jsonFetch(base, `/applications/${id2}/withdrawal`, {
      method: 'POST',
      headers: APPROVER_HEADERS,
      body: { reason: '客户撤销' },
    });
    assert.equal(withdrawn.status, 201);

    const late = await jsonFetch(base, `/applications/${id2}/external-signals`, {
      method: 'POST',
      body: {
        dedupeKey: 'S|late',
        content: { source: 'S', signalType: 'LITIGATION', severity: 'HIGH' },
      },
    });
    assert.equal(late.status, 200);
    assert.equal(late.data.ignored, true);
    assert.equal(late.data.accepted, false);

    const pkg = await jsonFetch(base, `/applications/${id2}`);
    assert.equal(pkg.data.ignoredExternalSignals.length, 1);
    assert.equal(pkg.data.ignoredExternalSignals[0].reason, 'WITHDRAWN');
  } finally {
    await stop();
  }
});

test('未鉴权请求被拒绝', async () => {
  const { base, stop } = await startHarness();
  try {
    const r = await jsonFetch(base, '/applications', {
      method: 'POST',
      body: { applicationId: 'X', customerId: 'C' },
    });
    assert.equal(r.status, 401);
  } finally {
    await stop();
  }
});
