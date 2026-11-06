#!/usr/bin/env bash
# deepai-mem installer — links the extension and prompt templates into pi's agent dirs.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXT="$SCRIPT_DIR/extension/deepai-mem.ts"

link_ext() {
  local dir="$1"
  mkdir -p "$dir/extensions" "$dir/prompts"
  if [[ -e "$dir/extensions/deepai-mem.ts" && ! -L "$dir/extensions/deepai-mem.ts" ]]; then
    mv "$dir/extensions/deepai-mem.ts" "$dir/extensions/deepai-mem.ts.bak.$(date +%s)"
    echo "  backed up existing deepai-mem.ts"
  fi
  ln -sfn "$EXT" "$dir/extensions/deepai-mem.ts"
  for f in "$SCRIPT_DIR"/prompts/*.md; do
    ln -sfn "$f" "$dir/prompts/$(basename "$f")"
  done
  echo "  linked: $dir/extensions/deepai-mem.ts + $(ls "$SCRIPT_DIR"/prompts/*.md | wc -l | tr -d ' ') prompt templates"
}

# 1) 素の pi (~/.pi/agent)
link_ext "$HOME/.pi/agent"

# 2) PI_CODING_AGENT_DIR が設定されている場合(DeepAI Code 等)
if [[ -n "${PI_CODING_AGENT_DIR:-}" && "$PI_CODING_AGENT_DIR" != "$HOME/.pi/agent" ]]; then
  link_ext "$PI_CODING_AGENT_DIR"
fi

echo
echo "✅ deepai-mem installed."
echo "   新しいチャット/セッションを開けば有効になります。"
echo "   メモリ保存先: ~/.pi/agent/memory/<プロジェクト>/"
