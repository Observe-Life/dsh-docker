# dsh-docker：DeepSeek Harness 自建 Docker 镜像流水线

官方 deepseek-ai/deepseek-harness 只发布 npm 包、不发布 Docker 镜像。本仓库用 GitHub Actions 云构建，把官方 npm 包打成自建镜像，并把登录插件烤入镜像（打开内网网址即登录页，无外层壳、无令牌网址）。

## 镜像内容

- 官方 `@deepseek-ai/dsh` npm 包整装（版本由构建时指定，钉死不漂移）
- 自研登录插件 `@local/dsh-host-authentication-login`（镜像内置）：官方匿名路由 `/login` 提供账号密码登录页，签发与官方同协议的登录 Cookie
- 构建期登录跳转补丁：未登录访问首页 → 302 跳转 `/login`（锚点校验：命中数必须恰好为 1，否则构建失败）
- 构建期中文技能名补丁：3 处正则放宽为 Unicode 字母（技能总校验、`/手势`、网页端角标），中文技能名可被发现、注入、按名调用；输入框补全无需改动
- 自签 TLS 证书在容器首次启动时生成（持久化于数据卷）

## 如何构建新版本镜像

1. 到本仓库 Actions 页选 build-image，点 Run workflow；
2. 填官方 dsh 版本号（在官方 npm 包 `@deepseek-ai/dsh` 的版本列表里选，官方发布页 dsh-vX.Y.Z 对应 npm 版本 X.Y.Z）；
3. 构建完成后镜像发布到 `ghcr.io/<所有者小写>/dsh:<版本>` 和 `:latest`。

跟踪官方更新的节奏完全手动：不自动跟踪，官方有新版时（看官方 GitHub releases）再回来手动构建。

## 如何部署

```yaml
# compose 片段（deepseek-harness 容器）
image: ghcr.io/<所有者小写>/dsh:0.2.2-rc.5
environment:
  - DSH_LAN_IP=192.168.31.115     # 对外公布的内网地址
  - DSH_BIND_IP=172.23.0.51       # 容器内监听地址（自建网桥固定 IP）
  - DSH_TRUSTED_HOST=192.168.31.115
```

登录插件、跳转补丁均已烤入镜像，启动时无需再打补丁；登录账号密码在数据卷的 `cordis.patch.yml`（首次启动自动写入，改密码即编辑该文件后重启容器）。

## 升级新版本前须知

官方仍在快速迭代期（预发布版本、含破坏性变更）。升级时构建流水线的锚点校验会自动把关：若官方改动导致补丁锚点失效，构建会直接失败并明说，不会产出错误镜像；此时需要人工核对官方改动、更新对应补丁脚本（`scripts/apply-login-patch.js`、`scripts/apply-chinese-skill-patch.js`）的锚点后再构建。
