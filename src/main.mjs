import { createServer } from 'node:http';
import path from 'node:path';
import { EventStore } from './infra/event-store.mjs';
import { SnapshotStore } from './infra/snapshot-store.mjs';
import { CreditApplicationService, createAnalysisRunner } from './application/service.mjs';
import { createHttpApp } from './application/http-app.mjs';

/**
 * 组合根：装配事件存储、快照库、确定性分析器与 HTTP 适配层。
 * 数据目录由 DATA_DIR 指定（默认 ./.data），事件与快照均为普通文件，
 * 服务重启后通过重放事件流完整恢复。
 */
export async function createApp({ dataDir = process.env.DATA_DIR || path.resolve('./.data') } = {}) {
  const eventStore = new EventStore({ dir: dataDir });
  const snapshotStore = new SnapshotStore({ dir: dataDir });
  await eventStore.init();
  await snapshotStore.init();

  const analysisRunner = createAnalysisRunner({ snapshotStore });
  const service = new CreditApplicationService({
    eventStore,
    snapshotStore,
    analysisRunner,
  });

  const app = createHttpApp({
    service,
    snapshotStore,
    callbackToken: process.env.CALLBACK_TOKEN || null,
  });
  return { app, service, eventStore, snapshotStore };
}

export async function startServer({ port = Number(process.env.PORT) || 3000 } = {}) {
  const { app } = await createApp();
  const server = createServer(app);
  await new Promise((resolve) => server.listen(port, resolve));
  return server;
}

// 直接运行时启动；被测试 import 时不自动监听。
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT) || 3000;
  startServer({ port }).then(() => {
    console.log(`智能授信证据台已启动: http://localhost:${port}`);
  });
}
