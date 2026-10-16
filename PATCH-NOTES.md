# Foundry Tube 1.4.1.1 — community patch

An unofficial patch on top of shrade's Foundry Tube 1.4.1. The upstream repo has been quiet since
March 2026 with open issues (#8, #11, #12), so this fixes the breakage without waiting. Same module
ID, so your saved presets, playlists and settings carry over untouched.

## What was broken, and what changed

### Playlist import (issue #11) — the big one
The module fetched every YouTube page through three free CORS proxies. All three now fail
(one blocks CORS, one returns 520 errors, one requires a paid key), and there were no timeouts, so
playlist imports failed outright and single videos could take ~2 minutes to add.

Imports no longer depend on those proxies:

1. **With an API key** (optional, see below): the official YouTube Data API. Real titles and
   lengths, up to 2,000 videos, and private/deleted/non-embeddable videos are skipped with a count.
2. **Without a key**: YouTube's own embedded player is asked for the playlist's video list (no
   proxy involved), and titles come from oEmbed lookups.
3. **Last resort**: the original proxy scrape, now with a 7-second timeout per proxy. A proxy that
   fails is skipped for the next 10 minutes.

Any track imported with a placeholder title ("Video abc123") or length ("--:--") **repairs itself
the first time it plays**, and the fix is saved for everyone.

Also:
- Pasting a song link copied from a YouTube **Mix** (`&list=RD…`) adds that song instead of trying
  to import an auto-generated radio station.
- `youtube.com/shorts/…` and `youtube.com/live/…` links are recognised.
- The page-data parser no longer truncates YouTube's JSON at the first `};` it finds.

### Search
Works instantly with an API key. Without one it still tries the proxies (and an optional
**custom proxy** you can configure); if none can reach YouTube, the search panel now says so and
suggests pasting a link, instead of a bare "No results".

### Videos that won't play (issue #8, "some music is not played at all")
Many videos have embedding disabled by their owner. Previously they failed silently. Now:
- The GM gets a message saying which video failed and why.
- With **Skip Unplayable Videos** on (default), the channel moves to the next track. If every
  track in a row fails, it stops instead of looping forever.
- Adding a single video that can't be embedded is refused up front, with the reason.

### Volume (issue #8, "players can only mute")
Each channel tab has its own slider, but it only changed the channel you were *viewing*. A player
looking at channel 1 while the GM played channel 3 could mute (which hits everything) but never
turn the music down. The slider is now a **master volume for all channels**, kept in sync across
tabs.

### Shuffle
- Fixed an operator-precedence bug and an off-by-one that sent the track index outside the
  playlist (about 1 pick in 20 on a 5-track list), which threw an error and stopped playback.
- Now a proper **shuffle bag**: every track plays once before any repeats, never the same track
  twice in a row.
- The shuffle button on players' screens now lights up correctly (it was reading the loop flag),
  and is hidden for players like the other GM-only buttons.

### Sync between GM and players
- When a player connected, the GM broadcast **~100 sync messages to every client**, making other
  players' music skip and blip. Now the GM sends a targeted reply to only the player who asked
  (20 messages), and with several GMs online only one answers.
- A player joining while a channel is paused (or with Auto Play off) gets the track cued silently
  at the right spot, instead of a short burst of sound.
- If the GM empties a channel, players' copies stop.
- The player **Sync** button now resyncs every channel, not just the one on screen.

### Other fixes
- **Pressing Esc** no longer freezes the clock and seek bar (timers were torn down even though the
  window refused to close).
- **Saving or deleting a preset** no longer restarts every playing channel from 0:00 on the GM's
  side (it used to rebuild the whole window).
- **Security:** video titles are YouTube-controlled text and were inserted as raw HTML on every
  client. They are now escaped.
- Dialogs moved from the deprecated V1 `Dialog` to `DialogV2`.
- The scene-control button gets the `order` field Foundry v13+ expects.
- Removing the last track while it's playing no longer throws an error.

## New settings (Configure Settings → Foundry Tube)
| Setting | Who | What it does |
|---|---|---|
| YouTube API Key | GM, this browser only | Fast, reliable search and imports with real titles and lengths. |
| Custom CORS Proxy | GM, this browser only | Your own proxy for search without a key. Use `{url}` as the placeholder. |
| Try Free Public Proxies | GM, this browser only | On by default. Turn off to never route requests through third-party proxies. |
| Skip Unplayable Videos | World | Auto-skip videos YouTube refuses to embed. On by default. |

### Getting a free YouTube API key (about 5 minutes)
1. Go to <https://console.cloud.google.com/> and create a project (any name).
2. **APIs & Services → Library**, search **YouTube Data API v3**, click **Enable**.
3. **APIs & Services → Credentials → Create credentials → API key.** Copy it.
4. Recommended: edit the key, under *API restrictions* allow only YouTube Data API v3.
5. Paste it into Foundry Tube's **YouTube API Key** setting.

The free quota is 10,000 units a day. A search costs 100 units (about 100 searches a day), while
importing a playlist costs roughly 2 units per 50 videos. The key is stored only in the GM's
browser and is never sent to players.

## Installing
1. Return Foundry to the **Setup** screen (or shut it down).
2. Find your User Data folder (shown on the Setup screen's **Configuration** tab), then open
   `Data/modules/foundry-tube/`.
3. Replace everything in that folder with the contents of this zip, so `module.json` sits directly
   inside `foundry-tube/`.
4. Launch the world. **Manage Modules** should show version **1.4.1.1**.
5. Ask players to hard-refresh (Ctrl+F5 / Cmd+Shift+R) once so their browsers drop the old script.

**Heads-up:** the manifest still points at shrade's repo. If the original author releases 1.4.2 or
later, Foundry will offer it as an update, and installing it would replace these fixes with
whatever that release contains.

## Testing status
These changes were exercised in headless Chromium against simulated Foundry and YouTube APIs,
including the exact proxy failures from issue #11. They have **not** yet been run inside a real
Foundry world against live YouTube, so treat the first session as a shakedown. The browser
console (F12) logs anything unexpected with a `foundry-tube |` prefix.
