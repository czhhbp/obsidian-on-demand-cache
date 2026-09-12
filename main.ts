import {
	App,
	Plugin,
	PluginSettingTab,
	Setting,
	Notice,
	TFile,
	normalizePath,
	requestUrl,
	MarkdownView,
	Component,
	FileSystemAdapter,
	Modal,
	getLanguage,
	MarkdownPostProcessorContext,
	SettingDefinitionItem,
} from "obsidian";

// ==================== 类型与常量 ====================

interface OnDemandCacheSettings {
	// 文件类别过滤
	filterMode: "whitelist" | "blacklist"; // 二选一
	fileExtensions: string[]; // 后缀列表（不含点，小写）
	// 大小限制
	maxFileSizeMB: number; // 单个附件最大大小（MB），0 表示不限制
	// 缓存目录（相对于 vault 根目录，非笔记文件夹）
	cacheFolder: string;
	// 清理
	cleanupOnStartup: boolean;
	// 是否启用渲染替换
	enableRenderReplace: boolean;
	// 是否启用诊断日志（默认关闭，避免性能开销）
	debugMode: boolean;
}

const DEFAULT_SETTINGS: OnDemandCacheSettings = {
	filterMode: "whitelist",
	fileExtensions: [
		"png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico",
		"mp4", "webm", "mov", "mkv", "avi",
		"mp3", "wav", "ogg", "m4a", "flac",
		"pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
	],
	maxFileSizeMB: 50,
	cacheFolder: ".cache",
	cleanupOnStartup: true,
	enableRenderReplace: true,
	debugMode: false,
};

// 缓存索引文件名
const INDEX_FILE = "cache-index.json";

// ==================== 缓存索引结构 ====================

interface CacheEntry {
	url: string;          // 原始网络链接
	file: string;         // 缓存文件相对路径（相对于 vault 根目录）
	ext: string;          // 文件后缀（小写，不含点）
	size: number;         // 文件大小（字节）
	hash: string;         // 内容哈希（用于去重）
	cachedAt: number;     // 缓存时间戳
	lastUsedAt: number;   // 最近使用时间戳
}

interface CacheIndex {
	version: number;
	entries: CacheEntry[];
}

// ==================== 工具函数 ====================

function normalizeExt(ext: string): string {
	return ext.toLowerCase().replace(/^\./, "");
}

