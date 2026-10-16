const MODULE_ID = 'foundry-tube';
const SOCKET_NAME = `module.${MODULE_ID}`;
const { ApplicationV2, HandlebarsApplicationMixin, DialogV2 } = foundry.applications.api;
const TAB_COUNT = 5;

/* -------------------------------------------- */
/*  Network helpers                             */
/* -------------------------------------------- */

// Free public CORS proxies. They are only a last resort (search without an API key, or when every
// other route fails) because they come and go: as of late 2026 all three were failing for most users.
const PUBLIC_PROXIES = [
    { name: "codetabs", build: (url) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`, json: false },
    { name: "allorigins", build: (url) => `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`, json: true },
    { name: "corsproxy", build: (url) => `https://corsproxy.io/?url=${encodeURIComponent(url)}`, json: false }
];

const FETCH_TIMEOUT_MS = 7000;           // no single request may hang the UI for minutes any more
const ENDPOINT_COOLDOWN_MS = 10 * 60000; // a failing endpoint is skipped for 10 minutes
const PLACEHOLDER_DURATION = "--:--";
const UNPLAYABLE_CODES = [100, 101, 150];
const PLAYER_ERRORS = {
    2: "the video ID is invalid",
    5: "the browser's video player hit an error",
    100: "the video was removed or is private",
    101: "the owner doesn't allow it to play outside YouTube",
    150: "the owner doesn't allow it to play outside YouTube",
    153: "YouTube rejected the request (no referrer information was sent)"
};

const endpointCooldowns = new Map();
const endpointIsCooling = (name) => (endpointCooldowns.get(name) ?? 0) > Date.now();
const coolEndpoint = (name) => endpointCooldowns.set(name, Date.now() + ENDPOINT_COOLDOWN_MS);

async function fetchWithTimeout(url, { timeout = FETCH_TIMEOUT_MS, ...init } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try { return await fetch(url, { ...init, signal: controller.signal }); }
    finally { clearTimeout(timer); }
}

/** Run `fn` over `items` with at most `limit` calls in flight. */
async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const i = next++;
            try { results[i] = await fn(items[i], i); } catch (e) { results[i] = undefined; }
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

/* -------------------------------------------- */
/*  Text helpers                                */
/* -------------------------------------------- */

const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
/** Video titles come from YouTube and are user-controlled, so they are never inserted as raw HTML. */
function escapeHTML(value) { return String(value ?? "").replace(/[&<>"']/g, c => HTML_ESCAPES[c]); }
/** For notification text: drop anything tag-like. */
function plainText(value) { return String(value ?? "").replace(/[<>]/g, ""); }
/** The Data API's search endpoint returns HTML-encoded titles ("Rock &amp; Roll"). */
function decodeEntities(text) {
    if (!text || !text.includes("&")) return text;
    // DOMParser documents never run scripts or fetch resources, so this is a safe decoder.
    return new DOMParser().parseFromString(`<!doctype html><body>${text}`, "text/html").body.textContent;
}
function isValidVideoId(id) { return typeof id === "string" && /^[a-zA-Z0-9_-]{11}$/.test(id); }
function safeThumb(url, id) {
    if (typeof url === "string" && /^https:\/\//i.test(url)) return url;
    return `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
}
function formatTime(s) {
    if (!s || isNaN(s)) return "0:00";
    const sec = Math.floor(s % 60), min = Math.floor((s / 60) % 60), hrs = Math.floor(s / 3600);
    const ss = sec < 10 ? `0${sec}` : sec;
    if (hrs > 0) { const mm = min < 10 ? `0${min}` : min; return `${hrs}:${mm}:${ss}`; }
    return `${min}:${ss}`;
}
function parseISODuration(iso) {
    const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso || "");
    if (!m) return 0;
    const [d, h, mi, s] = m.slice(1).map(x => parseInt(x || "0"));
    return d * 86400 + h * 3600 + mi * 60 + s;
}
function isPlaceholderTitle(video) {
    const t = video?.title;
    return !t || t === "Video" || t === "Loading..." || t === `Video ${video.id}`;
}
function isPlaceholderDuration(d) { return !d || d === PLACEHOLDER_DURATION || d === "0:00"; }
function makeVideo(id, data = {}) {
    return {
        id,
        title: data.title || `Video ${id}`,
        author: data.author || "YouTube",
        thumb: safeThumb(data.thumb, id),
        duration: data.duration || PLACEHOLDER_DURATION
    };
}

/**
 * YouTube embeds pages' state as `var ytInitialData = {...};</script>`. Match through the closing
 * script tag: the first "};" is usually deep inside the JSON, which made the old regex truncate it.
 */
function extractJSONAssignment(html, name) {
    const re = new RegExp(`${name}"?\\]?\\s*=\\s*(\\{.+?\\})\\s*;\\s*(?:<\\/script>|var\\s|window\\[)`, "s");
    const m = html.match(re);
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch (e) { return null; }
}

/* -------------------------------------------- */
/*  Invisible helper players                    */
/* -------------------------------------------- */

/**
 * Uses YouTube's own embedded player, which reads YouTube data without any CORS proxy, to look up a
 * playlist's video IDs or a single video's title. Each call builds an off-screen muted player and
 * always destroys it afterwards.
 */
class YTProbe {
    static async waitForAPI(timeout = 15000) {
        const start = Date.now();
        while (!window.YT?.Player) {
            if (Date.now() - start > timeout) throw new Error("The YouTube IFrame API did not load");
            await new Promise(r => setTimeout(r, 200));
        }
    }

    static async poll(fn, { timeout = 10000, interval = 250, state } = {}) {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            if (state?.dead) return null;
            try { const v = fn(); if (v) return v; } catch (e) {}
            await new Promise(r => setTimeout(r, interval));
        }
        return null;
    }

    static async withPlayer(options, work, { timeout = 25000 } = {}) {
        await this.waitForAPI();
        const host = document.createElement("div");
        host.className = "foundry-tube-probe";
        host.style.cssText = "position:fixed;left:-10000px;top:0;width:200px;height:200px;opacity:0;pointer-events:none;";
        const target = document.createElement("div");
        host.appendChild(target);
        document.body.appendChild(host);
        const state = { dead: false };
        let player;
        try {
            return await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error("YouTube helper player timed out")), timeout);
                const finish = (fn) => (value) => { clearTimeout(timer); state.dead = true; fn(value); };
                player = new YT.Player(target, {
                    width: 200, height: 200,
                    videoId: options.videoId,
                    playerVars: { controls: 0, autoplay: 0, mute: 1, playsinline: 1, origin: window.location.origin, ...(options.playerVars || {}) },
                    events: {
                        onReady: () => { Promise.resolve(work(player, state)).then(finish(resolve), finish(reject)); },
                        onError: (e) => {
                            // A playlist whose *first* video can't be embedded still lists fine, so
                            // playlist lookups keep polling instead of giving up.
                            if (options.ignoreErrors) return;
                            finish(reject)(Object.assign(new Error(`YouTube error ${e.data}`), { code: e.data }));
                        }
                    }
                });
            });
        } finally {
            state.dead = true;
            try { player?.destroy?.(); } catch (e) {}
            host.remove();
        }
    }

    /** Video IDs of a playlist, in order. */
    static async playlistIds(listId) {
        return this.withPlayer({ playerVars: { listType: "playlist", list: listId }, ignoreErrors: true }, async (player, state) => {
            const read = () => { const l = player.getPlaylist?.(); return l?.length ? l : null; };
            let ids = await this.poll(read, { timeout: 5000, state });
            if (!ids && !state.dead) {
                player.cuePlaylist?.({ listType: "playlist", list: listId });
                ids = await this.poll(read, { timeout: 12000, state });
            }
            return (ids || []).filter(isValidVideoId);
        });
    }

    /** Title, channel and length of one video. Rejects with `code` 101/150 when embedding is disabled. */
    static async videoInfo(videoId) {
        return this.withPlayer({ videoId }, async (player, state) => {
            const data = await this.poll(() => { const d = player.getVideoData?.(); return d?.title ? d : null; }, { timeout: 8000, state });
            const duration = await this.poll(() => player.getDuration?.() || null, { timeout: 2000, state });
            return data ? { title: data.title, author: data.author, duration: duration || 0 } : null;
        });
    }
}

/* -------------------------------------------- */
/*  Application                                 */
/* -------------------------------------------- */

class FoundryTubeApp extends HandlebarsApplicationMixin(ApplicationV2) {
    constructor() {
        super();
        window.tubeApp = this;
        this.players = Array(TAB_COUNT).fill(null);
        this.activeTab = 0;
        this.tabsState = Array(TAB_COUNT).fill(null).map(() => ({
            playlist: [], currentIndex: -1, localVideoId: "", isLooping: false, isShuffling: false, isInputMode: false, loaded: false
        }));
        this.isCustomMinimized = false;
        this.savedHeight = 360;
        this.savedWidth = 580;
        this.progressIntervals = Array(TAB_COUNT).fill(null);
        this._resizeObserver = null;
        this.initialLoad = true;
        this.isMuted = false;
        this.preMuteVolume = 50;
        this._shuffleBags = Array(TAB_COUNT).fill(null);
        this._errorStreak = Array(TAB_COUNT).fill(0);
        this._warnedErrors = new Set();
        this._lastFetchReachedYouTube = true;
    }

