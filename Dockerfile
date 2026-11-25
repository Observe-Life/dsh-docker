# 自建 dsh 镜像：官方 npm 包整装 + 自研登录插件烤入 + 登录跳转补丁（构建期应用、锚点校验）
# 构建：GitHub Actions（.github/workflows/build.yml），版本号由运行时指定
FROM node:24-slim

ARG DSH_VERSION=0.2.2-rc.5

# 官方软件整装（全局安装；程序位于 /usr/local/lib/node_modules/@deepseek-ai/dsh）
RUN npm install -g --omit=dev "@deepseek-ai/dsh@${DSH_VERSION}"

# 基础工具（tini 作 1 号进程收尸；openssl 生成自签证书）
RUN apt-get update -qq && apt-get install -y --no-install-recommends tini openssl python3 curl git \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable pnpm && corepack prepare pnpm@latest --activate

# 登录跳转补丁：构建期应用，锚点必须恰好命中一处，否则构建直接失败
COPY scripts/apply-login-patch.js /opt/dsh-login/apply-login-patch.js
RUN node /opt/dsh-login/apply-login-patch.js

# 中文技能名补丁：3 处正则放宽为 Unicode 字母（技能总校验 / 斜杠手势 / 网页端角标），
# 使中文技能名可被发现、注入、按名调用；锚点校验同上
COPY scripts/apply-chinese-skill-patch.js /opt/dsh-patches/apply-chinese-skill-patch.js
RUN node /opt/dsh-patches/apply-chinese-skill-patch.js

# 自研登录插件（镜像内置）与启动脚本
COPY plugin/ /opt/dsh-login/plugin/
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# 插件依赖链接（登录插件 import 的官方包在全局 dsh 的 node_modules 下，测试期需可解析）
RUN ln -s /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules /opt/dsh-login/plugin/node_modules

# 补丁后行为回归测试：任一断言失败即构建失败（锚点漂移之外的最后一道行为把关）
COPY scripts/tests/ /opt/dsh-patches/tests/
RUN node /opt/dsh-patches/tests/test-skill-patch.mjs \
    && PLUGIN_PATH=/opt/dsh-login/plugin/index.js node /opt/dsh-patches/tests/test-login-plugin.mjs

# 官方数据根：profile/凭据等工作目录由 DSH_HOME 指向数据卷（与官方约定一致）
ENV DSH_HOME=/data

# 默认绑定：DSH_LAN_IP=对外公布的内网地址；DSH_BIND_IP=容器内监听地址（部署时可用环境变量覆盖）
ENV DSH_LAN_IP=192.168.31.115 DSH_BIND_IP=172.23.0.51 DSH_TRUSTED_HOST=192.168.31.115

EXPOSE 3080
ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
