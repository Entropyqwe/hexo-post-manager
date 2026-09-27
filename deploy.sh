#!/bin/bash
#
# deploy.sh —— 把云函数部署到 Cloudflare Pages
#
# 两个容易踩的坑（都实测过）：
#   坑 1：`wrangler pages deploy <目录>` 只在「当前工作目录」下找 functions/，
#         所以必须在 cloudflare-pages 目录**内部**执行 `deploy .`。
#         在上一级执行 `deploy cloudflare-pages` 只会传静态资源，
#         **函数不会被打包**（日志里看不到 "Uploading Functions bundle"）。
#   坑 2：`wrangler pages secret put` 是从 **stdin** 读值的。
#         千万不要给它加 `</dev/null`，那会把管道输入覆盖成空，
#         结果是密钥"创建成功"但值为空，函数里 `env.ADMIN_KEY` 为 falsy。
#   另：Secret 只对新部署生效 —— 所以顺序必须是
#       先部署 → 写密钥 → 再部署一次。
#
set -euo pipefail
[ -f .env ] && set -a && . ./.env && set +a
# CLOUDFLARE_API_TOKEN 可留空：留空则直接使用 `wrangler login` 的登录态
: "${REPO:?REPO 未填}"
: "${BRANCH:?BRANCH 未填}"
: "${ADMIN_KEY:?ADMIN_KEY 未填}"
CF_PROJECT="${CF_PROJECT:-entropy-upload}"

# 部署目录：默认取同目录下的 cloudflare-pages
FUNCS_DIR="${FUNCS_DIR:-cloudflare-pages}"
[ -d "$FUNCS_DIR/functions" ] || { echo "找不到 $FUNCS_DIR/functions"; exit 1; }

# 复用已存在的 Pages 项目（必须与发布/相册插件同一个项目，/manage 才会挂在同一域名下）
npx --yes wrangler pages project create "$CF_PROJECT" --production-branch main 2>/dev/null || true

# ---- 第一次部署（把函数传上去）---------------------------------------
# 注意：先 cd 进去再 deploy .（见上面「坑 1」）
echo "── 部署函数 ──"
( cd "$FUNCS_DIR" && npx --yes wrangler pages deploy . --project-name "$CF_PROJECT" --branch main )

# ---- 写密钥（服务端 Secret，前端拿不到）------------------------------
# 注意：绝不能加 </dev/null（见上面「坑 2」）
echo "── 写入密钥 ──"
echo "$ADMIN_KEY" | npx --yes wrangler pages secret put ADMIN_KEY --project-name "$CF_PROJECT"
echo "$REPO"      | npx --yes wrangler pages secret put REPO      --project-name "$CF_PROJECT"
echo "$BRANCH"    | npx --yes wrangler pages secret put BRANCH    --project-name "$CF_PROJECT"

# GITHUB_TOKEN 通常已由先前的插件配置过；填空则跳过，避免覆盖
if [ -n "${GITHUB_TOKEN:-}" ]; then
  echo "$GITHUB_TOKEN" | npx --yes wrangler pages secret put GITHUB_TOKEN --project-name "$CF_PROJECT"
  echo "GITHUB_TOKEN 已更新"
else
  echo "GITHUB_TOKEN 留空，沿用项目里已有的值"
fi

# ---- 第二次部署（让新密钥生效）---------------------------------------
echo "── 重新部署以激活密钥 ──"
( cd "$FUNCS_DIR" && npx --yes wrangler pages deploy . --project-name "$CF_PROJECT" --branch main )

echo
echo "✅ 部署完成: https://$CF_PROJECT.pages.dev"
echo
echo "── 自检 ──"
code=$(curl -s -o /tmp/_mg.json -w '%{http_code}' -X POST "https://$CF_PROJECT.pages.dev/manage" \
  -H 'content-type: application/json' -d "{\"key\":\"$ADMIN_KEY\",\"action\":\"verify\"}")
echo "  /manage verify -> HTTP $code  $(cat /tmp/_mg.json 2>/dev/null)"
[ "$code" = "200" ] && echo "  ✅ 可用" || echo "  ❌ 异常：若返回 500「未配置 ADMIN_KEY」，说明密钥写入失败，检查是否误加了 </dev/null"