    static DEFAULT_OPTIONS = {
        id: "foundry-tube-app", tag: "div",
        window: { title: "Tube", icon: "fas fa-tv", resizable: true, minimizable: true, controls: [] },
        position: { width: 580, height: 360, top: 100, left: 115 },
        actions: {
            togglePlayback: FoundryTubeApp.prototype._onTogglePlayback,
            toggleLoop: FoundryTubeApp.prototype._onToggleLoop,
            toggleShuffle: FoundryTubeApp.prototype._onToggleShuffle,
            toggleInputMode: FoundryTubeApp.prototype._onToggleInputMode,
            executeSmartInput: FoundryTubeApp.prototype._onExecuteSmartInput,
            toggleQueue: FoundryTubeApp.prototype._onToggleQueue,
            clearQueue: FoundryTubeApp.prototype._onClearQueue,
            playNext: FoundryTubeApp.prototype._onPlayNextAction,
            playPrev: FoundryTubeApp.prototype._onPlayPrevAction,
            closeSearch: FoundryTubeApp.prototype._onCloseSearch,
            savePreset: FoundryTubeApp.prototype._onSavePreset,
            loadPreset: FoundryTubeApp.prototype._onLoadPreset,
            deletePreset: FoundryTubeApp.prototype._onDeletePreset,
            importFromClipboard: FoundryTubeApp.prototype._onImportFromClipboard,
            switchTab: FoundryTubeApp.prototype._onSwitchTab,
            manualSync: FoundryTubeApp.prototype._onManualSync,
            toggleMute: FoundryTubeApp.prototype._onToggleMute
        }
    };

    static PARTS = { main: { template: `modules/${MODULE_ID}/templates/widget.hbs` } };

    async minimize() {
        this.isCustomMinimized = !this.isCustomMinimized;
        if (this.isCustomMinimized) {
            if (this.element) {
                this.savedWidth = this.element.offsetWidth;
                if (this.element.offsetHeight > 100) this.savedHeight = this.element.offsetHeight;
            }
            this.element.classList.add('custom-minimized');
            return this.setPosition({ height: 58, width: this.savedWidth });
        } else {
            this.element.classList.remove('custom-minimized');
            const w = this.savedWidth || 580;
            const h = (this.savedHeight && this.savedHeight > 100) ? this.savedHeight : 360;
            return this.setPosition({ width: w, height: h });
        }
    }

    async close(options={}) {
        // The player is meant to stay open (Escape and "close all windows" must not stop the music).
        // Previously the timers and resize observer were torn down *before* this check, so pressing
        // Escape froze the seek bar and clock while the window stayed on screen.
        if (!options.force) return this;
        if (this._resizeObserver) { this._resizeObserver.disconnect(); this._resizeObserver = null; }
        this.progressIntervals.forEach(i => clearInterval(i));
        return super.close(options);
    }

    /** Show the window without re-rendering it (a re-render would rebuild every YouTube player). */
    show() {
        if (!this.element) return this.render({ force: true });
        this.element.style.display = "";
        this.bringToFront?.();
    }

    async _prepareContext(options) {
        const globalState = game.settings.get(MODULE_ID, 'tabsState') || {};
        const savedPlaylists = game.settings.get(MODULE_ID, 'savedPlaylists');
        const volume = game.settings.get(MODULE_ID, 'clientVolume');
        const tabsData = [];
        for(let i=0; i<TAB_COUNT; i++) {
            if (!this.tabsState[i].loaded) {
                const s = globalState[i] || {};
                this.tabsState[i].playlist = s.playlist || [];
                this.tabsState[i].currentIndex = s.currentIndex ?? -1;
                this.tabsState[i].localVideoId = s.videoId || "";
                this.tabsState[i].isLooping = s.isLooping || false;
                this.tabsState[i].isShuffling = s.isShuffling || false;
                this.tabsState[i].loaded = true;
            }
            tabsData.push({
                index: i, humanIndex: i + 1, isActive: (i === this.activeTab),
                          title: this.tabsState[i].playlist[this.tabsState[i].currentIndex]?.title || "No Video",
                          volume: volume, isLooping: this.tabsState[i].isLooping, isShuffling: this.tabsState[i].isShuffling
            });
        }
        return { isGM: game.user.isGM, savedPlaylists, tabs: tabsData };
    }

    _onRender(context, options) {
        try {
            const appHeader = this.element.closest('.window-app')?.querySelector('.window-header');
            if (appHeader) {
                const newHeader = appHeader.cloneNode(true);
                appHeader.parentNode.replaceChild(newHeader, appHeader);
                newHeader.addEventListener('dblclick', (e) => { e.preventDefault(); e.stopPropagation(); this.minimize(); });
                const t = newHeader.querySelector('.window-title'); if(t) t.innerText = "";
            }

            if (!this._resizeObserver) {
                this._resizeObserver = new ResizeObserver((entries) => {
                    for (const entry of entries) {
                        if (entry.contentRect.width > 50 && this.element.style.display !== 'none') {
                            this.savedWidth = entry.contentRect.width;
                            this.position.width = entry.contentRect.width;

                            const i = this.activeTab;
                            const el = this.element.querySelector(`#track-title-text-${i}`);
                            if (el) {
                                const span = el.querySelector('span');
                                if (span) this.updateTrackTitle(i, span.innerText);
                            }
                        }
                    }
                });
                this._resizeObserver.observe(this.element);
            }

            const vol = game.settings.get(MODULE_ID, 'clientVolume');
            if (vol === 0) this.isMuted = true;
            this.element.querySelectorAll('.volume-mute-btn i').forEach(icon => {
                icon.className = (vol === 0) ? "fas fa-volume-mute" : "fas fa-volume-up";
            });

            for(let i=0; i<TAB_COUNT; i++) {
                this._renderPlaylist(i);
                this._tryInitPlayer(i);
                if(this.tabsState[i].localVideoId) this._refreshTitle(i, this.tabsState[i].localVideoId);

                const container = this.element.querySelector(`.tube-instance[data-tab-index="${i}"]`);
                if(!container) continue;

                const smartInp = container.querySelector('input[name="smartInput"]');
                if(smartInp) {
                    const newInp = smartInp.cloneNode(true);
                    smartInp.parentNode.replaceChild(newInp, smartInp);
                    newInp.addEventListener('keydown', (e) => {
                        if(e.key === 'Enter') {
                            e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
                            newInp.blur();
                            this.executeSmartInput(i);
                        }
                    });
                }

                // The volume slider is a master volume for every channel. It used to only touch the
                // channel being viewed, so a player looking at channel 1 while the GM played channel 3
                // could mute (which hit every channel) but never turn the music down.
                const volInput = container.querySelector('input[name="volume"]');
                if (volInput) {
                    volInput.title = "Your volume (all channels)";
                    volInput.oninput = (e) => this._applyVolume(parseInt(e.target.value), { save: false });
                    volInput.onchange = (e) => this._applyVolume(parseInt(e.target.value), { save: true });
                }

                const seeker = container.querySelector('.video-seeker');
                if (seeker && game.user.isGM) {
                    const newSeeker = seeker.cloneNode(true);
                    seeker.parentNode.replaceChild(newSeeker, seeker);
                    newSeeker.addEventListener('change', () => {
                        const val = parseFloat(newSeeker.value);
                        if (this.players[i]?.seekTo) {
                            this.players[i].seekTo(val, true);
                            this.emitSocket("play", { time: val, tabId: i });
                        }
                    });
                }

                const shield = container.querySelector(`#player-shield-${i}`);
                if (shield) {
                    if (game.user.isGM) {
                        shield.style.cursor = "pointer";
                        shield.onclick = (e) => { e.stopPropagation(); this.togglePlayback(i); };
                    } else {
                        shield.style.cursor = "default";
                        shield.onclick = (e) => { e.preventDefault(); e.stopPropagation(); };
                    }
                }
                if (!game.user.isGM) {
                    const playBtn = container.querySelector('[data-action="togglePlayback"]');

                    if (playBtn && playBtn.parentNode) {
                        const controlsContainer = playBtn.parentNode;

                        if (!controlsContainer.querySelector('[data-action="manualSync"]')) {

                            const prevBtn = container.querySelector('[data-action="playPrev"]');
                            const loopBtn = container.querySelector('[data-action="toggleLoop"]');
                            if (loopBtn) loopBtn.style.display = 'none';
                            const shuffleBtn = container.querySelector('[data-action="toggleShuffle"]');
                            if (shuffleBtn) shuffleBtn.style.display = 'none';
                            const nextBtn = container.querySelector('[data-action="playNext"]');

                            if (prevBtn) prevBtn.style.display = 'none';
                            if (playBtn) playBtn.style.display = 'none';
                            if (nextBtn) nextBtn.style.display = 'none';

                            const syncBtn = document.createElement('button');
                            syncBtn.type = "button";
                            syncBtn.dataset.action = "manualSync";
                            syncBtn.innerHTML = '<i class="fas fa-sync"></i> Sync';
                            syncBtn.title = "Resync every channel with the GM";

                            syncBtn.className = playBtn.className;
                            syncBtn.style.width = "auto";
                            syncBtn.style.padding = "0 10px";
                            syncBtn.style.borderRadius = "5px";
                            syncBtn.style.fontSize = "12px";

                            controlsContainer.appendChild(syncBtn);
                        }
                    }
                }

            }

            if (this.isCustomMinimized) {
                this.element.classList.add('custom-minimized');
                this.setPosition({ height: 58, width: this.savedWidth });
            }
            const enabled = game.settings.get(MODULE_ID, 'enableTransparency');
            const op = enabled ? game.settings.get(MODULE_ID, 'minimizedOpacity') / 100 : 1;
            this.element.style.setProperty('--minimized-opacity', op);
        } catch (err) { console.error(err); }
    }

