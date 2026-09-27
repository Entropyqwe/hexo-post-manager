#!/bin/bash
set -euo pipefail
# 用法: ./install.sh <HEXO_ROOT> [THEME_NAME]
HEXO="${1:?用法 ./install.sh /path/hexo工程 [主题名]}"
THEME="${2:-themes/firefly}"
TH="$HEXO/$THEME"
[ -d "$TH/layout" ] || { echo "找不到主题目录: $TH"; exit 1; }
mkdir -p "$TH/layout/_partials" "$HEXO/cloudflare-pages/functions"

cp theme-files/layout/_partials/post-manager.ejs "$TH/layout/_partials/post-manager.ejs"
cp cloudflare-pages/functions/manage.js "$HEXO/cloudflare-pages/functions/manage.js"

# 自动挂载到布局 </body> 前
python3 - "$TH" <<'PY'
import sys, os
th = sys.argv[1]
lay = os.path.join(th, 'layout', 'layout.ejs')
need = "  <%- partial('_partials/post-manager') %>"
if os.path.isfile(lay):
    s = open(lay, encoding='utf-8').read()
    if need not in s:
        s = s.replace('</body>', need + '\n</body>') if '</body>' in s else s + '\n' + need + '\n'
        open(lay, 'w', encoding='utf-8').write(s)
    print('post-manager.ejs 已挂载到', lay)
else:
    print('⚠️ 未找到 layout.ejs，请手动挂载: ' + need)
PY

echo "✅ 安装完成"
echo
echo "接下来两步："
echo "  1) 主题配置 ($TH/_config.yml) 加入："
echo "       manage:"
echo "         enabled: true"
echo "         # endpoint 省略则复用 upload.endpoint"
echo "  2) cp .env.example .env 并填写，然后 ./deploy.sh 部署云函数"
