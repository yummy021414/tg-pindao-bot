#!/bin/bash

# 启动Telegram机器人服务

echo "🚀 启动Telegram频道管理机器人..."

# 检查服务是否已在运行
if systemctl is-active --quiet telegram-bot; then
    echo "✅ 服务已在运行中"
    echo "📊 服务状态:"
    sudo systemctl status telegram-bot --no-pager
    exit 0
fi

# 启动服务
echo "🔄 启动服务..."
sudo systemctl start telegram-bot

# 等待服务启动
sleep 3

# 检查服务状态
if systemctl is-active --quiet telegram-bot; then
    echo "✅ 服务启动成功！"
    echo ""
    echo "📊 服务状态:"
    sudo systemctl status telegram-bot --no-pager
    echo ""
    echo "📋 管理命令:"
    echo "  查看日志: sudo journalctl -u telegram-bot -f"
    echo "  停止服务: sudo systemctl stop telegram-bot"
    echo "  重启服务: sudo systemctl restart telegram-bot"
else
    echo "❌ 服务启动失败"
    echo "📋 查看错误日志:"
    sudo journalctl -u telegram-bot --no-pager -n 20
    exit 1
fi