    /* -------------------------------------------- */
    /*  Playback                                    */
    /* -------------------------------------------- */

    async playVideoNow(tab, videoData) {
        const insertIdx = this.tabsState[tab].currentIndex + 1;
        this.tabsState[tab].playlist.splice(insertIdx, 0, videoData);
        this.tabsState[tab].currentIndex = insertIdx;
        await this._syncPlaylistState(tab);
        this.broadcastState(tab, videoData.id, 0, true);
        this.updateTrackTitle(tab, videoData.title);
    }

    async playNext(tab) {
        if (!this.tryAdvanceTrackIndex(tab)) return;
        await this._syncPlaylistState(tab);
        const v = this.tabsState[tab].playlist[this.tabsState[tab].currentIndex];
        if (!v) return;
        this.broadcastState(tab, v.id, 0, true);
        this.updateTrackTitle(tab, v.title);
    }

    async playPrev(tab) {
        if (this.tabsState[tab].currentIndex <= 0) return;
        this.tabsState[tab].currentIndex--;
        await this._syncPlaylistState(tab);
        const v = this.tabsState[tab].playlist[this.tabsState[tab].currentIndex];
        if (!v) return;
        this.broadcastState(tab, v.id, 0, true);
        this.updateTrackTitle(tab, v.title);
    }

    tryAdvanceTrackIndex(tab) {
        const st = this.tabsState[tab];
        const playlistLength = st.playlist.length;
        if (playlistLength === 0) return false;

        if (st.isShuffling) {
            st.currentIndex = this._nextShuffleIndex(tab);
            return true;
        }
        if (st.currentIndex + 1 >= playlistLength) return false;
        st.currentIndex++;
        return true;
    }

    /**
     * "Shuffle bag": every track plays once, in random order, before any track repeats, and the
     * same track never plays twice in a row. Replaces the old random jump, whose operator-precedence
     * bug (`currentIndex + 1 % length`) and off-by-one (`random * length - 1`) could pick index -1
     * or run past the end of the playlist and throw.
     */
    _nextShuffleIndex(tab) {
        const st = this.tabsState[tab];
        const len = st.playlist.length;
        const cur = st.currentIndex;
        if (len <= 1) return 0;
        const key = st.playlist.map(v => v.id).join("|");
        const allButCurrent = () => [...Array(len).keys()].filter(i => i !== cur);
        let bag = this._shuffleBags[tab];
        if (!bag || bag.key !== key) bag = this._shuffleBags[tab] = { key, remaining: allButCurrent() };
        bag.remaining = bag.remaining.filter(i => i !== cur && i < len);
        if (!bag.remaining.length) bag.remaining = allButCurrent();
        const pick = Math.floor(Math.random() * bag.remaining.length);
        return bag.remaining.splice(pick, 1)[0];
    }

    broadcastState(tab, videoId, time=0, isPlaying=true) {
        this.loadVideo(tab, videoId);
        setTimeout(() => { if(this.players[tab]?.playVideo && isPlaying) this.players[tab].playVideo(); }, 800);
        this.emitSocket(null, { action: "syncState", tabId: tab, videoId, time, isPlaying, isLooping: this.tabsState[tab].isLooping, isShuffling: this.tabsState[tab].isShuffling });
    }

    loadVideo(tab, videoId) {
        this.tabsState[tab].localVideoId = videoId;
        this._refreshTitle(tab, videoId);
        if(this.players[tab] && typeof this.players[tab].loadVideoById === 'function') {
            this.players[tab].loadVideoById(videoId);
        } else {
            this._tryInitPlayer(tab);
        }
    }

    playVideo(tab, time) { if(this.players[tab]?.seekTo) { this.players[tab].seekTo(time, true); this.players[tab].playVideo(); } }
    pauseVideo(tab) { this.players[tab]?.pauseVideo?.(); }

    /**
     * Move a channel to `time` and leave it paused. A cued video starts playing when seeked, so that
     * case is done muted to avoid the short audible blip players used to hear when they joined.
     */
    _seekPaused(tab, time) {
        const p = this.players[tab];
        if (!p?.seekTo) return;
        const state = p.getPlayerState?.();
        if (state === 1 || state === 2 || state === 3) { p.pauseVideo(); p.seekTo(time, true); return; }
        p.mute?.();
        p.seekTo(time, true);
        setTimeout(() => { p.pauseVideo?.(); p.unMute?.(); }, 250);
    }

    togglePlayback(tab) {
        const p = this.players[tab];
        if(p && typeof p.getPlayerState === 'function') {
            p.getPlayerState()===1 ? (this.pauseVideo(tab), this.emitSocket("pause", {tabId:tab})) : (this.playVideo(tab, p.getCurrentTime()), this.emitSocket("play", {time: p.getCurrentTime(), tabId:tab}));
        }
    }

    _applyVolume(val, { save = false } = {}) {
        if (isNaN(val)) return;
        this.players.forEach(p => { if (p?.setVolume) p.setVolume(val); });
        this.element?.querySelectorAll('input[name="volume"]').forEach(i => { if (i !== document.activeElement) i.value = val; });
        this.isMuted = (val === 0);
        if (val > 0) this.preMuteVolume = val;
        this.element?.querySelectorAll('.volume-mute-btn i').forEach(icon => {
            icon.className = this.isMuted ? "fas fa-volume-mute" : "fas fa-volume-up";
        });
        if (save) return game.settings.set(MODULE_ID, 'clientVolume', val);
    }

    /* -------------------------------------------- */
    /*  Actions                                     */
    /* -------------------------------------------- */

    _onSwitchTab(event, target) {
        const idx = parseInt(target.dataset.target);
        this.activeTab = idx;
        this.element.querySelectorAll('.tube-instance').forEach(el => el.classList.remove('active'));
        this.element.querySelector(`.tube-instance[data-tab-index="${idx}"]`)?.classList.add('active');
        this.element.querySelectorAll('.channel-btn').forEach(btn => {
            const btnTarget = parseInt(btn.dataset.target);
            if (btnTarget === idx) btn.classList.add('active');
            else btn.classList.remove('active');
        });
            const el = this.element.querySelector(`#track-title-text-${idx}`);
            if (el) {
                const span = el.querySelector('span');
                if (span) this.updateTrackTitle(idx, span.innerText);
            }
    }

    _onTogglePlayback() { this.togglePlayback(this.activeTab); }
    _onToggleLoop(e, t) { this.toggleLoop(this.activeTab, t); }
    _onToggleShuffle(e, t) { this.toggleShuffle(this.activeTab, t); }
    _onToggleInputMode(e, t) { this.toggleInputMode(this.activeTab, t); }
    _onExecuteSmartInput(e, t, forced) { this.executeSmartInput(forced ?? this.activeTab); }
    _onToggleQueue(e, t) {
        const o=this.element.querySelector(`#queue-overlay-${this.activeTab}`), s=this.element.querySelector(`#search-overlay-${this.activeTab}`);
        if(o){ o.classList.toggle('hidden'); if(s) s.classList.add('hidden'); t.classList.toggle('active'); }
    }
    async _onClearQueue() {
        const tab = this.activeTab;
        const ok = await this._confirm("Clear Playlist", `<p>Clear the playlist on channel ${tab + 1}?</p>`);
        if (!ok) return;
        this.tabsState[tab].playlist = [];
        this.tabsState[tab].currentIndex = -1;
        this._shuffleBags[tab] = null;
        await this._syncPlaylistState(tab);
        this.updateTrackTitle(tab, "No Video");
    }
    _onPlayNextAction() { this.playNext(this.activeTab); }
    _onPlayPrevAction() { this.playPrev(this.activeTab); }
    async _onToggleMute(event, target) {
        const currentVol = game.settings.get(MODULE_ID, 'clientVolume');
        if (this.isMuted || currentVol === 0) {
            await this._applyVolume(this.preMuteVolume || 50, { save: true });
        } else {
            this.preMuteVolume = currentVol;
            await this._applyVolume(0, { save: true });
        }
    }
    _onManualSync() {
        ui.notifications.info("Syncing with GM...");
        // Ask for every channel: the music a player hears is often not on the channel they're viewing.
        this.emitSocket("requestSync", { requesterId: game.user.id });
    }
    _onCloseSearch() { this.element.querySelector(`#search-overlay-${this.activeTab}`)?.classList.add('hidden'); }

