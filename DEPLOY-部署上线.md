# 部署上线指南（把系统变成公网网站）

本仓库已内置部署所需的全部文件：

| 文件 | 作用 |
| --- | --- |
| `Dockerfile` | 生产镜像：固定 Node 24，暴露 3000 端口，带健康检查 |
| `.dockerignore` | 排除 `.git`、`data`、`*.bat`、`*.docx` 等非运行文件 |
| `render.yaml` | Render 平台的一键部署配置（Blueprint） |

后端已支持平台注入的 `PORT` 环境变量，监听 `0.0.0.0`，所以云平台可以直接跑起来，**不需要改代码**。

---

## 一、推荐平台：Render（免费、支持 Docker、可连 GitHub）

适合作业/演示：免费实例、自动 HTTPS 域名、GitHub 推送后自动重新部署。
访问地址形如 `https://sports-booking-system-xxxx.onrender.com`。

### 步骤 1：注册账号

1. 打开 <https://render.com>
2. 点 **Get Started** → 选择 **GitHub** 登录（最省事，后面要连仓库）
3. 按提示完成邮箱验证

> 需要一张能收验证邮件的邮箱即可，免费方案不用绑卡。

### 步骤 2：把仓库授权给 Render

登录后如果没弹出授权，手动进：**右上角头像 → Account Settings → GitHub → Connect GitHub**，
选择 **Only select repositories** → 勾选 `Hong-zy/sports-booking-backend` → Install。

### 步骤 3：创建服务（推荐 Blueprint 一键）

1. 控制台右上角 **New +** → **Blueprint**
2. 选择仓库 `sports-booking-backend`
3. Render 会自动读取 `render.yaml`，显示服务 `sports-booking-system`
4. 点 **Apply** / **Create Resources**
5. 等构建（首次 3–6 分钟：拉镜像 → 装 Node 基础层 → 复制代码）

> 如果 Blueprint 页面没识别到 `render.yaml`，改用：
> **New +** → **Web Service** → 选仓库 → **Language/Runtime 选 `Docker`**
> → **Plan 选 `Free`** → **Region 选 `Singapore`**（国内访问相对快） → **Create Web Service**

### 步骤 4：拿到网址并验证

构建完成、状态变成 **Live** 后，页面顶部会显示域名，例如：

```
https://sports-booking-system-abcd.onrender.com
```

按这个清单点一遍：

1. 首页能打开，显示 **5 个场馆卡片**和筛选栏；
2. 右上角「登录」→ 管理员 `admin@yueqiu.local` / `admin123456`；
3. 顶部出现「⚙ 管理后台」→ 进入后能看到 7 个子页；
4. 点「🗄 数据库」→ 能看到数据库路径、文件大小、各表行数；
5. 「场馆管理」→ 编辑一个场馆价格并保存 → 刷新页面仍生效（说明写库成功）；
6. 打开 `https://你的域名/api/health` → 返回 `{"ok":true,...,"version":"2.0.0"}`。

### 步骤 5（重要）：改掉默认管理员密码

公网地址任何人都能访问，`admin@yueqiu.local / admin123456` 是公开的演示账号，
**别人登进去可以删你的场馆和预约**。上线后建议立刻：

- 用管理员登录 → **个人中心 → 修改密码**（改完立即生效，写进数据库）；
- 或者登录后到「用户管理」把其他演示账号删除/降权。

> 如果希望我帮忙把默认密码改成随机强密码并写进种子数据，说一声即可。

---

## 二、Render 免费版要知道的限制

| 限制 | 说明 | 影响 |
| --- | --- | --- |
| 15 分钟无访问自动休眠 | 再次访问需要冷启动 | 打开会等 **30–60 秒**，属正常 |
| 内存 512 MB | 单实例 | 够用（本项目很轻） |
| **文件系统是临时的** | 重新部署 / 重启 / 休眠唤醒后 | **数据库重置为初始演示数据** |
| 不能开多实例 | SQLite 不支持多实例并发写 | 保持 `numInstances: 1` |
| 免费域名 | `*.onrender.com` | 不能绑自定义域名（要绑需付费） |

**想让数据持久化**：升级到付费实例（约 $7/月起）后，在 `render.yaml` 里取消 `disk:` 注释，
磁盘挂到 `/app/data`（正好是默认数据库目录），重新部署即可。

---

## 三、其他平台（同样可用，步骤类似）

任何支持 Docker 的平台都能跑，选仓库后它会自动识别 `Dockerfile`：

- **Railway** <https://railway.app>：New Project → Deploy from GitHub repo → 自动识别 Dockerfile
- **Zeabur** <https://zeabur.com>：国内访问较快，New Project → GitHub 仓库
- **Koyeb** <https://koyeb.com>：免费实例，选 Dockerfile 构建
- **自备服务器**（有 VPS/云主机的话）：装 Docker 后执行

  ```bash
  git clone https://github.com/Hong-zy/sports-booking-backend.git
  cd sports-booking-backend
  docker build -t sports-booking .
  docker run -d --name sports-booking -p 80:3000 \
    -v $(pwd)/data:/app/data \
    sports-booking
  ```

  `-v` 把数据库挂到宿主机，数据不会丢。

---

## 四、环境变量

平台默认会注入 `PORT`，其余可选：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | 3000 | 平台自动注入，不要手动写死 |
| `HOST` | 0.0.0.0 | 保持默认 |
| `DB_PATH` | `/app/data/app.db` | 想换位置就设它（需目录可写） |
| `TZ` | Asia/Shanghai | 时区，已在 render.yaml 配好 |
| `LOCK_MINUTES` | 10 | 锁定时长 |
| `CANCEL_HOURS` | 2 | 自助取消时限 |
| `BOOKING_DAYS_AHEAD` | 30 | 可预约天数 |
| `HTTP_LOG` | 0（部署配置里关闭） | 设为 1 可看请求日志 |
| `TOKEN_SECRET` | dev-secret-change-me | **正式环境建议设一个随机值** |

---

## 五、常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| 构建失败 | 进 Render 服务页 → **Logs** 看具体报错；常见是 Dockerfile 路径或仓库未授权 |
| 部署成功但打开 502/超时 | 健康检查未通过：确认 `/api/health` 可访问；看 Logs 里是否端口不是 `PORT` |
| 打开要等很久（30–60 秒） | 免费实例休眠后冷启动，正常现象 |
| 改的数据第二天没了 | 免费版文件系统临时，重启/重新部署会重置（见第二节） |
| 页面能开但接口 404 | 确认用的是 `https://域名/api/...`，不是 `localhost` |
| 想本地先试 Docker | 装 Docker Desktop 后在仓库根目录执行 `docker build -t sports-booking . && docker run -p 3000:3000 sports-booking` |

---

## 六、部署后自检命令

```bash
curl https://你的域名/api/health
curl https://你的域名/api/venues
```

两条都返回 JSON 且不报错，说明网站已经跑通。
