# PindaoBot

Telegram 资料管理机器人：上传、搜索、发布到频道，可选网页相册。

## 功能

- 按关键词上传 / 搜索资料（图、视频、文档等）
- 发布到指定频道（支持多关键词连发）
- 频道管理、按钮制作、群发、网页相册
- 金库备份：换 Bot Token 时迁移媒体 `file_id`

## 环境要求

- Node.js 18+
- 或 Docker

## 快速开始

```bash
npm install
cp .env.example .env
# 编辑 .env，填入 BOT_TOKEN、SUPER_ADMIN_ID、CHANNEL_IDS 等

npm run dev          # 开发
# 或
npm run build && npm start
```

### 必填配置（`.env`）

| 变量 | 说明 |
|------|------|
| `BOT_TOKEN` | BotFather 的 Token |
| `SUPER_ADMIN_ID` | 超级管理员的 Telegram 数字 ID |
| `CHANNEL_IDS` | 频道 ID，多个用逗号分隔 |
| `PERSISTENT_CHANNEL_ID` | 备份金库频道（换 Token 用，建议填） |
| `DOMAIN` | 网页相册域名，如 `http://你的域名:3000` |

## Docker 部署

```bash
cd deploy
cp env.example .env   # 填好配置
docker compose up -d --build
docker logs -f pindaobot
```

## 换 Bot（金库）

1. `npm run vault:status` — 看覆盖率  
2. `npm run vault:sync` — 旧 Token 同步到金库  
3. `npm run vault:claim` — 用新 Token 认领 `file_id`  
4. 把 `.env` 里的 `BOT_TOKEN` 换成新 Token，重启  

认领前需配置 `NEW_BOT_TOKEN`、`CLAIM_TO_CHAT_ID`，并先给新 Bot 发过 `/start`。

## 目录说明

```
src/          源码
scripts/      金库等脚本
deploy/       Docker 部署
data/         运行数据（勿提交 Git）
.env          密钥（勿提交 Git）
```

## 许可证

MIT
