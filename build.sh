#!/usr/bin/env bash
# pi-web 一键: stop 服务 -> build -> start 服务
#
# 直接 ./build.sh 即可——会自动交给 systemd-run 后台跑（system.slice），
# 敲完这条命令 SSH 马上就能关。
#   断线前看:    journalctl -u pi-web-rebuild -f
#   回来后查结果: journalctl -u pi-web-rebuild -e && systemctl status pi-web.service
#
# 例外: ./build.sh --foreground 在前台跑（看实时进度，但别关 SSH）
set -euo pipefail

SELF="$(readlink -f "$0")"

# 还没在 systemd-run 里、且没要求前台 → 移交 systemd-run
if [ -z "${PI_WEB_BUILD_VIA_SYSTEMD:-}" ] && [ "${1:-}" != "--foreground" ]; then
  if systemctl is-active --quiet pi-web-rebuild; then
    echo "==> 已有 build 在跑（unit pi-web-rebuild）: journalctl -u pi-web-rebuild -f"
    exit 0
  fi
  echo "==> 交给 systemd-run 后台运行，SSH 可以关..."
  systemctl reset-failed pi-web-rebuild 2>/dev/null || true   # 清理上次失败残留的单元
  if ! systemd-run --unit=pi-web-rebuild -E PI_WEB_BUILD_VIA_SYSTEMD=1 /bin/bash "$SELF"; then
    echo "!! systemd-run 发起失败，回退前台执行（这条别关 SSH！）"
  else
    echo "==> 已在后台（unit pi-web-rebuild），现在可以关 SSH"
    echo "    回来后: journalctl -u pi-web-rebuild -e && systemctl status pi-web.service"
    exit 0
  fi
fi

cd "$(dirname "$SELF")"

# systemd-run 的默认 PATH 没有 nvm，补上
if ! command -v node >/dev/null 2>&1; then
  for d in /root/.nvm/versions/node/*/bin; do
    [ -x "$d/node" ] && export PATH="$d:$PATH"
  done
fi
command -v node >/dev/null 2>&1 || { echo "!! 找不到 node" >&2; exit 1; }

# 锁: 防并发 build；build 期间手动 start pi-web.service 也不会崩（ExecStartPre 会等锁释放）
LOCK=/run/pi-web.building
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "!! 已有 build 在跑（$LOCK 被占用），退出" >&2
  exit 1
fi
trap 'rm -f "$LOCK"' EXIT

echo "==> [1/3] 停止 pi-web.service（释放内存给 build）..."
systemctl stop pi-web.service

echo "==> [2/3] npm run build ..."
if npm run build; then
  echo "==> [3/3] 构建成功，启动 pi-web.service ..."
  rm -f "$LOCK"   # 先解锁再启动，否则 ExecStartPre 会死等
  systemctl start pi-web.service
  sleep 3
  code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:30141/ || true)
  echo "==> 完成 $(date)"
  echo "    服务: $(systemctl is-active pi-web.service)   HTTP /: ${code:-无响应}（401=密码门，正常）"
else
  echo "!! 构建失败：pi-web.service 保持停止，避免加载半截的 .next。" >&2
  echo "!! 修复后重跑 ./build.sh 即可。" >&2
  exit 1
fi
