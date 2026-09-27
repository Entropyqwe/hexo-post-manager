#!/bin/bash
set -euo pipefail
[ -f .env ] && set -a && . ./.env && set +a
: "${CLOUDFLARE_API_TOKEN:?请先 cp .env.example .env 并填写}"
: "${REPO:?REPO 未填}"
: "${BRANCH:?BRANCH 未填}"
: "${ADMIN_KEY:?ADMIN_KEY 未填}"
CF_PROJECT="${CF_PROJECT:-entropy-quick-post}"

# 复用已存在的 Pages 项目（必须与发布/相册插件同一个项目，/manage 才会挂在同一域名下）
npx --yes wrangler pages project create "$CF_PROJECT" --production-branch main 2>/dev/null || true

# 部署云函数（整个 functions 目录一起上传；manage.js 会与 publish.js/upload.js 共存）
npx --yes wrangler pages deploy cloudflare-pages --project-name "$CF_PROJECT" --branch main

# 写入密钥（服务端 Secret，前端拿不到）
echo "$ADMIN_KEY"  | npx --yes wrangler pages secret put ADMIN_KEY    --project-name "$CF_PROJECT"
echo "$REPO"       | npx --yes wrangler pages secret put REPO         --project-name "$CF_PROJECT"
echo "$BRANCH"     | npx --yes wrangler pages secret put BRANCH       --project-name "$CF_PROJECT"

# GITHUB_TOKEN 通常已由先前的插件配置过；填空则跳过，避免覆盖
if [ -n "${GITHUB_TOKEN:-}" ]; then
  echo "$GITHUB_TOKEN" | npx --yes wrangler pages secret put GITHUB_TOKEN --project-name "$CF_PROJECT"
  echo "GITHUB_TOKEN 已更新"
else
  echo "GITHUB_TOKEN 留空，沿用项目里已有的值"
fi

echo
echo "✅ 部署完成: https://$CF_PROJECT.pages.dev"
echo "   验证端点: curl -X POST https://$CF_PROJECT.pages.dev/manage -H 'content-type: application/json' -d '{\"key\":\"$ADMIN_KEY\",\"action\":\"verify\"}'"