    async _onSavePreset() {
        const tab = this.activeTab;
        if (this.tabsState[tab].playlist.length === 0) return ui.notifications.warn("Queue empty");
        const name = await this._promptText("Save Preset", "Name");
        if (!name) return;
        const saved = foundry.utils.deepClone(game.settings.get(MODULE_ID, 'savedPlaylists') || {});
        saved[name] = foundry.utils.deepClone(this.tabsState[tab].playlist);
        await game.settings.set(MODULE_ID, 'savedPlaylists', saved);
        this._refreshPresetSelects(name);
        ui.notifications.info(`Saved preset: ${plainText(name)}`);
    }
    async _onLoadPreset() {
        const tab = this.activeTab;
        const name = this.element.querySelector(`.preset-select[data-tab="${tab}"]`)?.value;
        if (!name) return ui.notifications.warn("Choose a preset first.");
        const saved = game.settings.get(MODULE_ID, 'savedPlaylists') || {};
        if (!saved[name]) return;
        this.tabsState[tab].playlist = foundry.utils.deepClone(saved[name]);
        this.tabsState[tab].currentIndex = 0;
        this._shuffleBags[tab] = null;
        await this._syncPlaylistState(tab);
        if (this.tabsState[tab].playlist.length > 0) {
            this.broadcastState(tab, this.tabsState[tab].playlist[0].id, 0, true);
            this.updateTrackTitle(tab, this.tabsState[tab].playlist[0].title);
        }
    }
    async _onDeletePreset() {
        const tab = this.activeTab;
        const name = this.element.querySelector(`.preset-select[data-tab="${tab}"]`)?.value;
        if (!name) return;
        const saved = foundry.utils.deepClone(game.settings.get(MODULE_ID, 'savedPlaylists') || {});
        delete saved[name];
        await game.settings.set(MODULE_ID, 'savedPlaylists', saved);
        this._refreshPresetSelects();
    }
    async _onImportFromClipboard() {
        const tab = this.activeTab;
        const url = await this._promptText("Import", "YouTube video or playlist URL");
        if (url) await this._handleImport(tab, url);
    }

    /**
     * Rebuild the preset dropdowns in place. Saving or deleting a preset used to call render(),
     * which rebuilt every YouTube player and restarted all playing channels from 0:00 for the GM.
     */
    _refreshPresetSelects(selectName) {
        const names = Object.keys(game.settings.get(MODULE_ID, 'savedPlaylists') || {});
        this.element?.querySelectorAll('.preset-select').forEach(sel => {
            const keep = (sel.dataset.tab === String(this.activeTab) && selectName) ? selectName : sel.value;
            sel.innerHTML = `<option value="" disabled>Presets...</option>` +
                names.map(n => `<option value="${escapeHTML(n)}">${escapeHTML(n)}</option>`).join("");
            sel.value = names.includes(keep) ? keep : "";
        });
    }

    async _promptText(title, label) {
        try {
            const value = await DialogV2.prompt({
                window: { title },
                content: `<div class="form-group"><label>${escapeHTML(label)}</label><div class="form-fields"><input type="text" name="tubeValue" autofocus></div></div>`,
                ok: { label: "OK", callback: (event, button) => button.form.elements.tubeValue.value },
                rejectClose: false
            });
            return (typeof value === "string") ? value.trim() : null;
        } catch (e) { return null; }
    }

    async _confirm(title, content) {
        try { return !!(await DialogV2.confirm({ window: { title }, content, rejectClose: false })); }
        catch (e) { return false; }
    }

    toggleLoop(tab, target) { this.tabsState[tab].isLooping = !this.tabsState[tab].isLooping; if(target) target.classList.toggle('active'); this.emitSocket("syncLoop", {isLooping: this.tabsState[tab].isLooping, tabId:tab}); this._syncPlaylistState(tab); }
    toggleShuffle(tab, target) { this.tabsState[tab].isShuffling = !this.tabsState[tab].isShuffling; this._shuffleBags[tab] = null; if(target) target.classList.toggle('active'); this.emitSocket("syncShuffle", {isShuffling: this.tabsState[tab].isShuffling, tabId:tab}); this._syncPlaylistState(tab); }
    toggleInputMode(tab, btn) {
        this.tabsState[tab].isInputMode = !this.tabsState[tab].isInputMode;

        if (!btn) btn = this.element.querySelector(`.tube-instance[data-tab-index="${tab}"] [data-action="toggleInputMode"]`);

        if (btn) {
            const icon = btn.querySelector('i');
            if (this.tabsState[tab].isInputMode) {
                btn.classList.add('active');
                if (icon) icon.className = "fas fa-times";
            } else {
                btn.classList.remove('active');
                if (icon) icon.className = "fas fa-plus";
            }
        }

        const s = this.element.querySelector(`#view-seeker-${tab}`);
        const i = this.element.querySelector(`#view-input-${tab}`);
        if (!s || !i) return;

        if (this.tabsState[tab].isInputMode) {
            s.style.display = 'none';
            i.style.display = 'flex';
            setTimeout(() => this.element.querySelector(`#view-input-${tab} input`)?.focus(), 50);
        } else {
            s.style.display = 'block';
            i.style.display = 'none';
            this.element.querySelector(`#search-overlay-${tab}`)?.classList.add('hidden');
        }
    }

    async executeSmartInput(tab) {
        const i = this.element.querySelector(`#view-input-${tab} input`);
        if (!i) return;
        const v = i.value.trim();
        if (!v) return;
        i.value = "";
        i.blur();
        await this._handleImport(tab, v);
    }

    async _syncPlaylistState(tab) {
        if(game.user.isGM) {
            const globalState = foundry.utils.deepClone(game.settings.get(MODULE_ID, 'tabsState') || {});
            globalState[tab] = { playlist: this.tabsState[tab].playlist, currentIndex: this.tabsState[tab].currentIndex, videoId: (this.tabsState[tab].playlist[this.tabsState[tab].currentIndex]||{}).id||"", isLooping: this.tabsState[tab].isLooping, isShuffling: this.tabsState[tab].isShuffling };
            await game.settings.set(MODULE_ID, 'tabsState', globalState);
            this.emitSocket("syncPlaylist", { tabId: tab, playlist: this.tabsState[tab].playlist, index: this.tabsState[tab].currentIndex });
        }
        this._renderPlaylist(tab);
    }

