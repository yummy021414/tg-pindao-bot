#!/bin/bash

# ========================================
# Telegram Bot Docker 一键部署脚本
# 支持首次部署和更新部署
# ========================================

set -e  # 遇到错误立即退出

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 打印函数
print_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

print_error() {
    echo -e "${RED}❌ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

print_info() {
    echo -e "${BLUE}ℹ️  $1${NC}"
}

echo "════════════════════════════════════════"
echo "  Telegram Bot Docker 部署工具"
echo "  Version: 2.0"
echo "════════════════════════════════════════"
echo ""

# ==================== 第1步：环境检查 ====================
echo "🔍 [1/9] 环境检查..."

# 检查Docker
if ! command -v docker &> /dev/null; then
    print_error "Docker未安装！"
    echo ""
    print_info "请先运行: ./install-docker.sh"
    echo "或手动安装Docker: https://docs.docker.com/engine/install/"
    exit 1
fi

print_success "Docker: $(docker --version)"

# 检查Docker Compose
if ! command -v docker-compose &> /dev/null && ! docker compose version &> /dev/null; then
    print_error "Docker Compose未安装！"
    exit 1
fi

if command -v docker-compose &> /dev/null; then
    COMPOSE_CMD="docker-compose"
    print_success "Docker Compose: $(docker-compose --version)"
else
    COMPOSE_CMD="docker compose"
    print_success "Docker Compose: $(docker compose version)"
fi

# 检查Docker是否运行
if ! docker info &> /dev/null; then
    print_error "Docker未运行！"
    echo "启动Docker: sudo systemctl start docker"
    exit 1
fi

print_success "Docker服务运行正常"

# 检查磁盘空间
AVAILABLE_SPACE=$(df -BG . | tail -1 | awk '{print $4}' | sed 's/G//')
if [ "$AVAILABLE_SPACE" -lt 2 ]; then
    print_warning "磁盘空间不足2GB，可能影响部署"
fi

echo ""

# ==================== 第2步：备份数据 ====================
echo "📦 [2/9] 备份现有数据..."

if [ -d "data" ] || [ -f "env" ] || [ -f ".env" ]; then
    TIMESTAMP=$(date +%Y%m%d_%H%M%S)
    BACKUP_DIR="backups/backup_$TIMESTAMP"
    
    mkdir -p "$BACKUP_DIR"
    
    [ -d "data" ] && cp -r data/ "$BACKUP_DIR/" && print_success "data/ 已备份"
    [ -f "env" ] && cp env "$BACKUP_DIR/" && print_success "env 已备份"
    [ -f ".env" ] && cp .env "$BACKUP_DIR/" && print_success ".env 已备份"
    
    # 压缩备份
    cd backups
    tar -czf "backup_$TIMESTAMP.tar.gz" "backup_$TIMESTAMP"
    cd ..
    
    BACKUP_SIZE=$(du -sh "$BACKUP_DIR.tar.gz" 2>/dev/null | cut -f1)
    print_success "备份完成: $BACKUP_DIR.tar.gz ($BACKUP_SIZE)"
else
    print_info "无需备份（首次部署）"
fi

echo ""

# ==================== 第3步：停止现有服务 ====================
echo "🛑 [3/9] 停止现有服务..."

# 停止Docker容器（如果存在）
if [ "$($COMPOSE_CMD ps -q)" ]; then
    print_info "停止Docker容器..."
    $COMPOSE_CMD down
    print_success "Docker容器已停止"
fi

# 停止PM2进程（如果存在）
if command -v pm2 &> /dev/null; then
    if pm2 list | grep -q "telegram-bot"; then
        print_info "检测到PM2进程，停止中..."
        pm2 stop telegram-bot 2>/dev/null || true
        print_success "PM2进程已停止"
        print_warning "提示：部署成功后，PM2进程将被Docker容器替代"
    fi
fi

echo ""

# ==================== 第4步：检查必需文件 ====================
echo "📄 [4/9] 检查必需文件..."

if [ ! -f "Dockerfile" ]; then
    print_error "缺少Dockerfile文件！"
    exit 1
fi
print_success "Dockerfile 存在"

if [ ! -f "docker-compose.yml" ]; then
    print_error "缺少docker-compose.yml文件！"
    exit 1
fi
print_success "docker-compose.yml 存在"

if [ ! -f "env" ] && [ ! -f ".env" ]; then
    print_warning "未找到环境配置文件"
    print_info "请确保env或.env文件存在并配置了BOT_TOKEN"
fi

echo ""

# ==================== 第5步：清理旧镜像 ====================
echo "🧹 [5/9] 清理旧镜像..."

# 删除悬空镜像
DANGLING=$(docker images -f "dangling=true" -q | wc -l)
if [ "$DANGLING" -gt 0 ]; then
    docker image prune -f
    print_success "清理了 $DANGLING 个悬空镜像"
else
    print_info "无需清理"
fi

echo ""

# ==================== 第6步：构建Docker镜像 ====================
echo "🔨 [6/9] 构建Docker镜像..."
echo "💡 这可能需要几分钟，请耐心等待..."
echo ""

if $COMPOSE_CMD build --no-cache; then
    print_success "Docker镜像构建成功"
else
    print_error "Docker镜像构建失败！"
    exit 1
fi

echo ""

# ==================== 第7步：启动容器 ====================
echo "🚀 [7/9] 启动Docker容器..."

if $COMPOSE_CMD up -d; then
    print_success "Docker容器启动成功"
else
    print_error "Docker容器启动失败！"
    exit 1
fi

echo ""

# ==================== 第8步：等待并健康检查 ====================
echo "⏳ [8/9] 等待服务启动..."

sleep 5

# 检查容器状态
if ! docker ps | grep -q pindaobot; then
    print_error "容器未运行！"
    echo ""
    echo "查看错误日志:"
    $COMPOSE_CMD logs --tail=50
    exit 1
fi

print_success "容器运行正常"

# 等待健康检查
echo "🏥 等待健康检查..."
for i in {1..10}; do
    if docker inspect --format='{{.State.Health.Status}}' pindaobot 2>/dev/null | grep -q "healthy"; then
        print_success "健康检查通过"
        break
    elif [ $i -eq 10 ]; then
        print_warning "健康检查超时（可能正常，继续监控）"
    else
        echo "   等待中... ($i/10)"
        sleep 3
    fi
done

echo ""

# ==================== 第9步：显示状态和日志 ====================
echo "📊 [9/9] 部署状态..."
echo ""

# 容器状态
$COMPOSE_CMD ps

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# 显示最近日志
echo "📋 最近日志（最后30行）:"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
$COMPOSE_CMD logs --tail=30

echo ""
echo "════════════════════════════════════════"
print_success "部署完成！"
echo "════════════════════════════════════════"
echo ""
echo "📊 容器信息:"
echo "  名称: pindaobot"
echo "  状态: $(docker inspect --format='{{.State.Status}}' pindaobot 2>/dev/null || echo '未知')"
echo ""
echo "📋 常用命令:"
echo "  查看日志:   $COMPOSE_CMD logs -f"
echo "  查看状态:   $COMPOSE_CMD ps"
echo "  重启服务:   $COMPOSE_CMD restart"
echo "  停止服务:   $COMPOSE_CMD down"
echo "  进入容器:   $COMPOSE_CMD exec telegram-bot sh"
echo "  查看资源:   docker stats pindaobot"
echo ""
echo "🔧 PM2迁移提示:"
echo "  如果部署成功，可以删除PM2进程:"
echo "  pm2 delete telegram-bot"
echo "  pm2 save"
echo ""
echo "💡 测试机器人:"
echo "  在Telegram中发送 /start 测试"
echo ""