function getExtFromUrl(url: string): string {
	try {
		const u = new URL(url);
		const pathname = u.pathname;
		const m = pathname.match(/\.([a-zA-Z0-9]+)(?:$|[?#])/);
		if (m) return normalizeExt(m[1]);
		// 尝试从查询参数中获取
		return "";
	} catch {
		return "";
	}
}

function getExtFromContentType(contentType: string | null): string {
	if (!contentType) return "";
	const map: Record<string, string> = {
		"image/png": "png",
		"image/jpeg": "jpg",
		"image/gif": "gif",
		"image/webp": "webp",
		"image/svg+xml": "svg",
		"image/bmp": "bmp",
		"image/x-icon": "ico",
		"video/mp4": "mp4",
		"video/webm": "webm",
		"video/quicktime": "mov",
		"audio/mpeg": "mp3",
		"audio/wav": "wav",
		"audio/ogg": "ogg",
		"audio/mp4": "m4a",
		"audio/flac": "flac",
		"application/pdf": "pdf",
		"application/zip": "zip",
		"application/x-rar-compressed": "rar",
		"application/x-7z-compressed": "7z",
		"application/gzip": "gz",
		"application/x-tar": "tar",
	};
	const mime = contentType.split(";")[0].trim().toLowerCase();
	return map[mime] || "";
}

// 简单哈希（用于去重，非加密用途）
function simpleHash(str: string): string {
	let hash = 0;
	for (let i = 0; i < str.length; i++) {
		const chr = str.charCodeAt(i);
		hash = ((hash << 5) - hash) + chr;
		hash |= 0;
	}
	return Math.abs(hash).toString(36);
}

// ==================== 国际化（i18n） ====================

/** 检测 Obsidian 当前界面语言是否为中文 */
function isChinese(): boolean {
	try {
		const lang = getLanguage();
		if (lang) return lang.toLowerCase().startsWith("zh");
	} catch { /* ignore */ }
	// 回退：根据浏览器语言判断
	try {
		return navigator.language.toLowerCase().startsWith("zh");
	} catch { /* ignore */ }
	return false;
}

/** 根据语言返回中文或英文文本 */
function t(zh: string, en: string): string {
	return isChinese() ? zh : en;
}

// ==================== 主插件 ====================

export default class OnDemandCachePlugin extends Plugin {
	settings: OnDemandCacheSettings;
	private index: CacheIndex = { version: 1, entries: [] };
	private indexLoaded = false;
	private processing = false;
	private renderComponent: Component | null = null;

	// ==================== 诊断日志 ====================
	private logLines: string[] = []; // 全量日志（展示用）
	private pendingLog: string[] = []; // 待写入文件的日志
	private logFlushTimer: number | null = null;
	private loggedReplacements = new Set<string>();
	private loggedSkips = new Set<string>();
	private loggedPaths = new Set<string>();
	private firstRenderLogged = false;

	async onload() {
		await this.loadSettings();
		await this.loadIndex();

		// 关键：后处理器必须在设置加载后、且尽早注册。
		// 注意：不能放在 loadSettings 之前，否则 this.settings 为 undefined 会抛错。
		if (this.settings.enableRenderReplace) {
			this.registerMarkdownPostProcessor((el, ctx) => {
				this.replaceRemoteWithCache(el, ctx);
			});
			this.logDiag("[注册] markdown 后处理器已注册");
		} else {
			this.logDiag("[注册] enableRenderReplace=false，后处理器未注册");
		}

		// 注册设置面板
		this.addSettingTab(new OnDemandCacheSettingTab(this.app, this));

		// 诊断：查看/复制日志
		this.addCommand({
			id: "show-debug-log",
			name: t("查看诊断日志", "Show diagnostic log"),
			callback: () => this.showDebugLog(),
		});
		this.addCommand({
			id: "copy-debug-log",
			name: t("复制诊断日志", "Copy diagnostic log"),
			callback: () => this.copyDebugLog(),
		});

		// 一键缓存全部附件
		this.addCommand({
			id: "cache-all-attachments",
			name: t("缓存所有文档中的网络附件", "Cache all remote attachments"),
			callback: () => this.cacheAllAttachments(),
		});

		// 缓存当前文档的附件
		this.addCommand({
			id: "cache-current-file-attachments",
			name: t("缓存当前文档中的网络附件", "Cache remote attachments in current note"),
			callback: () => this.cacheCurrentFile(),
		});

		// 清理未使用的缓存
		this.addCommand({
			id: "cleanup-unused-cache",
			name: t("清理未使用的缓存文件", "Clean up unused cache files"),
			callback: () => this.cleanupUnusedCache(),
		});

		// 打开文档时自动缓存（用时缓存）
		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				if (file) {
					void this.cacheFile(file);
				}
			})
		);

		// 主动重渲染：文档打开后延迟触发，确保后处理器重新执行替换
		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				if (!file) return;
				// 延迟 500ms，等缓存下载完成后再重渲染
				window.setTimeout(() => {
					const view = this.app.workspace.getActiveViewOfType(MarkdownView);
					if (view && view.file && view.file.path === file.path) {
						this.logDiag(`[主动重渲染] 触发 ${file.path} 重新渲染`);
						view.previewMode.rerender(true);
					}
				}, 500);
			})
		);

		// 渲染替换：后处理器已在 onload 最前面注册（见上方）

		// 兜底方案：全局 MutationObserver，监听 DOM 变化，主动替换远程图片。
		// 不依赖后处理器触发时机，兼容阅读视图与实时预览。
		this.setupGlobalObserver();

		// 启动时清理
		if (this.settings.cleanupOnStartup) {
			this.app.workspace.onLayoutReady(() => {
				void this.cleanupUnusedCache();
			});
		}

		// 启动诊断日志
		this.app.workspace.onLayoutReady(() => {
			void this.logStartup();
		});
	}

	onunload() {
		this.renderComponent?.unload();
		this.globalObserver?.disconnect();
	}

	// ==================== 全局 DOM 观察器（兜底替换） ====================

	private globalObserver: MutationObserver | null = null;

	private setupGlobalObserver() {
		if (this.globalObserver) return;
		this.globalObserver = new MutationObserver((mutations) => {
			for (const m of mutations) {
				if (m.type !== "childList") continue;
				for (const node of Array.from(m.addedNodes)) {
					if (!node.instanceOf(HTMLElement)) continue;
					// 新增节点本身是 img，或包含 img
					if (node.tagName === "IMG") {
						this.tryReplaceImg(node as HTMLImageElement);
					} else {
						node.querySelectorAll("img").forEach((img) => this.tryReplaceImg(img));
					}
				}
			}
		});
		this.globalObserver.observe(document.body, { childList: true, subtree: true });
		this.logDiag("[观察器] 全局 MutationObserver 已启动");
	}

	/** 尝试替换单个 img 的远程 src 为本地缓存路径 */
	private tryReplaceImg(img: HTMLImageElement) {
		const src = img.getAttribute("src");
		if (!src || !/^https?:\/\//i.test(src)) return;
		const entry = this.findEntryByUrl(src);
		if (!entry) return;
		const localPath = this.getLocalResourcePath(entry.file);
		if (img.getAttribute("src") === localPath) return; // 已替换
		img.setAttribute("src", localPath);
		img.setAttribute("data-original-src", src);
		if (this.settings.debugMode && !this.loggedReplacements.has(src)) {
			this.loggedReplacements.add(src);
			this.logDiag(`[观察器替换] 远程: ${src}`);
			this.logDiag(`[观察器替换] 本地: ${localPath}`);
		}
	}

	/** 主动扫描整个文档的所有 img，替换远程图片（兜底） */
	private scanAndReplaceAll() {
		const imgs = document.querySelectorAll("img");
		let replaced = 0;
		imgs.forEach((img) => {
			const src = img.getAttribute("src");
			if (src && /^https?:\/\//i.test(src)) {
				const entry = this.findEntryByUrl(src);
				if (entry) {
					const localPath = this.getLocalResourcePath(entry.file);
					img.setAttribute("src", localPath);
					img.setAttribute("data-original-src", src);
					replaced++;
				}
			}
		});
		if (replaced > 0) {
			this.logDiag(`[主动扫描] 替换了 ${replaced} 个远程图片`);
		}
	}

	// ==================== 诊断日志 ====================

	/** 记录一条诊断日志：写入内存 + 控制台 + 落盘 debug.log */
	private logDiag(msg: string) {
		// debugMode 关闭时直接返回，零开销
		if (!this.settings.debugMode) return;
		const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
		this.logLines.push(line);
		// 内存中最多保留 500 条
		if (this.logLines.length > 500) {
			this.logLines.splice(0, this.logLines.length - 500);
		}
		this.pendingLog.push(line);
		console.debug("[OnDemandCache]", msg);
		this.flushLog();
	}

	/** 将待写日志追加到 debug.log（防抖，避免高频写盘） */
	private flushLog() {
		if (this.logFlushTimer !== null) return;
		this.logFlushTimer = window.setTimeout(async () => {
			this.logFlushTimer = null;
			const lines = this.pendingLog;
			this.pendingLog = [];
			if (lines.length === 0) return;
			try {
				const adapter = this.app.vault.adapter;
				const folder = this.settings.cacheFolder;
				const path = normalizePath(folder + "/debug.log");
				if (!(await adapter.exists(folder))) {
					await adapter.mkdir(folder);
				}
				// 追加写入（而非读全文件再写回），避免日志增长时 O(n) 磁盘 IO
				await adapter.append(path, lines.join("\n") + "\n");
			} catch (e) {
				console.error("[OnDemandCache] 写入诊断日志失败", e);
			}
		}, 1000);
	}

	/** 读取完整诊断日志文本（优先读文件） */
	private async readDebugLogText(): Promise<string> {
		// 先强制刷新未写盘的日志（追加写入）
		if (this.pendingLog.length > 0) {
			const lines = this.pendingLog;
			this.pendingLog = [];
			try {
				const adapter = this.app.vault.adapter;
				const folder = this.settings.cacheFolder;
				const path = normalizePath(folder + "/debug.log");
				if (!(await adapter.exists(folder))) await adapter.mkdir(folder);
				await adapter.append(path, lines.join("\n") + "\n");
			} catch { /* ignore */ }
		}

		let fullLog = "";
		try {
			const adapter = this.app.vault.adapter;
			const path = normalizePath(this.settings.cacheFolder + "/debug.log");
			if (await adapter.exists(path)) {
				fullLog = await adapter.read(path);
			}
		} catch { /* ignore */ }

		return fullLog || this.logLines.join("\n") || t("（暂无日志）", "(no logs yet)");
	}

	/** 展示诊断日志（模态框，可滚动、可一键复制） */
	async showDebugLog() {
		const content = await this.readDebugLogText();

		const modal = new Modal(this.app);
		modal.titleEl.setText(t("On-Demand Cache 诊断日志", "On-Demand Cache Diagnostic Log"));
		modal.contentEl.empty();
		modal.contentEl.createEl("p", {
			text: t(
				`日志同时保存在 ${this.settings.cacheFolder}/debug.log，可直接用文本编辑器打开。`,
				`The log is also saved to ${this.settings.cacheFolder}/debug.log and can be opened with a text editor.`
			),
			cls: "setting-item-description",
		});

		const pre = modal.contentEl.createEl("pre", {
			text: content,
			cls: "debug-log-content",
		});
		pre.setCssStyles({
			whiteSpace: "pre-wrap",
			wordBreak: "break-all",
			maxHeight: "55vh",
			overflowY: "auto",
			background: "var(--background-secondary)",
			padding: "12px",
			borderRadius: "6px",
			fontSize: "12px",
			fontFamily: "monospace",
		});

		new Setting(modal.contentEl)
			.setName(t("复制全部日志", "Copy all logs"))
			.addButton((btn) =>
				btn
					.setButtonText(t("复制", "Copy"))
					.setCta()
					.onClick(async () => {
						try {
							await navigator.clipboard.writeText(content);
							new Notice(t("诊断日志已复制到剪贴板", "Diagnostic log copied to clipboard"));
						} catch {
							new Notice(t("复制失败，请手动选中日志文本复制", "Copy failed, please select the log text manually"));
						}
						modal.close();
					})
			);
		new Setting(modal.contentEl)
			.setName(t("清空日志", "Clear logs"))
			.addButton((btn) =>
				btn
					.setButtonText(t("清空", "Clear"))
					.onClick(async () => {
						this.logLines = [];
						try {
							const adapter = this.app.vault.adapter;
							const path = normalizePath(this.settings.cacheFolder + "/debug.log");
							if (await adapter.exists(path)) {
								await adapter.write(path, "");
							}
						} catch { /* ignore */ }
						new Notice(t("诊断日志已清空", "Diagnostic log cleared"));
						modal.close();
					})
			);

		modal.open();
	}

	/** 复制诊断日志到剪贴板 */
	async copyDebugLog() {
		let fullLog = "";
		try {
			const adapter = this.app.vault.adapter;
			const path = normalizePath(this.settings.cacheFolder + "/debug.log");
			if (await adapter.exists(path)) {
				fullLog = await adapter.read(path);
			}
		} catch { /* ignore */ }
		const content = fullLog || this.logLines.join("\n") || t("（暂无日志）", "(no logs yet)");
		try {
			await navigator.clipboard.writeText(content);
			new Notice(t("诊断日志已复制到剪贴板（" + content.length + " 字符）", "Diagnostic log copied to clipboard (" + content.length + " chars)"));
		} catch {
			new Notice(t("复制失败，请手动打开 " + this.settings.cacheFolder + "/debug.log", "Copy failed, please open " + this.settings.cacheFolder + "/debug.log manually"));
		}
	}

	/** 探测一个本地资源路径是否真的能被 Obsidian 渲染层加载（隐藏 img 实测） */
	private probeResourcePath(localPath: string, label: string): void {
		// debugMode 关闭时跳过探测，避免额外的资源加载开销
		if (!this.settings.debugMode) return;
		const testImg = new Image();
		const timer = window.setTimeout(() => {
			if (!testImg.dataset.done) {
				this.logDiag(`[探测超时] ${label}: ${localPath}（8秒内无 onload/onerror）`);
			}
		}, 8000);
		testImg.onload = () => {
			testImg.dataset.done = "1";
			window.clearTimeout(timer);
			this.logDiag(`[探测成功] ${label}: ${localPath} → ${testImg.naturalWidth}x${testImg.naturalHeight}`);
		};
		testImg.onerror = (e) => {
			testImg.dataset.done = "1";
			window.clearTimeout(timer);
			this.logDiag(`[探测失败] ${label}: ${localPath} → 浏览器无法加载该路径`);
		};
		testImg.src = localPath;
	}

	/** 启动插件诊断 */
	private async logStartup() {
		const adapter = this.app.vault.adapter;
		// 防御式判断：移动端运行时可能未导出 FileSystemAdapter 类，
		// 直接 `adapter instanceof FileSystemAdapter` 在 undefined 右操作数下会抛 TypeError。
		const isFileSystem =
			typeof FileSystemAdapter === "function" &&
			adapter instanceof FileSystemAdapter;
		this.logDiag("========== 插件启动诊断 ==========");
		this.logDiag(`adapter 类型: ${adapter.constructor.name}（isFileSystem: ${isFileSystem}）`);
		this.logDiag(`设置: enableRenderReplace=${this.settings.enableRenderReplace}, cacheFolder=${this.settings.cacheFolder}`);
		this.logDiag(`索引条目数: ${this.index.entries.length}`);
		for (const e of this.index.entries) {
			this.logDiag(`  索引: url=${e.url} file=${e.file} size=${e.size}`);
		}
		if (this.index.entries.length > 0) {
			const sample = this.index.entries[0];
			const testPath = this.getLocalResourcePath(sample.file);
			this.logDiag(`样例缓存路径生成: ${sample.file} → ${testPath}`);
			this.probeResourcePath(testPath, "样例缓存");
			const exists = await adapter.exists(sample.file);
			this.logDiag(`样例缓存文件是否存在: ${exists}`);
			if (exists) {
				const st = await adapter.stat(sample.file);
				if (st) {
					this.logDiag(`样例缓存文件大小: ${st.size} 字节（索引记录 ${sample.size}）`);
				}
			}
		}
	}

	// ==================== 设置加载/保存 ====================

	async loadSettings() {
		const data = (await this.loadData()) as Partial<OnDemandCacheSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data ?? {});
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	// ==================== 索引加载/保存 ====================

	private getIndexPath(): string {
		return normalizePath(this.settings.cacheFolder + "/" + INDEX_FILE);
	}

	private async loadIndex() {
		try {
			const adapter = this.app.vault.adapter;
			const indexPath = this.getIndexPath();
			if (await adapter.exists(indexPath)) {
				const raw = await adapter.read(indexPath);
				this.index = JSON.parse(raw) as CacheIndex;
				if (!this.index.entries) this.index.entries = [];
			}
		} catch (e) {
			console.error("On-Demand Cache: 加载缓存索引失败", e);
			this.index = { version: 1, entries: [] };
		}
		this.indexLoaded = true;
		this.logDiag(`索引加载完成: ${this.index.entries.length} 条记录（${this.getIndexPath()}）`);
	}

	private async saveIndex() {
		try {
			const adapter = this.app.vault.adapter;
			const indexPath = this.getIndexPath();
			const folder = this.settings.cacheFolder;
			if (!(await adapter.exists(folder))) {
				await adapter.mkdir(folder);
			}
			await adapter.write(indexPath, JSON.stringify(this.index, null, 2));
		} catch (e) {
			console.error("On-Demand Cache: 保存缓存索引失败", e);
		}
	}

	// ==================== 链接提取 ====================

	/**
	 * 从文档内容中提取所有网络链接。
	 * 支持 Markdown 图片、链接、HTML img/audio/video/source、裸 URL、以及 Obsidian wiki 链接（双中括号）。
	 */
	extractRemoteLinks(content: string): string[] {
		const urls = new Set<string>();

		// 1. Markdown 图片 ![alt](url)
		const mdImage = /!\[[^\]]*\]\(([^)\s]+)\)/g;
		let m;
		while ((m = mdImage.exec(content)) !== null) {
			urls.add(m[1]);
		}

		// 2. Markdown 链接 [text](url)
		const mdLink = /\[[^\]]*\]\(([^)\s]+)\)/g;
		while ((m = mdLink.exec(content)) !== null) {
			urls.add(m[1]);
		}

		// 3. HTML img src
		const htmlImg = /<img[^>]+src=["']([^"']+)["']/gi;
		while ((m = htmlImg.exec(content)) !== null) {
			urls.add(m[1]);
		}

		// 4. HTML audio/video/source src
		const htmlMedia = /<(?:audio|video|source)[^>]+src=["']([^"']+)["']/gi;
		while ((m = htmlMedia.exec(content)) !== null) {
			urls.add(m[1]);
		}

		// 5. Obsidian wiki 链接（双中括号）
		// 形式：![[https://...]]、[[https://...]]、[[https://...|别名]]、![[https://...|300]]
		const wikiLink = /!?\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;
		while ((m = wikiLink.exec(content)) !== null) {
			const target = m[1].trim();
			if (/^https?:\/\//i.test(target)) {
				urls.add(target);
			}
		}

		// 6. 裸 URL（http/https）
		const bareUrl = /https?:\/\/[^\s<>"')\]]+/g;
		while ((m = bareUrl.exec(content)) !== null) {
			urls.add(m[0]);
		}

		// 过滤：只保留 http/https 链接
		const result: string[] = [];
		for (const url of urls) {
			if (/^https?:\/\//i.test(url)) {
				result.push(url);
			}
		}
		return result;
	}

	// ==================== 缓存判断逻辑 ====================

	/**
	 * 判断某个链接是否应该被缓存。
	 * 返回 { shouldCache, reason, ext }
	 */
	shouldCache(url: string): { shouldCache: boolean; reason: string; ext: string } {
		// 1. 是否已经缓存
		const existing = this.index.entries.find((e) => e.url === url);
		if (existing) {
			return { shouldCache: false, reason: "already-cached", ext: existing.ext };
		}

		// 2. 提取后缀
		let ext = getExtFromUrl(url);
		if (!ext) {
			// 无后缀，尝试从 URL 判断是否为图片等，这里默认不缓存无后缀链接
			return { shouldCache: false, reason: "no-extension", ext: "" };
		}

		// 3. 文件类别过滤
		const exts = this.settings.fileExtensions.map(normalizeExt);
		if (this.settings.filterMode === "whitelist") {
			if (!exts.includes(ext)) {
				return { shouldCache: false, reason: "not-in-whitelist", ext };
			}
		} else {
			// blacklist
			if (exts.includes(ext)) {
				return { shouldCache: false, reason: "in-blacklist", ext };
			}
		}

		return { shouldCache: true, reason: "", ext };
	}

	// ==================== 下载与缓存 ====================

	/**
	 * 下载并缓存单个链接。
	 * 处理去重：相同内容（哈希相同）只缓存一份。
	 */
	async cacheUrl(url: string): Promise<CacheEntry | null> {
		const { shouldCache, ext } = this.shouldCache(url);
		if (!shouldCache) {
			return null;
		}

		try {
			const response = await requestUrl({
				url,
				method: "GET",
				headers: { "User-Agent": "Mozilla/5.0" },
			});

			const arrayBuffer = response.arrayBuffer;
			const size = arrayBuffer.byteLength;

			// 大小限制
			if (this.settings.maxFileSizeMB > 0) {
				const maxBytes = this.settings.maxFileSizeMB * 1024 * 1024;
				if (size > maxBytes) {
					return null;
				}
			}

			// 确定最终后缀（优先 URL 后缀，其次 Content-Type）
			let finalExt = ext;
			if (!finalExt) {
				finalExt = getExtFromContentType(response.headers["content-type"] || null);
			}
			if (!finalExt) finalExt = "bin";

			// 计算内容哈希用于去重
			const bytes = new Uint8Array(arrayBuffer);
			let hashStr = "";
			// 简单哈希（取前若干字节 + 长度）
			const sample = bytes.slice(0, 4096);
			let hex = "";
			for (let i = 0; i < sample.length; i++) {
				hex += sample[i].toString(16).padStart(2, "0");
			}
			hashStr = simpleHash(hex + ":" + size);

			// 检查是否已有相同内容的缓存（去重）
			const dup = this.index.entries.find((e) => e.hash === hashStr && e.size === size);
			if (dup) {
				// 相同内容，复用已有缓存文件，但记录新的 URL 映射
				const newEntry: CacheEntry = {
					url,
					file: dup.file,
					ext: dup.ext,
					size: dup.size,
					hash: dup.hash,
					cachedAt: Date.now(),
					lastUsedAt: Date.now(),
				};
				this.index.entries.push(newEntry);
				await this.saveIndex();
				return newEntry;
			}

			// 生成缓存文件名：hash + 后缀
			const fileName = `${hashStr}.${finalExt}`;
			const folder = this.settings.cacheFolder;
			const filePath = normalizePath(folder + "/" + fileName);

			// 确保目录存在
			const adapter = this.app.vault.adapter;
			if (!(await adapter.exists(folder))) {
				await adapter.mkdir(folder);
			}

			// 写入文件
			await adapter.writeBinary(filePath, arrayBuffer);

			const entry: CacheEntry = {
				url,
				file: filePath,
				ext: finalExt,
				size,
				hash: hashStr,
				cachedAt: Date.now(),
				lastUsedAt: Date.now(),
			};
			this.index.entries.push(entry);
			await this.saveIndex();

			return entry;
		} catch (e) {
			console.error(`On-Demand Cache: 下载失败 ${url}`, e);
			return null;
		}
	}

	// ==================== 单文档处理 ====================

	/**
	 * 处理单个文档：提取链接并缓存。
	 */
	async cacheFile(file: TFile) {
		if (this.processing) return;
		try {
			const content = await this.app.vault.read(file);
			const urls = this.extractRemoteLinks(content);
			if (urls.length === 0) return;

			let cachedCount = 0;
			for (const url of urls) {
				const entry = await this.cacheUrl(url);
				if (entry) cachedCount++;
			}

			if (cachedCount > 0) {
				// 如果当前打开的是该文件，触发重新渲染以应用缓存
				const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (activeView && activeView.file && activeView.file.path === file.path) {
					activeView.previewMode.rerender(true);
				}
				// 主动扫描当前文档所有 img，立即替换（不依赖重渲染）
				this.scanAndReplaceAll();
			}
		} catch (e) {
			console.error(`On-Demand Cache: 处理文档失败 ${file.path}`, e);
		}
	}

	/**
	 * 缓存当前打开的文档。
	 */
	async cacheCurrentFile() {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view || !view.file) {
			new Notice(t("没有打开的文档", "No note is open"));
			return;
		}
		new Notice(t("开始缓存当前文档的附件...", "Caching attachments in current note..."));
		await this.cacheFile(view.file);
		new Notice(t("当前文档附件缓存完成", "Current note attachments cached"));
	}

	// ==================== 遍历所有文档 ====================

	/**
	 * 遍历所有 Markdown 文档，逐个缓存。
	 */
	async cacheAllAttachments() {
		if (this.processing) {
			new Notice(t("正在处理中，请稍候...", "Processing, please wait..."));
			return;
		}
		this.processing = true;
		const notice = new Notice(t("开始缓存所有文档的附件...", "Caching all attachments..."), 0);

		try {
			const files = this.app.vault.getMarkdownFiles();
			let totalCached = 0;
			let processed = 0;

			for (const file of files) {
				processed++;
				const content = await this.app.vault.read(file);
				const urls = this.extractRemoteLinks(content);
				for (const url of urls) {
					const entry = await this.cacheUrl(url);
					if (entry) totalCached++;
				}
				// 更新进度
				if (processed % 10 === 0) {
					notice.setMessage(t(
						`缓存中... ${processed}/${files.length} 个文档，已缓存 ${totalCached} 个附件`,
						`Caching... ${processed}/${files.length} notes, ${totalCached} attachments cached`
					));
				}
			}

			notice.hide();
			new Notice(t(
				`缓存完成：处理 ${files.length} 个文档，新缓存 ${totalCached} 个附件`,
				`Done: processed ${files.length} notes, cached ${totalCached} attachments`
			));
		} catch (e) {
			console.error("On-Demand Cache: 批量缓存失败", e);
			new Notice(t("批量缓存失败，请查看控制台", "Batch caching failed, check the console"));
		} finally {
			this.processing = false;
		}
	}

	// ==================== 清理未使用缓存 ====================

	/**
	 * 扫描所有文档，找出仍在使用的 URL，删除未被引用的缓存。
	 */
	async cleanupUnusedCache() {
		try {
			// 收集所有文档中引用的 URL
			const usedUrls = new Set<string>();
			const files = this.app.vault.getMarkdownFiles();
			for (const file of files) {
				const content = await this.app.vault.read(file);
				const urls = this.extractRemoteLinks(content);
				for (const url of urls) {
					usedUrls.add(url);
				}
			}

			// 找出未使用的缓存条目
			const unused = this.index.entries.filter((e) => !usedUrls.has(e.url));
			if (unused.length === 0) {
				new Notice(t("清理完成：没有未使用的缓存文件", "Cleanup done: no unused cache files"));
				return;
			}

			const adapter = this.app.vault.adapter;
			let deleted = 0;
			let failed = 0;

			for (const entry of unused) {
				// 检查是否有其他 URL 仍引用同一文件（去重场景）
				const stillReferenced = this.index.entries.some(
					(e) => e.file === entry.file && usedUrls.has(e.url)
				);
				if (stillReferenced) {
					// 文件仍被其他 URL 使用，只删除该 URL 的索引条目
					this.index.entries = this.index.entries.filter((e) => e !== entry);
					continue;
				}

				// 删除文件
				try {
					if (await adapter.exists(entry.file)) {
						await adapter.remove(entry.file);
						deleted++;
					}
				} catch (e) {
					failed++;
					console.error(`On-Demand Cache: 删除缓存失败 ${entry.file}`, e);
				}
				this.index.entries = this.index.entries.filter((e) => e !== entry);
			}

			await this.saveIndex();
			if (failed > 0) {
				new Notice(t(`清理完成：删除 ${deleted} 个文件，${failed} 个删除失败`, `Cleanup done: deleted ${deleted} files, ${failed} failed`));
			} else {
				new Notice(t(`清理完成：已删除 ${deleted} 个未使用的缓存文件`, `Cleanup done: deleted ${deleted} unused cache files`));
			}
		} catch (e) {
			console.error("On-Demand Cache: 清理失败", e);
			new Notice(t("清理失败，请查看控制台", "Cleanup failed, check the console"));
		}
	}

	// ==================== 清空缓存 ====================

	/**
	 * 清空所有缓存：删除所有缓存文件并重置索引。
	 */
	async clearAllCache() {
		try {
			const adapter = this.app.vault.adapter;
			let deleted = 0;

			// 删除所有缓存文件
			for (const entry of this.index.entries) {
				try {
					if (await adapter.exists(entry.file)) {
						await adapter.remove(entry.file);
						deleted++;
					}
				} catch (e) {
					console.error(`On-Demand Cache: 删除缓存失败 ${entry.file}`, e);
				}
			}

			// 重置索引
			this.index.entries = [];
			await this.saveIndex();

			new Notice(t(`已清空缓存，删除 ${deleted} 个文件`, `Cache cleared, deleted ${deleted} files`));
		} catch (e) {
			console.error("On-Demand Cache: 清空缓存失败", e);
			new Notice(t("清空缓存失败，请查看控制台", "Failed to clear cache, check the console"));
		}
	}

	// ==================== 渲染替换 ====================

	/**
	 * 获取缓存文件的本地资源路径。
	 * FileSystemAdapter.getResourcePath 会把磁盘绝对路径编码进 app:// 资源代理 URL，
	 * Obsidian 渲染层据此直接读取本地文件，不依赖 vault 的文件索引，因此缓存目录
	 * 可以是隐藏目录（如 .cache）。该 URI 是官方推荐给浏览器引擎嵌入图片用的。
	 */
	private getLocalResourcePath(filePath: string): string {
		const adapter = this.app.vault.adapter;
		const result = adapter.getResourcePath(filePath);
		// 每个路径只记录一次（仅 debugMode 开启时）
		if (this.settings.debugMode && !this.loggedPaths.has(filePath)) {
			this.loggedPaths.add(filePath);
			this.logDiag(`[路径生成] ${filePath} → ${result}（adapter=${adapter.constructor.name}）`);
		}
		return result;
	}

	/**
	 * 在渲染时，将网络链接替换为本地缓存路径。
	 */
	/**
	 * 在索引中查找 URL 对应的缓存条目。
	 * 先精确匹配；失败时尝试忽略查询参数（? 之后）再匹配，
	 * 以兼容文档中 URL 带/不带参数的情况。
	 */
	private findEntryByUrl(url: string): CacheEntry | undefined {
		let entry = this.index.entries.find((e) => e.url === url);
		if (entry) return entry;
		// 忽略查询参数/fragment 后匹配
		try {
			const base = url.split(/[?#]/)[0];
			if (base !== url) {
				const hit = this.index.entries.find((e) => e.url.split(/[?#]/)[0] === base);
				if (hit) {
					return hit;
				}
			}
		} catch { /* ignore */ }
		return undefined;
	}

	private replaceRemoteWithCache(el: HTMLElement, ctx: MarkdownPostProcessorContext) {
		if (!this.settings.enableRenderReplace) return;

		// 首次调用时记录（仅 debugMode 开启时执行诊断，避免额外开销）
		if (this.settings.debugMode && !this.firstRenderLogged) {
			this.firstRenderLogged = true;
			const file = (ctx && ctx.sourcePath) ? ctx.sourcePath : "未知";
			this.logDiag(`后处理器被调用: 文档=${file}, 索引条目数=${this.index.entries.length}`);
			// 记录容器内所有 img 的 src，用于诊断 Obsidian 是否改写了 src
			const allImgs = el.querySelectorAll("img");
			this.logDiag(`容器内 img 数量: ${allImgs.length}`);
			allImgs.forEach((im, i) => {
				this.logDiag(`  img[${i}] src=${im.getAttribute("src")}`);
			});
			// 记录容器 HTML 片段（前 500 字符）
			this.logDiag(`容器 HTML 片段: ${el.innerHTML.substring(0, 500)}`);
		}

		// 处理 img 标签
		const imgs = el.querySelectorAll("img");
		imgs.forEach((img) => {
			const src = img.getAttribute("src");
			if (!src || !/^https?:\/\//i.test(src)) return;

			const entry = this.findEntryByUrl(src);
			if (!entry) {
				if (this.settings.debugMode && !this.loggedSkips.has("skip:" + src)) {
					this.loggedSkips.add("skip:" + src);
					this.logDiag(`[跳过] 图片在索引中未找到: ${src}`);
				}
				return;
			}

			const localPath = this.getLocalResourcePath(entry.file);
			if (this.settings.debugMode && !this.loggedReplacements.has(src)) {
				this.loggedReplacements.add(src);
				this.logDiag(`[替换] 远程: ${src}`);
				this.logDiag(`[替换] 本地: ${localPath}`);
				// 用隐藏 Image 实测本地路径是否可加载（这是最终裁决）
				this.probeResourcePath(localPath, "实际渲染");
				// 检查文件是否存在于磁盘
				void this.app.vault.adapter.exists(entry.file).then((exists: boolean) => {
					this.logDiag(`[磁盘检查] ${entry.file} 存在=${exists}`);
				});
			}
			img.setAttribute("src", localPath);
			img.setAttribute("data-original-src", src);
		});

		// 处理 audio/video/source 标签
		const media = el.querySelectorAll("audio, video, source");
		media.forEach((node) => {
			const src = node.getAttribute("src");
			if (src && /^https?:\/\//i.test(src)) {
				const entry = this.findEntryByUrl(src);
				if (entry) {
					const localPath = this.getLocalResourcePath(entry.file);
					node.setAttribute("src", localPath);
					node.setAttribute("data-original-src", src);
				}
			}
		});

		// 处理普通链接（a 标签）指向可缓存文件类型
		const links = el.querySelectorAll("a");
		links.forEach((a) => {
			const href = a.getAttribute("href");
			if (href && /^https?:\/\//i.test(href)) {
				const entry = this.findEntryByUrl(href);
				if (entry) {
					const localPath = this.getLocalResourcePath(entry.file);
					a.setAttribute("href", localPath);
					a.setAttribute("data-original-href", href);
				}
			}
		});
	}

}

// ==================== 设置面板 ====================

class OnDemandCacheSettingTab extends PluginSettingTab {
	plugin: OnDemandCachePlugin;

	constructor(app: App, plugin: OnDemandCachePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	/**
	 * 声明式设置定义（Obsidian 1.13.0+），让设置项出现在设置搜索中。
	 */
	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: t("文件类别过滤模式", "File type filter mode"),
				desc: t("白名单：只缓存列表中的后缀；黑名单：不缓存列表中的后缀", "Whitelist: only cache listed extensions; Blacklist: skip listed extensions"),
				control: {
					key: "filterMode",
					type: "dropdown",
					options: {
						whitelist: t("白名单（只缓存以下类别）", "Whitelist (only cache these)"),
						blacklist: t("黑名单（不缓存以下类别）", "Blacklist (skip these)"),
					},
				},
			},
			{
				name: t("文件后缀列表", "File extensions"),
				desc: t("用逗号分隔，例如：png,jpg,mp4,pdf,docx", "Comma-separated, e.g. png,jpg,mp4,pdf,docx"),
				control: {
					key: "fileExtensions",
					type: "textarea",
					placeholder: "png,jpg,mp4,pdf,docx",
					rows: 4,
				},
			},
			{
				name: t("单个附件最大大小 (MB)", "Max attachment size (MB)"),
				desc: t("超过此大小的附件不会被缓存，0 表示不限制", "Attachments larger than this won't be cached; 0 means no limit"),
				control: {
					key: "maxFileSizeMB",
					type: "text",
					placeholder: "50",
				},
			},
			{
				name: t("缓存目录", "Cache folder"),
				desc: t("缓存文件存放的文件夹（相对于 vault 根目录）；隐藏目录（以 . 开头，如 .cache）同样可用，建议将其排除同步", "Folder for cached files (relative to vault root); hidden folders (starting with ., e.g. .cache) work too. Avoid syncing this folder"),
				control: {
					key: "cacheFolder",
					type: "text",
					placeholder: ".cache",
				},
			},
			{
				name: t("启动时自动清理", "Auto-clean on startup"),
				desc: t("启动时自动删除未被文档引用的缓存文件", "Automatically delete cache files not referenced by any note on startup"),
				control: {
					key: "cleanupOnStartup",
					type: "toggle",
				},
			},
			{
				name: t("渲染时使用缓存", "Use cache when rendering"),
				desc: t("阅读/预览时，将网络链接替换为本地缓存文件（文档内容不变）", "When reading/previewing, replace remote links with local cache files (note content stays unchanged)"),
				control: {
					key: "enableRenderReplace",
					type: "toggle",
				},
			},
			{
				name: t("诊断日志", "Diagnostic logging"),
				desc: t("开启后记录详细日志到缓存目录的 debug.log（用于排查问题，默认关闭以避免性能开销）", "When enabled, writes detailed logs to debug.log in the cache folder (for troubleshooting; off by default to avoid overhead)"),
				control: {
					key: "debugMode",
					type: "toggle",
				},
			},
			{
				type: "group",
				heading: t("操作", "Actions"),
				items: [
					{
						name: t("一键缓存所有附件", "Cache all attachments"),
						desc: t("遍历所有文档并缓存其中的网络附件", "Scan all notes and cache their remote attachments"),
						action: () => {
							void this.plugin.cacheAllAttachments();
						},
					},
					{
						name: t("清理未使用缓存", "Clean up unused cache"),
						desc: t("删除未被任何文档引用的缓存文件", "Delete cache files not referenced by any note"),
						action: () => {
							void this.plugin.cleanupUnusedCache();
						},
					},
					{
						name: t("清空缓存", "Clear cache"),
						desc: t("删除所有缓存文件并重置缓存索引", "Delete all cache files and reset the cache index"),
						action: () => {
							this.confirmClearCache();
						},
					},
				],
			},
		];
	}

	/**
	 * 读取设置值。fileExtensions 是数组，需要转换为逗号分隔字符串。
	 */
	getControlValue(key: string): unknown {
		if (key === "fileExtensions") {
			return this.plugin.settings.fileExtensions.join(",");
		}
		return (this.plugin.settings as unknown as Record<string, unknown>)[key];
	}

	/**
	 * 写入设置值。fileExtensions 需要从逗号分隔字符串转换回数组。
	 */
	setControlValue(key: string, value: unknown): void | Promise<void> {
		if (key === "fileExtensions") {
			this.plugin.settings.fileExtensions = String(value)
				.split(",")
				.map((s) => normalizeExt(s.trim()))
				.filter((s) => s.length > 0);
		} else if (key === "maxFileSizeMB") {
			const num = parseFloat(String(value));
			this.plugin.settings.maxFileSizeMB = isNaN(num) ? 0 : num;
		} else if (key === "cacheFolder") {
			this.plugin.settings.cacheFolder = String(value).trim() || ".cache";
		} else {
			(this.plugin.settings as unknown as Record<string, unknown>)[key] = value;
		}
		return this.plugin.saveSettings();
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setHeading().setName(t("On-Demand Cache 设置", "On-Demand Cache Settings"));

		// 文件类别过滤模式
		new Setting(containerEl)
			.setName(t("文件类别过滤模式", "File type filter mode"))
			.setDesc(t("白名单：只缓存列表中的后缀；黑名单：不缓存列表中的后缀", "Whitelist: only cache listed extensions; Blacklist: skip listed extensions"))
			.addDropdown((dropdown) => {
				dropdown
					.addOption("whitelist", t("白名单（只缓存以下类别）", "Whitelist (only cache these)"))
					.addOption("blacklist", t("黑名单（不缓存以下类别）", "Blacklist (skip these)"))
					.setValue(this.plugin.settings.filterMode)
					.onChange(async (value) => {
						this.plugin.settings.filterMode = value as "whitelist" | "blacklist";
						await this.plugin.saveSettings();
					});
			});

		// 文件后缀列表
		const extSetting = new Setting(containerEl)
			.setName(t("文件后缀列表", "File extensions"))
			.setDesc(t("用逗号分隔，例如：png,jpg,mp4,pdf,zip", "Comma-separated, e.g. png,jpg,mp4,pdf,zip"))
			.addTextArea((text) => {
				text
					.setPlaceholder("png,jpg,mp4,pdf,zip")
					.setValue(this.plugin.settings.fileExtensions.join(","))
					.onChange(async (value) => {
						this.plugin.settings.fileExtensions = value
							.split(",")
							.map((s) => normalizeExt(s.trim()))
							.filter((s) => s.length > 0);
						await this.plugin.saveSettings();
					});
				text.inputEl.rows = 7;
				text.inputEl.addClass("on-demand-cache-ext-input");
			});
		// 让该设置项垂直排列并占满整行，使输入框获得更大宽度（样式见 styles.css）
		extSetting.settingEl.addClass("on-demand-cache-ext-setting");

		// 最大大小
		new Setting(containerEl)
			.setName(t("单个附件最大大小 (MB)", "Max attachment size (MB)"))
			.setDesc(t("超过此大小的附件不会被缓存，0 表示不限制", "Attachments larger than this won't be cached; 0 means no limit"))
			.addText((text) => {
				text
					.setPlaceholder("50")
					.setValue(String(this.plugin.settings.maxFileSizeMB))
					.onChange(async (value) => {
						const num = parseFloat(value);
						this.plugin.settings.maxFileSizeMB = isNaN(num) ? 0 : num;
						await this.plugin.saveSettings();
					});
			});

		// 缓存目录
		new Setting(containerEl)
			.setName(t("缓存目录", "Cache folder"))
			.setDesc(t("缓存文件存放的文件夹（相对于 vault 根目录）；隐藏目录（以 . 开头，如 .cache）同样可用，建议将其排除同步", "Folder for cached files (relative to vault root); hidden folders (starting with ., e.g. .cache) work too. Avoid syncing this folder"))
			.addText((text) => {
				text
					.setPlaceholder(".cache")
					.setValue(this.plugin.settings.cacheFolder)
					.onChange(async (value) => {
						this.plugin.settings.cacheFolder = value.trim() || ".cache";
						await this.plugin.saveSettings();
					});
			});

		// 启动时清理
		new Setting(containerEl)
			.setName(t("启动时自动清理", "Auto-clean on startup"))
			.setDesc(t("启动时自动删除未被文档引用的缓存文件", "Automatically delete cache files not referenced by any note on startup"))
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.cleanupOnStartup)
					.onChange(async (value) => {
						this.plugin.settings.cleanupOnStartup = value;
						await this.plugin.saveSettings();
					});
			});

		// 渲染替换
		new Setting(containerEl)
			.setName(t("渲染时使用缓存", "Use cache when rendering"))
			.setDesc(t("阅读/预览时，将网络链接替换为本地缓存文件（文档内容不变）", "When reading/previewing, replace remote links with local cache files (note content stays unchanged)"))
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.enableRenderReplace)
					.onChange(async (value) => {
						this.plugin.settings.enableRenderReplace = value;
						await this.plugin.saveSettings();
					});
			});

		// 诊断日志
		new Setting(containerEl)
			.setName(t("诊断日志", "Diagnostic logging"))
			.setDesc(t("开启后记录详细日志到缓存目录的 debug.log（用于排查问题，默认关闭以避免性能开销）", "When enabled, writes detailed logs to debug.log in the cache folder (for troubleshooting; off by default to avoid overhead)"))
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.debugMode)
					.onChange(async (value) => {
						this.plugin.settings.debugMode = value;
						await this.plugin.saveSettings();
					});
			});

		// 操作按钮
		new Setting(containerEl).setHeading().setName(t("操作", "Actions"));

		new Setting(containerEl)
			.setName(t("一键缓存所有附件", "Cache all attachments"))
			.setDesc(t("遍历所有文档并缓存其中的网络附件", "Scan all notes and cache their remote attachments"))
			.addButton((button) => {
				button
					.setButtonText(t("立即缓存", "Cache now"))
					.setCta()
					.onClick(() => {
						void this.plugin.cacheAllAttachments();
					});
			});

		new Setting(containerEl)
			.setName(t("清理未使用缓存", "Clean up unused cache"))
			.setDesc(t("删除未被任何文档引用的缓存文件", "Delete cache files not referenced by any note"))
			.addButton((button) => {
				button
					.setButtonText(t("立即清理", "Clean now"))
					.setCta()
					.onClick(() => {
						void this.plugin.cleanupUnusedCache();
					});
			});

		new Setting(containerEl)
			.setName(t("清空缓存", "Clear cache"))
			.setDesc(t("删除所有缓存文件并重置缓存索引", "Delete all cache files and reset the cache index"))
			.addButton((button) => {
				button
					.setButtonText(t("清空缓存", "Clear cache"))
					.setCta()
					.onClick(() => {
						this.confirmClearCache();
					});
			});
	}

	/**
	 * 弹出二次确认对话框，确认后才执行清空缓存（不可撤销操作）。
	 */
	confirmClearCache(): void {
		const modal = new Modal(this.app);
		modal.titleEl.setText(t("确认清空缓存？", "Clear cache?"));

		modal.contentEl.createEl("p", {
			text: t(
				"此操作将删除所有已缓存的附件文件并重置缓存索引，且无法撤销。",
				"This will delete all cached attachment files and reset the cache index. This action cannot be undone."
			),
		});
		modal.contentEl.createEl("p", {
			text: t(
				"原始网络链接不受影响，下次打开笔记时会重新下载。",
				"Your original links are not affected; files will be re-downloaded the next time you open a note."
			),
			cls: "setting-item-description",
		});

		const btnRow = modal.contentEl.createDiv({ cls: "modal-button-container" });

		const cancelBtn = btnRow.createEl("button", {
			text: t("取消", "Cancel"),
		});
		cancelBtn.onclick = () => modal.close();

		const confirmBtn = btnRow.createEl("button", {
			text: t("确认清空", "Clear cache"),
			cls: "mod-warning",
		});
		confirmBtn.onclick = () => {
			modal.close();
			void this.plugin.clearAllCache();
		};

		modal.open();
	}
}
