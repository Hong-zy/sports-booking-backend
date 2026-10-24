# 运动场馆易约 · 前后端分离版（v2）

按 PRD《运动场馆易约》实现的可用版系统，**零第三方依赖**（Node 内置 `http` + `node:sqlite`），
开箱即跑，不需要 Redis / PostgreSQL / `npm install`。

v3 相比 v2 的变化：新增 **AI 能力**（对话式预约助手 + AI 经营分析，支持大模型与本地规则双模式）。`n`nv2 相比 v1 的三点变化：

1. **代码拆成三块**：`frontend/`（原生 JS 单页应用）、`backend/`（HTTP + 业务 + SQLite）、`shared/`（前后端公用常量、时间工具、表单校验）；
2. **数据库可编辑**：管理后台可以对场馆、场地、时段标记、预约、用户做增删改，并带「数据库」页直接查看表结构与数据；
3. **前端是完整界面**：场馆预约、我的预约、消息、个人中心、管理后台五个页面，支持实时刷新。

## 快速开始

```bash
cd sports-booking-backend
node backend/src/server.js      # 或 npm start
```

打开 http://localhost:3000/ 就是完整前端界面（无需构建、无需安装依赖）。

Windows 下也可以直接**双击 `1-启动服务.bat`**，脚本会启动服务并自动打开浏览器。

内置账号：

| 角色 | 账号 | 密码 |
| --- | --- | --- |
| 管理员 | `admin@yueqiu.local`（或 `13900000001`） | `admin123456` |
| 普通用户 | `13800000000` | `demo123456` |
| 普通用户 | `13800000002` | `user123456` |

跑一遍端到端自测（`npm test`，或双击 `2-运行自测.bat`）：覆盖账号、场馆查询、先到先得锁定、
并发不超卖、取消规则、SSE 推送、后台 CRUD、数据库浏览、前端静态资源、AI 意图解析/推荐/经营分析等 97 项断言。

## 作业验收

本项目的作业说明（git 配置、同步记录、验收方式）见 **[作业说明.md](作业说明.md)**。

## 部署上线（变成公网网站）

仓库已内置 `Dockerfile`、`.dockerignore` 和 `render.yaml`，可直接部署到 Render / Railway / Zeabur / Koyeb
等支持 Docker 的平台，或用自备服务器跑 Docker。完整步骤见 **[DEPLOY-部署上线.md](DEPLOY-部署上线.md)**。

要点：平台会自动注入 `PORT`；免费版文件系统是临时的（重启后数据库重置为演示数据）；
保持单实例运行（SQLite 不支持多实例并发写）；上线后请立刻修改默认管理员密码。


## 目录结构

```
frontend/                  前端（原生 ESM 单页应用，无构建步骤）
  index.html               入口页面
  css/styles.css           样式
  js/api.js                fetch 封装 / 鉴权 / 错误处理 / SSE
  js/store.js              前端全局状态
  js/ui.js                 toast、modal、表格等通用组件
  js/router.js             hash 路由
  js/pages/user.js         场馆预约 / 我的预约 / 消息 / 个人中心
  js/pages/admin.js        管理后台（含数据库页）
  js/main.js               应用入口

backend/                   后端（Node 内置模块，零依赖）
  src/server.js            启动入口
  src/app.js               HTTP 服务、路由分发、静态资源、SSE 接入
  src/config.js            配置（目录约定 / 端口 / 数据库路径 / 业务参数）
  src/db.js                SQLite 建表 + 预编译语句缓存
  src/seed.js              初始数据（5 场馆 / 16 场地 / 3 账号 / 示例预约）
  src/core.js              业务核心：可用性计算、锁定、预约、取消、通知、定时清扫
  src/events.js            SSE 广播
  src/auth.js              scrypt 密码 + HMAC 令牌 + 角色校验
  src/http.js              统一响应 / 错误 / 请求体解析
  src/router.js            极简路由
  src/routes/              四组接口：auth / venues / bookings / admin
  test/smoke.mjs           端到端自测

shared/                    前后端公用模块（两边 import 同一份实现）
  constants.js             状态枚举、文案、业务默认值、数据库表白名单
  time.js                  分钟/时间字符串/日期/区间判断等纯函数
  validate.js              表单校验（注册、资料、场馆、场地、时段标记…）

data/                      运行时自动生成的 SQLite 数据库（.gitignore）
package.json               根配置与 npm 脚本
README.md / 提交说明.md / 使用说明.docx
```

## 前后端公用部分（shared/）

这是 v2 的结构重点：**同一份代码同时被前后端使用**，保证状态文案与校验规则永远一致。

| 模块 | 后端用法 | 前端用法 |
| --- | --- | --- |
| `constants.js` | 路由校验状态取值、数据库表白名单、默认业务参数 | 状态徽章文案、下拉选项、tab 路由表 |
| `time.js` | 时段对齐、日期比较、区间重叠判断 | 时段表渲染、倒计时、日期显示 |
| `validate.js` | `POST/PATCH` 接口入参校验（400 响应） | 表单即时校验，提交前就提示 |

