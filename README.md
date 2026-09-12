# On-Demand Cache

On-demand persistent cache for remote attachments (images, videos, audio, documents). Downloads files only when you open a note, then transparently serves the local copy instead of the network file while keeping your original links unchanged.

[中文文档 / Chinese documentation](README.zh-CN.md)

## How it works

- **Original links preserved**: Network links (`https://...`) in your notes stay untouched. Syncing only syncs the link text, never the actual files.
- **On-demand download**: Attachments are downloaded only when you open a note, not proactively in bulk.
- **Persistent local cache**: Files are stored in the `.cache` folder (excluded from syncing, so they are never synced).
- **Serve local copy**: When reading/previewing, remote links are transparently replaced with local cache paths for offline access.
- **Auto-fill on other devices**: When you open a note on another device, missing attachments are downloaded automatically.

## Difference from "download & replace" plugins

Most similar plugins **permanently rewrite** the links in your notes (changing `https://...` to a local path). This plugin **never modifies your note content** — it only temporarily uses local files at render time, keeping the original network links intact. As a result:

- Notes sync safely across devices (only link text is synced, not large files).
- Missing attachments are re-cached on demand after switching devices.
- You can always fall back to network loading with no side effects.

## Implementation

### Key processing steps

1. **Link extraction**: When a note is opened, all network links are extracted from the Markdown content using regex, supporting Markdown images `![alt](url)`, Markdown links `[text](url)`, HTML tags `<img>`/`<audio>`/`<video>`/`<source>`, and bare URLs.

2. **Cache decision**: Each link is checked against whether it should be cached — already cached, has a file extension, matches the whitelist/blacklist, and is within the size limit.

3. **Download & dedup**: Files are downloaded via `requestUrl`, deduplicated by content hash (identical content is stored only once), written to the `.cache` folder, and recorded in the cache index `cache-index.json`.

4. **Render replacement**: A Markdown post-processor combined with a global `MutationObserver` replaces the `src` of `<img>` and other tags from the network link to a local `app://` resource path (`getResourcePath`) at render time, enabling offline display.

5. **Cleanup**: On startup, all notes are scanned and cache files no longer referenced by any note are deleted.

### Key design decisions

- **The cache folder may be a hidden directory**: `FileSystemAdapter.getResourcePath` encodes the absolute file path directly into an `app://` resource-proxy URL, which Obsidian's renderer resolves by reading the file from disk. It does not depend on the vault's file index, so a hidden directory such as `.cache` works fine. The default is therefore `.cache`.
- **Render replacement never modifies the source**: Replacement only happens on the rendered DOM; the note file content is always unchanged.

## Installation

This plugin is available in the Obsidian community plugin store.

**From the store (recommended):**

1. Open Obsidian → Settings → Community plugins → Browse.
2. Search for "On-Demand Cache" and click Install, then Enable.

**Manual installation:**

1. Download `main.js` and `manifest.json` from the [latest release](https://github.com/czhhbp/obsidian-on-demand-cache/releases).
2. Place both files into a new folder `.obsidian/plugins/on-demand-cache/` in your vault.
3. Enable "On-Demand Cache" in Obsidian → Settings → Community plugins → Installed plugins.

## Usage

### Automatic caching (default)

**Cache on open**: When you open a note containing remote attachments, the plugin automatically downloads them to the local cache. They remain visible even after going offline.

> ⚠️ **Important**: Caching is triggered **only when a note is opened**. If you insert a new remote attachment **while editing** (for example, pasting a network image link), the plugin will **not** cache it immediately. You need to **reopen the note** (or switch to another note and back) for the plugin to detect and cache the newly inserted attachment.

### Commands

- **Cache all remote attachments**: Scan all Markdown notes and cache their remote attachments.
- **Cache remote attachments in current note**: Cache only the currently open note.
- **Clean up unused cache files**: Delete cache files that are no longer referenced.

### Settings

Configure in Obsidian Settings → Community plugins → On-Demand Cache (the UI language switches between English and Chinese automatically based on Obsidian's language):

| Setting | Description |
|--------|------|
| Filter mode | Whitelist / Blacklist |
| File extensions | Comma-separated, e.g. `png,jpg,mp4,pdf,docx` |
| Max size | In MB, 0 means no limit |
| Cache folder | Default `.cache` |
| Auto-clean | Toggle |
| Use cache | Toggle |
| Diagnostic logging | Enable for troubleshooting, off by default |

## Cache folder

Cache files are stored in the `.cache` folder. This folder should be **excluded from syncing** so the actual files are never uploaded:

- **Git**: add `.cache/` to your `.gitignore`.
- **Other sync tools** (Obsidian Sync, Dropbox, OneDrive, etc.): configure the corresponding exclusion/ignore rule for the `.cache/` folder.

> Note: The cache folder **may** start with `.` (a hidden directory). Because `app://` resource paths are resolved directly from disk rather than through the vault index, hidden directories such as `.cache` load images correctly.

## Supported link formats

- Markdown image: `![alt](https://...)`
- Markdown link: `[text](https://...)`
- Obsidian wiki link: `![[https://...]]`, `[[https://...]]`, `[[https://...|alias]]`
- HTML tags: `<img src="https://...">`, `<audio>`, `<video>`, `<source>`
- Bare URL: `https://...`

## Development

```bash
npm install
npm run build   # build
npm run dev     # dev mode (watch)
```
