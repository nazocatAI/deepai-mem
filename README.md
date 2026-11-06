# deepai-mem

**claude-mem 風の永続メモリ拡張** for [pi](https://github.com/earendil-works/pi) / DeepAI Code。

「記憶がなくなっていることがある」問題を、**メモリ(要点)** と **履歴(実物)** の両輪で解決します。

## 特徴

- 🧠 **毎ターン自動注入** — メモリを system prompt に毎回再注入するので、**コンパクション(会話圧縮)でも新セッションでも記憶が消えない**
- 💬 **2層スコープ** — `project`(全チャット共有)と `chat`(チャット固有。そのチャット再開時のみ注入)
- 🤖 **自動記録** — 各実行終了後、バックグラウンドで LLM が重要事実を抽出して保存。指示不要・非ブロッキング
- 📚 **過去チャット一括取り込み(バックフィル)** — 既存セッションを自動解析してメモリ化。chat スコープは元セッションに紐付くので、古いチャットを再開すると当時の文脈が戻る
- 🕰️ **history_recall** — 生セッション履歴(コンパクション後も残る)から過去のやり取りを一字一句復元・検索
- 💰 **実質ゼロコスト** — 抽出用 LLM は DeepAI の GLM 5.3 Flash(無料)を使用

## インストール

```bash
git clone https://github.com/YOUR_USERNAME/deepai-mem.git
cd deepai-mem
./install.sh
```

`install.sh` は次を行います:

1. `~/.pi/agent/extensions/` と `~/.pi/agent/prompts/` にシンボリックリンクを作成(素の pi 用)
2. `PI_CODING_AGENT_DIR` が設定されていれば(DeepAI Code など)、そちらにもリンク(既存ファイルは退避)

その後 **新しいチャットを開けば有効** になります(既に開いているチャットは開き直してください)。

### 手動インストール

```bash
ln -s "$(pwd)/extension/deepai-mem.ts" ~/.pi/agent/extensions/deepai-mem.ts
mkdir -p ~/.pi/agent/prompts
ln -s "$(pwd)/prompts" ~/.pi/agent/prompts   # または各 .md をコピー
```

## 使い方

基本は**何もしなくて動きます**。会話するだけで、重要な事実が自動記録され、次回以降のチャットに自動注入されます。

### ツール(モデルが自動使用)

| ツール | 説明 |
|---|---|
| `memory_save` | 保存(scope=`project` 全チャット共有 / `chat` このチャット限定) |
| `memory_search` | 全メモリを全文検索 |
| `memory_forget` | ID 指定で削除 |
| `history_recall` | このチャットの生履歴を再生・検索(圧縮後の復元に最適) |
| `mem_manage` | `import`(バックフィル実行)/ `stats`(統計表示) |

### スラッシュコマンド / テンプレート

| コマンド | 動作 |
|---|---|
| `/mem` | メモリ表示・手動追記 |
| `/mem-import` | 過去チャットを取り込む |
| `/mem-stats` | 保存状況を表示 |
| `/mem-save <内容>` | 手動保存 |
| `/mem-find <語>` | 検索 |
| `/mem-forget <ID/語>` | 削除 |
| `/recall [語]` | チャットの過去のやり取りを再生 |

スラッシュコマンドが UI 側で握り潰されるホストでは、自然言語で「メモリを取り込んで」「メモリの状態を見せて」などと言えば `mem_manage` が呼ばれます。

## 保存先

```
~/.pi/agent/memory/<プロジェクトスラッグ>/
├── MEMORY.md        # project スコープ(人間も直接編集OK)
├── log.jsonl        # 全履歴(削除記録含む)
├── imported.json    # バックフィル済みセッション管理
└── chats/
    ├── <セッションID>.md   # chat スコープ
    └── ...
```

## 仕組み

1. `before_agent_start` で毎ターン system prompt の `project_memory` セクションにメモリを注入(pi のセクション差分更新を利用するためキャッシュも効く)
2. `agent_settled` 後にバックグラウンドで GLM 5.3 Flash が直近のやり取りから永続化すべき事実を抽出(重複は自動スキップ、20秒間隔スロットル)
3. `session_start` で未取り込みセッションを検出 → バックフィル。`chat` スコープは元セッション ID に紐付け
4. コンパクション検出(`session_compact` / セッションファイル解析)で「経緯ダイジェスト」を注入し、詳細は `history_recall` で引き出す運用に誘導
5. プロセス終了時は `session_shutdown` で実行中の抽出完了を待つ(`pi -p` でも記録が漏れない)

## 要件

- pi 1.5+(`@earendil-works/pi-coding-agent`)
- 抽出用モデル: DeepAI GLM 5.3 Flash(無料)。別のモデルに変えたい場合は `extension/deepai-mem.ts` 内の `EXTRACTOR_MODEL_ID` / `EXTRACTOR_PROVIDER` を編集してください

## LICENSE

MIT
