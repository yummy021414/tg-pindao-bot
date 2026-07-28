# 🚀 5分钟快速部署指南

## 📦 准备工作

### 1. 上传文件到服务器

**方法1：使用FileZilla/WinSCP**
```
上传整个项目文件夹到: /root/telegram222/
```

**方法2：使用scp**
```bash
scp -r pindaobot/ root@你的服务器IP:/root/
```

---

## ⚡ 快速部署（3步）

### 步骤1：连接服务器
```bash
ssh root@你的服务器IP
cd /root/telegram222
```

### 步骤2：配置环境
```bash
# 复制配置模板
cp env.example env

# 编辑配置
nano env

# 修改这两项（必须）：
BOT_TOKEN=你的Bot_Token
SUPER_ADMIN_ID=你的Telegram_ID

# 保存：Ctrl+O，回车
# 退出：Ctrl+X
```

### 步骤3：一键部署
```bash
# 设置权限
chmod +x *.sh

# 如果Docker未安装（首次）
./install-docker.sh

# 部署
./deploy-docker.sh
```

**完成！** 🎉

---

## 🧪 测试

在Telegram中：
```
1. 发送: /start
2. 应该看到主菜单
3. 点击: 🎛️ 账号控制
4. 测试各项功能
```

---

## 📋 部署后管理

### 查看日志
```bash
docker-compose logs -f
```

### 重启服务
```bash
docker-compose restart
```

### 停止服务
```bash
docker-compose down
```

### 备份数据
```bash
./backup.sh
```

---

## 🔄 更新代码

```bash
# 1. 备份
./backup.sh

# 2. 上传新代码

# 3. 一键更新
./update-docker.sh
```

---

## ❓ 常见问题

### Docker未安装？
```bash
./install-docker.sh
```

### 容器无法启动？
```bash
docker-compose logs
# 查看错误信息
```

### 需要回滚？
```bash
# 恢复备份
tar -xzf backups/backup_最新.tar.gz
cp -r backups/backup_最新/data/ ./
docker-compose restart
```

---

## 📞 获取帮助

1. 查看完整文档：[DOCKER_DEPLOYMENT.md](DOCKER_DEPLOYMENT.md)
2. 查看更新日志：[UPDATE_LOG.md](UPDATE_LOG.md)
3. 查看日志排错：`docker-compose logs`

---

**祝部署顺利！** 🎉

