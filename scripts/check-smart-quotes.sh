#!/bin/bash
# 检查源代码中的智能引号
# 智能引号会导致 JavaScript 语法错误

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m' # No Color

echo "🔍 Checking for smart quotes in source files..."

# 要检查的目录
DIRS="src proxy-scripts/src resources/webviews"

found=0

for dir in $DIRS; do
  if [ ! -d "$dir" ]; then
    continue
  fi

  # 查找包含智能引号的文件（使用 grep -P 和十六进制模式）
  while IFS= read -r file; do
    if grep -qP '\x{201C}|\x{201D}' "$file" 2>/dev/null; then
      echo -e "${RED}❌ Found smart quotes in: $file${NC}"

      # 显示具体位置
      grep -nP '\x{201C}|\x{201D}' "$file" | head -3

      found=$((found + 1))
    fi
  done < <(find "$dir" -type f \( -name "*.js" -o -name "*.ts" -o -name "*.json" \) 2>/dev/null)
done

if [ $found -eq 0 ]; then
  echo -e "${GREEN}✅ No smart quotes found!${NC}"
  exit 0
else
  echo -e "${RED}❌ Found smart quotes in $found file(s)${NC}"
  echo ""
  echo "To fix automatically, run:"
  echo "  perl -i -pe 's/\\xe2\\x80\\x9c/\"/g; s/\\xe2\\x80\\x9d/\"/g' <file>"
  exit 1
fi