引用方式：

```js
// 后端 backend/src/routes/admin.js
import { DB_TABLES } from '../../../shared/constants.js';
import { validateVenueInput } from '../../../shared/validate.js';

// 前端 frontend/js/pages/admin.js（浏览器里由后端把 shared/ 挂到 /shared/ 路径）
import { DB_TABLES } from '/shared/constants.js';
import { validateVenueInput } from '/shared/validate.js';
```

## 数据库

SQLite 单文件数据库，默认位于 `data/app.db`（首次启动自动建表并写入种子数据），
WAL 模式 + 外键约束。表结构：

| 表 | 说明 |
| --- | --- |
| `users` | 用户（手机号/邮箱、scrypt 密码哈希、角色、积分、实名信息） |
| `venues` | 场馆（运动类型、开放时间、时段长度、营业状态） |
| `courts` | 场地（所属场馆、每小时价格、启停状态） |
| `locks` | 时段锁定（10 分钟有效期，先到先得的锁） |
| `bookings` | 预约（预约码、二维码凭证、金额、状态、取消原因） |
| `slot_overrides` | 维护中 / 临时关闭的时段标记 |
| `notifications` | 站内通知 |

**如何改数据**（三种方式，任选）：

1. 界面：用管理员账号登录 → 管理后台（场馆管理 / 场地管理 / 时段标记 / 预约管理 / 用户管理 / 数据库）；
2. API：见下方「管理后台」接口，全部支持 `POST / PATCH / DELETE`；
3. 直接改库：停掉服务后用任意 SQLite 工具打开 `data/app.db`。

删除有保护：有有效预约的场馆/场地不能删除、有预约记录的用户不能删除，避免破坏历史数据；
场馆可改为「暂停营业」。

## 接口一览

所有接口以 `/api` 开头，鉴权用 `Authorization: Bearer <token>`，错误统一返回
`{ "error": { "status": 409, "message": "...", "suggestions": [...] } }`。

### 公共

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查（版本、SSE 连接数） |
| GET | `/api/stream?date=&venueId=` | SSE 实时推送（锁定/释放/预约/取消/维护/场馆变更） |

### 账户

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/auth/register` | 手机号/邮箱注册 |
| POST | `/api/auth/login` | 登录，返回 token |
| GET | `/api/me` | 个人中心（积分、预约统计） |
| PATCH | `/api/me` | 修改昵称 / 手机号 / 邮箱 |
| POST | `/api/me/password` | 修改密码 |
| POST | `/api/me/verify` | 实名认证 |
| GET / POST | `/api/notifications`、`/api/notifications/read` | 站内信查询 / 标记已读 |

### 场馆与实时查询

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/sports` | 运动类型列表 |
| GET | `/api/venues?sport=&keyword=&date=` | 场馆列表 + 开放状态 + 可约段数/占用率 |
| GET | `/api/venues/:id?date=` | 场馆详情（场地 + 时段） |
| GET | `/api/venues/:id/availability?date=` | 时段轴（逐场地逐时段状态） |
| GET | `/api/availability?sport=&date=&startTime=&endTime=` | 按条件筛选可用场地 |

