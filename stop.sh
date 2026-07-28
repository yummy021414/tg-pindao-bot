#!/bin/bash

# 停止Telegram机器人服务

echo "🛑 停止Telegram频道管理机器人..."

# 检查服务是否在运行
if ! systemctl is-active --quiet telegram-bot; then
    echo "ℹ️ 服务未在运行"
    exit 0
fi

# 停止服务
echo "🔄 停止服务..."
sudo systemctl stop telegram-bot

# 等待服务停止
sleep 2

# 检查服务状态
if ! systemctl is-active --quiet telegram-bot; then
    echo "✅ 服务已成功停止"
else
    echo "⚠️ 服务可能仍在运行，请检查:"
    sudo systemctl status telegram-bot --no-pager
fi

