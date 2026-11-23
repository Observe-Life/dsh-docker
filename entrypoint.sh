#!/bin/bash
set -e
LAN_IP="${DSH_LAN_IP:-192.168.31.115}"
BIND_IP="${DSH_BIND_IP:-172.23.0.51}"

# ---- TLS 证书（持久化 /data/certs；SAN 覆盖内网地址）----
mkdir -p /data/certs
if [ ! -f /data/certs/server.crt ]; then
  openssl req -x509 -nodes -newkey rsa:2048 -days 825 \
    -keyout /data/certs/server.key -out /data/certs/server.crt \
    -subj "/CN=$LAN_IP" \
    -addext "subjectAltName=IP:$LAN_IP,IP:127.0.0.1,DNS:localhost"
  echo "[entrypoint] TLS 证书已生成"
fi

# ---- profile 物化与插件挂载（幂等；物化失败即退出）----
if [ ! -f /data/profiles/web/cordis.patch.yml ]; then
  echo "[entrypoint] 首次启动：物化 profile..."
  dsh web --port 3080 --no-open >/tmp/dsh-firstboot.log 2>&1 &
  FB=$!
  ok=0
  for i in $(seq 1 120); do
    [ -f /data/profiles/web/cordis.patch.yml ] && { ok=1; break; }
    sleep 1
  done
  sleep 3
  kill "$FB" 2>/dev/null || true
  wait "$FB" 2>/dev/null || true
  if [ "$ok" != "1" ]; then echo "[entrypoint] profile 物化失败" >&2; exit 1; fi
  echo "[entrypoint] profile 已就绪"
fi
node -e '
const fs = require("fs");
const p = "/data/profiles/web/cordis.patch.yml";
let s = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
if (s.includes("host-authentication-login")) process.exit(0);
const entry = "- insert:\n    - name: \"@local/dsh-host-authentication-login\"\n      config:\n        authUser: \"bingcan\"\n        authPass: \"fwq01byLin.\"\n";
if (/^\[\]\s*$/m.test(s)) {
  s = s.replace(/^\[\]\s*$/m, entry);
} else {
  s = s.replace(/\s*$/, "") + "\n" + entry;
}
const tmp = p + ".tmp";
fs.writeFileSync(tmp, s);
fs.renameSync(tmp, p);
console.log("[entrypoint] 登录插件挂载已写入");
'

# ---- 登录插件就位（镜像内置；软链官方依赖树，放入数据卷解析路径；幂等）----
# 必须在首次物化之后执行：物化过程会清理数据根 node_modules 里的外来包
NM=/data/node_modules
mkdir -p "$NM/@local"
rm -rf "$NM/@local/dsh-host-authentication-login"
cp -r /opt/dsh-login/plugin "$NM/@local/"
ln -sfn /usr/local/lib/node_modules/@deepseek-ai "$NM/@deepseek-ai"
echo "[entrypoint] 登录插件已就位（镜像内置版）"

# ---- 正式启动（登录跳转补丁已在镜像构建期应用，无需重放）----
mkdir -p /data/run
TRUSTED="${DSH_TRUSTED_HOST:-$LAN_IP}"
dsh web --host "$BIND_IP" --port 3080 --no-open \
  --tls-cert /data/certs/server.crt --tls-key /data/certs/server.key \
  --public-url "https://$LAN_IP:3080/" \
  --trusted-host "$TRUSTED" >/tmp/dsh-web.log 2>&1 &
DSPID=$!
trap 'kill "$DSPID" 2>/dev/null' TERM INT
started=0
for i in $(seq 1 90); do
  if (exec 3<>/dev/tcp/"$BIND_IP"/3080) 2>/dev/null; then exec 3>&- 3<&-; echo "[entrypoint] dsh READY (bind $BIND_IP, https)"; started=1; break; fi
  sleep 1
done
if [ "$started" != "1" ]; then echo "[entrypoint] WARNING: dsh 90s 未就绪" >&2; tail -30 /tmp/dsh-web.log >&2; fi
echo "[entrypoint] container up: official dsh + baked login plugin"
wait "$DSPID"