### 预约与锁定

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/bookings/lock` | 锁定时段 10 分钟，返回 lockId / 倒计时；被抢占返回 409 + 相邻推荐 |
| POST | `/api/bookings` | 按 lockId 确认预约（生成预约码 + 二维码凭证 + 通知） |
| GET | `/api/bookings/mine?status=&date=` | 我的预约 |
| GET | `/api/bookings/:id` | 预约详情 |
| POST | `/api/bookings/:id/cancel` | 取消（距开场 ≥2 小时可自助，取消后时段释放） |

### 管理后台（需 admin）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST / PATCH / DELETE | `/api/admin/venues[/:id]` | 新增 / 修改 / 删除场馆 |
| POST / PATCH / DELETE | `/api/admin/venues/:id/courts`、`/api/admin/courts/:id` | 新增 / 修改 / 删除场地 |
| POST / GET / DELETE | `/api/admin/overrides[/:id]` | 维护中 / 临时关闭标记 |
| GET / POST | `/api/admin/bookings`、`/api/admin/bookings/:id/cancel` | 预约总览 / 强制取消 |
| GET / PATCH / DELETE | `/api/admin/users[/:id]` | 用户查询 / 改角色积分 / 删除 |
| GET | `/api/admin/report?days=7&from=` | 未来 N 天报表（预约量、利用率、营收） |
| GET | `/api/admin/stats` | 数据库概览（路径、大小、各表行数、运行时长、SSE 数） |
| GET | `/api/admin/db/:table?limit=&offset=&q=` | 只读浏览数据表（白名单，用户表自动脱敏） |
| GET | `/api/admin/health` | 后台健康检查 |

## 关键实现说明

- **先到先得不超卖**：一次锁定 = 「查冲突 + 写锁」在同一同步事务里完成；Node 单线程 + SQLite 事务
  保证并发下只有一个请求成功。测试里 12 个并发请求抢同一时段：1 成功 / 11 个 409。
- **时段模型**：场馆配置开放时间与时段长度，可用性 = 时段格子 − 已确认预约 − 有效锁定 − 维护/关闭标记，
  优先级 `closed > maintenance > booked > locked`。
- **取消规则**：自助取消需距开场 ≥ 2 小时；管理员可随时强制取消（用户 +2 积分补偿）。
- **实时性**：SSE + 内存广播代替 WebSocket / Redis；多实例部署时替换 `events.js` 即可。
- **前端零构建**：原生 ESM + hash 路由，浏览器直接加载，改完刷新即生效。

## 与 PRD 的对应

| PRD 大型需求 | 实现 |
| --- | --- |
| 场馆与场地实时查询（自动刷新、筛选） | 场馆列表 + 时段轴 + 运动类型/日期/关键词筛选 + SSE 推送 |
| 先到先得锁定 10 分钟、冲突推荐相邻时段 | 锁定接口 + 409 冲突 + 相邻时段推荐 + 定时回收 |
| 预约通知凭证、我的预约、取消释放 | 预约码/二维码、站内信、自助取消（2 小时规则） |
| 管理员后台 | 场馆/场地/时段/预约/用户管理与 7 天报表 |
| 账户与实名、积分 | 注册登录、实名认证、积分体系 |

## 未实现（按需再加）

真实支付渠道、真实短信/邮件网关、实名认证三方校验、多实例部署。前端未使用框架（React 等），
如需工程化前端可在 `frontend/` 基础上替换为 Vite + React，接口无需改动。

## 环境变量

均可留空：`PORT`、`HOST`、`DB_PATH`、`TOKEN_SECRET`、`LOCK_MINUTES`（默认 10）、
`CANCEL_HOURS`（默认 2）、`BOOKING_DAYS_AHEAD`（默认 30）、`HTTP_LOG=0`（关请求日志）、
`AI_API_KEY`（配置后启用大模型，不配则自动降级为本地规则引擎）、`AI_BASE_URL`（默认 DeepSeek）、`AI_MODEL`（默认 deepseek-chat）、`AI_TIMEOUT_MS`（默认 15000）。

## AI 能力（v3 新增）

系统具备两项 AI 能力，且**双模式运行**：配置了 `AI_API_KEY` 时调用真实大模型（DeepSeek / 任意 OpenAI 兼容接口，后端内置 `fetch`，仍保持零 npm 依赖）；未配置或调用失败时自动降级为**本地规则引擎**，离线也能完整演示。

### 1. AI 预约助手（对话式）

右下角「🤖 AI 预约助手」：用户用一句话描述需求，系统解析意图并直接推荐可约时段，可一键锁定并完成预约。

```
用户：明天下午帮我订 2 小时羽毛球
AI  ：按「运动：羽毛球，日期：明天，时长：2 小时」帮你找到 2 个可约时段。
      最推荐：城市体育中心羽毛球馆 1 号场，08:00-10:00，¥80。
      [去预约]  → 锁定 10 分钟 → [确认预约] → 生成凭证
```

- 意图解析：运动类型、相对/绝对日期、时间段、时长、价格/空闲偏好；
- 推荐：复用现有可用性引擎（时段 − 预约 − 锁定 − 维护），支持价格优先、接近指定时间等排序；
- 大模型可用时还会额外生成自然语言回复；每次提问写入 `ai_logs` 表（后台数据库页可见）。

### 2. AI 经营分析（管理员）

管理后台 →「经营报表」→「🤖 AI 经营分析」：读取当前周期的预约量、利用率、营收，输出运营摘要、关键亮点与可执行建议。

### 接口与数据

| 接口 | 说明 |
| --- | --- |
| `GET /api/ai/status` | 当前模式（llm/rule）、模型名、快捷话术 |
| `POST /api/ai/chat` | 对话式预约：`{message}` → `{reply, intent, candidates, mode}` |
| `POST /api/ai/recommend` | 结构化推荐：`{sport,date,startTime,durationMinutes}` |
| `GET /api/admin/ai/insights?days=7` | 经营分析：`{summary, highlights, suggestions, mode}` |

新增数据表 `ai_logs`（提问日志）；新增共用模块 `shared/ai-schema.js`（模式/标签/快捷话术，前后端共用）。

### 配置

```bash
# Windows PowerShell
$env:AI_API_KEY="sk-xxxx"          # 不配置则自动使用本地规则引擎
$env:AI_BASE_URL="https://api.deepseek.com/v1"
$env:AI_MODEL="deepseek-chat"
node backend/src/server.js
```