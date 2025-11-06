# 🤖 Telegram资料管理机器人 V2.0

> **企业级Telegram资料管理系统** - 支持大批量处理，后台任务，完善的账号管理

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D16.0.0-brightgreen.svg)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/docker-supported-blue.svg)](https://www.docker.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue.svg)](https://www.typescriptlang.org/)

---

## ✨ 核心特性

### 🎯 V2.0 重大更新

#### **后台任务系统** ⭐⭐⭐⭐⭐
- ✅ 支持100+关键词，1000+条消息处理
- ✅ 非阻塞收集（收集期间可使用其他功能）
- ✅ 串行收集机制（每个关键词完整独立）
- ✅ 定时发送（1-24小时灵活分散）
- ✅ 100%保证顺序和完整性

#### **完善的账号管理** ⭐⭐⭐⭐⭐
- ✅ 添加/删除/切换账号
- ✅ 自动回复功能（私信自动回复）
- ✅ 发私信
- ✅ 发送媒体库（后台任务模式）
- ✅ 任务状态实时查询

#### **智能媒体管理** ⭐⭐⭐⭐
- ✅ 批量上传媒体（照片、视频、文档）
- ✅ 关键词智能分类
- ✅ 媒体组完整性保证
- ✅ 发布到频道
- ✅ 媒体搜索

#### **用户和权限管理** ⭐⭐⭐⭐
- ✅ 用户列表分页显示
- ✅ 详细用户信息（姓名、用户名、ID、活跃时间）
- ✅ 群发消息
- ✅ 权限管理

---

## 🚀 快速开始

### 方式1：Docker部署（推荐）⭐⭐⭐⭐⭐

```bash
# 1. 克隆项目
git clone https://github.com/你的用户名/pindaobot.git
cd pindaobot/

# 2. 配置环境
cd deploy/
cp env.example ../env
nano ../env  # 修改 BOT_TOKEN 和 SUPER_ADMIN_ID

# 3. 一键部署
chmod +x *.sh
./install-docker.sh  # 安装Docker（如果未安装）
./deploy-docker.sh   # 部署
```

### 方式2：传统部署

```bash
# 1. 克隆项目
git clone https://github.com/你的用户名/pindaobot.git
cd pindaobot/

# 2. 安装依赖
npm install

# 3. 配置环境
cp deploy/env.example env
nano env  # 修改配置

# 4. 编译运行
npm run build
npm start

# 或使用PM2
pm2 start dist/index.js --name telegram-bot
```

---

## 📋 环境要求

### 系统要求
- **Node.js**: >= 16.0.0
- **操作系统**: Linux (Debian/Ubuntu/CentOS) 或 Windows
- **内存**: 至少512MB
- **磁盘**: 至少2GB可用空间

### Docker部署要求
- **Docker**: >= 20.10
- **Docker Compose**: >= 2.0

---

## ⚙️ 配置说明

### 必填配置

编辑 `env` 文件：

```bash
# Telegram Bot Token（从 @BotFather 获取）
BOT_TOKEN=你的Bot_Token

# 超级管理员ID（你的Telegram用户ID）
SUPER_ADMIN_ID=你的Telegram_ID
```

### 获取配置信息

```
1. Bot Token: 
   - 与 @BotFather 对话
   - 创建新机器人或使用现有机器人
   - 获取Token

2. 用户ID:
   - 与 @userinfobot 对话
   - 查看你的用户ID
```

---

## 📖 主要功能

### 🎛️ 账号控制

```
功能：
- 添加Telegram账号（支持多账号管理）
- 切换账号（自动启用自动回复）
- 删除账号（二次确认 + 完整清理）
- 账号状态查看
- 任务状态查询
```

**特点：**
- 固定4步添加流程（API ID → API Hash → Session → 昵称）
- 支持不同API配置的账号
- 完全在机器人内配置，无需修改服务器文件

### 📦 发送媒体库（核心功能）

```
支持能力：
- 关键词数量: 1-100+
- 消息数量: 10-1000+
- 时间分布: 1/6/12/24小时
```

**工作流程：**
1. 输入关键词（支持多个）
2. 输入目标频道/群组
3. 选择时间分布
4. 后台自动收集
5. 定时发送（保证顺序）

**特性：**
- ✅ 收集期间可用其他功能
- ✅ 串行收集（不混淆）
- ✅ 按关键词边界分组
- ✅ 文字说明和媒体不分离
- ✅ 100%保证顺序

### 🤖 自动回复

```
功能：
- 设置自动回复内容
- 启用/禁用自动回复
- 只回复私信（过滤群组和频道）
- 过滤自己发的消息
```

### 🔍 智能搜索

```
功能：
- 关键词快速搜索
- 最多显示10个结果
- 支持照片、视频、文档、音频
- 显示原始说明文字
```

### 📁 批量上传

```
功能：
- 上传照片、视频、文档、音频、语音
- 设置关键词分类
- 添加文字说明
- 保存到数据库或发布到频道
```

### 📢 群发消息

```
功能：
- 用户列表分页显示（详细信息）
- 支持文字、图片、视频、文档
- 发送前预览和确认
```

### 💬 其他功能

- 发私信（使用控制账号发送）
- 频道管理
- 用户管理
- 权限管理
- 关键词优化

---

## 🐳 Docker部署

### 优势

- ✅ 环境100%一致（开发环境 = 生产环境）
- ✅ 依赖自动处理（sqlite3、telegram等自动编译）
- ✅ 一键部署（`./deploy-docker.sh`）
- ✅ 自启动配置（服务器重启自动运行）
- ✅ 健康检查（自动监控和重启）
- ✅ 日志管理（自动轮转）
- ✅ 数据持久化（挂载卷）

### 管理命令

```bash
# 进入部署目录
cd deploy/

# 查看日志
docker-compose logs -f

# 重启
docker-compose restart

# 停止
docker-compose down

# 启动
docker-compose up -d

# 查看状态
docker-compose ps

# 备份数据
cd ..
./backup-docker.sh
```

详细文档：[deploy/DOCKER_DEPLOYMENT.md](deploy/DOCKER_DEPLOYMENT.md)

---

## 📂 项目结构

```
pindaobot/
├── src/                          # 源代码
│   ├── bot/                      # 机器人核心
│   │   ├── index.ts             # 主程序（4637行）
│   │   └── handlers/            # 功能处理器
│   ├── userAccount/             # 账号控制模块 ⭐ V2.0核心
│   │   ├── controller.ts        # 控制器（2752行）
│   │   ├── commands.ts          # 命令处理（1155行）
│   │   └── database.ts          # 数据库
│   ├── database/                # 数据库模块
│   ├── config/                  # 配置
│   └── types/                   # 类型定义
│
├── deploy/                       # Docker部署方案
│   ├── Dockerfile               # 镜像定义
│   ├── docker-compose.yml       # 编排配置
│   ├── deploy-docker.sh         # 一键部署
│   ├── install-docker.sh        # Docker安装
│   ├── update-docker.sh         # 一键更新
│   └── 📖 完整文档
│
├── data/                         # 数据目录（.gitignore）
│   ├── bot.json                 # 媒体库
│   ├── user_accounts.json       # 账号数据
│   └── sessions/                # Session缓存
│
├── package.json                  # 依赖定义
├── tsconfig.json                 # TS配置
├── .gitignore                   # Git忽略
└── README.md                     # 本文档
```

---

## 🔧 技术栈

- **语言**: TypeScript 5.3
- **运行时**: Node.js 20+
- **机器人框架**: Telegraf 4.15
- **Telegram库**: gramjs (telegram 2.26)
- **数据库**: JSON文件存储
- **部署**: Docker + Docker Compose

---

## 📊 功能对比

| 功能 | V1.0 | V2.0 | 提升 |
|------|------|------|------|
| **关键词支持** | 4-5个 | 100+ | 20倍 |
| **消息处理** | 40-50条 | 1000+ | 20倍 |
| **收集方式** | 并发（混乱） | 串行（完整） | 质的飞跃 |
| **发送方式** | 立即 | 定时分散 | 质的飞跃 |
| **是否阻塞** | 阻塞 | 非阻塞 | 用户体验提升 |
| **账号管理** | 基础 | 完整 | 功能完善 |

---

## 🎯 使用场景

### 场景1：个人资料库管理
- 上传整理个人照片、视频、文档
- 按关键词分类管理
- 快速搜索和分享

### 场景2：团队资料协作
- 多账号管理
- 权限控制
- 统一资料库

### 场景3：频道内容管理
- 批量上传内容
- 一键发布到频道
- 定时发布内容

### 场景4：大批量数据处理
- 100+关键词批量处理
- 1000+条消息定时发送
- 后台任务，不影响其他工作

---

## 📝 更新日志

### V2.0.0 (2025-10-31)

#### 🎯 核心更新
- ✅ 后台任务系统（支持大批量处理）
- ✅ 串行收集机制（保证完整性）
- ✅ 程序定时器发送（保证顺序）
- ✅ 按关键词边界分组（不分离）

#### ✨ 新增功能
- ✅ 删除账号功能
- ✅ 任务状态查询
- ✅ 全局取消机制（/cancel）
- ✅ 返回主菜单功能
- ✅ 用户列表分页

#### 🔧 重大修复
- 🐛 自动回复发送失败（已修复）
- 🐛 上传发布媒体组拆散（已修复）
- 🐛 用户追踪空实现（已修复）
- 🐛 消息乱序问题（已修复）

详细更新日志：[deploy/UPDATE_LOG.md](deploy/UPDATE_LOG.md)

---

## 🛡️ 安全性

### 敏感数据保护
- ✅ env文件不上传（.gitignore）
- ✅ 数据目录不上传
- ✅ Session缓存不上传
- ✅ 备份文件不上传

### 部署建议
- 🔒 修改默认配置
- 🔒 定期备份数据
- 🔒 使用HTTPS代理（如需要）
- 🔒 限制超级管理员权限

---

## 📞 支持

### 文档
- [Docker部署指南](deploy/DOCKER_DEPLOYMENT.md)
- [快速开始](deploy/QUICK_START.md)
- [更新日志](deploy/UPDATE_LOG.md)

### 故障排查
```bash
# 查看日志
docker-compose logs -f

# 检查容器状态
docker-compose ps

# 重新部署
./deploy-docker.sh
```

---

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

---

## 📄 License

MIT License

---

## 🌟 Star History

如果这个项目对你有帮助，请给个⭐！

---

## 📊 统计信息

- **代码行数**: ~8900行
- **核心功能**: 19个
- **支持平台**: Linux, Windows, Docker
- **开发时间**: 2025年
- **版本**: V2.0

---

**更新时间**: 2025-10-31  
**版本**: V2.0.0  
**作者**: yummy
联系方式：https://t.me/faziliaobot
