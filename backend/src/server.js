import { config } from './config.js';
import { createApp } from './app.js';

const app = createApp();
const address = await app.listen(config.port, config.host);
const port = typeof address === 'object' && address ? address.port : config.port;

console.log(`运动场馆易约 v2 已启动: http://localhost:${port}`);
console.log(`前端界面: http://localhost:${port}/`);
console.log(`API 基地址: http://localhost:${port}/api`);
console.log(`公用模块: http://localhost:${port}/shared/`);
console.log(`数据库文件: ${config.dbPath}`);
console.log(`管理员账号: admin@yueqiu.local / admin123456    演示用户: 13800000000 / demo123456`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    console.log('\n正在关闭服务...');
    await app.close();
    process.exit(0);
  });
}
