/**
 * deepai-mem — claude-mem 風の永続メモリ拡張 for pi / DeepAI Code
 *
 * 2層スコープ:
 *  - project : プロジェクト(cwd)共通のメモリ。全チャットで共有。
 *  - chat    : チャット(セッションID)固有のメモリ。そのチャットを再開したときだけ注入。
 *
 * 機能:
 *  - 毎ターン system prompt へ自動注入(コンパクション/新セッションでも消えない)
 *  - 自動記録: 各実行終了(agent_settled)後、バックグラウンドで LLM が重要事実を抽出して保存
 *    (セッションはブロックしない = 同時起動/並行動作)
 *  - memory_save / memory_search / memory_forget ツール(scope 対応)
 *  - /mem コマンド(一覧・手動追記)
 *  - フッターウィジェットに件数表示
 *
 * 保存先: ~/.pi/agent/memory/<project-slug>/MEMORY.md + log.jsonl + chats/<sessionId>.md
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

interface MemLogEntry {
	id: number;
	ts: string;
	content: string;
	tags?: string[];
	scope: "project" | "chat";
	chatId?: string;
	forgotten?: boolean;
	auto?: boolean;
}

type Scope = "project" | "chat";

const MEMORY_CHAR_LIMIT = 6000; // 注入する本文の上限(超過時は末尾のみ)
const AUTO_MIN_INTERVAL_MS = 20_000; // 自動記録の最小間隔(連発防止)
const AUTO_MAX_TOKENS = 800;
const BACKFILL_TRANSCRIPT_LIMIT = 16_000; // 過去セッション1件あたりの解析上限
const EXTRACTOR_PROVIDER = "deepai";
const EXTRACTOR_MODEL_ID = "glm-5.3-flash"; // 自動記録用 LLM(無料・無制限)

function memDir(cwd: string): string {
	const slug =
		cwd
			.replace(os.homedir(), "~")
			.replace(/[^a-zA-Z0-9._~-]+/g, "_")
			.replace(/^_+/, "")
			.slice(0, 80) || "default";
	return path.join(os.homedir(), ".pi", "agent", "memory", slug);
}

function projectMemoryFile(cwd: string): string {
	return path.join(memDir(cwd), "MEMORY.md");
}

function chatMemoryFile(cwd: string, chatId: string): string {
	return path.join(memDir(cwd), "chats", `${chatId}.md`);
}

function logFile(cwd: string): string {
	return path.join(memDir(cwd), "log.jsonl");
}

function ensureDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
}

/** 現在のチャット(セッション)ID */
function chatId(ctx: any): string {
	try {
		const sm = ctx?.sessionManager;
		const id = sm?.getSessionId?.() || (sm?.getSessionFile?.() ? path.basename(String(sm.getSessionFile())).replace(/\.jsonl$/, "") : "");
		if (id) return String(id).slice(0, 12); // 先頭12桁で十分一意
	} catch {
		/* fall through */
	}
	return process.env.PI_SESSION_ID
		? process.env.PI_SESSION_ID.slice(0, 12)
		: "adhoc";
}

function readFileSafe(file: string): string {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return "";
	}
}

function readLog(cwd: string): MemLogEntry[] {
	return readFileSafe(logFile(cwd))
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l) as MemLogEntry);
}

function appendLog(cwd: string, entry: MemLogEntry): void {
	ensureDir(memDir(cwd));
	fs.appendFileSync(logFile(cwd), JSON.stringify(entry) + "\n");
}

function nextId(cwd: string): number {
	return readLog(cwd).reduce((m, e) => Math.max(m, e.id), 0) + 1;
}

