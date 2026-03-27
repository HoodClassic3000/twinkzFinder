// ==UserScript==
// @name         Rugplay Twink Finder
// @namespace    http://tampermonkey.net/
// @version      2.0.0
// @description  Track arcade gamblers to identify twink alt accounts on rugplay
// @author       HoodClassic
// @match        *://rugplay.com/*
// @grant        unsafeWindow
// @run-at       document_start
// ==/UserScript==

(function () {
    'use strict';

    const WIN_THRESHOLD   = 2_000_000;
    const WIN_WINDOW_MS   = 60 * 60 * 1000;
    const GRACE_MS        = 30 * 60 * 1000;
    const FETCH_INTERVAL  = 10_000;
    const STORAGE_KEY     = 'twinkfinder_v2';
    const _now            = new Date();
    const CURRENT_MONTH   = _now.getMonth();
    const CURRENT_YEAR    = _now.getFullYear();

    const users = new Map();
    const fetchedProfiles = new Set();
    const fetchQueue = [];
    let fetchBusy = false;

    const OriginalWebSocket = unsafeWindow.WebSocket;

    function fmt(n) {
        if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
        if (n >= 1_000)     return `$${(n / 1_000).toFixed(1)}K`;
        return `$${n.toFixed(2)}`;
    }

    function scoreLabel(score) {
        if (score >= 80) return { label: 'Very Likely 🔥', color: '#ef4444' };
        if (score >= 60) return { label: 'Likely',         color: '#f97316' };
        if (score >= 35) return { label: 'Possible',       color: '#eab308' };
        return                  { label: 'Unlikely',       color: '#6b7280' };
    }

    function getOrCreate(userId, username, userImage) {
        if (!users.has(userId)) {
            users.set(userId, {
                userId, username, userImage,
                gamesPlayed: 0, wins: 0, losses: 0,
                totalWagered: 0,
                winEvents: [],
                firstSeen: Date.now(), lastSeen: Date.now(),
                windowResetAt: null,
                arcadeWins: null, arcadeLosses: null,
                profile: null, stats: null, twinkScore: 0
            });
        }
        return users.get(userId);
    }

    function pruneOldEvents(user) {
        const now = Date.now();
        const idleSince = now - user.lastSeen;

        if (idleSince > WIN_WINDOW_MS + GRACE_MS) {
            user.winEvents = [];
            user.gamesPlayed = 0;
            user.wins = 0;
            user.losses = 0;
            user.totalWagered = 0;
            user.windowResetAt = now;
            return;
        }

        const cutoff = now - WIN_WINDOW_MS;
        user.winEvents = user.winEvents.filter(e => e.timestamp > cutoff);
    }

    function getWindowWins(user) {
        const cutoff = Date.now() - WIN_WINDOW_MS;
        return user.winEvents
            .filter(e => e.timestamp > cutoff)
            .reduce((sum, e) => sum + e.amount, 0);
    }

    function getWindowGames(user) {
        const cutoff = Date.now() - WIN_WINDOW_MS;
        return user.winEvents.filter(e => e.timestamp > cutoff).length;
    }

    function windowTimeRemaining(user) {
        if (!user.winEvents.length) return null;
        const oldest = Math.min(...user.winEvents.map(e => e.timestamp));
        const expiresAt = oldest + WIN_WINDOW_MS;
        const remaining = expiresAt - Date.now();
        if (remaining <= 0) return null;
        const m = Math.floor(remaining / 60000);
        const s = Math.floor((remaining % 60000) / 1000);
        return `${m}m ${s}s`;
    }

    function resolveSkData(dataArr, refObj) {
        const out = {};
        for (const key in refObj) out[key] = dataArr[refObj[key]];
        return out;
    }

    function calcTwinkScore(user) {
        let score = 0;
        const windowWins = getWindowWins(user);
        const effectiveWins   = user.arcadeWins   ?? windowWins;
        const effectiveLosses = user.arcadeLosses ?? (user.totalWagered - windowWins);

        if (user.profile?.createdAt) {
            const created = new Date(user.profile.createdAt);
            if (created.getFullYear() === CURRENT_YEAR && created.getMonth() === CURRENT_MONTH) score += 35;
            else if ((Date.now() - created.getTime()) < 60 * 86400000) score += 20;
        }

        if (windowWins >= 5_000_000)   score += 30;
        else if (windowWins >= WIN_THRESHOLD) score += 20;

        if (user.arcadeWins !== null) {
            if (effectiveWins >= 5_000_000)  score += 15;
            else if (effectiveWins >= WIN_THRESHOLD) score += 10;
        }

        if (user.stats) {
            const tradeVol = parseFloat(user.stats.totalBuyVolume || 0) + parseFloat(user.stats.totalSellVolume || 0);
            const totalArcadeVol = effectiveWins + Math.max(effectiveLosses, 0);
            const arcadeRatio = totalArcadeVol / (totalArcadeVol + tradeVol + 1);
            if (arcadeRatio >= 0.9)   score += 25;
            else if (arcadeRatio >= 0.7) score += 15;
            if ((user.stats.holdingsCount || 0) < 3) score += 10;
            if ((user.stats.coinsCreated  || 0) === 0) score += 5;
        }

        if (user.gamesPlayed >= 10) {
            const wr = user.wins / user.gamesPlayed;
            if (wr >= 0.45 && wr <= 0.65) score += 5;
        }

        return Math.min(score, 100);
    }

    async function processFetchQueue() {
        if (!fetchQueue.length) { fetchBusy = false; return; }
        fetchBusy = true;
        const userId = fetchQueue.shift();
        fetchedProfiles.add(userId);
        try {
            const user = users.get(userId);
            const slug = user?.username ?? userId;
            const res = await fetch(`/user/${slug}/__data.json?x-sveltekit-invalidated=11`);
            if (res.ok) {
                const raw = await res.json();
                const dataArr = raw.nodes?.[1]?.data;
                if (dataArr && user) {
                    const root           = dataArr[0];
                    const profileDataRef = dataArr[root.profileData];
                    const profileRef     = dataArr[profileDataRef.profile];
                    const statsRef       = dataArr[profileDataRef.stats];
                    user.profile         = resolveSkData(dataArr, profileRef);
                    user.stats           = resolveSkData(dataArr, statsRef);
                    user.arcadeWins      = parseFloat(user.profile.arcadeWins   || 0);
                    user.arcadeLosses    = parseFloat(user.profile.arcadeLosses || 0);
                    user.twinkScore      = calcTwinkScore(user);
                }
            }
        } catch (_) {}
        saveState();
        setTimeout(processFetchQueue, FETCH_INTERVAL);
    }

    function enqueueFetch(userId) {
        if (fetchedProfiles.has(userId) || fetchQueue.includes(userId)) return;
        fetchQueue.push(userId);
        if (!fetchBusy) processFetchQueue();
    }

    function handleArcadeActivity(activity) {
        const { userId, username, userImage, amount, won, game } = activity;
        const user = getOrCreate(userId, username, userImage);

        pruneOldEvents(user);

        user.gamesPlayed++;
        user.lastSeen = Date.now();
        user.totalWagered += amount;

        if (won) {
            user.wins++;
            user.winEvents.push({ timestamp: Date.now(), amount, game: game || 'unknown' });
        } else {
            user.losses++;
        }

        user.twinkScore = calcTwinkScore(user);

        const windowWins = getWindowWins(user);
        if (windowWins >= WIN_THRESHOLD) enqueueFetch(userId);

        saveState();
    }

    function saveState() {
        try {
            const serializable = [...users.entries()].map(([id, u]) => [id, { ...u }]);
            localStorage.setItem(STORAGE_KEY, JSON.stringify(serializable));
        } catch (_) {}
    }

    function loadState() {
        try {
            const saved = localStorage.getItem(STORAGE_KEY);
            if (!saved) return;
            JSON.parse(saved).forEach(([id, data]) => {
                users.set(id, data);
                if (fetchedProfiles && data.profile) fetchedProfiles.add(id);
            });
        } catch (_) {}
    }

    unsafeWindow.WebSocket = new Proxy(OriginalWebSocket, {
        construct(target, args) {
            const ws = new target(...args);
            ws.addEventListener('message', (eventRaw) => {
                try {
                    const event = JSON.parse(eventRaw.data);
                    if (event.type === 'arcade_activity' && event.arcadeActivity) {
                        handleArcadeActivity(event.arcadeActivity);
                    }
                } catch (_) {}
            });
            return ws;
        }
    });

    setInterval(() => {
        users.forEach(user => {
            pruneOldEvents(user);
            user.twinkScore = calcTwinkScore(user);
        });
        saveState();
    }, 60_000);

    function renderModal() {
        document.getElementById('twink-finder-modal')?.remove();

        const candidates = [...users.values()]
            .filter(u => getWindowWins(u) >= WIN_THRESHOLD || (u.arcadeWins !== null && u.arcadeWins >= WIN_THRESHOLD))
            .sort((a, b) => b.twinkScore - a.twinkScore);

        const modal = document.createElement('div');
        modal.id = 'twink-finder-modal';
        modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:99999;display:flex;align-items:center;justify-content:center;';
        modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });

        const card = document.createElement('div');
        card.style.cssText = 'background:var(--card);border:1px solid var(--border);border-radius:12px;width:760px;max-height:84vh;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 25px 60px rgba(0,0,0,0.6);';

        const header = document.createElement('div');
        header.style.cssText = 'padding:20px 24px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;flex-shrink:0;';
        header.innerHTML = `
            <div>
                <h2 style="margin:0;font-size:18px;font-weight:700;color:var(--foreground);">Twink Finder</h2>
                <p style="margin:4px 0 0;font-size:12px;color:#888;">${candidates.length} suspect${candidates.length !== 1 ? 's' : ''} flagged · 1h rolling window · ${users.size} total tracked · queue: ${fetchQueue.length} pending</p>
            </div>
            <div style="display:flex;gap:8px;align-items:center;">
                <button id="twink-clear-btn" style="background:none;border:1px solid var(--border);color:#888;border-radius:6px;padding:6px 12px;cursor:pointer;font-size:12px;">Clear Data</button>
                <button id="twink-close-btn" style="background:none;border:1px solid var(--border);color:var(--foreground);border-radius:6px;padding:6px 14px;cursor:pointer;font-size:13px;">✕ Close</button>
            </div>
        `;

        const legend = document.createElement('div');
        legend.style.cssText = 'padding:8px 24px;background:color-mix(in srgb,var(--muted) 60%,transparent);border-bottom:1px solid var(--border);font-size:11px;color:#888;display:flex;align-items:center;gap:16px;flex-shrink:0;flex-wrap:wrap;';
        legend.innerHTML = `
            <span>Rolling 1h wins ≥ $2M · created this month · arcade:trade ratio · low holdings</span>
            <span style="margin-left:auto;display:flex;gap:12px;">
                <span style="color:#ef4444;">● Very Likely 80+</span>
                <span style="color:#f97316;">● Likely 60+</span>
                <span style="color:#eab308;">● Possible 35+</span>
                <span style="color:#6b7280;">● Unlikely</span>
            </span>
        `;

        const body = document.createElement('div');
        body.style.cssText = 'overflow-y:auto;flex:1;padding:12px;';

        if (!candidates.length) {
            body.innerHTML = `<div style="text-align:center;padding:48px 20px;color:#666;font-size:14px;line-height:1.8;">No suspects yet.<br><span style="font-size:12px;">Tracking ${users.size} player${users.size !== 1 ? 's' : ''}.<br>Any page on rugplay.com collects arcade events.</span></div>`;
        } else {
            candidates.forEach(user => {
                const { label, color } = scoreLabel(user.twinkScore);
                const windowWins = getWindowWins(user);
                const windowRemaining = windowTimeRemaining(user);
                const sessionWinRate = user.gamesPlayed
                    ? ((user.wins / user.gamesPlayed) * 100).toFixed(1) : '0.0';
                const lifetimeWinRate = (user.arcadeWins !== null && user.arcadeLosses !== null && (user.arcadeWins + user.arcadeLosses) > 0)
                    ? ((user.arcadeWins / (user.arcadeWins + user.arcadeLosses)) * 100).toFixed(1) : null;
                const tradeVol = user.stats
                    ? parseFloat(user.stats.totalBuyVolume || 0) + parseFloat(user.stats.totalSellVolume || 0) : null;
                const totalArcadeVol = user.arcadeWins !== null ? user.arcadeWins + user.arcadeLosses : null;
                const arcadeRatioPct = (totalArcadeVol !== null && tradeVol !== null)
                    ? ((totalArcadeVol / (totalArcadeVol + tradeVol + 1)) * 100).toFixed(0) : null;
                const createdAt = user.profile?.createdAt;
                const createdStr = createdAt
                    ? new Date(createdAt).toLocaleDateString()
                    : (fetchedProfiles.has(user.userId) ? 'N/A' : 'Pending...');
                const imgSrc = user.userImage ? `https://rugplay.com/${user.userImage}` : '';
                const isNewAccount = createdAt && (() => {
                    const c = new Date(createdAt);
                    return c.getFullYear() === CURRENT_YEAR && c.getMonth() === CURRENT_MONTH;
                })();

                const row = document.createElement('div');
                row.style.cssText = 'display:flex;align-items:center;gap:14px;padding:14px;border:1px solid var(--border);border-radius:8px;margin-bottom:8px;transition:background 0.15s;';
                row.onmouseenter = () => row.style.background = 'color-mix(in srgb,var(--muted) 50%,transparent)';
                row.onmouseleave = () => row.style.background = '';

                row.innerHTML = `
                    <img src="${imgSrc}" style="width:44px;height:44px;border-radius:50%;object-fit:cover;flex-shrink:0;border:2px solid ${color};" onerror="this.style.visibility='hidden'">
                    <div style="flex:1;min-width:0;">
                        <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;flex-wrap:wrap;">
                            <a href="/user/${user.username}" target="_blank" style="font-weight:700;color:var(--foreground);text-decoration:none;font-size:14px;">@${user.username}</a>
                            <span style="font-size:10px;color:#666;background:var(--muted);padding:1px 6px;border-radius:4px;">ID ${user.userId}</span>
                            ${isNewAccount ? `<span style="font-size:10px;color:#22c55e;background:rgba(34,197,94,0.1);padding:1px 6px;border-radius:4px;font-weight:600;">NEW ACCOUNT</span>` : ''}
                            ${user.profile?.nameColor ? `<span style="font-size:10px;color:#aaa;background:var(--muted);padding:1px 6px;border-radius:4px;">${user.profile.nameColor}</span>` : ''}
                            ${windowRemaining ? `<span style="font-size:10px;color:#eab308;background:rgba(234,179,8,0.1);padding:1px 6px;border-radius:4px;">⏱ window expires ${windowRemaining}</span>` : ''}
                        </div>
                        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:5px 12px;font-size:11px;color:#888;">
                            <span>1h wins: <strong style="color:#22c55e;">${fmt(windowWins)}</strong></span>
                            <span>Lifetime wins: <strong style="color:#22c55e;">${user.arcadeWins !== null ? fmt(user.arcadeWins) : '—'}</strong></span>
                            <span>Lifetime losses: <strong style="color:#ef4444;">${user.arcadeLosses !== null ? fmt(user.arcadeLosses) : '—'}</strong></span>
                            <span>Lifetime WR: <strong style="color:var(--foreground);">${lifetimeWinRate !== null ? lifetimeWinRate + '%' : sessionWinRate + '%*'}</strong></span>
                            <span>Session games: <strong style="color:var(--foreground);">${user.gamesPlayed}</strong></span>
                            <span>Arcade ratio: <strong style="color:var(--foreground);">${arcadeRatioPct !== null ? arcadeRatioPct + '%' : '—'}</strong></span>
                            <span>Trade vol: <strong style="color:var(--foreground);">${tradeVol !== null ? fmt(tradeVol) : '—'}</strong></span>
                            <span>Holdings: <strong style="color:var(--foreground);">${user.stats?.holdingsCount ?? '—'}</strong></span>
                            <span>Coins made: <strong style="color:var(--foreground);">${user.stats?.coinsCreated ?? '—'}</strong></span>
                            <span>Transactions: <strong style="color:var(--foreground);">${user.stats?.totalTransactions ?? '—'}</strong></span>
                            <span>Prestige: <strong style="color:var(--foreground);">${user.profile?.prestigeLevel ?? '—'}</strong></span>
                            <span>Created: <strong style="color:var(--foreground);">${createdStr}</strong></span>
                        </div>
                    </div>
                    <div style="text-align:center;flex-shrink:0;min-width:80px;">
                        <div style="font-size:28px;font-weight:800;color:${color};line-height:1;">${user.twinkScore}</div>
                        <div style="font-size:10px;font-weight:600;color:${color};margin-top:2px;">${label}</div>
                        <div style="font-size:10px;color:#666;margin-top:1px;">twink score</div>
                    </div>
                `;
                body.appendChild(row);
            });
        }

        card.appendChild(header);
        card.appendChild(legend);
        card.appendChild(body);
        modal.appendChild(card);
        document.body.appendChild(modal);

        document.getElementById('twink-close-btn').addEventListener('click', () => modal.remove());
        document.getElementById('twink-clear-btn').addEventListener('click', () => {
            users.clear();
            fetchedProfiles.clear();
            localStorage.removeItem(STORAGE_KEY);
            modal.remove();
        });
    }

    function injectButton() {
        if (!location.pathname.startsWith('/arcade')) return;
        if (document.getElementById('twink-finder-btn')) return;
        const tabRow = document.querySelector('div.flex.justify-center.gap-4');
        if (!tabRow) return;
        const btn = document.createElement('button');
        btn.id = 'twink-finder-btn';
        btn.style.cssText = 'padding:6px 16px;border-radius:6px;font-size:14px;font-weight:600;cursor:pointer;background:#6c35de;color:white;border:none;white-space:nowrap;transition:opacity 0.15s;';
        btn.textContent = 'Twink Finder';
        btn.onmouseenter = () => btn.style.opacity = '0.85';
        btn.onmouseleave = () => btn.style.opacity = '1';
        btn.addEventListener('click', renderModal);
        tabRow.appendChild(btn);
    }

    loadState();

    document.addEventListener('DOMContentLoaded', injectButton);

    window.addEventListener('popstate', () => {
        document.getElementById('twink-finder-btn')?.remove();
        setTimeout(injectButton, 500);
    });

    new MutationObserver(() => {
        if (location.pathname.startsWith('/arcade')) injectButton();
        else document.getElementById('twink-finder-btn')?.remove();
    }).observe(document.documentElement, { childList: true, subtree: true });

})();