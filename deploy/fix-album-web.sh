#!/bin/bash
# ========================================
# 一键修复：网页相册域名访问 + Bot 启动配置
# 用法: bash /root/pindaobot/deploy/fix-album-web.sh
# ========================================
set -e

ROOT="/root/pindaobot"
ENV_FILE="$ROOT/env/.env"
ENV_FILE2="$ROOT/.env"
COMPOSE_DIR="$ROOT/deploy"
DOMAIN_HOST="www.hotbabys.cn"
DOMAIN_URL="http://www.hotbabys.cn"
API_ROOT="https://api.telegram.org"

echo "========================================"
echo "  网页相册一键修复"
echo "========================================"

# ---------- 1. Nginx 反代 ----------
echo "[1/6] 配置 Nginx 反代 -> 127.0.0.1:3000"
mkdir -p /etc/nginx/conf.d

# 关掉可能抢 80 端口的默认站
if [ -f /etc/nginx/sites-enabled/default ]; then
  rm -f /etc/nginx/sites-enabled/default
  echo "  已禁用 sites-enabled/default"
fi

cat > /etc/nginx/conf.d/hotbabys.conf <<'NGINX'
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name www.hotbabys.cn hotbabys.cn _;

    client_max_body_size 100m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 60s;
        proxy_send_timeout 300s;
        proxy_read_timeout 300s;
    }
}
NGINX

nginx -t
systemctl enable nginx >/dev/null 2>&1 || true
systemctl restart nginx
echo "  Nginx 已重启"

# ---------- 2. 修正 docker-compose 挂载 ----------
echo "[2/6] 修正 docker-compose.yml"
COMPOSE="$COMPOSE_DIR/docker-compose.yml"
if [ -f "$COMPOSE" ]; then
  # 目录挂载 -> 文件挂载
  sed -i 's|../env:/app/.env:ro|../env/.env:/app/.env:ro|g' "$COMPOSE"
  # 确保有 3000 端口
  if ! grep -q '3000:3000' "$COMPOSE"; then
    echo "  警告: compose 里没有 3000:3000，请确认 ports 配置"
  fi
  echo "  compose 已检查"
else
  echo "  错误: 找不到 $COMPOSE"
  exit 1
fi

# ---------- 3. 修复 env ----------
echo "[3/6] 修复环境变量 DOMAIN / TELEGRAM_API_ROOT"
fix_env_file() {
  local f="$1"
  if [ ! -f "$f" ]; then
    echo "  跳过不存在: $f"
    return
  fi
  # DOMAIN（必须 http，不要 https）
  if grep -q '^DOMAIN=' "$f"; then
    sed -i "s|^DOMAIN=.*|DOMAIN=$DOMAIN_URL|" "$f"
  else
    echo "DOMAIN=$DOMAIN_URL" >> "$f"
  fi
  # 去掉可能残留的 https
  sed -i 's|^DOMAIN=https://|DOMAIN=http://|g' "$f"
  # 确保强制 http 开关存在
  if grep -q '^ALBUM_FORCE_HTTP=' "$f"; then
    sed -i 's|^ALBUM_FORCE_HTTP=.*|ALBUM_FORCE_HTTP=1|' "$f"
  else
    echo "ALBUM_FORCE_HTTP=1" >> "$f"
  fi
  # TELEGRAM_API_ROOT（去掉失效代理）
  if grep -q '^TELEGRAM_API_ROOT=' "$f"; then
    sed -i "s|^TELEGRAM_API_ROOT=.*|TELEGRAM_API_ROOT=$API_ROOT|" "$f"
  else
    echo "TELEGRAM_API_ROOT=$API_ROOT" >> "$f"
  fi
  # PORT
  if grep -q '^PORT=' "$f"; then
    sed -i 's|^PORT=.*|PORT=3000|' "$f"
  else
    echo "PORT=3000" >> "$f"
  fi
  echo "  已修复: $f"
  grep -E '^(DOMAIN|TELEGRAM_API_ROOT|PORT)=' "$f" | sed 's/^/    /'
}

fix_env_file "$ENV_FILE"
fix_env_file "$ENV_FILE2"

# ---------- 4. 防火墙放行 80/3000（有 ufw 才处理） ----------
echo "[4/6] 检查防火墙"
if command -v ufw >/dev/null 2>&1; then
  ufw allow 80/tcp >/dev/null 2>&1 || true
  ufw allow 3000/tcp >/dev/null 2>&1 || true
  echo "  ufw 已放行 80/3000"
else
  echo "  未检测到 ufw，跳过（请确认云厂商安全组放行 80）"
fi

# ---------- 5. 重启容器 ----------
echo "[5/6] 重启 Docker 容器"
cd "$COMPOSE_DIR"
if command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_CMD="docker-compose"
else
  COMPOSE_CMD="docker compose"
fi
$COMPOSE_CMD up -d --force-recreate
sleep 5

# ---------- 6. 自检 ----------
echo "[6/6] 自检"
echo "---- docker ps ----"
docker ps --filter name=pindaobot --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
echo "---- curl 本机 3000 ----"
curl -sI http://127.0.0.1:3000/ | head -5 || echo "FAIL: 3000"
echo "---- curl Nginx 反代 ----"
curl -sI -H "Host: $DOMAIN_HOST" http://127.0.0.1/ | head -8 || echo "FAIL: nginx"
echo "---- curl 公网域名 ----"
curl -sI "http://$DOMAIN_HOST/" | head -8 || echo "FAIL: domain"
echo "---- bot 日志（最近 20 行）----"
docker logs --tail 20 pindaobot 2>&1 || true

echo ""
echo "========================================"
echo "  修复完成"
echo "========================================"
echo "浏览器请打开（必须 http，不要 https）："
echo "  http://www.hotbabys.cn/"
echo "  http://www.hotbabys.cn/v/你的相册ID"
echo ""
echo "Cloudflare DNS 请保持："
echo "  1) www A 记录 = 本机公网 IP"
echo "  2) 灰色云（仅 DNS），不要橙色代理"
echo "========================================"