/** 指定スコープのメモリファイルに1行追記。id タグ [m<n>] を付けて対応付け */
function appendMemoryLine(cwd: string, scope: Scope, chatIdStr: string, id: number, content: string): string {
	const file =
		scope === "chat" ? chatMemoryFile(cwd, chatIdStr) : projectMemoryFile(cwd);
	ensureDir(path.dirname(file));
	let existing = readFileSafe(file);
	const header = existing.startsWith("# ") ? "" : "# Memory\n\n";
	const line = `- [m${id}] ${content.replace(/\n+/g, " ").trim()}\n`;
	fs.writeFileSync(file, header + existing.replace(/^# Memory\n+/, "") + line);
	return file;
}

/** メモリファイルから指定 id の行を削除 */
function removeFromMemoryFile(file: string, id: number): boolean {
	const text = readFileSafe(file);
	if (!text) return false;
	const marker = `[m${id}]`;
	const lines = text.split("\n").filter((l) => !l.includes(marker));
	const joined = lines.join("\n");
	if (joined === text) return false;
	fs.writeFileSync(file, joined);
	return true;
}

/** 注入する本文(上限超過時は末尾を優先) */
function memoryForInjection(cwd: string, file: string): string {
	const raw = readFileSafe(file);
	if (!raw.trim()) return "";
	let body = raw;
	if (raw.length > MEMORY_CHAR_LIMIT) {
		body =
			"…(古いエントリは省略。memory_search で全文検索可)…\n" +
			raw.split("\n").slice(-120).join("\n");
	}
	return body.trim();
}

function searchMemories(cwd: string, chatIdStr: string, query: string, limit: number): string[] {
	const q = query.toLowerCase();
	const hits: string[] = [];
	for (const line of readFileSafe(projectMemoryFile(cwd)).split("\n")) {
		if (line.toLowerCase().includes(q)) hits.push(`[project] ${line.trim()}`);
	}
	for (const line of readFileSafe(chatMemoryFile(cwd, chatIdStr)).split("\n")) {
		if (line.toLowerCase().includes(q)) hits.push(`[chat] ${line.trim()}`);
	}
	for (const e of readLog(cwd)) {
		if (e.forgotten) continue;
		const hay = (e.content + " " + (e.tags ?? []).join(" ")).toLowerCase();
		if (hay.includes(q))
			hits.push(`log[m${e.id}|${e.scope}] (${e.ts}): ${e.content}`);
	}
	return hits.slice(-limit);
}

/** 重複検出用: 既存メモリ本文の正規化セット */
function existingContents(cwd: string, cid: string): Set<string> {
	const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").slice(0, 100);
	const set = new Set<string>();
	for (const l of readFileSafe(projectMemoryFile(cwd)).split("\n")) {
		const m = l.match(/\[m\d+\]\s*(.*)/);
		if (m) set.add(norm(m[1]));
	}
	for (const l of readFileSafe(chatMemoryFile(cwd, cid)).split("\n")) {
		const m = l.match(/\[m\d+\]\s*(.*)/);
		if (m) set.add(norm(m[1]));
	}
	for (const e of readLog(cwd)) {
		if (!e.forgotten) set.add(norm(e.content));
	}
	return set;
}

/** メッセージ配列を抽出用テキストへ(容量制限あり) */
function messagesToTranscript(messages: any[], limit = 6000): string {
	const parts: string[] = [];
	for (const m of messages) {
		const role = m.role ?? "?";
		let text = "";
		if (typeof m.content === "string") {
			text = m.content;
		} else if (Array.isArray(m.content)) {
			text = m.content
				.map((c: any) => (c?.type === "text" ? c.text : c?.type === "thinking" ? "" : `[${c?.type}]`))
				.filter(Boolean)
				.join(" ");
		}
		if (text.trim()) parts.push(`${role}: ${text.replace(/\s+/g, " ").slice(0, 1500)}`);
	}
	let out = parts.join("\n");
	while (out.length > limit) {
		const idx = out.indexOf("\n", Math.floor(out.length - limit));
		out = "…(省略)…\n" + (idx === -1 ? out.slice(-limit) : out.slice(idx + 1));
	}
	return out;
}

/** 自動記録用 LLM は GLM 5.3 Flash 固定(見つからなければ現在のモデルにフォールバック) */
function pickExtractorModel(ctx: any): any {
	const reg = ctx?.modelRegistry;
	try {
		const m = reg?.find?.(EXTRACTOR_PROVIDER, EXTRACTOR_MODEL_ID);
		if (m) return m;
	} catch {
		/* fall through */
	}
	try {
		const avail: any[] = reg?.getAvailable?.() ?? [];
		const hit = avail.find((m: any) =>
			/m\.glm/i.test(`${m?.provider ?? ""}/${m?.id ?? ""}`),
		);
		if (hit) return hit;
	} catch {
		/* fall through */
	}
	return ctx?.model;
}

/** 過去セッションファイルから user/assistant のテキストを抽出 */
function transcriptFromSessionFile(file: string): { chatId: string; transcript: string } {
	const base = path.basename(file);
	// ファイル名: <ISOタイムスタンプ>_<セッションID>.jsonl → セッションID先頭12桁をチャットIDに
	const idMatch = base.match(/_([0-9a-f-]{36})\.jsonl$/i);
	const chatIdStr = idMatch ? idMatch[1].slice(0, 12) : base.replace(/\.jsonl$/, "").slice(-12);
	const parts: string[] = [];
	try {
		for (const line of fs.readFileSync(file, "utf8").split("\n")) {
			if (!line.trim()) continue;
			let entry: any;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			const msg = entry?.type === "message" ? entry.message : entry?.message;
			const role = msg?.role;
			if (role !== "user" && role !== "assistant") continue;
			let text = "";
			if (typeof msg.content === "string") text = msg.content;
			else if (Array.isArray(msg.content))
				text = msg.content
					.map((c: any) => (c?.type === "text" ? c.text : c?.type === "thinking" ? "" : ""))
					.filter(Boolean)
					.join(" ");
			if (text.trim()) parts.push(`${role}: ${text.replace(/\s+/g, " ").slice(0, 1500)}`);
		}
	} catch {
		return { chatId: chatIdStr, transcript: "" };
	}
	return { chatId: chatIdStr, transcript: parts.join("\n").slice(-BACKFILL_TRANSCRIPT_LIMIT) };
}

/** 抽出用 LLM プロンプト */
function extractionPrompt(existing: Set<string>, transcript: string): string {
	const known = [...existing].slice(-40).join("\n- ");
	return [
		"以下はコーディングセッションの最近のやり取りです。次回以降に役立つ「永続化すべき事実」を抽出してください。",
	'- project スコープ: ユーザーの好み、プロジェクトの決定事項、環境の事実、ハマりどころ(全チャットで共有すべきもの)',
	'- chat スコープ: このチャット内だけで有効な経緯・作業状態',
	"- 一時的な作業内容、コードの中身、自明なことは保存しない。新規の事実が何もなければ [] だけを返す。",
	"- 出力は JSON 配列のみ(説明文なし)。最大5件。content は簡潔に1文で。",
	'  形式: [{"scope":"project"|"chat","content":"...","tags":["..."]}]',
	"",
	"既存メモリ(これと重複するものは保存しない):",
	known ? "- " + known : "(なし)",
	"",
	"--- やり取り ---",
	transcript,
	].join("\n");
}

function parseExtractionText(text: string): { scope: Scope; content: string; tags?: string[] }[] {
	const m = text.match(/\[[\s\S]*\]/);
	if (!m) return [];
	try {
		const arr = JSON.parse(m[0]);
		if (!Array.isArray(arr)) return [];
		return arr
			.filter((e: any) => e && typeof e.content === "string" && e.content.trim())
			.map((e: any) => ({
				scope: e.scope === "chat" ? ("chat" as Scope) : ("project" as Scope),
				content: String(e.content).trim(),
				tags: Array.isArray(e.tags) ? e.tags.map(String).slice(0, 4) : undefined,
			}))
			.slice(0, 5);
	} catch {
		return [];
	}
}

/** セッションファイルから user/assistant の生履歴とコンパクション有無を抽出 */
function readSessionHistory(sessionFile: string | undefined): {
	msgs: { role: string; text: string }[];
	hasCompaction: boolean;
} {
	const msgs: { role: string; text: string }[] = [];
	let hasCompaction = false;
	if (!sessionFile || !fs.existsSync(sessionFile)) return { msgs, hasCompaction };
	try {
		for (const line of fs.readFileSync(sessionFile, "utf8").split("\n")) {
			if (!line.trim()) continue;
			let entry: any;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			if (entry?.type === "compaction") hasCompaction = true;
			const msg = entry?.type === "message" ? entry.message : entry?.message;
			const role = msg?.role;
			if (role !== "user" && role !== "assistant") continue;
			let text = "";
			if (typeof msg.content === "string") text = msg.content;
			else if (Array.isArray(msg.content))
				text = msg.content
					.map((c: any) => (c?.type === "text" ? c.text : ""))
					.filter(Boolean)
					.join(" ");
			if (text.trim()) msgs.push({ role, text: text.replace(/\s+/g, " ").trim() });
		}
	} catch {
		/* 読めなければ空で返す */
	}
	return { msgs, hasCompaction };
}

/** 履歴ダイジェスト(ユーザーの発言番号付き一覧。コンパクション後の注入用) */
function historyDigest(msgs: { role: string; text: string }[], maxExchanges = 30): string {
	const userMsgs: string[] = [];
	for (const m of msgs) {
		if (m.role === "user") {
			userMsgs.push(m.text.slice(0, 150));
		}
	}
	if (userMsgs.length === 0) return "";
	const shown = userMsgs.slice(-maxExchanges);
	const startNo = Math.max(1, userMsgs.length - shown.length + 1);
	const lines = shown.map((t, i) => `${startNo + i}. ${t}`);
	return [
		"## このチャットの経緯ダイジェスト(過去のあなた=モデルへの依頼一覧)",
		...lines,
		"(詳細なやり取りを思い出すには history_recall ツールを使う)",
	].join("\n");
}

/** 完了済みインポート記録: セッションファイル名 → true */
function importedMap(cwd: string): Record<string, boolean> {
	try {
		return JSON.parse(readFileSafe(path.join(memDir(cwd), "imported.json")) || "{}");
	} catch {
		return {};
	}
}

function markImported(cwd: string, fileBase: string): void {
	ensureDir(memDir(cwd));
	const map = importedMap(cwd);
	map[fileBase] = true;
	fs.writeFileSync(path.join(memDir(cwd), "imported.json"), JSON.stringify(map));
}

/** LLM で抽出 → 重複除外して保存。保存件数を返す */
async function extractAndSave(
	ctx: any,
	cwd: string,
	cid: string,
	transcript: string,
	opts: { forceChatId?: string; label: string },
): Promise<number> {
	const model = pickExtractorModel(ctx);
	if (!model) throw new Error("no model for extraction");
	const existing = existingContents(cwd, cid);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 120_000);
	try {
		const response = await ctx.modelRegistry.complete(
			model,
			{
				systemPrompt:
					"あなたはセッション記録のアナライザです。指示どおり JSON 配列のみを出力してください。",
				messages: [
					{ role: "user", content: extractionPrompt(existing, transcript) },
				],
			} as any,
			{ signal: controller.signal, maxTokens: AUTO_MAX_TOKENS } as any,
		);
		const text = Array.isArray(response?.content)
			? response.content
					.filter((c: any) => c?.type === "text")
					.map((c: any) => c.text)
					.join("\n")
			: String(response?.content ?? "");
		const found = parseExtractionText(text);
		let saved = 0;
		for (const item of found) {
			const key = item.content.toLowerCase().replace(/\s+/g, " ").slice(0, 100);
			if (existing.has(key)) continue; // 重複は保存しない
			existing.add(key);
			const id = nextId(cwd);
			const scopeChatId = item.scope === "chat" ? (opts.forceChatId ?? cid) : cid;
			const suffix = item.tags?.length ? ` [${item.tags.join("/")}]` : "";
			appendLog(cwd, {
				id,
				ts: new Date().toISOString(),
				content: item.content,
				tags: item.tags,
				scope: item.scope,
				chatId: scopeChatId,
				auto: true,
			});
			appendMemoryLine(cwd, item.scope, scopeChatId, id, item.content + suffix);
			saved++;
		}
		return saved;
	} finally {
		clearTimeout(timer);
	}
}

/** ウィジェットの件数表示を更新 */
function refreshWidget(ctx: any, cwd: string, cid: string, note?: string): void {
	try {
		const log = readLog(cwd).filter((e) => !e.forgotten);
		const p = log.filter((e) => e.scope !== "chat").length;
		const c = log.filter((e) => e.scope === "chat" && e.chatId === cid).length;
		ctx.ui.setWidget("deepai-mem", [`mem: project ${p} / chat ${c} 件${note ? ` (${note})` : ""}`]);
	} catch {
		/* noop */
	}
}

export default function deepaiMem(pi: ExtensionAPI) {
	// ===== 自動記録の状態 =====
	let pendingMessages: any[] = [];
	let extracting = false;
	let backfilling = false;
	let backfillPending = false;
	let currentExtraction: Promise<void> = Promise.resolve();
	let lastExtractAt = 0;
	// LLM 抽出タスクの直列化キュー(ID 採番競合防止)。エラーで毒されないよう吸収する。
	let queue: Promise<any> = Promise.resolve();
	let historyDigestPending = false; // コンパクション後/再開時に履歴ダイジェストを注入する
	const enqueue = (task: () => Promise<any>): Promise<any> => {
		const p = queue.then(task);
		queue = p.catch(() => undefined);
		return p;
	};

	// ---- 毎ターンのメモリ注入(コンパクション/新セッションで消えない本丸) ----
	pi.on("before_agent_start", (event, ctx) => {
		const cwd = ctx.cwd ?? process.cwd();
		const cid = chatId(ctx);
		const project = memoryForInjection(cwd, projectMemoryFile(cwd));
		const chat = memoryForInjection(cwd, chatMemoryFile(cwd, cid));
		const rules = [
			"## メモリ運用ルール",
			"- ユーザーの好み、プロジェクトの決定事項、ハマりどころ、環境固有の事実を学んだら memory_save(scope=\"project\")で永続化する。",
			"- このチャット内でだけ有効な経緯・作業状態・約束ごとは memory_save(scope=\"chat\")で保存する。",
			"- 過去の経緯が思い出せない・足りないときは memory_search を使う(会話履歴が圧縮されていてもメモリは残っている)。",
			"- このチャット内の過去のやり取りそのもの(何を言った、何をした)を思い出すには history_recall を使う。特に会話が圧縮された後はこれが一次情報。",
			"- 誤りや古くなったメモリを見つけたら memory_forget で削除する。",
			"- 重要な事実は memory_save を明示的に使わなくても、実行終了後に自動記録される。",
			"- 保存するのは事実と決定のみ。コード全文や一時的な作業ファイルの中身は保存しない。",
		].join("\n");
		const sections: string[] = [];
		// コンパクション後/再開時は、圧縮で消えた過去の経緯をダイジェストで補う
		if (historyDigestPending) {
			const sessionFile = ctx.sessionManager?.getSessionFile?.();
			const hist = readSessionHistory(sessionFile);
			const digest = historyDigest(hist.msgs);
			if (digest) sections.push(digest);
			historyDigestPending = false;
		}
		if (chat) sections.push(`## このチャットのメモリ(chat スコープ)\n${chat}`);
		if (project) sections.push(`## プロジェクトメモリ(project スコープ・全チャット共有)\n${project}`);
		sections.push(rules);
		event.systemPromptOptions.sections.project_memory = sections.join("\n\n");
	});

	// ---- 実行終了ごとにメッセージを蓄積 ----
	pi.on("agent_end", (event) => {
		if (Array.isArray(event.messages)) pendingMessages.push(...event.messages);
	});

	// ---- agent_settled 後にバックグラウンド自動記録(同時起動・非ブロッキング) ----
	pi.on("agent_settled", async (event, ctx) => {
		if (event.aborted) {
			pendingMessages = [];
			return;
		}
		if (extracting || pendingMessages.length === 0) return;
		if (Date.now() - lastExtractAt < AUTO_MIN_INTERVAL_MS) return;

		const cwd = ctx.cwd ?? process.cwd();
		const cid = chatId(ctx);
		if (!pickExtractorModel(ctx)) return;

		const messages = pendingMessages;
		pendingMessages = [];
		lastExtractAt = Date.now();
		extracting = true;

		// 非同期で並行実行(セッションの入力をブロックしない)。
		// バックフィルとの競合避けにキューへ積む。
		currentExtraction = enqueue(() =>
			(async () => {
				try {
					ctx.ui.setStatus("deepai-mem", "mem: 自動記録中…");
					const saved = await extractAndSave(
						ctx,
						cwd,
						cid,
						messagesToTranscript(messages),
						{ label: "自動記録" },
					);
					refreshWidget(ctx, cwd, cid, saved ? `+${saved} 自動記録` : undefined);
				} catch {
					// 自動記録は失敗しても静かに諦める(本線に影響させない)
				} finally {
					ctx.ui.setStatus("deepai-mem", null);
					extracting = false;
				}
			})(),
		) as Promise<void>;

		// 起動時に未取り込みの過去チャットがあれば、この生きた ctx でバックフィル開始
		if (backfillPending && !backfilling) {
			backfillPending = false;
			enqueue(() => runBackfill(ctx, true)).catch(() => undefined);
		}
	});

	// ---- 終了時: 実行中の自動記録/バックフィルがあれば完了を待ってから落ちる ----
	pi.on("session_shutdown", async () => {
		await currentExtraction;
	});

	// ---- 過去セッションの一括取り込み(バックフィル) ----
	async function runBackfill(ctx: any, quiet: boolean): Promise<string> {
		const cwd = ctx.cwd ?? process.cwd();
		const cid = chatId(ctx);
		if (backfilling) return "既に実行中です";
		const sessionDir = ctx.sessionManager?.getSessionDir?.();
		if (!sessionDir || !fs.existsSync(sessionDir)) return "セッションディレクトリが見つかりません";
		const files = fs
			.readdirSync(sessionDir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => ({
				base: f,
				full: path.join(sessionDir, f),
				mtime: fs.statSync(path.join(sessionDir, f)).mtimeMs,
			}))
			.sort((a, b) => b.mtime - a.mtime);
		const currentFile = ctx.sessionManager?.getSessionFile?.();
		const done = importedMap(cwd);
		const targets = files.filter((f) => !done[f.base] && f.full !== currentFile);
		if (targets.length === 0) return "未取り込みの過去チャットはありません";

		backfilling = true;
		let totalSaved = 0;
		let processed = 0;
		try {
			for (const t of targets) {
				processed++;
				try {
					ctx.ui.setStatus("deepai-mem", `mem: 過去チャット取り込み中 ${processed}/${targets.length}…`);
					const { transcript } = transcriptFromSessionFile(t.full);
					if (transcript.trim().length >= 200) {
						const chatIdOfSession =
							t.base.match(/_([0-9a-f-]{36})\.jsonl$/i)?.[1]?.slice(0, 12) ?? "adhoc";
						await enqueue(() =>
							extractAndSave(ctx, cwd, cid, transcript, {
								forceChatId: chatIdOfSession,
								label: "取り込み",
							}),
						).then((n: any) => {
							totalSaved += n ?? 0;
						});
					}
					markImported(cwd, t.base);
				} catch (e: any) {
				}
			}
		} finally {
			ctx.ui.setStatus("deepai-mem", null);
			backfilling = false;
			refreshWidget(ctx, cwd, cid, totalSaved ? `+${totalSaved} 過去分` : undefined);
		}
		return `過去チャット ${processed} 件を解析し、${totalSaved} 件のメモリを新規保存しました`;
	}

	// ---- コンパクション検出 → 履歴ダイジェスト注入を予約 ----
	pi.on("session_compact", () => {
		historyDigestPending = true;
	});

	// ---- ウィジェット(件数表示)+ 起動時に過去分を自動取り込み ----
	pi.on("session_start", (_event, ctx) => {
		const cwd = ctx.cwd ?? process.cwd();
		const cid = chatId(ctx);
		refreshWidget(ctx, cwd, cid);
		// 過去にコンパクションが起きたチャット(再開含む)は履歴ダイジェストを注入
		const hist = readSessionHistory(ctx.sessionManager?.getSessionFile?.());
		if (hist.hasCompaction) historyDigestPending = true;
		// 未取り込みの過去チャットがあればバックグラウンドで解析(同時起動・非ブロッキング)
		const done = importedMap(cwd);
		const sessionDir = ctx.sessionManager?.getSessionDir?.();
		if (sessionDir && fs.existsSync(sessionDir)) {
			const currentFile = ctx.sessionManager?.getSessionFile?.();
			const pending = fs
				.readdirSync(sessionDir)
				.filter((f) => f.endsWith(".jsonl") && !done[f] && path.join(sessionDir, f) !== currentFile);
			if (pending.length > 0) {
				// ctx が生きているうちに処理したいので、最初の agent_settled まで待ってから実行。
				// 未完了分は次回起動時に自動再開される。
				backfillPending = true;
				refreshWidget(ctx, cwd, cid, `過去分 ${pending.length} チャット取り込み待ち`);
			}
		}
	});

	// ---- ツール ----
	pi.registerTool({
		name: "memory_save",
		label: "Memory Save",
		description:
			"記憶を永続化する。scope=\"project\" は全チャット共通(ユーザーの好み、決定事項、環境の事実など)、scope=\"chat\" はこのチャット限定(この会話の経緯・作業状態など)。既定は project。",
		parameters: Type.Object({
			content: Type.String({ description: "保存するメモリの本文(1事実=1エントリで簡潔に)" }),
			scope: Type.Optional(StringEnum(["project", "chat"] as const, { description: "保存スコープ(既定: project)" })),
			tags: Type.Optional(Type.String({ description: "カンマ区切りのタグ(例: pref,decision,env)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const cwd = ctx?.cwd ?? process.cwd();
			const scope: Scope = params.scope === "chat" ? "chat" : "project";
			const cid = chatId(ctx);
			const id = nextId(cwd);
			const tags = params.tags
				? params.tags.split(",").map((t: string) => (t as string).trim()).filter(Boolean)
				: undefined;
			const entry: MemLogEntry = { id, ts: new Date().toISOString(), content: params.content, tags, scope, chatId: cid };
			appendLog(cwd, entry);
			const suffix = tags?.length ? ` [${tags.join("/")}]` : "";
			const file = appendMemoryLine(cwd, scope, cid, id, params.content + suffix);
			return {
				content: [{ type: "text", text: `保存しました (m${id}, scope=${scope}) → ${file}` }],
				details: { id, scope },
			};
		},
	});

	pi.registerTool({
		name: "memory_search",
		label: "Memory Search",
		description:
			"永続メモリを全文検索する。プロジェクト全体とこのチャットのメモリ両方を検索する。会話から失われた文脈を復元するときに使う。",
		parameters: Type.Object({
			query: Type.String({ description: "検索語" }),
			limit: Type.Optional(Type.Number({ description: "最大件数(既定20)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const cwd = ctx?.cwd ?? process.cwd();
			const hits = searchMemories(cwd, chatId(ctx), params.query, params.limit ?? 20);
			return {
				content: [
					{
						type: "text",
						text: hits.length ? hits.join("\n") : `「${params.query}」に一致するメモリはありません`,
					},
				],
				details: { count: hits.length },
			};
		},
	});

	pi.registerTool({
		name: "history_recall",
		label: "History Recall",
		description:
			"このチャットの過去のやり取り(生履歴)を再生・検索する。会話が圧縮されて前の話が消えたとき、『前のほうで話した◯◯って何だっけ?』を確認するときに使う。query 指定で全文検索、省略時は直近のやり取りを返す。",
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "検索語(省略時は直近のやり取り)" })),
			last: Type.Optional(Type.Number({ description: "末尾から返す発言数(既定12)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const sessionFile = ctx?.sessionManager?.getSessionFile?.();
			const { msgs } = readSessionHistory(sessionFile);
			if (msgs.length === 0) {
				return { content: [{ type: "text", text: "このチャットにはまだ履歴がありません" }], details: {} };
			}
			let out: string;
			if (params.query) {
				const q = params.query.toLowerCase();
				const idxs: number[] = [];
				msgs.forEach((m, i) => {
					if (m.text.toLowerCase().includes(q)) idxs.push(i);
				});
				if (idxs.length === 0) {
					out = `「${params.query}」に一致する過去のやり取りはありません`;
				} else {
					// ヒット箇所とその前後1件を時系列で返す
					const want = new Set<number>();
					for (const i of idxs) {
						want.add(i - 1);
						want.add(i);
						want.add(i + 1);
					}
					const seen = new Set<number>();
					const lines: string[] = [];
					for (const i of [...want].sort((a, b) => a - b)) {
						if (i < 0 || i >= msgs.length || seen.has(i)) continue;
						seen.add(i);
						const m = msgs[i];
						const mark = idxs.includes(i) ? "★" : "-";
						lines.push(`${mark} ${m.role}: ${m.text.slice(0, 600)}`);
					}
					out = lines.join("\n");
				}
			} else {
				const n = params.last ?? 12;
				out = msgs
					.slice(-n)
					.map((m) => `${m.role}: ${m.text.slice(0, 600)}`)
					.join("\n");
			}
			return {
				content: [{ type: "text", text: `〔このチャットの履歴 ${msgs.length} 発言中〕\n${out}` }],
				details: { total: msgs.length },
			};
		},
	});

	pi.registerTool({
		name: "memory_forget",
		label: "Memory Forget",
		description:
			"誤りや古くなったメモリを ID 指定で削除する。ID は memory_search の結果や MEMORY.md の [m<n>] 表記で確認できる。",
		parameters: Type.Object({
			id: Type.Number({ description: "削除するメモリの ID (例: 12)" }),
			reason: Type.Optional(Type.String({ description: "削除理由(ログに記録)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const cwd = ctx?.cwd ?? process.cwd();
			const cid = chatId(ctx);
			const entry = readLog(cwd).find((e) => e.id === params.id);
			const file =
				entry?.scope === "chat" ? chatMemoryFile(cwd, entry.chatId ?? cid) : projectMemoryFile(cwd);
			const ok = removeFromMemoryFile(file, params.id);
			appendLog(cwd, {
				id: params.id,
				ts: new Date().toISOString(),
				content: params.reason ?? "(forgotten)",
				scope: entry?.scope ?? "project",
				chatId: cid,
				forgotten: true,
			});
			return {
				content: [
					{
						type: "text",
						text: ok
							? `m${params.id} を削除しました`
							: `m${params.id} はメモリファイルに見つかりません(ログには記録済み)`,
					},
				],
				details: { ok },
			};
		},
	});

	// ---- /mem コマンド(TUI 用) + input フォールバック(TUI 外のUI用) ----
	async function handleMem(args: string, ctx: any): Promise<void> {
		const cwd = ctx.cwd ?? process.cwd();
		const cid = chatId(ctx);
			const text = (args ?? "").trim();
			if (text === "import") {
				const msg = await runBackfill(ctx, false);
				ctx.ui.notify(`mem: ${msg}`, "info");
				return;
			}
			if (text) {
				const id = nextId(cwd);
				appendLog(cwd, { id, ts: new Date().toISOString(), content: text, tags: ["manual"], scope: "chat", chatId: cid });
				const file = appendMemoryLine(cwd, "chat", cid, id, text);
				ctx.ui.notify(`チャットメモリに追記しました (m${id}) → ${file}`, "info");
				return;
			}
			const log = readLog(cwd).filter((e) => !e.forgotten);
			const p = log.filter((e) => e.scope !== "chat").length;
			const c = log.filter((e) => e.scope === "chat" && e.chatId === cid).length;
			const preview = readFileSafe(projectMemoryFile(cwd)).trim().split("\n").slice(-10).join("\n");
			ctx.ui.notify(
				`mem: project ${p} 件 / chat ${c} 件\n${projectMemoryFile(cwd)}\n---\n${preview || "(まだ何もありません)"}`,
				"info",
			);
			refreshWidget(ctx, cwd, cid);
	}

	pi.registerCommand("mem", {
		description: "永続メモリを表示・追記・取り込む (/mem [import|追記内容])",
		handler: handleMem,
	});

	// TUI を持たないホスト(DeepAI Code アプリ等)でも /mem が届いたら拾う
	// (/mem-stats などのテンプレート名は食わないよう完全一致/空白区切りのみ)
	pi.on("input", async (event, ctx) => {
		const text = (event?.text ?? "").trim();
		if (text === "/mem" || text.startsWith("/mem ")) {
			await handleMem(text.slice(4), ctx);
			return { action: "handled" } as any;
		}
	});

	// ---- mem_manage ツール: UIコマンドなしでモデル経由で操作可能 ----
	pi.registerTool({
		name: "mem_manage",
		label: "Memory Manage",
		description:
			"メモリシステムの管理操作。action=import: 過去チャットセッションを解析してメモリを取り込む(バックフィル)。action=stats: 保存済みメモリの統計を表示。ユーザーが『メモリを取り込んで』『メモリの状態を見せて』などと言ったら使う。",
		parameters: Type.Object({
			action: StringEnum(["import", "stats"] as const, { description: "実行する操作" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (params.action === "import") {
				const msg = await runBackfill(ctx, false);
				return { content: [{ type: "text", text: `メモリ取り込み結果: ${msg}` }], details: {} };
			}
			const cwd = ctx?.cwd ?? process.cwd();
			const cid = chatId(ctx);
			const log = readLog(cwd).filter((e: any) => !e.forgotten);
			const p = log.filter((e: any) => e.scope !== "chat").length;
			const c = log.filter((e: any) => e.scope === "chat" && e.chatId === cid).length;
			const imported = Object.keys(importedMap(cwd)).length;
			return {
				content: [{
					type: "text",
					text: `project ${p} 件 / このチャット ${c} 件 / 取り込み済みセッション ${imported} 件\n保存先: ${memDir(cwd)}`,
				}],
				details: {},
			};
		},
	});
}
