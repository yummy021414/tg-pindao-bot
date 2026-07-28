#!/bin/bash

# ========================================
# Docker 和 Docker Compose 自动安装脚本
# 支持 Debian/Ubuntu/CentOS
# ========================================

set -e

echo "════════════════════════════════════════"
echo "  Docker 环境自动安装"
echo "════════════════════════════════════════"
echo ""

# 检测系统
if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS=$ID
    VER=$VERSION_ID
else
    echo "❌ 无法检测操作系统"
    exit 1
fi

echo "📋 系统信息: $OS $VER"
echo ""

# ==================== 安装Docker ====================
echo "🐳 [1/3] 安装Docker..."

if command -v docker &> /dev/null; then
    echo "✅ Docker已安装: $(docker --version)"
else
    echo "📦 开始安装Docker..."
    
    if [ "$OS" = "debian" ] || [ "$OS" = "ubuntu" ]; then
        # Debian/Ubuntu
        sudo apt-get update
        sudo apt-get install -y \
            ca-certificates \
            curl \
            gnupg \
            lsb-release
        
        # 添加Docker官方GPG密钥
        sudo mkdir -p /etc/apt/keyrings
        curl -fsSL https://download.docker.com/linux/$OS/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
        
        # 设置仓库
        echo \
          "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/$OS \
          $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
        
        # 安装Docker Engine
        sudo apt-get update
        sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
        
    elif [ "$OS" = "centos" ] || [ "$OS" = "rhel" ]; then
        # CentOS/RHEL
        sudo yum install -y yum-utils
        sudo yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
        sudo yum install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    else
        echo "❌ 不支持的操作系统: $OS"
        exit 1
    fi
    
    echo "✅ Docker安装完成"
fi

echo ""

# ==================== 启动Docker ====================
echo "🚀 [2/3] 启动Docker服务..."

# 启动Docker
sudo systemctl start docker

# 设置开机自启
sudo systemctl enable docker

# 检查状态
if systemctl is-active --quiet docker; then
    echo "✅ Docker服务运行正常"
else
    echo "❌ Docker服务启动失败"
    sudo systemctl status docker
    exit 1
fi

echo ""

# ==================== 配置用户权限 ====================
echo "👤 [3/3] 配置用户权限..."

# 将当前用户添加到docker组（避免每次sudo）
if ! groups | grep -q docker; then
    sudo usermod -aG docker $USER
    echo "✅ 用户已添加到docker组"
    echo "⚠️  注意: 需要重新登录才能生效"
    echo "   或运行: newgrp docker"
else
    echo "✅ 用户权限已配置"
fi

echo ""

# ==================== 安装Docker Compose（独立版本，如果需要） ====================
if ! command -v docker-compose &> /dev/null; then
    echo "📦 安装Docker Compose（独立版本）..."
    
    sudo curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" \
        -o /usr/local/bin/docker-compose
    
    sudo chmod +x /usr/local/bin/docker-compose
    
    echo "✅ Docker Compose安装完成: $(docker-compose --version)"
fi

echo ""
echo "════════════════════════════════════════"
echo "✅ Docker环境安装完成！"
echo "════════════════════════════════════════"
echo ""
echo "📋 验证命令:"
echo "  docker --version"
echo "  docker-compose --version"
echo "  docker ps"
echo ""
echo "🚀 下一步:"
echo "  运行: ./deploy-docker.sh"
echo ""