    _renderPlaylist(tab) {
        const container = this.element.querySelector(`#playlist-container-${tab}`);
        const count = this.element.querySelector(`#playlist-count-${tab}`);
        if(count) count.innerText = this.tabsState[tab].playlist.length;
        if (container) {
            container.innerHTML = this.tabsState[tab].playlist.length ? '' : '<div class="empty-msg">Playlist is empty</div>';
            this.tabsState[tab].playlist.forEach((v, i) => {
                const el = document.createElement('div');
                el.className = 'list-item';
                el.dataset.index = i;
                if (i === this.tabsState[tab].currentIndex) el.classList.add('active-track');
                if (!this.tabsState[tab].isShuffling && i < this.tabsState[tab].currentIndex) el.style.opacity = '0.5';
                const copyBtn = `<button class="list-copy" title="Copy Link"><i class="fas fa-link"></i></button>`;
                const removeBtn = game.user.isGM ? `<button class="list-remove" title="Remove"><i class="fas fa-times"></i></button>` : '';
                el.innerHTML = this._listItemHTML(v) + `<div style="display:flex; align-items:center;">${copyBtn}${removeBtn}</div>`;
                el.querySelector('.list-copy').addEventListener('click', (e) => { e.stopPropagation(); game.clipboard.copyPlainText(`https://www.youtube.com/watch?v=${v.id}`); ui.notifications.info(`Link copied: ${plainText(v.title)}`); });
                if (game.user.isGM) {
                    el.setAttribute('draggable', 'true');
                    el.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', JSON.stringify({idx: i, tab: tab})); el.classList.add('dragging'); });
                    el.addEventListener('dragend', () => { el.classList.remove('dragging'); container.querySelectorAll('.drag-over').forEach(it => it.classList.remove('drag-over')); });
                    el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('drag-over'); });
                    el.addEventListener('dragleave', () => { el.classList.remove('drag-over'); });
                    el.addEventListener('drop', async (e) => {
                        e.preventDefault(); el.classList.remove('drag-over');
                        let data;
                        try { data = JSON.parse(e.dataTransfer.getData('text/plain')); } catch (err) { return; }
                        if(data.tab !== tab) return;
                        const fromIndex = data.idx;
                        const toIndex = i;
                        if (fromIndex === toIndex) return;
                        const currentId = (this.tabsState[tab].currentIndex >= 0) ? this.tabsState[tab].playlist[this.tabsState[tab].currentIndex]?.id : null;
                        const movedItem = this.tabsState[tab].playlist.splice(fromIndex, 1)[0];
                        this.tabsState[tab].playlist.splice(toIndex, 0, movedItem);
                        if (currentId) this.tabsState[tab].currentIndex = this.tabsState[tab].playlist.findIndex(x => x.id === currentId);
                        await this._syncPlaylistState(tab);
                    });
                    el.addEventListener('click', (e) => {
                        if (e.target.closest('.list-remove')) {
                            e.stopPropagation();
                            this.tabsState[tab].playlist.splice(i, 1);
                            if(i < this.tabsState[tab].currentIndex) this.tabsState[tab].currentIndex--;
                            else if(i === this.tabsState[tab].currentIndex) {
                                if (this.tabsState[tab].currentIndex >= this.tabsState[tab].playlist.length) this.tabsState[tab].currentIndex = this.tabsState[tab].playlist.length - 1;
                                const next = this.tabsState[tab].playlist[this.tabsState[tab].currentIndex];
                                if (next) {
                                    this.broadcastState(tab, next.id, 0, true);
                                    this.updateTrackTitle(tab, next.title);
                                }
                            }
                            this._syncPlaylistState(tab);
                        } else {
                            this.tabsState[tab].currentIndex = i;
                            this._syncPlaylistState(tab);
                            this.broadcastState(tab, v.id, 0, true);
                            this.updateTrackTitle(tab, v.title);
                        }
                    });
                } else { el.classList.add('readonly'); }
                container.appendChild(el);
            });
            const activeEl = container.querySelector('.active-track');
            if(activeEl) activeEl.scrollIntoView({ block: "center", behavior: "smooth" });
        }
    }

    _listItemHTML(v) {
        const title = escapeHTML(v.title);
        const meta = [v.author, v.duration].filter(Boolean).map(escapeHTML).join(" • ");
        return `<img src="${escapeHTML(safeThumb(v.thumb, v.id))}" class="list-thumb"><div class="list-info"><div class="list-title" title="${title}">${title}</div><div class="list-meta">${meta}</div></div>`;
    }

    _showProgressBar(tab) { const b=this.element.querySelector(`#queue-progress-${tab}`); const f=b?.querySelector('.queue-progress-bar'); if(b&&f){b.classList.add('active');f.style.width='10%';} }
    _updateProgressBar(tab, p) { const f=this.element.querySelector(`#queue-progress-${tab} .queue-progress-bar`); if(f) f.style.width=`${p}%`; }
    _hideProgressBar(tab) { const b=this.element.querySelector(`#queue-progress-${tab}`); if(b){ this._updateProgressBar(tab, 100); setTimeout(()=>{b.classList.remove('active');this._updateProgressBar(tab,0);},500); } }

    _openQueue(tab) {
        const overlay = this.element.querySelector(`#queue-overlay-${tab}`);
        if (overlay && overlay.classList.contains('hidden')) this.element.querySelector(`.tube-instance[data-tab-index="${tab}"] [data-action="toggleQueue"]`)?.click();
    }

    /* -------------------------------------------- */
    /*  Import & search                             */
    /* -------------------------------------------- */

    async _handleImport(tab, val) {
        const listId = this._extractPlaylistID(val);
        const videoId = this._extractVideoID(val);
        // A song link copied from a YouTube "Mix" carries &list=RD... — that's an auto-generated radio
        // station, not a playlist the user picked, so treat it as the single video.
        const isMix = listId?.startsWith("RD") && !!videoId;

        if (listId && !isMix) {
            this._openQueue(tab);
            this._showProgressBar(tab);
            ui.notifications.info(`Tab ${tab+1}: Scanning Playlist...`);
            let videos = [];
            try { videos = await this._fetchPlaylist(tab, listId, val); }
            catch (e) { console.warn(`${MODULE_ID} | playlist import failed`, e); }
            this._hideProgressBar(tab);
            if (videos.length > 0) {
                this.tabsState[tab].playlist.push(...videos);
                if (this.tabsState[tab].currentIndex === -1) {
                    this.tabsState[tab].currentIndex = 0;
                    this.broadcastState(tab, videos[0].id, 0, true);
                    this.updateTrackTitle(tab, videos[0].title);
                }
                await this._syncPlaylistState(tab);
                ui.notifications.info(`Tab ${tab+1}: Imported ${videos.length} videos!`);
                if (this.tabsState[tab].isInputMode) this.toggleInputMode(tab);
                return;
            }
            if (videoId) return this._handleImport(tab, `https://www.youtube.com/watch?v=${videoId}`);
            ui.notifications.warn("Couldn't read that playlist. It may be private, or YouTube refused the request. Adding a YouTube API key in the module settings makes imports much more reliable.");
            return;
        }
        if (videoId) {
            this._showProgressBar(tab);
            ui.notifications.info("Loading info...");
            const meta = await this._fetchMetadata(videoId);
            this._hideProgressBar(tab);
            if (meta.unplayable) {
                ui.notifications.warn(`"${plainText(meta.title)}" can't be added: ${PLAYER_ERRORS[meta.unplayable] || "YouTube won't embed it"}.`);
                return;
            }
            delete meta.unplayable;
            this.tabsState[tab].playlist.push(meta);
            if (this.tabsState[tab].currentIndex === -1) {
                this.tabsState[tab].currentIndex = 0;
                this.broadcastState(tab, meta.id, 0, true);
                this.updateTrackTitle(tab, meta.title);
            } else {
                ui.notifications.info(`Added: ${plainText(meta.title)}`);
            }
            await this._syncPlaylistState(tab);
            if (this.tabsState[tab].isInputMode) this.toggleInputMode(tab);
        } else {
            this.element.querySelector(`#queue-overlay-${tab}`)?.classList.add('hidden');
            this.element.querySelector(`#search-overlay-${tab}`)?.classList.remove('hidden');
            this._performSearch(tab, val);
        }
    }

    /**
     * Playlist import, most reliable route first:
     *   1. YouTube Data API (only when the GM has entered an API key)
     *   2. YouTube's own embedded player, which lists a playlist's videos without any proxy
     *   3. Scraping the playlist page through a CORS proxy (the original method)
     */
    async _fetchPlaylist(tab, listId, originalUrl) {
        const fromApi = await this._apiPlaylist(tab, listId);
        if (fromApi?.length) return fromApi;

        this._updateProgressBar(tab, 20);
        let ids = [];
        try { ids = await YTProbe.playlistIds(listId); }
        catch (e) { console.warn(`${MODULE_ID} | embedded-player playlist lookup failed`, e); }
        if (ids.length) {
            let done = 0;
            const videos = await mapLimit(ids, 6, async (id) => {
                const info = await this._fetchOEmbed(id);
                done++;
                this._updateProgressBar(tab, 30 + Math.round((done / ids.length) * 65));
                return makeVideo(id, info || {});
            });
            return videos.filter(Boolean);
        }

        this._updateProgressBar(tab, 40);
        return this._scrapeYoutubePlaylist(tab, `https://www.youtube.com/playlist?list=${listId}`);
    }

    async _performSearch(tab, q){
        const c=this.element.querySelector(`#search-container-${tab}`);
        c.innerHTML='<div class="empty-msg"><i class="fas fa-spinner fa-spin"></i></div>';
        let results = await this._apiSearch(q);
        if (!results?.length) results = await this._searchYoutubeScrape(q);
        if(!results.length){
            const hasKey = !!this._apiKey();
            c.innerHTML = (this._lastFetchReachedYouTube || hasKey)
                ? '<div class="empty-msg">No results.</div>'
                : '<div class="empty-msg hint">Search couldn\'t reach YouTube (the free proxies it relies on are down).<br>'
                  + 'Paste a video or playlist link instead, or add a YouTube API key in Configure Settings → Foundry Tube.</div>';
            return;
        }
        c.innerHTML='';
        results.forEach(v=>{
            const el=document.createElement('div');
            el.className='list-item';
            el.innerHTML = this._listItemHTML(v) + `<button class="list-btn list-add"><i class="fas fa-plus"></i></button><button class="list-btn list-play"><i class="fas fa-play"></i></button>`;
            el.querySelector('.list-add').addEventListener('click',(e)=>{e.stopPropagation();this.tabsState[tab].playlist.push(v);if (this.tabsState[tab].currentIndex === -1) { this.tabsState[tab].currentIndex = 0; this.broadcastState(tab, v.id, 0, true); this.updateTrackTitle(tab, v.title); } this._syncPlaylistState(tab);ui.notifications.info(`Added: ${plainText(v.title)}`);});
            el.querySelector('.list-play').addEventListener('click',(e)=>{e.stopPropagation();this.playVideoNow(tab, v);this.element.querySelector(`#search-overlay-${tab}`)?.classList.add('hidden');this.toggleInputMode(tab);});
            c.appendChild(el);
        });
    }

    /* ---------- YouTube Data API (optional, needs a key) ---------- */

    _apiKey() { return (game.settings.get(MODULE_ID, 'youtubeApiKey') || "").trim(); }

    async _youtubeApi(endpoint, params) {
        const key = this._apiKey();
        if (!key) return null;
        const url = new URL(`https://www.googleapis.com/youtube/v3/${endpoint}`);
        for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, v);
        url.searchParams.set("key", key);
        try {
            const res = await fetchWithTimeout(url.toString(), { timeout: 10000 });
            const data = await res.json().catch(() => null);
            if (!res.ok) {
                const msg = data?.error?.message || `HTTP ${res.status}`;
                if (!this._warnedErrors.has(`api:${msg}`)) {
                    this._warnedErrors.add(`api:${msg}`);
                    ui.notifications.warn(`YouTube API: ${plainText(msg)}`);
                }
                return null;
            }
            return data;
        } catch (e) {
            console.warn(`${MODULE_ID} | YouTube API request failed`, e);
            return null;
        }
    }

    /** Full video records for up to 50 IDs per request; marks videos YouTube won't embed. */
    async _apiVideos(ids) {
        const out = new Map();
        for (let i = 0; i < ids.length; i += 50) {
            const chunk = ids.slice(i, i + 50);
            const data = await this._youtubeApi("videos", { part: "snippet,contentDetails,status", id: chunk.join(","), maxResults: 50 });
            if (!data) return null;
            for (const item of data.items || []) {
                const live = item.snippet?.liveBroadcastContent === "live";
                const video = makeVideo(item.id, {
                    title: item.snippet?.title,
                    author: item.snippet?.channelTitle,
                    thumb: item.snippet?.thumbnails?.medium?.url,
                    duration: live ? "Live" : formatTime(parseISODuration(item.contentDetails?.duration))
                });
                if (item.status?.embeddable === false) video.unplayable = 101;
                out.set(item.id, video);
            }
        }
        return out;
    }

    async _apiPlaylist(tab, listId) {
        if (!this._apiKey()) return null;
        const ids = [];
        let pageToken;
        for (let page = 0; page < 40; page++) { // up to 2000 videos
            const data = await this._youtubeApi("playlistItems", { part: "contentDetails", playlistId: listId, maxResults: 50, pageToken });
            if (!data) return null;
            for (const item of data.items || []) if (isValidVideoId(item.contentDetails?.videoId)) ids.push(item.contentDetails.videoId);
            this._updateProgressBar(tab, Math.min(60, 20 + page * 5));
            pageToken = data.nextPageToken;
            if (!pageToken) break;
        }
        // Private and deleted entries come back from videos.list as nothing at all, so they drop out here.
        const details = await this._apiVideos(ids);
        if (!details) return null;
        let skipped = 0;
        const videos = [];
        for (const id of ids) {
            const v = details.get(id);
            if (!v || v.unplayable) { skipped++; continue; }
            videos.push(v);
        }
        if (skipped) ui.notifications.info(`Skipped ${skipped} private, deleted or non-embeddable video${skipped === 1 ? "" : "s"}.`);
        return videos;
    }

    async _apiSearch(q) {
        if (!this._apiKey()) return null;
        const data = await this._youtubeApi("search", { part: "snippet", type: "video", maxResults: 20, q, videoEmbeddable: "true" });
        if (!data) return null;
        const ids = (data.items || []).map(i => i.id?.videoId).filter(isValidVideoId);
        const details = await this._apiVideos(ids);
        return ids.map(id => {
            const d = details?.get(id);
            if (d) return d;
            const item = data.items.find(i => i.id?.videoId === id);
            return makeVideo(id, { title: decodeEntities(item?.snippet?.title), author: decodeEntities(item?.snippet?.channelTitle), thumb: item?.snippet?.thumbnails?.medium?.url, duration: "" });
        }).filter(v => !v.unplayable);
    }

    /* ---------- oEmbed (no key, no proxy) ---------- */

    async _fetchOEmbed(id) {
        const target = encodeURIComponent(`https://www.youtube.com/watch?v=${id}`);
        const endpoints = [
            { name: "noembed", url: `https://noembed.com/embed?url=${target}` },
            { name: "youtube-oembed", url: `https://www.youtube.com/oembed?format=json&url=${target}` }
        ];
        for (const ep of endpoints) {
            if (endpointIsCooling(ep.name)) continue;
            try {
                const res = await fetchWithTimeout(ep.url, { timeout: 5000 });
                if (!res.ok) continue; // a 401/404 is about this video, not the service
                const d = await res.json();
                if (d?.title) return { title: d.title, author: d.author_name, thumb: d.thumbnail_url };
            } catch (e) {
                coolEndpoint(ep.name); // network/CORS failure: skip this service for a while
            }
        }
        return null;
    }

    /* ---------- CORS proxies (last resort) ---------- */

    _proxies() {
        const list = [];
        const custom = (game.settings.get(MODULE_ID, 'customProxy') || "").trim();
        if (custom) list.push({
            name: "custom", json: false,
            build: (url) => custom.includes("{url}") ? custom.replace("{url}", encodeURIComponent(url)) : custom + encodeURIComponent(url)
        });
        if (game.settings.get(MODULE_ID, 'usePublicProxies')) list.push(...PUBLIC_PROXIES);
        return list;
    }

    async _fetchText(url) {
        for (const proxy of this._proxies()) {
            if (endpointIsCooling(proxy.name)) continue;
            try {
                const res = await fetchWithTimeout(proxy.build(url));
                if (!res.ok) { coolEndpoint(proxy.name); continue; }
                if (proxy.json) {
                    const json = await res.json();
                    if (json?.contents?.length > 100) { this._lastFetchReachedYouTube = true; return json.contents; }
                } else {
                    const text = await res.text();
                    if (text.length > 100) { this._lastFetchReachedYouTube = true; return text; }
                }
            } catch (e) { coolEndpoint(proxy.name); }
        }
        this._lastFetchReachedYouTube = false;
        return null;
    }

    async _scrapeYoutubePlaylist(tab, url) {
        this._updateProgressBar(tab, 30);
        try {
            const t = await this._fetchText(url);
            if(!t) return [];
            this._updateProgressBar(tab, 60);
            const videos = [];
            const data = extractJSONAssignment(t, "ytInitialData");
            if (data) {
                const find = (obj) => {
                    if(!obj || typeof obj !== 'object') return;
                    if(obj.playlistVideoRenderer) { const v=obj.playlistVideoRenderer; if (isValidVideoId(v.videoId)) videos.push(makeVideo(v.videoId, {title:v.title?.runs?.[0]?.text||v.title?.simpleText,author:v.shortBylineText?.runs?.[0]?.text,thumb:v.thumbnail?.thumbnails?.[0]?.url,duration:v.lengthText?.simpleText})); return; }
                    if(obj.playlistPanelVideoRenderer) { const v=obj.playlistPanelVideoRenderer; if (isValidVideoId(v.videoId)) videos.push(makeVideo(v.videoId, {title:v.title?.simpleText||v.title?.runs?.[0]?.text,author:v.shortBylineText?.runs?.[0]?.text,thumb:v.thumbnail?.thumbnails?.[0]?.url,duration:v.lengthText?.simpleText})); return; }
                    Object.values(obj).forEach(val => find(val));
                };
                find(data);
            }
            if(videos.length === 0) {
                const regex = /watch\?v=([a-zA-Z0-9_-]{11})/g;
                let match; const seen=new Set();
                while ((match = regex.exec(t)) !== null) {
                    if(seen.has(match[1])) continue; seen.add(match[1]);
                    videos.push(makeVideo(match[1]));
                }
            }
            return videos;
        } catch (e) { return []; }
    }

    async _searchYoutubeScrape(q){
        try {
            const t = await this._fetchText(`https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`);
            if(!t) return [];
            const data = extractJSONAssignment(t, "ytInitialData");
            if (data) {
                const res = [];
                const find = (obj) => {
                    if(!obj || typeof obj !== 'object') return;
                    if(obj.videoRenderer) {
                        const v = obj.videoRenderer;
                        if (isValidVideoId(v.videoId)) res.push(makeVideo(v.videoId, { title: v.title?.runs?.[0]?.text, author: v.ownerText?.runs?.[0]?.text, thumb: v.thumbnail?.thumbnails?.[0]?.url, duration: v.lengthText?.simpleText||"Live" }));
                        return;
                    }
                    Object.values(obj).forEach(val => find(val));
                };
                find(data);
                if(res.length > 0) return res.slice(0, 20);
            }
            const regex = /"videoId":"([a-zA-Z0-9_-]{11})"/g;
            const ids = []; let match; const seen=new Set();
            while ((match = regex.exec(t)) !== null && ids.length < 20) {
                if(seen.has(match[1])) continue; seen.add(match[1]);
                ids.push(match[1]);
            }
            // The page layout wasn't recognised; fetch real titles so the results are pickable.
            return mapLimit(ids, 6, async (id) => makeVideo(id, (await this._fetchOEmbed(id)) || {}));
        } catch(e){ return[]; }
    }

    /**
     * Title/channel/length for one video. Fast sources first; every step has a timeout, so adding a
     * single video no longer takes minutes when the proxies are down.
     */
    async _fetchMetadata(id, { thorough = true } = {}) {
        const m = makeVideo(id, { duration: "" });
        if (thorough) {
            const api = await this._apiVideos([id]);
            if (api?.get(id)) return api.get(id);
        }
        const o = await this._fetchOEmbed(id);
        if (o) return makeVideo(id, { ...o, duration: "" });
        if (!thorough) return m;
        try {
            const info = await YTProbe.videoInfo(id);
            if (info?.title) return makeVideo(id, { title: info.title, author: info.author, duration: info.duration ? formatTime(info.duration) : "" });
        } catch (e) {
            if (UNPLAYABLE_CODES.includes(e.code)) { m.unplayable = e.code; return m; }
        }
        try {
            const t = await this._fetchText(`https://www.youtube.com/watch?v=${id}`);
            const d = t && extractJSONAssignment(t, "ytInitialPlayerResponse")?.videoDetails;
            if (d) return makeVideo(id, { title: d.title, author: d.author, duration: d.lengthSeconds ? formatTime(parseInt(d.lengthSeconds)) : "" });
        } catch (e) { }
        return m;
    }
    _extractVideoID(url) { if(!url) return null; const m = url.match(/(?:youtu\.be\/|v\/|u\/\w\/|embed\/|shorts\/|live\/|watch\?v=|&v=)([^#&?]*).*/); if (m && isValidVideoId(m[1])) return m[1]; return isValidVideoId(url.trim()) ? url.trim() : null; }
    _extractPlaylistID(url) { const m = (url || "").match(/[&?]list=([a-zA-Z0-9_-]+)/); return m ? m[1] : null; }

    updateTrackTitle(tabId, text) {
        const container = this.element.querySelector(`#view-seeker-${tabId} .track-info`);
        const el = this.element.querySelector(`#track-title-text-${tabId}`);
        if (!el || !container) return;
        const safeText = escapeHTML(text || "No Video");
        el.classList.remove('scrolling');
        el.style.animationDuration = '0s';
        el.innerHTML = `<span>${safeText}</span>`;
        if (el.scrollWidth > container.clientWidth) {
            const spacer = "&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;";
            el.innerHTML = `<span>${safeText}</span><span>${spacer}</span><span>${safeText}</span><span>${spacer}</span>`;
            el.classList.add('scrolling');
            const speed = Math.max(10, el.scrollWidth / 20);
            el.style.animationDuration = `${speed}s`;
        } else {
            el.innerHTML = `<span>${safeText}</span>`;
        }
    }

    async _refreshTitle(tabId, videoId) {
        if (!videoId) return;
        const inPlaylist = this.tabsState[tabId].playlist.find(v => v.id === videoId);
        if (inPlaylist && !isPlaceholderTitle(inPlaylist)) {
            this.updateTrackTitle(tabId, inPlaylist.title);
            return;
        }
        if (this.players[tabId] && typeof this.players[tabId].getVideoData === 'function') {
            const data = this.players[tabId].getVideoData();
            if (data && data.title) { this.updateTrackTitle(tabId, data.title); return; }
        }
        // Lightweight lookup only: this runs on every render, so no helper players or proxies here.
        const meta = await this._fetchMetadata(videoId, { thorough: false });
        if (meta && !isPlaceholderTitle(meta) && this.tabsState[tabId].localVideoId === videoId) this.updateTrackTitle(tabId, meta.title);
    }

    /**
     * Once a track is actually playing, the player knows its real title and length. Playlist entries
     * that were imported with placeholders ("Video abc123", "--:--") get repaired and saved.
     */
    _healTrackMetadata(tab) {
        if (!game.user.isGM) return;
        const st = this.tabsState[tab];
        const v = st.playlist[st.currentIndex];
        const p = this.players[tab];
        if (!v || !p?.getVideoData) return;
        const data = p.getVideoData();
        if (!data || (data.video_id && data.video_id !== v.id)) return;
        let changed = false;
        if (data.title && isPlaceholderTitle(v)) { v.title = data.title; changed = true; }
        if (data.author && (!v.author || v.author === "YouTube")) { v.author = data.author; changed = true; }
        const dur = p.getDuration?.();
        if (dur > 0 && isPlaceholderDuration(v.duration)) { v.duration = formatTime(dur); changed = true; }
        if (changed) { this._syncPlaylistState(tab); this.updateTrackTitle(tab, v.title); }
    }

    _onPlayerError(tab, code) {
        const st = this.tabsState[tab];
        const current = st.playlist[st.currentIndex];
        const name = plainText((current?.id === st.localVideoId ? current?.title : null) || st.localVideoId || "this video");
        const reason = PLAYER_ERRORS[code] || `YouTube error ${code}`;
        console.warn(`${MODULE_ID} | channel ${tab + 1}: can't play "${name}": ${reason}`);
        if (!game.user.isGM) {
            // Errors that only affect this player's browser are worth telling them about, once.
            if (!UNPLAYABLE_CODES.includes(code) && !this._warnedErrors.has(code)) {
                this._warnedErrors.add(code);
                ui.notifications.warn(`Tube channel ${tab + 1}: ${reason}.`);
            }
            return;
        }
        ui.notifications.warn(`Tube channel ${tab + 1}: can't play "${name}" (${reason}).`);
        if (!UNPLAYABLE_CODES.includes(code) || !game.settings.get(MODULE_ID, 'skipUnplayable')) return;
        this._errorStreak[tab]++;
        if (this._errorStreak[tab] >= Math.min(Math.max(st.playlist.length, 1), 10)) {
            // Every track tried so far has failed: stop rather than skip around forever.
            if (st.playlist.length > 1) ui.notifications.error(`Tube channel ${tab + 1}: ${this._errorStreak[tab]} videos in a row couldn't play, so playback stopped.`);
            this._errorStreak[tab] = 0;
            return;
        }
        setTimeout(() => this.playNext(tab), 1500);
    }

    _tryInitPlayer(tab) {
        if (!window.YT?.Player) { setTimeout(() => this._tryInitPlayer(tab), 500); return; }
        const container = this.element.querySelector(`#foundry-tube-player-${tab}`);
        if (!container) return;
        if (this.players[tab] && document.getElementById(`foundry-tube-iframe-${tab}`)) return;
        const videoId = this.tabsState[tab].localVideoId || "";
        container.innerHTML = "";
        const placeholder = document.createElement('div');
        placeholder.id = `foundry-tube-iframe-${tab}`;
        container.appendChild(placeholder);
        this.players[tab] = new YT.Player(`foundry-tube-iframe-${tab}`, {
            height: '100%', width: '100%', videoId: videoId,
            playerVars: { 'playsinline': 1, 'controls': 0, 'rel': 0, 'modestbranding': 1, 'iv_load_policy': 3, 'origin': window.location.origin },
            events: {
                'onReady': (e) => {
                    e.target.setVolume(game.settings.get(MODULE_ID, 'clientVolume'));
                    this._startProgressLoop(tab);
                    this._refreshTitle(tab, videoId);
                    const autoplay = game.settings.get(MODULE_ID, 'autoplayStart');
                    if (videoId && videoId.length > 0) {
                        if (!this.initialLoad || autoplay) e.target.playVideo();
                    }
                    if (!game.user.isGM) this.emitSocket("requestSync", { tabId: tab, requesterId: game.user.id });
                    const f = e.target.getIframe();
                    f.style.width="150%"; f.style.height="150%"; f.style.position="absolute"; f.style.top="50%"; f.style.left="50%"; f.style.transform="translate(-50%,-50%)"; f.style.border="none"; f.style.pointerEvents="none";
                },
                'onStateChange': (e) => {
                    const isPlaying = e.data === YT.PlayerState.PLAYING;
                    const btn = this.element.querySelector(`.tube-instance[data-tab-index="${tab}"] [data-action="togglePlayback"] i`);
                    if (btn) btn.className = isPlaying ? "fas fa-pause" : "fas fa-play";
                    this.element.querySelectorAll(`.channel-btn[data-target="${tab}"]`).forEach(b => {
                        if (isPlaying) b.classList.add('playing'); else b.classList.remove('playing');
                    });
                        if (isPlaying) {
                            this._errorStreak[tab] = 0;
                            this._refreshTitle(tab, this.tabsState[tab].localVideoId);
                            this._healTrackMetadata(tab);
                        }
                        if (game.user.isGM && e.data === YT.PlayerState.ENDED) {
                            if (this.tabsState[tab].isLooping) { this.playVideo(tab, 0); this.emitSocket("play", { time: 0, tabId: tab }); }
                            else { this.playNext(tab); }
                        }
                },
                'onError': (e) => this._onPlayerError(tab, e.data)
            }
        });
    }

    _startProgressLoop(tab) {
        if (this.progressIntervals[tab]) clearInterval(this.progressIntervals[tab]);
        this.progressIntervals[tab] = setInterval(() => {
            const p = this.players[tab];
            if (!p || !p.getCurrentTime) return;
            try {
                const cur = p.getCurrentTime();
                const dur = p.getDuration();
                const time = this.element.querySelector(`#current-time-${tab}`);
                const durl = this.element.querySelector(`#duration-time-${tab}`);
                const seek = this.element.querySelector(`.tube-instance[data-tab-index="${tab}"] .video-seeker`);
                if(time) time.innerText = this._fmt(cur);
                if(durl) durl.innerText = this._fmt(dur);
                if(seek) { seek.max = dur; if(document.activeElement !== seek) seek.value = cur; }
            } catch(e) {}
        }, 1000);
    }

    _fmt(s) { return formatTime(s); }
    emitSocket(a, d={}) { game.socket.emit(SOCKET_NAME, a ? {action:a, ...d} : d); }

    /* -------------------------------------------- */
    /*  Sockets                                     */
    /* -------------------------------------------- */

    /** Only one GM answers sync requests, even when several GMs are connected. */
    _isResponsibleGM() {
        const active = game.users.activeGM;
        return active ? active.isSelf : game.user.isGM;
    }

    /** Send one channel's full state to one user (or everyone, without a target). */
    _sendTabState(i, targetUserId) {
        const st = this.tabsState[i];
        const saved = (game.settings.get(MODULE_ID, 'tabsState') || {})[i] || {};
        const player = this.players[i];
        const time = (player && typeof player.getCurrentTime === 'function') ? player.getCurrentTime() : 0;
        const isPlaying = (player && typeof player.getPlayerState === 'function') ? (player.getPlayerState() === 1) : false;
        const base = { tabId: i, targetUserId };
        game.socket.emit(SOCKET_NAME, { action: "syncPlaylist", ...base, playlist: st.playlist, index: st.currentIndex });
        game.socket.emit(SOCKET_NAME, { action: "syncLoop", ...base, isLooping: st.isLooping });
        game.socket.emit(SOCKET_NAME, { action: "syncShuffle", ...base, isShuffling: st.isShuffling });
        game.socket.emit(SOCKET_NAME, { action: "syncState", ...base, videoId: st.localVideoId || saved.videoId || "", time, isPlaying, isLooping: st.isLooping, isShuffling: st.isShuffling, sentAt: Date.now() });
    }

    _onSocket(p) {
        if (!p || !this.rendered) return;
        // Replies to one player's sync request are ignored by everyone else. Previously every
        // join triggered ~100 broadcast messages that made other players' music skip and blip.
        if (p.targetUserId && p.targetUserId !== game.user.id) return;
        const tab = Number.isInteger(p.tabId) ? p.tabId : 0;

        if (p.action === "syncPlaylist") {
            this.tabsState[tab].playlist = p.playlist || [];
            this.tabsState[tab].currentIndex = p.index ?? -1;
            this._renderPlaylist(tab);
            const v = this.tabsState[tab].playlist[this.tabsState[tab].currentIndex];
            if (v) this.updateTrackTitle(tab, v.title);
        }
        else if (p.action === "syncLoop") {
            this.tabsState[tab].isLooping = p.isLooping;
            const btn = this.element.querySelector(`.tube-instance[data-tab-index="${tab}"] [data-action="toggleLoop"]`);
            if (btn) btn.classList.toggle('active', !!p.isLooping);
        }
        else if (p.action === "syncShuffle") {
            this.tabsState[tab].isShuffling = p.isShuffling;
            const btn = this.element.querySelector(`.tube-instance[data-tab-index="${tab}"] [data-action="toggleShuffle"]`);
            if (btn) btn.classList.toggle('active', !!p.isShuffling); // was reading p.isLooping
        }
        else if (p.action === "syncState") {
            if (!p.videoId) {
                // The GM's channel is empty: stop whatever this client still had loaded there.
                if (this.tabsState[tab].localVideoId) { this.players[tab]?.stopVideo?.(); this.tabsState[tab].localVideoId = ""; }
                return;
            }
            const autoplay = game.settings.get(MODULE_ID, 'autoplayStart');
            const delay = this.initialLoad ? 1500 : 100;
            // On first load with "Auto play on Startup" off, the player gets the right track and
            // position but waits for the Sync button.
            const shouldPlay = p.isPlaying && !(this.initialLoad && !autoplay);
            let seekTime = p.time || 0;
            if (p.isPlaying && this.initialLoad) {
                // Clocks on different machines disagree, so never trust more than a few seconds of "lag".
                const networkLag = p.sentAt ? Math.min(Math.max((Date.now() - p.sentAt) / 1000, 0), 5) : 0;
                seekTime += (networkLag + delay / 1000);
            }

            const player = this.players[tab];
            const changed = p.videoId !== this.tabsState[tab].localVideoId;
            if (!shouldPlay && changed && player?.cueVideoById) {
                // Cue silently at the right spot. Loading and then pausing played a burst of sound.
                this.tabsState[tab].localVideoId = p.videoId;
                this._refreshTitle(tab, p.videoId);
                player.cueVideoById({ videoId: p.videoId, startSeconds: seekTime });
            } else {
                if (changed) this.loadVideo(tab, p.videoId);
                if (shouldPlay) setTimeout(() => this.playVideo(tab, seekTime), delay);
                else setTimeout(() => this._seekPaused(tab, seekTime), delay);
            }

            if (this.initialLoad) setTimeout(() => { this.initialLoad = false; }, 2000);
        }
        else if (p.action === "play") this.playVideo(tab, p.time);
        else if (p.action === "pause") this.pauseVideo(tab);
        else if (p.action === "requestSync" && game.user.isGM) {
            if (!this._isResponsibleGM()) return;
            const tabs = Number.isInteger(p.tabId) ? [p.tabId] : [...Array(TAB_COUNT).keys()];
            for (const i of tabs) this._sendTabState(i, p.requesterId);
        }
    }
}

/* -------------------------------------------- */
/*  Hooks                                       */
/* -------------------------------------------- */

let tubeApp;
Hooks.once('init', () => {
    game.settings.register(MODULE_ID, 'currentVideoId', { scope: 'world', config: false, type: String, default: "" });
    game.settings.register(MODULE_ID, 'tabsState', { scope: 'world', config: false, type: Object, default: {} });
    game.settings.register(MODULE_ID, 'clientVolume', { scope: 'client', config: false, type: Number, default: 50 });
    game.settings.register(MODULE_ID, 'savedPlaylists', { scope: 'world', config: false, type: Object, default: {} });
    game.settings.register(MODULE_ID, 'autoplayStart', { name: "Auto play on Startup", hint: "If disabled, video will not start automatically when you log in. Use the Sync button to start listening.", scope: 'client', config: true, type: Boolean, default: false });
    game.settings.register(MODULE_ID, 'hideOnStartup', { name: "Hide on Startup", hint: "If enabled, the player widget will be hidden when you load the world.", scope: 'client', config: true, type: Boolean, default: true });
    game.settings.register(MODULE_ID, 'enableTransparency', { name: "Enable Transparency", hint: "If enabled, minimized player becomes transparent when not hovered.", scope: 'client', config: true, type: Boolean, default: true, onChange: () => { const app = window.tubeApp; if(app && app.element) { const op = game.settings.get(MODULE_ID, 'enableTransparency') ? game.settings.get(MODULE_ID, 'minimizedOpacity')/100 : 1; app.element.style.setProperty('--minimized-opacity', op); } } });
    game.settings.register(MODULE_ID, 'minimizedOpacity', { name: "Minimized Opacity (%)", hint: "Opacity of the player when minimized and not hovered (0-100).", scope: 'client', config: true, type: Number, default: 50, range: { min: 0, max: 100, step: 5 }, onChange: v => { const el = document.getElementById('foundry-tube-app'); if(el && game.settings.get(MODULE_ID, 'enableTransparency')) el.style.setProperty('--minimized-opacity', v / 100); } });
    game.settings.register(MODULE_ID, 'skipUnplayable', { name: "Skip Unplayable Videos", hint: "When YouTube refuses to play a video (removed, private, or embedding disabled by its owner), automatically move on to the next track.", scope: 'world', config: true, type: Boolean, default: true });
    game.settings.register(MODULE_ID, 'youtubeApiKey', { name: "YouTube API Key (optional, GM)", hint: "Makes search and playlist import fast and reliable, with real titles and lengths. Free from Google Cloud Console: enable 'YouTube Data API v3' and create an API key. Stored only in this browser.", scope: 'client', config: true, restricted: true, type: String, default: "" });
    game.settings.register(MODULE_ID, 'customProxy', { name: "Custom CORS Proxy (optional, GM)", hint: "A CORS proxy to use for search when there is no API key. Put {url} where the YouTube address goes, e.g. https://my-proxy.example/?url={url}. Leave blank to skip.", scope: 'client', config: true, restricted: true, type: String, default: "" });
    game.settings.register(MODULE_ID, 'usePublicProxies', { name: "Try Free Public Proxies (GM)", hint: "Last resort for search without an API key. These free services are often down or rate-limited; failing ones are skipped for 10 minutes.", scope: 'client', config: true, restricted: true, type: Boolean, default: true });

    if (!document.getElementById('yt-api-script')) {
        const tag = document.createElement('script'); tag.id = 'yt-api-script'; tag.src = "https://www.youtube.com/iframe_api";
        document.head.appendChild(tag);
    }
});
Hooks.once('ready', () => {
    tubeApp = new FoundryTubeApp();
    window.tubeApp = tubeApp;
    const m = game.modules.get(MODULE_ID);
    if (m) m.api = { open: () => tubeApp.show() };

    setTimeout(async () => {
        await tubeApp.render({ force: true });
        if (game.settings.get(MODULE_ID, 'hideOnStartup') && tubeApp.element) tubeApp.element.style.display = 'none';
    }, 1000);

    game.socket.on(SOCKET_NAME, (p) => tubeApp._onSocket(p));
});
Hooks.on('getSceneControlButtons', (controls) => {
    const toolConfig = {
        name: "tube-toggle",
        title: "Tube Player",
        icon: "fas fa-tv",
        visible: true,
        button: true,
        onChange: () => {
            const app = window.tubeApp;
            if (!app) return;

            if (!app.element) {
                app.render({ force: true });
                return;
            }

            if (app.element.style.display === "none") {
                app.element.style.display = "";
                app.bringToFront();
            } else {
                app.element.style.display = "none";
            }
        }
    };

    if (Array.isArray(controls)) {
        const token = controls.find(c => c.name === 'token');
        if (token) token.tools.push(toolConfig);
    } else {
        const tokenLayer = controls.token || controls.tokens;
        if (tokenLayer) {
            if (Array.isArray(tokenLayer.tools)) {
                tokenLayer.tools.push(toolConfig);
            } else {
                // v13+ tools are keyed objects sorted by a required `order` field.
                toolConfig.order = Object.keys(tokenLayer.tools).length;
                tokenLayer.tools["tube-toggle"] = toolConfig;
            }
        }
    }
});
