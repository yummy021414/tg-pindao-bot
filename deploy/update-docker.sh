#!/bin/bash

# ========================================
# Telegram Bot Docker 更新脚本
# 用于更新已部署的Docker版本
# ========================================

set -e

echo "════════════════════════════════════════"
echo "  Telegram Bot 更新工具"
echo "════════════════════════════════════════"
echo ""

# 检测docker-compose命令
if command -v docker-compose &> /dev/null; then
    COMPOSE_CMD="docker-compose"
else
    COMPOSE_CMD="docker compose"
fi

# ==================== 第1步：备份 ====================
echo "📦 [1/5] 自动备份..."

if [ -f "./backup.sh" ]; then
    ./backup.sh
else
    echo "⚠️  backup.sh不存在，跳过备份"
fi

echo ""

# ==================== 第2步：停止容器 ====================
echo "🛑 [2/5] 停止现有容器..."

if [ "$($COMPOSE_CMD ps -q)" ]; then
    $COMPOSE_CMD down
    echo "✅ 容器已停止"
else
    echo "💡 无运行中的容器"
fi

echo ""

# ==================== 第3步：拉取代码（如果使用git） ====================
echo "📥 [3/5] 更新代码..."

if [ -d ".git" ]; then
    git pull
    echo "✅ 代码已更新"
else
    echo "💡 非git仓库，跳过代码拉取"
    echo "   请手动上传新代码文件"
fi

echo ""

# ==================== 第4步：重新构建 ====================
echo "🔨 [4/5] 重新构建镜像..."

$COMPOSE_CMD build --no-cache

echo "✅ 镜像构建完成"
echo ""

# ==================== 第5步：启动 ====================
echo "🚀 [5/5] 启动服务..."

$COMPOSE_CMD up -d

sleep 3

# 检查状态
if docker ps | grep -q pindaobot; then
    echo "✅ 服务启动成功"
    echo ""
    echo "📋 最近日志:"
    $COMPOSE_CMD logs --tail=20
else
    echo "❌ 服务启动失败"
    echo ""
    echo "错误日志:"
    $COMPOSE_CMD logs
    exit 1
fi

echo ""
echo "════════════════════════════════════════"
echo "✅ 更新完成！"
echo "════════════════════════════════════════"
echo ""
echo "💡 查看日志: $COMPOSE_CMD logs -f"
echo ""

