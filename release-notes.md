Fixed the cache-folder documentation and made `.cache` the default.

### What's changed

- **Default cache folder is now `.cache`**: the default was previously `cache`. Both work equally well; `.cache` keeps the cached files tidily hidden inside your vault.
- **Corrected a documentation error**: earlier docs stated the cache folder *must be a non-hidden directory* because Obsidian does not index hidden folders. This was **wrong**. `FileSystemAdapter.getResourcePath` encodes the absolute file path directly into an `app://` resource-proxy URL, which Obsidian's renderer resolves by reading from disk — it does not depend on the vault's file index. Hidden folders such as `.cache` therefore render images correctly (verified on desktop, including after clearing Obsidian's HTTP cache and going offline).
- **Updated the README** (English and Chinese) to reflect the corrected behavior and the new default.

### Notes

- No changes to caching behavior, link handling, filters, or commands.
- Existing users keep whatever cache folder they have configured; only the default (used for fresh installs and when the field is cleared) changed.
- Requires Obsidian 1.8.7 or later (unchanged).

This is a documentation/behavior-default fix. Upgrading is recommended.