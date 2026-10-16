# Changelog

## 1.6.0 — 2026-10-16

### Pop the player out into its own window (Foundry v14+)
A new button in the widget, next to the playlist button, moves the whole player into a separate
browser window, for the GM and for players. Put it on a second monitor, or keep it in view while
Foundry is minimized. Press it again to put the player back.

- Every channel carries on where it was: the YouTube players are rebuilt in the new window and
  resume at the same spot with a short fade-in. Players also re-sync with the GM.
- The docked mixer comes along with the player.
- Closing the pop-out window with its own close button brings the player back into Foundry,
  still playing.
- Uses Foundry v14's built-in window pop-out support. On v13 the button is hidden.

### Changes
- Marked as verified for Foundry v14.

## 1.5.0 — 2026-10-16

### Table mixer (GM)
Every channel gets its own row: name, volume, previous / play-pause / next.

- **Docked or floating.** It docks to the side of the player, and the **pop-out** button turns it
  into its own window. A docked mixer collapses along with the player; a floating one stays put,
  so you can collapse the player and keep the controls. The **sliders** button in the player shows
  or hides it. Where it lives and where you left the window are remembered.
- **Table mix.** Channel volumes are the GM's mix for the whole table: they update live for
  everyone while you drag, and are saved when you let go. Each player's own volume slider sits on
  top as a master volume.
- **Channel names.** Double-click a channel's name (or number) to rename it, such as "Music",
  "Ambience" or "Combat". Custom names replace track names in the mixer and show as tooltips on
  the channel buttons. Clear the name to go back to the track title.
- **Less clutter when docked.** The channel you're viewing in the player doesn't repeat its track
  name in the mixer; the floating mixer shows every channel. Clicking a channel number views it.

### Fades
Pausing fades a channel out, resuming fades it back in, and skipping fades the old track out and
the new one in, in step for everyone at the table. Tracks that end on their own still move on
straight away. **Fade Length** (world setting, default 1.5 s; 0 turns fades off).

### Player controls
- **Pause just for yourself.** Players can pause a channel for their own ears without
  affecting anyone. While paused they stay paused even if the GM changes tracks. Pressing play
  rejoins the table wherever the music is now, with a fade-in.
- **Skip requests.** A player's skip button asks the GM to skip the current track. The GM gets a
  small card ("Aria wants to skip *Rain on Rooftops* on Ambience") with **Skip it** and **Keep
  playing**. Requests from several players merge into one card, pressing Next in the mixer also
  approves, and requests about a track that has already changed or that no one answers within a
  minute are cleared, with the player told the outcome. **Players Can Request Skips** (world
  setting) turns the button off.

### Fixes
- Collapsing the player while it was hidden could shrink it to the minimum width.

## 1.4.1.1 — 2026-10-16

First release of the community fork, on top of shrade's 1.4.1. Same module ID, so existing
playlists, presets and settings carry over.

### Playlist import (upstream issue #11) — the big one
The module fetched every YouTube page through three free CORS proxies. All three now fail
(one blocks CORS, one returns 520 errors, one requires a paid key), and there were no timeouts, so
playlist imports failed outright and single videos could take ~2 minutes to add.

Imports no longer depend on those proxies:

1. **With an API key** (optional, see the README): the official YouTube Data API. Real titles and
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

### Videos that won't play (upstream issue #8, "some music is not played at all")
Many videos have embedding disabled by their owner. Previously they failed silently. Now:
- The GM gets a message saying which video failed and why.
- With **Skip Unplayable Videos** on (default), the channel moves to the next track. If every
  track in a row fails, it stops instead of looping forever.
- Adding a single video that can't be embedded is refused up front, with the reason.

### Volume (upstream issue #8, "players can only mute")
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

### New settings
YouTube API Key, Custom CORS Proxy, Try Free Public Proxies, and Skip Unplayable Videos. See the
[README](README.md#settings).
