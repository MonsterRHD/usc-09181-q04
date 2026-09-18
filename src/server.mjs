import { startServer } from './main.mjs';

const port = Number(process.env.PORT) || 3000;
startServer({ port }).then(() => {
  console.log(`智能授信证据台已启动: http://localhost:${port}`);
});
