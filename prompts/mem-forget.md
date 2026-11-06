---
description: メモリを削除する
argument-hint: "<ID または 検索語>"
---
引数「$ARGUMENTS」が数値(ID)なら、その ID のメモリを `memory_forget` ツールで削除して。
数値でなければ、まず `memory_search` で検索して該当候補を提示し、どれを削除するか確認してから `memory_forget` で削除して。
