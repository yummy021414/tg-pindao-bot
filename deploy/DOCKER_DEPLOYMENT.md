# 🐳 Telegram Bot Docker 部署文档

## 📋 目录
- [环境要求](#环境要求)
- [快速开始](#快速开始)
- [详细步骤](#详细步骤)
- [常用操作](#常用操作)
- [故障排查](#故障排查)
- [数据备份恢复](#数据备份恢复)
- [从PM2迁移](#从pm2迁移)

---

## 🔧 环境要求

### 系统要求
- **操作系统**: Linux (Debian 9+, Ubuntu 18.04+, CentOS 7+)
- **架构**: AMD64 或 ARM64
- **磁盘空间**: 至少2GB可用空间
- **内存**: 至少512MB

### 软件要求
- Docker >= 20.10
- Docker Compose >= 2.0
- （如果未安装，脚本会自动安装）

---

## 🚀 快速开始

### 首次部署（3条命令）

```bash
# 1. 安装Docker环境（如果未安装）
chmod +x install-docker.sh
./install-docker.sh

# 2. 配置环境变量
cp env.example env
nano env  # 修改 BOT_TOKEN 和 SUPER_ADMIN_ID

# 3. 一键部署
chmod +x deploy-docker.sh
./deploy-docker.sh
```

**就这么简单！** ✨

---

## 📖 详细步骤

### 步骤1：准备文件

确保以下文件存在：
```
pindaobot/
├── Dockerfile              ✅ Docker镜像定义
├── docker-compose.yml      ✅ 编排配置
├── .dockerignore          ✅ 忽略文件
├── deploy-docker.sh       ✅ 部署脚本
├── install-docker.sh      ✅ Docker安装脚本
├── update-docker.sh       ✅ 更新脚本
├── backup.sh              ✅ 备份脚本
├── env                    ⚠️  需要配置
├── src/                   ✅ 源代码
├── package.json           ✅ 依赖定义
└── tsconfig.json          ✅ TS配置
```

### 步骤2：配置环境变量

```bash
# 编辑env文件
nano env

# 必须配置：
BOT_TOKEN=你的机器人Token
SUPER_ADMIN_ID=你的TelegramID

# 可选配置：
SOURCE_CHANNELS=
TARGET_CHANNELS=
```

### 步骤3：执行部署

```bash
# 设置脚本权限
chmod +x *.sh

# 如果Docker未安装
./install-docker.sh

# 部署
./deploy-docker.sh
```

---

## 🎮 常用操作

### 查看日志
```bash
# 实时日志
docker-compose logs -f

# 最近100行
docker-compose logs --tail=100

# 只看错误
docker-compose logs | grep -i error
```

### 管理容器
```bash
# 查看状态
docker-compose ps

# 重启
docker-compose restart

# 停止
docker-compose down

# 启动
docker-compose up -d
```

### 进入容器
```bash
# 进入容器shell
docker-compose exec telegram-bot sh

# 查看容器内文件
ls -la /app/

# 退出容器
exit
```

### 查看资源占用
```bash
# 实时监控
docker stats pindaobot

# 查看详情
docker inspect pindaobot
```

---

## 🔧 故障排查

### 容器无法启动

**症状：**
```
docker-compose ps
显示: Exit 1 或 Restarting
```

**排查步骤：**
```bash
# 1. 查看错误日志
docker-compose logs

# 2. 检查配置文件
cat env

# 3. 检查Docker状态
docker info

# 4. 重新构建
docker-compose down
docker-compose build --no-cache
docker-compose up -d
```

### 依赖安装失败

**症状：**
```
npm install 失败
或
模块找不到
```

**解决：**
```bash
# 重新构建（不使用缓存）
docker-compose build --no-cache
```

### 数据丢失

**症状：**
```
重启后账号/媒体丢失
```

**检查：**
```bash
# 检查数据卷挂载
docker inspect pindaobot | grep Mounts -A 20

# 检查宿主机数据
ls -la ./data/

# 恢复备份
tar -xzf backups/backup_最新.tar.gz
cp -r backups/backup_最新/data/ ./
docker-compose restart
```

---

## 💾 数据备份恢复

### 备份

```bash
# 自动备份（推荐）
./backup.sh

# 手动备份
timestamp=$(date +%Y%m%d_%H%M%S)
mkdir -p backups/backup_$timestamp
cp -r data/ backups/backup_$timestamp/
cp env backups/backup_$timestamp/
tar -czf backups/backup_$timestamp.tar.gz -C backups backup_$timestamp
```

### 恢复

```bash
# 1. 停止容器
docker-compose down

# 2. 恢复数据
tar -xzf backups/backup_20251031_225532.tar.gz
cp -r backups/backup_20251031_225532/data/ ./
cp backups/backup_20251031_225532/env ./

# 3. 重启容器
docker-compose up -d
```

### 定时备份

```bash
# 添加到crontab
crontab -e

# 每天凌晨3点备份
0 3 * * * cd /root/telegram222 && ./backup.sh >> /root/backup.log 2>&1
```

---

## 🔄 从PM2迁移到Docker

### 迁移步骤

```bash
# 1. 备份PM2数据
cd /root/telegram222  # PM2项目目录
./backup.sh

# 2. 停止PM2服务
pm2 stop telegram-bot

# 3. 在同一目录部署Docker
./deploy-docker.sh

# 4. 测试Docker版本
# 在Telegram中测试所有功能

# 5. 确认正常后，删除PM2进程
pm2 delete telegram-bot
pm2 save
```

### 回滚到PM2

```bash
# 如果Docker有问题，快速回滚
docker-compose down
pm2 restart telegram-bot
```

---

## 📊 性能对比

| 项目 | PM2 | Docker | 说明 |
|------|-----|--------|------|
| 内存占用 | ~100MB | ~150MB | Docker稍高 |
| CPU占用 | 正常 | 正常 | 基本相同 |
| 启动速度 | 快 | 稍慢 | Docker需要容器启动 |
| 稳定性 | 好 | 很好 | Docker更好隔离 |
| 维护性 | 中 | 高 | Docker更易维护 |

---

## 🛡️ 安全建议

### 1. 文件权限
```bash
chmod 600 env           # 配置文件只有root可读
chmod 700 data/         # 数据目录只有root可访问
```

### 2. 定期备份
```bash
# 设置自动备份
crontab -e
0 3 * * * cd /root/telegram222 && ./backup.sh
```

### 3. 监控日志
```bash
# 定期检查错误日志
docker-compose logs | grep -i error
```

---

## 💡 高级配置

### 资源限制

编辑 `docker-compose.yml`:
```yaml
deploy:
  resources:
    limits:
      cpus: '1.0'      # 最多使用1核
      memory: 512M     # 最多512MB内存
```

### 网络配置

如果需要暴露端口（Web界面等）:
```yaml
ports:
  - "3000:3000"
```

### 多实例部署

```bash
# 启动多个实例
docker-compose up -d --scale telegram-bot=3
```

---

## 📞 支持

**遇到问题？**

1. 查看日志: `docker-compose logs`
2. 检查状态: `docker-compose ps`
3. 查看文档: 本文件
4. 重新部署: `./deploy-docker.sh`

---

**更新时间**: 2025-10-31  
**版本**: V2.0

