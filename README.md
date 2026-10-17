# 运动场馆易约 · 后端 API

按 PRD《运动场馆易约》实现的可用版后端：**零第三方依赖**（Node 内置 `http` + `node:sqlite`），
开箱即跑，不需要 Redis / PostgreSQL / npm install。

## 快速开始

```bash
cd sports-booking-backend
node src/server.js        # 或 npm start
```

打开 http://localhost:3000/ 就是自带的接口演示页（选场馆 → 点时段 → 锁定 → 确认预约 → 我的预约 → 管理员后台）。

内置账号：

| 角色 | 账号 | 密码 |
| --- | --- | --- |
| 管理员 | `admin@yueqiu.local` / `13900000001` | `admin123456` |
| 普通用户 | `13800000000` | `demo123456` |

跑一遍端到端自测（39+ 项断言，含并发抢占/冲突推荐/取消规则/后台报表/SSE 推送）：

```bash
npm test
```

环境变量（都可不填，见 `src/config.js`）：`PORT`、`HOST`、`DB_PATH`、`TOKEN_SECRET`、
`LOCK_MINUTES`（默认 10）、`CANCEL_HOURS`（默认 2）、`BOOKING_DAYS_AHEAD`（默认 30）、`HTTP_LOG=0`（关请求日志）。

## 目录结构

```
src/
  server.js        启动入口
  app.js           HTTP 服务、路由分发、静态页、SSE 接入
  config.js        配置
  db.js            SQLite 建表 + 预编译语句缓存
  seed.js          初始数据（5 场馆 / 16 场地 / 3 账号 / 示例预约）
  core.js          业务核心：可用性计算、锁定、预约、取消、通知、定时清扫
  events.js        SSE 实时广播
  auth.js          scrypt 密码 + HMAC 令牌 + 角色校验
  router.js        极简路由
  routes/          auth / venues / bookings / admin 四组接口
public/index.html 接口演示页
test/smoke.mjs    端到端冒烟测试
data/app.db       运行时生成的数据库文件
```

## 接口一览

所有接口以 `/api` 开头，鉴权用 `Authorization: Bearer <token>`，错误统一返回
`{ "error": { "status": 409, "message": "...", "suggestions": [...] } }`。

### 账户

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/auth/register` | 手机号/邮箱注册（`name`,`phone`或`email`,`password`） |
| POST | `/api/auth/login` | 登录，返回 token |
| GET | `/api/me` | 个人中心：积分、历史/有效预约数 |
| POST | `/api/me/verify` | 实名认证（`realName`,`idCard`） |
| GET | `/api/notifications` | 站内消息（`?unread=1` 只看未读） |
| POST | `/api/notifications/read` | 标记已读 |

### 场馆与实时查询（对应大型需求 1）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/sports` | 运动类型列表 |
| GET | `/api/venues?sport=&keyword=&date=` | 场馆列表 + 当前开放状态 + 可约段数/占用率 |
| GET | `/api/venues/:id?date=` | 场馆详情（场地、时段配置） |
| GET | `/api/venues/:id/availability?date=` | 时段轴：逐场地逐时段的 `available/locked/booked/maintenance/closed` |
| GET | `/api/availability?sport=&date=&startTime=&endTime=` | 按运动类型+日期+时间段筛选可用场地 |
| GET | `/api/stream?date=&venueId=` | SSE 实时推送（`slot.locked`/`slot.released`/`booking.created`/`booking.cancelled`/`slot.status`），前端无需手动刷新 |

### 预约与锁定（对应大型需求 2，先到先得）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/bookings/lock` | 锁定时段 10 分钟并返回 `lockId`、`expiresAt`、`remainSeconds` |
| POST | `/api/bookings` | 按 `lockId` 确认预约，生成预约码与二维码凭证，发送站内/邮件/短信（邮件短信为模拟输出） |
| GET | `/api/bookings/mine?status=&date=` | 我的预约 |
| GET | `/api/bookings/:id` | 预约详情 |
| POST | `/api/bookings/:id/cancel` | 取消预约（距开场 ≥ 2 小时才允许自助取消，取消后时段立即释放） |

时间段被人抢先时返回 `409`，并在 `error.suggestions` 给出相邻可约时段，`error.conflicts` 说明冲突原因。

### 场馆管理员后台（对应大型需求 3）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/admin/venues` | 新建场馆（名称、地址、运动类型、开放时间、时段长度） |
| PATCH | `/api/admin/venues/:id` | 修改场馆信息/营业状态 |
| POST | `/api/admin/venues/:id/courts` | 新增场地（名称、每小时价格） |
| PATCH | `/api/admin/courts/:id` | 修改场地价格/状态 |
| POST | `/api/admin/overrides` | 把时段标记为 `maintenance`（维护中）或 `closed`（临时关闭），并提示是否与已有预约冲突 |
| GET / DELETE | `/api/admin/overrides[/:id]` | 查看/撤销时段标记 |
| GET | `/api/admin/bookings?date=&status=` | 全站预约总览 |
| POST | `/api/admin/bookings/:id/cancel` | 强制取消预约并通知用户（自动 +2 积分补偿） |
| GET | `/api/admin/report?days=7&from=` | 未来 N 天报表：场馆/每日预约量、时段利用率、营收 |
| GET | `/api/admin/users?q=` | 用户查询 |

## 关键实现说明

- **先到先得不超卖**：一次锁定 = 「查冲突 + 写锁」在同一个同步事务里完成；Node 单线程 + SQLite 事务
  保证并发下只有一个请求能写入，其余返回 409。`locks.expires_at` 到期后由后台清扫任务（每 30 秒）回收并广播释放。
- **时段模型**：场馆配置开放时间与时段长度（默认 60 分钟），预约按「日期 + 起止分钟」存储，
  可用性 = 场馆时段格子 − 已确认预约 − 有效锁定 − 维护/关闭标记，优先级 `closed > maintenance > booked > locked`。
- **取消规则**：自助取消需距开场 ≥ 2 小时；管理员可随时强制取消（用户积分 +2 作为补偿）。
- **积分/信用分**：注册送 100 分，完成一次预约 +1，被场馆强制取消 +2。
- **实时性**：用 SSE（而非 WebSocket）+ 内存广播，省掉 Redis；多实例部署时把 `events.js`
  换成 Redis Pub/Sub 即可，业务代码不用改。
- **数据落盘**：`data/app.db`（SQLite，WAL 模式）。想换 PostgreSQL，只需替换 `db.js` 里的
  预编译语句层，`core.js` 之上的业务逻辑不受影响。

## 与 PRD 目标的对应

PRD 里「6 个月利用率 45%→75%、重复预约冲突率 < 0.1%」依赖线上数据。
本实现提供了度量手段：`GET /api/admin/report?days=7` 直接给出各场馆时段利用率与预约量；
冲突率可从锁定接口的 409 计数（日志中的 `POST /api/bookings/lock 409`）统计。

## 尚未做的（按需再加）

真实支付渠道对接、短信/邮件真实网关、实名认证三方校验、多实例 Redis 锁、前端 React 工程。
这些都不影响当前流程演示与联调。
