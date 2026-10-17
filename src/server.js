import { config } from './config.js';
import { createApp } from './app.js';

const app = createApp();
const address = await app.listen(config.port, config.host);
const port = typeof address === 'object' && address ? address.port : config.port;

console.log(`运动场馆易约后端已启动: http://localhost:${port}`);
console.log(`演示页面: http://localhost:${port}/   (管理员账号 admin@yueqiu.local / admin123456)`);
console.log(`数据库文件: ${config.dbPath}`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    console.log('\n正在关闭服务...');
    await app.close();
    process.exit(0);
  });
}
