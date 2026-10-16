![Downloads](https://img.shields.io/github/downloads/jynxtraverse-ops/foundry-tube/total)

# Foundry Tube 📺

A compact, feature-rich, and synchronized YouTube player for Foundry VTT.

Foundry Tube allows GMs to play music, ambience, or videos from YouTube directly within the VTT. It features a modern, dark UI, a robust playlist system, preset management, and synchronized playback states for all connected players.

> **This is a community-maintained fork** of [Foundry Tube by shrade](https://github.com/shradee/foundry-tube).
> The original has been quiet since March 2026, and its playlist import and search broke when the
> free CORS proxies it relied on shut down. This fork fixes that and other bugs. See the
> [changelog](CHANGELOG.md) for details.
> All credit for the original module goes to shrade:
> [![Support the original author on Ko-fi](https://img.shields.io/badge/Support_the_original_author-Ko--fi-F16061?logo=ko-fi&logoColor=white)](https://ko-fi.com/shrade_himself)

## Installation

1. Copy the manifest URL:
   ```
   https://github.com/jynxtraverse-ops/foundry-tube/releases/latest/download/module.json
   ```
2. In Foundry's setup screen, open **Add-on Modules → Install Module**.
3. Paste the URL into **Manifest URL** and click **Install**.

**Switching from the original module:** uninstall the original Foundry Tube first, then install
from the URL above. Your playlists, presets and settings are stored in each world, not in the
module folder, so they carry over. Updates then arrive through Foundry's normal **Update** button.

## Features

*   **Synchronized Playback:** Play, Pause, Seek, and Loop states are synced instantly between GM and players.
*   **Compact UI:**
    *   **Standard Mode:** Full video player with controls.
    *   **Mini Mode:** Double-click the header (or drag-handle) to collapse the player into a slim, 50px control bar that stays out of your way.
*   **Smart Search & Import:**
    *   Paste a direct YouTube link.
    *   Paste a **YouTube Playlist** link to import all videos at once.
    *   Type a search query to find videos directly inside Foundry.
*   **Playlist Management:**
    *   **Drag & Drop:** Reorder tracks in the queue by dragging them.
    *   **Presets:** Save your current queue as a preset (e.g., "Battle Music", "Tavern Ambience") and load it later instantly.
*   **Seamless Marquee:** Long video titles scroll automatically and seamlessly in the interface.
*   **Loop and Shuffle:** Repeat the current track, or shuffle so every track plays once before any repeats.
*   **Unplayable videos:** Videos whose owners block embedding are reported and skipped automatically.

## Usage

### For GMs
1.  Open the **Token Controls** (left sidebar) and click the **TV Icon** to open the widget.
2.  Click the **+** button to open the input bar.
3.  Paste a link or type a search term and press Enter.
4.  Use the **List Icon** to view the queue.
    *   **Drag** items to reorder.
    *   **Save** the current queue using the Save icon in the preset toolbar.
5.  Double-click the very top edge (drag handle) to minimize/maximize the player.

### For Players
*   The video will play automatically when the GM starts it.
*   You can adjust your own **Local Volume** using the slider on the right. It applies to every channel.
*   The window can be moved or minimized locally.
*   **Sync** re-syncs every channel with the GM.

## Settings

Found under **Configure Settings → Foundry Tube**.

| Setting | Who | What it does |
|---|---|---|
| YouTube API Key | GM, this browser only | Fast, reliable search and imports with real titles and lengths. |
| Custom CORS Proxy | GM, this browser only | Your own proxy for search without a key. Use `{url}` as the placeholder. |
| Try Free Public Proxies | GM, this browser only | On by default. Turn off to never route requests through third-party proxies. |
| Skip Unplayable Videos | World | Auto-skip videos YouTube refuses to embed. On by default. |
| Auto play on Startup | Each user | Start playing as soon as you log in. Otherwise press **Sync**. |
| Hide on Startup | Each user | Start with the widget hidden. |

### Getting a free YouTube API key (optional, about 5 minutes)

Playlist import works without a key. Search needs either a key or a working proxy.

1. Go to <https://console.cloud.google.com/> and create a project (any name).
2. **APIs & Services → Library**, search **YouTube Data API v3**, click **Enable**.
3. **APIs & Services → Credentials → Create credentials → API key.** Copy it.
4. Recommended: edit the key, and under *API restrictions* allow only YouTube Data API v3.
5. Paste it into Foundry Tube's **YouTube API Key** setting.

The free quota is 10,000 units a day. A search costs 100 units (about 100 searches a day), and
importing a playlist costs roughly 2 units per 50 videos. The key is stored only in the GM's browser
and is never sent to players.

## Technical Details
*   Playback uses the standard YouTube IFrame API.
*   Playlists are read through YouTube's embedded player (no proxy needed), with titles from oEmbed;
    tracks without a title or length fill them in the first time they play.
*   With an API key, search and imports use the official YouTube Data API.
*   Without a key, search falls back to CORS proxies, each with a timeout.

## License
GNU General Public License v3.0, same as the original. See [LICENSE](LICENSE).
