const SANDBOX = Object.freeze({
    enabled: true,
    label: "LOCAL FIXTURE SANDBOX"
});

class SimulatedChatSocket {
    constructor() {
        this.readyState = 0;
        setTimeout(() => {
            this.readyState = 1;
            if (typeof this.onopen === "function") this.onopen();
        }, 40);
    }
    send(raw) {
        let message;
        try {
            message = JSON.parse(raw);
        } catch {
            return;
        }
        if (message.type === "new_conversation") {
            setTimeout(() => this.onmessage?.({
                data: JSON.stringify({
                    type: "system",
                    text: "[SIMULATED] Started a fresh local fixture conversation. No files or services changed."
                })
            }), 40);
            return;
        }
        if (message.type !== "chat") return;
        this.onmessage?.({
            data: JSON.stringify({
                type: "started"
            })
        });
        setTimeout(() => this.onmessage?.({
            data: JSON.stringify({
                type: "assistant",
                text: `[SIMULATED] I would turn “${String(message.text || "").slice(0, 140)}” into a reviewed local draft change. No external service is connected.`
            })
        }), 180);
        setTimeout(() => this.onmessage?.({
            data: JSON.stringify({
                type: "done"
            })
        }), 260);
    }
    close() {
        this.readyState = 3;
        if (typeof this.onclose === "function") this.onclose();
    }
}

const state = {
    mode: "production",
    modes: [],
    canSwitch: false,
    coauthorConfigured: false,
    previewOrigin: null,
    routeEpoch: 0,
    stream: null,
    chat: null,
    leaveScreen: null,
    funnelSort: {
        key: "visitors",
        dir: "desc"
    }
};

function beginRouteRequest(routeState = state) {
    const request = {
        epoch: (routeState.routeEpoch || 0) + 1,
        mode: routeState.mode
    };
    routeState.routeEpoch = request.epoch;
    return request;
}

function routeResponseIsCurrent(request, routeState = state) {
    return Boolean(request) && request.epoch === routeState.routeEpoch && request.mode === routeState.mode;
}

function syncRouteMode(request, answered, paint, routeState = state) {
    if (!routeResponseIsCurrent(request, routeState)) return false;
    if (answered && answered !== request.mode) {
        request.mode = answered;
        paint(answered);
    }
    return true;
}

function commitRouteResponse(request, responses, commit = () => {}, routeState = state) {
    if (!routeResponseIsCurrent(request, routeState)) return false;
    const items = Array.isArray(responses) ? responses : [ responses ];
    if (items.some(response => response?.__mode && response.__mode !== request.mode)) return false;
    commit();
    return true;
}

async function api(path, opts = {}) {
    const requestMode = opts.mode || state.mode;
    try {
        const res = await fetch(`/api/marketing${path}`, {
            method: opts.method || "GET",
            headers: {
                "Content-Type": "application/json",
                "X-Demo-Mode": requestMode
            },
            body: opts.body ? JSON.stringify(opts.body) : undefined
        });
        const answered = res.headers.get("X-Demo-Mode");
        if (opts.syncChrome !== false && opts.routeRequest) syncRouteMode(opts.routeRequest, answered, paintMode); else if (opts.syncChrome !== false && answered && answered !== requestMode) paintMode(answered);
        const text = await res.text();
        let body;
        try {
            body = text ? JSON.parse(text) : {};
        } catch {
            body = {
                success: false,
                error: text.slice(0, 300)
            };
        }
        if (!res.ok && body.success === undefined) body.success = false;
        body.__status = res.status;
        body.__mode = answered || requestMode;
        return body;
    } catch (err) {
        return {
            success: false,
            error: err?.message || "Network request failed",
            __status: 0,
            __mode: requestMode
        };
    }
}

const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === "class") n.className = v; else if (k === "html") n.innerHTML = v; else if (k.startsWith("on")) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) {
        if (kid == null || kid === false) continue;
        n.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return n;
};

const when = iso => iso ? new Date(iso).toLocaleString() : "-";

const modeLine = mode => mode === "production" ? "Real view" : "Test mode";

const MODE_KEY = "demo-console-mode";

function rememberedMode() {
    try {
        const v = sessionStorage.getItem(MODE_KEY);
        return v === "production" || v === "test" ? v : null;
    } catch {
        return null;
    }
}

function openingMode(cfg) {
    const remembered = rememberedMode();
    const usable = m => cfg.modes.some(x => x.mode === m && x.available);
    return remembered && usable(remembered) ? remembered : cfg.defaultMode;
}

function chooseMode(mode) {
    try {
        sessionStorage.setItem(MODE_KEY, mode);
    } catch {}
    paintMode(mode);
}

function paintMode(mode) {
    state.mode = mode;
    paintChromeMode(mode);
}

function paintChromeMode(mode, {label: label = modeLine(mode), toggleHidden: toggleHidden = false} = {}) {
    document.body.dataset.mode = mode;
    const flag = document.getElementById("real-flag");
    if (flag) {
        flag.hidden = mode !== "production";
        flag.textContent = mode === "production" ? "READ ONLY" : "";
    }
    document.getElementById("mode-line").textContent = label;
    const toggle = document.getElementById("mode-toggle");
    if (toggle) toggle.hidden = toggleHidden;
    for (const b of document.querySelectorAll("#mode-toggle button")) {
        b.setAttribute("aria-pressed", String(b.dataset.mode === mode));
    }
}

function routeChromeContext(hash, dataMode = state.mode) {
    if (/^#\/funnels\/[a-z0-9-]+\/build$/i.test(hash)) {
        return {
            mode: "test",
            label: "Test mode",
            toggleHidden: true,
            unifiedFunnels: true
        };
    }
    if (/^#\/funnels(?:\/|$)/i.test(hash)) {
        return {
            mode: "production",
            label: "Live versions",
            toggleHidden: true,
            unifiedFunnels: true
        };
    }
    return {
        mode: dataMode,
        label: modeLine(dataMode),
        toggleHidden: false,
        unifiedFunnels: false
    };
}

const ROUTES = [ {
    hash: "#/funnels",
    label: "Funnels",
    render: renderFunnels
} ];

function buildChrome(cfg) {
    state.modes = cfg.modes;
    state.canSwitch = cfg.canSwitch;
    state.coauthorConfigured = Boolean(cfg.coauthorConfigured);
    state.previewOrigin = cfg.previewOrigin || null;
    const toggle = document.getElementById("mode-toggle");
    toggle.replaceChildren(...cfg.modes.map(m => el("button", {
        type: "button",
        "data-mode": m.mode,
        disabled: !m.available,
        title: m.available ? m.mode === "production" ? `Read the ${m.label.toLowerCase()} environment (${m.database}); Production writes are refused` : `Read Test data from the ${m.label.toLowerCase()} environment (${m.database}); funnel editing opens through Edit draft` : "This fixture mode is unavailable in the sandbox.",
        onclick: () => {
            if (m.mode !== state.mode) {
                chooseMode(m.mode);
                route();
            }
        }
    }, m.label)));
    document.getElementById("nav").replaceChildren(...ROUTES.map(r => el("a", {
        href: r.hash
    }, r.label)), el("span", {
        class: "nav-disabled",
        title: "Only Funnels is packaged in this contributor sandbox."
    }, "Other panels unavailable"));
    paintMode(openingMode(cfg));
}

function route() {
    if (state.stream) {
        state.stream.close();
        state.stream = null;
    }
    if (state.chat) {
        state.chat.close();
        state.chat = null;
    }
    if (state.leaveScreen) {
        state.leaveScreen();
        state.leaveScreen = null;
    }
    const request = beginRouteRequest();
    const hash = location.hash || "#/funnels";
    const chrome = routeChromeContext(hash);
    paintChromeMode(chrome.mode, chrome);
    for (const a of document.querySelectorAll("#nav a")) a.classList.toggle("on", hash.startsWith(a.getAttribute("href")));
    const view = document.getElementById("view");
    view.classList.remove("builder-view");
    document.body.classList.remove("builder-route");
    view.replaceChildren(el("p", {
        class: "muted"
    }, "Loading…"));
    const build = hash.match(/^#\/funnels\/([a-z0-9-]+)\/build(?:\/(variation))?$/i);
    if (build) return renderBuild(view, build[1], request, build[2] ? "variation" : "control");
    const detail = hash.match(/^#\/funnels\/([a-z0-9-]+)/i);
    if (detail) return renderFunnel(view, detail[1], request);
    const hit = ROUTES.find(r => hash.startsWith(r.hash)) || ROUTES[0];
    return hit.render(view, request);
}

const deliveryReaches = status => status === "live";

const usesDelivery = f => {
    if (!f) return true;
    if (f.editable && typeof f.editable.usesDelivery === "boolean") return f.editable.usesDelivery;
    return !(f.delivery && f.delivery.enabled === false);
};

const deliveryStanding = f => {
    if (!usesDelivery(f)) return "unused";
    return deliveryReaches(f && f.status) ? "reaching" : "blocked";
};

const DELIVERY_PILL = {
    reaching: {
        class: "pill live",
        text: "delivery enabled",
        title: "The optional delivery fixture is enabled for this synthetic funnel."
    },
    blocked: {
        class: "pill draft",
        text: "delivery paused",
        title: "The optional delivery fixture is configured but paused."
    },
    unused: {
        class: "pill",
        text: "delivery not used",
        title: "This synthetic funnel does not use the optional delivery fixture."
    }
};

const deliveryPill = f => {
    const p = DELIVERY_PILL[deliveryStanding(f)];
    return el("span", {
        class: p.class,
        title: p.title
    }, p.text);
};

function previewPath(slug, mode = "test", page = "", origin = state.previewOrigin, consoleOrigin = (typeof location !== "undefined" ? location.origin : null)) {
    if (mode !== "test") return null;
    try {
        const preview = new URL(origin || consoleOrigin);
        if (preview.protocol !== "http:" || ![ "127.0.0.1", "localhost" ].includes(preview.hostname) || preview.username || preview.password) return null;
        if (consoleOrigin && preview.origin !== new URL(consoleOrigin).origin) return null;
        const cleanPage = String(page || "").replace(/^\/+/, "");
        return `${preview.origin}/preview/test/${encodeURIComponent(String(slug || ""))}/${cleanPage}`;
    } catch {
        return null;
    }
}

const authoritativeProductionUrl = config => {
    const raw = config?.readonly?.pages?.canonicalUrl;
    if (!raw) return null;
    return /^\/preview\/live\/[a-z0-9-]+\/?$/i.test(raw) ? raw : null;
};

const builderPageUrl = (config, mode, slug, page = "", origin = state.previewOrigin, consoleOrigin) => mode === "test" ? previewPath(slug, mode, page, origin, consoleOrigin) : mode === "production" ? authoritativeProductionUrl(config) : null;

function previewFrameAttributes(src) {
    return {
        src: src,
        sandbox: "allow-scripts allow-presentation",
        referrerpolicy: "no-referrer"
    };
}

const PREVIEW_DEVICES = Object.freeze({
    desktop: Object.freeze({
        key: "desktop",
        label: "Desktop",
        width: 1440,
        height: 900
    }),
    mobile: Object.freeze({
        key: "mobile",
        label: "Mobile",
        width: 390,
        height: 844
    })
});

function acceptPreviewVerification(event, expected) {
    const message = event && event.data;
    if (!event || event.source !== expected.source || event.origin !== expected.origin || !message || message.type !== "demo-preview-verification-result" || message.nonce !== expected.nonce || message.candidateId !== expected.candidateId || message.pagePath !== expected.pagePath || Number(message.width) !== expected.width || Number(message.height) !== expected.height) return null;
    return {
        pagePath: message.pagePath,
        width: Number(message.width),
        height: Number(message.height),
        rawTokens: Number(message.rawTokens),
        unresolvedCustomValues: Number(message.unresolvedCustomValues),
        failedSubresources: Number(message.failedSubresources),
        brokenAssets: Number(message.brokenAssets),
        browserErrors: Number(message.browserErrors),
        outcome: String(message.outcome || "")
    };
}

function verifyPreviewFrame(frame, {origin: origin, candidateId: candidateId, pagePath: pagePath, viewport: viewport, src: src, timeoutMs: timeoutMs = 2e4}) {
    const nonce = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    frame.style.width = `${viewport.width}px`;
    frame.style.height = `${viewport.height}px`;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error(`Browser verification timed out for ${pagePath || "main"} at ${viewport.width}×${viewport.height}.`)), timeoutMs);
        const onMessage = event => {
            const accepted = acceptPreviewVerification(event, {
                source: frame.contentWindow,
                origin: "null",
                nonce: nonce,
                candidateId: candidateId,
                pagePath: pagePath,
                width: viewport.width,
                height: viewport.height
            });
            if (accepted) finish(null, accepted);
        };
        const onLoad = () => {
            try {
                frame.contentWindow.postMessage({
                    type: "demo-preview-verification-request",
                    nonce: nonce,
                    candidateId: candidateId
                }, "*");
            } catch (err) {
                finish(err);
            }
        };
        function finish(error, result) {
            clearTimeout(timer);
            window.removeEventListener("message", onMessage);
            frame.removeEventListener("load", onLoad);
            if (error) reject(error); else resolve(result);
        }
        window.addEventListener("message", onMessage);
        frame.addEventListener("load", onLoad);
        const join = src.includes("?") ? "&" : "?";
        frame.src = `${src}${join}demo_verify=${encodeURIComponent(nonce)}`;
    });
}

function previewGeometry(deviceKey, canvasWidth, canvasHeight) {
    const device = PREVIEW_DEVICES[deviceKey] || PREVIEW_DEVICES.desktop;
    const availableWidth = Math.max(0, Number(canvasWidth) || 0);
    const availableHeight = Math.max(0, Number(canvasHeight) || 0);
    const scale = Math.min(1, availableWidth / device.width, availableHeight / device.height);
    const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 0;
    return {
        ...device,
        scale: safeScale,
        renderedWidth: device.width * safeScale,
        renderedHeight: device.height * safeScale
    };
}

function setStudioFullscreen(studio, body, control, on) {
    const full = Boolean(on);
    studio.classList.toggle("builder-full", full);
    body.classList.toggle("builder-full-open", full);
    control.textContent = full ? "Exit full screen" : "Full screen";
    control.setAttribute("aria-pressed", String(full));
    control.title = full ? "Return the co-author and preview studio to the page. Escape does the same." : "Fill the window with the co-author and preview together.";
    return full;
}

async function toggleNativeFullscreen(studio, doc = document) {
    if (doc.fullscreenElement === studio) {
        await doc.exitFullscreen();
        return false;
    }
    if (typeof studio.requestFullscreen !== "function") throw new Error("Full-screen is unavailable in this browser.");
    await studio.requestFullscreen();
    return true;
}

const blankSort = v => v == null || v === "" || typeof v === "number" && !Number.isFinite(v);

const DEPLOYED_RELEASE_STATUSES = new Set([ "deployed_verified", "published_public_values_unverified" ]);

const UNRESOLVED_RUNTIME_STATUSES = new Set([ "published_deployment_unverified", "push_unverified" ]);

function currentDeployedRelease(releases) {
    return (releases || []).filter(release => DEPLOYED_RELEASE_STATUSES.has(release?.status) && timeValue(release.deploymentVerification?.verifiedAt) != null).sort((a, b) => timeValue(b.deploymentVerification.verifiedAt) - timeValue(a.deploymentVerification.verifiedAt))[0] || null;
}

const currentVerifiedRelease = currentDeployedRelease;

function deployedReleaseIdentity(releases) {
    const rows = Array.isArray(releases) ? releases : [];
    const proven = currentDeployedRelease(rows);
    const provenIndex = proven ? rows.indexOf(proven) : rows.length;
    const unresolved = rows.find((release, index) => {
        if (!UNRESOLVED_RUNTIME_STATUSES.has(release?.status)) return false;
        if (!proven) return true;
        const releaseVersion = Number(release.version);
        const provenVersion = Number(proven.version);
        if (Number.isFinite(releaseVersion) && Number.isFinite(provenVersion)) return releaseVersion > provenVersion;
        const releaseTime = timeValue(release.committedAt);
        const provenTime = timeValue(proven.deploymentVerification?.verifiedAt);
        if (releaseTime != null && provenTime != null) return releaseTime > provenTime;
        return index < provenIndex;
    }) || null;
    if (unresolved) {
        return {
            state: "unverified",
            current: null,
            lastVerified: proven,
            unresolved: unresolved
        };
    }
    return {
        state: proven ? "known" : "unrecorded",
        current: proven,
        lastVerified: null,
        unresolved: null
    };
}

function deployedReleasePill(release, {long: long = false} = {}) {
    const complete = release?.status === "deployed_verified";
    const version = long ? `Version ${release?.version ?? "?"}` : `v${release?.version ?? "?"}`;
    return {
        className: `pill ${complete ? "live" : "blocker"}`,
        text: complete ? version : `${version} · final checks incomplete`,
        title: complete ? `Verified ${utcWhen(release.deploymentVerification.verifiedAt)}` : `Current deployed code. ${describeRelease(release).text}`
    };
}

function deployedIdentityElements(identity, {long: long = false} = {}) {
    if (identity?.state === "unverified") {
        const last = identity.lastVerified;
        return [ el("span", {
            class: "pill blocker",
            title: identity.unresolved ? describeRelease(identity.unresolved).text : ""
        }, long ? "Current deployed version unverified" : "Identity unverified"), last ? el("span", {
            class: "pill",
            title: `Verified ${utcWhen(last.deploymentVerification?.verifiedAt)}`
        }, long ? `Last verified Version ${last.version ?? "?"} · ${String(last.id || "").slice(0, 12)}` : `Last verified v${last.version ?? "?"}`) : null ].filter(Boolean);
    }
    if (identity?.current) {
        const pill = deployedReleasePill(identity.current, {
            long: long
        });
        return [ el("span", {
            class: pill.className,
            title: pill.title
        }, long ? `${pill.text} · ${String(identity.current.id || "").slice(0, 12)}` : pill.text) ];
    }
    return [];
}

function draftWorkspaceState({published: published, liveKnown: liveKnown = true, testFunnel: testFunnel, testKnown: testKnown = true, status: status}) {
    if (!testFunnel) return {
        label: testKnown ? "No Test draft" : "Draft status unavailable",
        detail: testKnown ? "No matching Test funnel record was returned." : "The Test funnel list did not answer, so draft presence is unknown.",
        kind: testKnown ? "neutral" : "bad"
    };
    if (!published) return {
        label: liveKnown ? "Not published" : "Draft, live unknown",
        detail: liveKnown ? "This Test draft has no current live Production record." : "The Test draft exists, but the Production funnel list did not answer.",
        kind: "warn"
    };
    if (!status?.ok) return {
        label: "Draft status unavailable",
        detail: status?.error || "The Test working copy did not answer.",
        kind: "bad"
    };
    const work = describeWork(status);
    const candidate = status.candidate || {};
    const changed = Boolean(candidate.configChanged || candidate.pagesChanged || status.dirtyFiles > 0 || status.unpushedCommits > 0);
    if (work.kind === "bad") return {
        label: "Draft blocked",
        detail: work.text,
        kind: "bad"
    };
    return {
        label: changed ? "Draft changes" : "No draft changes",
        detail: work.text,
        kind: changed ? "warn" : "ok"
    };
}

function mergeFunnelWorkspace(liveFunnels = [], testFunnels = [], {liveKnown: liveKnown = true, testKnown: testKnown = true} = {}) {
    const live = new Map(liveFunnels.map(funnel => [ funnel.slug, funnel ]));
    const test = new Map(testFunnels.map(funnel => [ funnel.slug, funnel ]));
    return [ ...new Set([ ...live.keys(), ...test.keys() ]) ].sort().map(slug => {
        const liveFunnel = live.get(slug) || null;
        const testFunnel = test.get(slug) || null;
        return {
            ...liveFunnel || testFunnel,
            slug: slug,
            name: liveFunnel?.name || testFunnel?.name || slug,
            published: Boolean(liveFunnel),
            liveKnown: liveKnown,
            testKnown: testKnown,
            liveFunnel: liveFunnel,
            testFunnel: testFunnel
        };
    });
}

const LIVE_THUMB_WIDTH = 148;

function livePreviewThumb(canonicalUrl, slug, width = LIVE_THUMB_WIDTH) {
    const device = PREVIEW_DEVICES.desktop;
    const scale = width / device.width;
    const frame = el("iframe", {
        class: "preview",
        title: `Read-only live preview of ${slug}`,
        scrolling: "no",
        loading: "lazy",
        tabindex: "-1",
        "aria-hidden": "true",
        ...previewFrameAttributes(canonicalUrl)
    });
    frame.style.width = `${device.width}px`;
    frame.style.height = `${device.height}px`;
    const scaler = el("div", {
        class: "preview-scaler"
    }, frame);
    scaler.style.width = `${device.width}px`;
    scaler.style.height = `${device.height}px`;
    scaler.style.transform = `scale(${scale})`;
    const stage = el("div", {
        class: "preview-stage live-thumb"
    }, scaler);
    stage.style.width = `${device.width * scale}px`;
    stage.style.height = `${device.height * scale}px`;
    return stage;
}

function funnelPageCell(f) {
    if (!f.published) {
        return el("td", {}, el("span", {
            class: `pill ${f.liveKnown ? "draft" : "blocker"}`
        }, f.liveKnown ? "Not published" : "Live state unavailable"));
    }
    if (!f.canonicalUrl) return el("td", {
        class: "err",
        title: f.pageError || ""
    }, "Canonical link unavailable");
    return el("td", {
        class: "mono"
    }, el("div", {
        class: "page-cell"
    }, livePreviewThumb(f.canonicalUrl, f.slug), el("a", {
        href: f.canonicalUrl,
        target: "_blank",
        rel: "noopener",
        title: `Open ${f.slug}'s current canonical live page`,
        onclick: event => event.stopPropagation()
    }, "Open live")));
}

const FUNNEL_COLUMNS = [ {
    key: "funnel",
    label: "Funnel",
    sortValue: f => String(f.name || f.slug || "").toLowerCase(),
    cell: f => el("td", {}, el("div", {
        class: "stack"
    }, el("span", {}, f.name || f.slug), f.published ? deliveryPill(f) : null), el("div", {
        class: "mono muted"
    }, f.slug))
}, {
    key: "version",
    label: "Current live version",
    sortValue: f => f.deploymentIdentity?.current?.version ?? f.deploymentIdentity?.lastVerified?.version ?? f.liveRelease?.version ?? null,
    cell: f => el("td", {}, f.published ? (() => {
        const identity = f.deploymentIdentity || (f.liveRelease ? {
            state: "known",
            current: f.liveRelease
        } : {
            state: "unrecorded",
            current: null
        });
        const elements = deployedIdentityElements(identity);
        return elements.length ? elements : el("span", {
            class: "pill blocker",
            title: f.releaseError || ""
        }, f.releaseKnown ? "Version unrecorded" : "Version unavailable");
    })() : el("span", {
        class: `pill ${f.liveKnown ? "draft" : "blocker"}`
    }, f.liveKnown ? "Not published" : "Unavailable"))
}, {
    key: "page",
    label: "Canonical page",
    sortValue: f => String(f.canonicalUrl || "").toLowerCase(),
    cell: f => funnelPageCell(f)
}, {
    key: "draft",
    label: "Draft",
    sortValue: f => ({
        bad: 0,
        warn: 1,
        neutral: 2,
        ok: 3
    }[f.draftState?.kind] ?? 0),
    cell: f => el("td", {}, el("span", {
        class: `pill ${f.draftState?.kind === "bad" ? "blocker" : f.draftState?.kind === "warn" ? "draft" : f.draftState?.kind === "ok" ? "live" : ""}`,
        title: f.draftState?.detail
    }, f.draftState?.label || "Draft status unavailable"))
}, {
    key: "visitors",
    label: "Last visitor",
    firstDir: "desc",
    sortValue: f => f.observed && f.observed.lastSeenAt ? Date.parse(f.observed.lastSeenAt) : null,
    cell: f => el("td", {
        class: "muted"
    }, el("div", {}, when(f.observed && f.observed.lastSeenAt)), f.observed && f.observed.seenCount ? el("div", {
        class: "mono muted"
    }, `${f.observed.seenCount} page loads`) : null)
} ];

function compareFunnels(a, b, column, dir) {
    const av = column.sortValue(a);
    const bv = column.sortValue(b);
    const ab = blankSort(av);
    const bb = blankSort(bv);
    if (ab || bb) return ab && bb ? 0 : ab ? 1 : -1;
    const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
    return dir === "desc" ? -cmp : cmp;
}

function sortFunnels(funnels, sort) {
    const column = FUNNEL_COLUMNS.find(c => c.key === sort.key);
    if (!column) return funnels.slice();
    return funnels.slice().sort((a, b) => compareFunnels(a, b, column, sort.dir) || String(a.slug || "").localeCompare(String(b.slug || "")));
}

async function renderFunnels(view, request) {
    const [liveResponse, testResponse] = await Promise.all([ api("/funnels", {
        mode: "production",
        syncChrome: false
    }), api("/funnels", {
        mode: "test",
        syncChrome: false
    }) ]);
    if (!routeResponseIsCurrent(request)) return;
    if (!liveResponse.success && !testResponse.success) {
        return view.replaceChildren(errorCard({
            error: `Live funnels: ${liveResponse.error || "unavailable"}. Test drafts: ${testResponse.error || "unavailable"}.`
        }));
    }
    const base = mergeFunnelWorkspace(liveResponse.success ? liveResponse.funnels : [], testResponse.success ? testResponse.funnels : [], {
        liveKnown: liveResponse.success,
        testKnown: testResponse.success
    });
    const funnels = await Promise.all(base.map(async funnel => {
        const [config, history, status] = await Promise.all([ funnel.published ? api(`/funnels/${funnel.slug}/config`, {
            mode: "production",
            syncChrome: false
        }) : Promise.resolve({
            success: false,
            error: null
        }), state.coauthorConfigured ? coauthor(`/releases?funnel=${encodeURIComponent(funnel.slug)}`) : Promise.resolve({
            ok: false,
            error: "Release history is unavailable."
        }), state.coauthorConfigured && funnel.testFunnel ? coauthor(`/status?funnel=${encodeURIComponent(funnel.slug)}&env=test`) : Promise.resolve({
            ok: false,
            error: "Draft status is unavailable."
        }) ]);
        const releases = history.ok ? history.releases || [] : [];
        const deploymentIdentity = deployedReleaseIdentity(releases);
        const liveRelease = deploymentIdentity.current;
        const latestRelease = releases[0] || null;
        const ordinaryDraftState = draftWorkspaceState({
            published: funnel.published,
            liveKnown: funnel.liveKnown,
            testFunnel: funnel.testFunnel,
            testKnown: funnel.testKnown,
            status: status
        });
        return {
            ...funnel,
            canonicalUrl: config.success ? authoritativeProductionUrl(config.config) : null,
            pageError: config.success ? null : config.error,
            liveRelease: liveRelease,
            deploymentIdentity: deploymentIdentity,
            releaseKnown: history.ok,
            releaseError: history.ok ? null : history.error,
            latestRelease: latestRelease,
            draftState: latestRelease && latestRelease.status !== "deployed_verified" ? {
                label: "Release incomplete",
                detail: describeRelease(latestRelease).text,
                kind: "bad"
            } : ordinaryDraftState
        };
    }));
    if (!routeResponseIsCurrent(request)) return;
    const sort = state.funnelSort;
    const head = el("tr", {});
    const tbody = el("tbody", {});
    const draw = () => {
        const rows = sortFunnels(funnels, sort).map(f => el("tr", {
            class: "clickable",
            onclick: () => {
                location.hash = `#/funnels/${f.slug}`;
            }
        }, ...FUNNEL_COLUMNS.map(c => c.cell(f))));
        tbody.replaceChildren(...rows.length ? rows : [ el("tr", {}, el("td", {
            colspan: String(FUNNEL_COLUMNS.length),
            class: "muted"
        }, "No live funnels or Test drafts were returned.")) ]);
        head.replaceChildren(...FUNNEL_COLUMNS.map(c => {
            const on = c.key === sort.key;
            return el("th", {
                class: `sortable${on ? " sorted" : ""}`,
                "aria-sort": on ? sort.dir === "asc" ? "ascending" : "descending" : "none",
                title: `Sort by ${c.label.toLowerCase()}`,
                onclick: () => {
                    sort.dir = on ? sort.dir === "asc" ? "desc" : "asc" : c.firstDir || "asc";
                    sort.key = c.key;
                    draw();
                }
            }, c.label, el("span", {
                class: "arrow"
            }, on ? sort.dir === "asc" ? "▲" : "▼" : "⇅"));
        }));
    };
    draw();
    view.replaceChildren(...[ !liveResponse.success ? errorCard(liveResponse, "Live versions unavailable") : null, !testResponse.success ? errorCard(testResponse, "Test drafts unavailable") : null, el("div", {
        class: "card"
    }, el("h2", {}, "Funnels", el("span", {
        class: "count muted"
    }, `${funnels.length}`), el("span", {
        class: "spacer"
    }), el("span", {
        class: "count muted"
    }, "Current live version with Test draft status")), el("div", {
        class: "table-scroll"
    }, el("table", {
        class: "list"
    }, el("thead", {}, head), tbody))), testResponse.success ? newFunnelCard() : null ].filter(Boolean));
}

function newFunnelCard() {
    const name = el("input", {
        class: "text",
        placeholder: "Spring pool promo",
        "aria-label": "Funnel name"
    });
    const slug = el("input", {
        class: "text mono",
        placeholder: "spring-pool-promo",
        "aria-label": "Slug"
    });
    const type = el("select", {
        class: "text",
        "aria-label": "Funnel type"
    }, el("option", {
        value: ""
    }, "Loading types…"));
    const note = el("div", {
        class: "body muted"
    }, "The slug becomes the local page folder and the end of its preview URL. It cannot be changed later in this in-memory demo.");
    const create = el("button", {
        class: "act go"
    }, "Create and start building");
    let slugTouched = false;
    slug.addEventListener("input", () => {
        slugTouched = true;
    });
    name.addEventListener("input", () => {
        if (slugTouched) return;
        slug.value = name.value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    });
    api("/funnel-types", {
        mode: "test",
        syncChrome: false
    }).then(r => {
        if (!r.success) return;
        type.replaceChildren(...(r.types || []).map(t => el("option", {
            value: t.type || t.key || t.id
        }, t.label || t.name || t.type || t.key)));
    });
    create.addEventListener("click", async () => {
        const cleanSlug = slug.value.trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
        if (!cleanSlug || !type.value) {
            note.className = "body err";
            note.textContent = "A slug and a type are both needed before there is anything to create.";
            return;
        }
        create.disabled = true;
        create.textContent = "Creating…";
        const res = await api("/funnels/new", {
            method: "POST",
            mode: "test",
            syncChrome: false,
            body: {
                slug: cleanSlug,
                name: name.value.trim() || cleanSlug,
                type: type.value
            }
        });
        create.disabled = false;
        create.textContent = "Create and start building";
        if (!res.success) {
            note.className = "body err";
            note.textContent = res.error || "The funnel was refused.";
            return;
        }
        location.hash = `#/funnels/${cleanSlug}/build`;
    });
    return el("div", {
        class: "card"
    }, el("h2", {}, "New funnel"), el("div", {
        class: "body stack"
    }, name, slug, type, create), note);
}

const APPOINTMENTS_PROOF_KEY = "fixture_proof_count";

function publicPageValueUpdate(config, rawValue) {
    const composition = config?.editable?.composition;
    if (!composition) return {
        ok: false,
        error: "Migrate this funnel to composition v1 before setting a release-scoped page value."
    };
    const value = String(rawValue || "").trim();
    return {
        ok: true,
        body: {
            publicPageValue: {
                key: APPOINTMENTS_PROOF_KEY,
                value: value
            }
        }
    };
}

function publicPageValuesSummary(value) {
    const values = value?.publicPageValues || value?.editable?.composition?.publicPageValues || {};
    const entries = Object.entries(values);
    return entries.length ? entries.map(([key, item]) => `${key}=${item}`).join("; ") : "none (shared fixture fallback)";
}

function publicPageValueCard(c, mode) {
    const current = c.editable?.composition?.publicPageValues?.[APPOINTMENTS_PROOF_KEY] || "";
    const input = el("input", {
        class: "text mono",
        value: current,
        placeholder: "7,104",
        "aria-label": "Appointments and live transfers proof number"
    });
    const status = el("div", {
        class: "body muted"
    }, current ? `Stored Test fixture: ${APPOINTMENTS_PROOF_KEY}=${current}. The read-only live fixture is unchanged.` : "No stored Test override; preview uses the shared fixture value.");
    const save = el("button", {
        class: "act go",
        disabled: !c.editable?.composition
    }, "Save Test page value");
    save.addEventListener("click", async () => {
        const update = publicPageValueUpdate(c, input.value);
        if (!update.ok) {
            status.className = "body err";
            status.textContent = update.error;
            return;
        }
        save.disabled = true;
        const res = await api(`/funnels/${c.slug}/config`, {
            method: "PUT",
            body: update.body,
            mode: mode
        });
        save.disabled = false;
        if (!res.success) {
            status.className = "body err";
            status.textContent = (res.rejections || []).map(r => `${r.field}: ${r.reason}`).join(" · ") || res.error || "refused";
            return;
        }
        status.className = "body";
        status.textContent = "Saved in local Test memory. Preview uses this draft; the read-only live fixture is unchanged.";
        route();
    });
    return el("div", {
        class: "card"
    }, el("h2", {}, "Versioned public page value"), el("div", {
        class: "body muted"
    }, `The synthetic page token is {{fixture_values.${APPOINTMENTS_PROOF_KEY}}}. This local-only value appears in the preview and release-history fixtures.`), el("div", {
        class: "body stack"
    }, input, save), status);
}

function identityCard(c, mode) {
    const ed = c.editable || {};
    const missing = identityMissing(ed);
    const status = el("div", {
        class: "body muted"
    }, missing.length ? `Not filled in yet: ${missing.join(", ")}. A funnel is not ready to go live without them.` : "The lead tag, the calendar and the webinar are all set.");
    const calWrap = el("span", {
        class: "stack"
    });
    const calNote = el("span", {
        class: "muted"
    }, "Loading the calendar list…");
    let readCalendar = () => ed.calendarId || "";
    const drawCalendar = options => {
        const choice = calendarChoice(ed.calendarId, options);
        if (choice.mode === "manual") {
            const box = el("input", {
                class: "text mono",
                value: ed.calendarId || "",
                placeholder: "calendar id",
                "aria-label": "Calendar id"
            });
            readCalendar = () => box.value.trim();
            calWrap.replaceChildren(box);
            calNote.className = "muted";
            calNote.textContent = choice.why;
            return;
        }
        const sel = el("select", {
            class: "text",
            "aria-label": "Calendar"
        }, el("option", {
            value: ""
        }, "None"), choice.unrecognised ? el("option", {
            value: ed.calendarId,
            selected: true
        }, `${ed.calendarId} (not in this location’s list)`) : null, ...choice.list.map(cal => el("option", {
            value: cal.id,
            selected: cal.id === ed.calendarId
        }, `${cal.name}${cal.isActive ? "" : " (inactive)"} - ${cal.id}`)));
        readCalendar = () => sel.value;
        calWrap.replaceChildren(sel);
        calNote.className = "muted";
        calNote.textContent = choice.unrecognised ? "The stored calendar is not one this location lists. It is kept as it is until you choose another." : `${choice.list.length} calendars on this funnel’s location.`;
    };
    const tagBox = el("input", {
        class: "text",
        value: ed.leadTag || "",
        placeholder: "lead tag",
        "aria-label": "Lead tag",
        list: "tag-options"
    });
    const tagList = el("datalist", {
        id: "tag-options"
    });
    const webinarBox = el("input", {
        class: "text mono",
        value: ed.webinar && ed.webinar.webinarId || "",
        placeholder: "webinar id",
        "aria-label": "Webinar id"
    });
    const webinarNote = el("span", {
        class: "muted"
    }, "Typed by hand for this fixture. The local mock validates the value when you save it.");
    const save = el("button", {
        class: "act go"
    }, "Save");
    save.addEventListener("click", async () => {
        save.disabled = true;
        save.textContent = "Saving…";
        const body = {
            calendarId: readCalendar() || null,
            leadTag: tagBox.value.trim() || null,
            webinar: {
                ...ed.webinar || {},
                webinarId: webinarBox.value.trim() || null,
                enabled: Boolean(webinarBox.value.trim())
            }
        };
        const res = await api(`/funnels/${c.slug}/config`, {
            method: "PUT",
            body: body,
            mode: mode
        });
        save.disabled = false;
        save.textContent = "Save";
        if (!res.success) {
            status.className = "body err";
            status.textContent = (res.rejections || []).map(r => `${r.field}: ${r.reason}`).join(" · ") || res.error || "refused";
            return;
        }
        status.className = "body";
        status.textContent = "Saved.";
        route();
    });
    (async () => {
        const opts = await api(`/funnels/${c.id}/form-options`, {
            mode: mode
        });
        drawCalendar(opts && opts.success ? opts : {
            calendars: [],
            errors: [ opts && opts.error || "The calendar list could not be loaded." ]
        });
        const tags = opts && opts.tags || [];
        tagList.replaceChildren(...tags.map(t => el("option", {
            value: t.name
        })));
    })();
    return el("div", {
        class: "card"
    }, el("h2", {}, "Where this funnel books, tags and registers"), el("div", {
        class: "body stack"
    }, el("span", {
        class: "muted"
    }, "Calendar"), calWrap, calNote), el("div", {
        class: "body stack"
    }, el("span", {
        class: "muted"
    }, "Lead tag"), tagBox, tagList), el("div", {
        class: "body stack"
    }, el("span", {
        class: "muted"
    }, "Webinar id"), webinarBox, webinarNote), el("div", {
        class: "body stack"
    }, save), status);
}

function duplicateCard(c, mode = "test") {
    const slug = el("input", {
        class: "text mono",
        placeholder: "new-slug",
        "aria-label": "New slug"
    });
    const name = el("input", {
        class: "text",
        value: `${c.name || c.slug} copy`,
        "aria-label": "New name"
    });
    const note = el("div", {
        class: "body muted"
    });
    const go = el("button", {
        class: "act go",
        disabled: true
    }, "Duplicate");
    const EXPLAINER = `Copies the pages and every setting: ${DUPLICATE_COPIES.join(", ")}, and the delivery declaration. ` + "The Test copy gets its own page URL, because two funnels cannot claim the same one.";
    const say = (text, cls = "body muted") => {
        note.className = cls;
        note.textContent = text;
    };
    const check = () => {
        const typed = slug.value.trim();
        const problem = duplicateSlugProblem(slug.value, c.slug);
        go.disabled = Boolean(problem);
        if (!typed) return say(EXPLAINER);
        if (problem) return say(problem, "body err");
        return say(`${EXPLAINER} Press Duplicate and the create path decides whether “${typed.toLowerCase()}” is free.`);
    };
    slug.addEventListener("input", check);
    check();
    go.addEventListener("click", async () => {
        const to = slug.value.trim().toLowerCase();
        go.disabled = true;
        go.textContent = "Duplicating…";
        say(`Creating “${to}”…`);
        const res = await duplicateFunnel(c, {
            slug: to,
            name: name.value.trim() || to
        }, {
            mode: mode
        });
        go.textContent = "Duplicate";
        if (!res.ok) {
            say(res.error, "body err");
            go.disabled = Boolean(duplicateSlugProblem(slug.value, c.slug));
            return;
        }
        say(`Copied ${res.files} file${res.files === 1 ? "" : "s"} of pages` + (res.copied.length ? `, and brought ${res.copied.join(", ")} across.` : ".") + " Its page URL is its own.", "body");
        location.hash = `#/funnels/${to}/build`;
    });
    return el("div", {
        class: "card"
    }, el("h2", {}, "Duplicate this funnel"), el("div", {
        class: "body stack"
    }, slug, name, go), note);
}

const DUPLICATE_COPIES = [ "description", "questions", "videos", "sequences", "schedule", "leadTag", "calendarId", "webinar" ];

const DUPLICATE_LEAVES = [ "matchUrls" ];

function duplicateContent(editable = {}) {
    const out = {};
    for (const key of DUPLICATE_COPIES) {
        if (editable[key] !== undefined) out[key] = editable[key];
    }
    return out;
}

const IDENTITY_FIELDS = [ {
    key: "leadTag",
    label: "the lead tag",
    isSet: v => Boolean(v)
}, {
    key: "calendarId",
    label: "the calendar id",
    isSet: v => Boolean(v)
}, {
    key: "webinar",
    label: "the webinar id",
    isSet: v => Boolean(v && v.webinarId)
} ];

function duplicateCopied(editable = {}) {
    return IDENTITY_FIELDS.filter(f => f.isSet(editable[f.key])).map(f => f.label);
}

function identityMissing(editable = {}) {
    return IDENTITY_FIELDS.filter(f => !f.isSet(editable[f.key])).map(f => f.label);
}

function calendarChoice(current, options = {}) {
    const list = Array.isArray(options.calendars) ? options.calendars : [];
    const errors = Array.isArray(options.errors) ? options.errors : [];
    const id = String(current || "").trim();
    if (!list.length) {
        return {
            mode: "manual",
            list: [],
            why: errors.length ? `${errors.join(" ")} Enter the calendar id by hand instead.` : "The calendar list could not be loaded, so this is the raw id. Enter it by hand.",
            unrecognised: false
        };
    }
    return {
        mode: "list",
        list: list,
        unrecognised: Boolean(id) && !list.some(c => c.id === id),
        why: null
    };
}

function duplicateSlugProblem(slug, source) {
    const raw = String(slug || "").trim();
    if (!raw) return "A new slug is needed. A duplicate never reuses the original’s.";
    if (raw.toLowerCase() === String(source || "").toLowerCase()) return "That is the original’s slug. Pick a different one.";
    if (!/^[a-z0-9-]+$/.test(raw)) return "Only lower-case letters, numbers and hyphens.";
    if (/^-|-$/.test(raw)) return "It cannot start or end with a hyphen.";
    return null;
}

async function duplicateFunnel(source, {slug: slug, name: name}, deps = {}) {
    const call = deps.api || api;
    const bridge = deps.coauthor || coauthor;
    const mode = deps.mode || "test";
    const created = await call("/funnels/new", {
        method: "POST",
        body: {
            slug: slug,
            name: name,
            type: source.funnelType
        },
        mode: mode,
        syncChrome: false
    });
    if (!created.success) {
        const why = (created.rejections || []).map(r => r.reason).join("; ");
        return {
            ok: false,
            step: "record",
            error: why || created.error || "the funnel was refused"
        };
    }
    const content = duplicateContent(source.editable || {});
    if (Object.keys(content).length) {
        const put = await call(`/funnels/${slug}/config`, {
            method: "PUT",
            body: content,
            mode: mode,
            syncChrome: false
        });
        if (!put.success) {
            return {
                ok: false,
                step: "content",
                slug: slug,
                error: `"${slug}" was created but its settings did not copy: ${(put.rejections || []).map(r => `${r.field}: ${r.reason}`).join("; ") || put.error || "refused"}. ` + "It is an empty draft, not a broken one."
            };
        }
    }
    const usesDelivery = (source.editable || {}).usesDelivery;
    if (typeof usesDelivery === "boolean") {
        const deliveryResult = await call(`/funnels/${slug}/config`, {
            method: "PUT",
            body: {
                usesDelivery: usesDelivery
            },
            mode: mode,
            syncChrome: false
        });
        if (!deliveryResult.success) {
            return {
                ok: false,
                step: "delivery",
                slug: slug,
                error: `"${slug}" copied, but its delivery declaration did not: ${deliveryResult.error || "refused"}. ` + "Set it on the copy before enabling the live fixture."
            };
        }
    }
    const pages = await bridge("/clone", {
        method: "POST",
        body: {
            from: source.slug,
            to: slug,
            env: "test"
        }
    });
    if (!pages.ok) {
        return {
            ok: false,
            step: "pages",
            slug: slug,
            error: `"${slug}" exists and its settings copied, but the pages did not: ${pages.error || "refused"}. ` + "Open it and ask the co-author to write them."
        };
    }
    return {
        ok: true,
        slug: slug,
        files: pages.files,
        pages: pages.pages || [],
        copied: duplicateCopied(source.editable || {})
    };
}

const deliveryTogglePrompt = (c, next) => next ? `Turn optional delivery ON for "${c.slug}"?\n\nThis changes only the in-memory Test fixture.` : `Turn optional delivery OFF for "${c.slug}"?\n\nThis changes only the in-memory Test fixture.`;

async function reconcileDeliveryChoice(slug, next, request = api, mode = state.mode) {
    const call = async (path, opts) => {
        try {
            return await request(path, opts);
        } catch (err) {
            return {
                success: false,
                error: err?.message || "Network request failed",
                __status: 0
            };
        }
    };
    const write = await call(`/funnels/${slug}/config`, {
        method: "PUT",
        body: {
            usesDelivery: next
        },
        mode: mode
    });
    if (write.success && write.config) {
        return {
            known: true,
            value: usesDelivery(write.config),
            write: write,
            read: null
        };
    }
    const read = await call(`/funnels/${slug}/config`, {
        mode: mode
    });
    if (read.success && read.config) {
        return {
            known: true,
            value: usesDelivery(read.config),
            write: write,
            read: read
        };
    }
    return {
        known: false,
        value: null,
        write: write,
        read: read
    };
}

function setDeliveryToggleState(box, text, value) {
    box.disabled = false;
    box.indeterminate = value === null;
    if (value !== null) box.checked = value;
    text.textContent = value === null ? "delivery state unknown" : "uses optional delivery";
}

function deliveryToggle(slug, c, mode = "test", deps = {}) {
    const request = deps.api || api;
    const confirmChoice = deps.confirm || (message => window.confirm(message));
    const showAlert = deps.alert || (message => window.alert(message));
    const refresh = deps.refresh || route;
    let current = usesDelivery(c);
    const box = el("input", {
        type: "checkbox"
    });
    const text = el("span", {}, "uses optional delivery");
    box.checked = current;
    box.addEventListener("change", async () => {
        const next = box.checked;
        const ask = deliveryTogglePrompt(c, next);
        if (!confirmChoice(ask)) {
            setDeliveryToggleState(box, text, current);
            return;
        }
        box.disabled = true;
        const result = await reconcileDeliveryChoice(slug, next, request, mode);
        current = result.value;
        setDeliveryToggleState(box, text, current);
        if (!result.known) {
            showAlert("The local delivery setting could not be verified. Refresh the fixture and try again.");
            return;
        }
        if (!result.write.success) showAlert(result.write.error || "The update was refused; the current setting was reloaded.");
        refresh();
    });
    return el("label", {
        class: "check",
        title: "Whether this synthetic funnel uses the optional delivery fixture."
    }, box, text);
}

async function renderFunnel(view, slug, request) {
    const [liveConfig, testConfig, diagnosis, splitState, history, status] = await Promise.all([ api(`/funnels/${slug}/config`, {
        mode: "production",
        syncChrome: false
    }), api(`/funnels/${slug}/config`, {
        mode: "test",
        syncChrome: false
    }), api(`/funnels/${slug}/diagnosis`, {
        mode: "production",
        syncChrome: false
    }), api(`/funnels/${slug}/split-test`, {
        mode: "production",
        syncChrome: false
    }), state.coauthorConfigured ? coauthor(`/releases?funnel=${encodeURIComponent(slug)}`) : Promise.resolve({
        ok: false,
        error: "Release history is unavailable."
    }), state.coauthorConfigured ? coauthor(`/status?funnel=${encodeURIComponent(slug)}&env=test`) : Promise.resolve({
        ok: false,
        error: "Draft status is unavailable."
    }) ]);
    if (!routeResponseIsCurrent(request)) return;
    const liveMissing = !liveConfig.success && liveConfig.__status === 404;
    const testMissing = !testConfig.success && testConfig.__status === 404;
    const liveKnown = liveConfig.success || liveMissing;
    const testKnown = testConfig.success || testMissing;
    if (!liveConfig.success && !testConfig.success) {
        return view.replaceChildren(errorCard({
            error: `Live version: ${liveConfig.error || "unavailable"}. Test draft: ${testConfig.error || "unavailable"}.`
        }));
    }
    const published = Boolean(liveConfig.success);
    const c = published ? liveConfig.config : testConfig.config;
    const productionUrl = published ? authoritativeProductionUrl(c) : null;
    const d = published && diagnosis.success ? diagnosis.diagnosis : null;
    const releases = history.ok ? history.releases || [] : [];
    const deploymentIdentity = deployedReleaseIdentity(releases);
    const liveRelease = deploymentIdentity.current;
    const latestRelease = releases[0] || null;
    const draftState = draftWorkspaceState({
        published: published,
        liveKnown: liveKnown,
        testFunnel: testConfig.success ? testConfig.config : null,
        testKnown: testKnown,
        status: status
    });
    const wrap = el("div", {});
    const draftPillClass = draftState.kind === "bad" ? "blocker" : draftState.kind === "warn" ? "draft" : draftState.kind === "ok" ? "live" : "";
    wrap.append(el("div", {
        class: "card"
    }, el("h2", {}, el("a", {
        href: "#/funnels"
    }, "← Funnels"), c.name || c.slug, published ? el("span", {
        class: "pill live"
    }, "Current live") : el("span", {
        class: `pill ${liveKnown ? "draft" : "blocker"}`
    }, liveKnown ? "Not published" : "Live state unavailable")), el("div", {
        class: "body stack"
    }, el("span", {
        class: "mono muted"
    }, c.slug), deploymentIdentity.state !== "unrecorded" ? deployedIdentityElements(deploymentIdentity, {
        long: true
    }) : published ? el("span", {
        class: "pill blocker",
        title: history.error || ""
    }, history.ok ? "Live version unrecorded" : "Live version unavailable") : null, el("span", {
        class: `pill ${draftPillClass}`,
        title: draftState.detail
    }, draftState.label), published ? deliveryPill(c) : null, d && el("span", {
        class: `pill ${d.summary.wired ? "live" : "blocker"}`
    }, d.summary.wired ? "Live connections resolve" : `${d.summary.broken} broken · ${d.summary.unknown} unchecked`), el("span", {
        class: "spacer"
    }), testConfig.success ? el("a", {
        class: "act go",
        href: `#/funnels/${slug}/build`
    }, "Edit draft") : el("span", {
        class: "err"
    }, testKnown ? "No Test draft" : "Test draft unavailable"), SANDBOX.enabled ? null : el("a", {
        class: "act",
        href: `#/performance?funnel=${encodeURIComponent(slug)}`
    }, "View performance"), productionUrl ? el("a", {
        class: "act",
        href: productionUrl,
        target: "_blank",
        rel: "noopener"
    }, "Open live page") : null, published ? el("button", {
        class: "act",
        type: "button",
        onclick: () => route()
    }, "Refresh live data") : null), el("div", {
        class: "body muted"
    }, published ? "This is the current live version and is read-only. Edit draft opens the isolated Test builder." : liveKnown ? "This funnel exists only as a Test draft. Edit draft to build and check it before Commit." : "The Test draft is available, but the current live version could not be read.")));
    if (!liveKnown) {
        wrap.append(el("div", {
            class: "performance-warning err",
            role: "alert"
        }, `Current live version is unavailable. ${liveConfig.error || "The Production API did not answer."}`));
    }
    if (draftState.kind === "bad") {
        wrap.append(el("div", {
            class: "performance-warning err",
            role: "alert"
        }, draftState.detail));
    }
    if (latestRelease && latestRelease.status !== "deployed_verified") {
        wrap.append(el("div", {
            class: "performance-warning err",
            role: "alert"
        }, `Latest release is incomplete. ${describeRelease(latestRelease).text}`));
    }
    if (published) wrap.append(readOnlyConfigCard(c));
    if (published && productionUrl) wrap.append(splitTestCard(slug, productionUrl, splitState, testConfig.success));
    const releaseRows = releases.length ? releases.map(release => {
        const current = deploymentIdentity.current?.id && release.id === deploymentIdentity.current.id;
        const lastVerified = deploymentIdentity.state === "unverified" && deploymentIdentity.lastVerified?.id === release.id;
        const currentComplete = current && release.status === "deployed_verified";
        return el("div", {
            class: "row"
        }, el("div", {
            class: "grow"
        }, el("div", {
            class: "label"
        }, `v${release.version ?? "?"} · ${String(release.id || "").slice(0, 12) || "unknown SHA"}`, current ? el("span", {
            class: `pill ${currentComplete ? "live" : "blocker"}`
        }, currentComplete ? "Current deployed" : "Current deployed, incomplete") : null, lastVerified ? el("span", {
            class: "pill"
        }, "Last verified") : null), el("div", {
            class: "headline"
        }, describeRelease(release).text), el("div", {
            class: "muted"
        }, release.deploymentVerification?.verifiedAt ? `Verified ${utcWhen(release.deploymentVerification.verifiedAt)}` : release.committedAt ? `Committed ${when(release.committedAt)}` : "Time unavailable")));
    }) : [ el("div", {
        class: history.ok ? "body muted" : "body err"
    }, history.ok ? "No release records yet." : history.error) ];
    wrap.append(el("div", {
        class: "card"
    }, el("h2", {}, "Versions"), el("div", {
        class: "body muted"
    }, "Historical releases retain snapshots and verification evidence. Open live page always opens the current canonical version."), ...releaseRows));
    if (published) {
        const technical = el("details", {
            class: "card live-details"
        }, el("summary", {}, "Live checks and technical details"));
        if (d) {
            for (const group of d.groups) {
                technical.append(el("section", {
                    class: "live-detail-section"
                }, el("h3", {}, group.label, ` · ${group.rows.filter(row => row.verdict === "ok").length}/${group.rows.length} ok`), ...group.rows.map(diagnosisRow)));
            }
        } else {
            technical.append(errorCard(diagnosis, "Connectivity diagnosis unavailable"));
        }
        technical.append(el("section", {
            class: "live-detail-section"
        }, el("h3", {}, "Go-live checklist"), ...(c.checklist || []).map(row => el("div", {
            class: `row v-${row.ok ? "ok" : row.blocker ? "broken" : "warn"}`
        }, el("span", {
            class: "dot"
        }), el("div", {
            class: "grow"
        }, el("div", {
            class: "label"
        }, row.label, row.blocker ? el("span", {
            class: "pill blocker"
        }, "blocks release") : null), el("div", {
            class: "headline"
        }, row.detail))))));
        wrap.append(technical);
    }
    view.replaceChildren(wrap);
}

function diagnosisRow(r) {
    return el("div", {
        class: `row v-${r.verdict}`
    }, el("span", {
        class: "dot"
    }), el("div", {
        class: "grow"
    }, el("div", {
        class: "label"
    }, r.label, " ", r.blocker && r.verdict !== "ok" ? el("span", {
        class: "pill blocker"
    }, "blocker") : ""), el("div", {
        class: "headline"
    }, r.headline), r.evidence && r.evidence.length ? el("details", {
        class: "evidence"
    }, el("summary", {}, "Evidence"), el("table", {}, ...r.evidence.map(e => el("tr", {}, el("td", {}, e.label), el("td", {}, e.value ?? "-"))))) : null, r.remedy ? el("div", {
        class: "remedy"
    }, r.remedy) : null));
}

function openCoauthorChat() {
    return new SimulatedChatSocket;
}

async function coauthor(path, opts = {}) {
    const method = opts.method || "GET";
    if (method !== "GET") return {
        ok: false,
        error: "Co-author mutations and release transports are disabled in this sandbox."
    };
    try {
        const res = await fetch(`/api/coauthor${path}`, {
            method: method,
            headers: {
                "Content-Type": "application/json"
            },
            body: opts.body ? JSON.stringify(opts.body) : undefined
        });
        const text = await res.text();
        try {
            return JSON.parse(text);
        } catch {
            return {
                ok: false,
                error: text.slice(0, 300)
            };
        }
    } catch (err) {
        return {
            ok: false,
            error: err?.message || "Network request failed"
        };
    }
}

function describeWork(git) {
    if (!git) return {
        label: "Status unavailable",
        kind: "bad",
        text: "The working copy did not answer.",
        ready: false
    };
    const bits = [];
    const candidate = git.candidate || null;
    if (candidate?.configChanged) bits.push("Test config changed");
    if (candidate?.pagesChanged && git.dirtyFiles === 0) bits.push("Test pages changed");
    if (git.dirtyFiles > 0) bits.push(`${git.dirtyFiles} changed file${git.dirtyFiles === 1 ? "" : "s"}`);
    if (git.unpushedCommits === null) bits.push("an unknown number of unpublished commits"); else if (git.unpushedCommits > 0) bits.push(`${git.unpushedCommits} unpublished commit${git.unpushedCommits === 1 ? "" : "s"}`);
    if (candidate?.error) return {
        label: "Candidate unavailable",
        kind: "bad",
        text: `Candidate unavailable: ${candidate.error}`,
        ready: false
    };
    if (candidate && !candidate.transitionConfigured) {
        return {
            label: "Commit blocked",
            kind: "bad",
            text: "Candidate cannot be committed until the audited Production config transition is configured.",
            ready: false
        };
    }
    if (candidate?.blockedBy?.length) {
        return {
            label: "Outside changes block release",
            kind: "bad",
            text: `Candidate is blocked by changes outside this funnel: ${candidate.blockedBy.join(", ")}.`,
            ready: false
        };
    }
    const destinationErrors = candidate?.destination?.errors?.map(error => error?.reason || error?.message).filter(Boolean);
    if (candidate?.destination?.ok === false || destinationErrors?.length) {
        return {
            label: "Commit blocked",
            kind: "bad",
            text: destinationErrors?.length ? `Production destination refused this candidate: ${destinationErrors.join("; ")}` : "Production destination refused this candidate. Review its release requirements.",
            ready: false
        };
    }
    const publicValues = candidate?.publicValues || candidate?.publicValueReadiness;
    const publicValueErrors = publicValues?.errors?.map(error => error?.reason || error?.message).filter(Boolean);
    if (publicValues && (publicValues.ok === false || publicValues.ready === false || publicValueErrors?.length)) {
        return {
            label: "Commit blocked",
            kind: "bad",
            text: publicValueErrors?.length ? `Public page values are not ready: ${publicValueErrors.join("; ")}` : `Public page values are not ready: ${publicValues.reason || "review the release requirements."}`,
            ready: false
        };
    }
    if (bits.length && candidate && !candidate.browserVerification?.passed) {
        return {
            label: "Checks required",
            kind: "warn",
            text: `Not ready to Commit: ${candidate.browserVerification?.reason || "run browser verification on the exact current candidate."}`,
            ready: false
        };
    }
    if (candidate?.ready === false) {
        return {
            label: "Commit blocked",
            kind: "bad",
            text: `Candidate readiness checks did not pass: ${candidate.reason || "review the release details for the blocking requirement."}`,
            ready: false
        };
    }
    if (!bits.length) return {
        label: "Working copy matches main",
        kind: "neutral",
        text: "Nothing to publish. Main matches this working copy; the deployed artifact is still a separate verification.",
        ready: false
    };
    const ready = git.unpushedCommits === null || git.unpushedCommits > 0 || candidate?.ready === true || !candidate && git.dirtyFiles > 0;
    return {
        label: ready ? "Ready to commit" : "Review required",
        kind: ready ? "ok" : "warn",
        text: `Not published yet: ${bits.join(" and ")}.`,
        ready: ready
    };
}

function productionSummary(config) {
    const issues = (config?.checklist || []).filter(item => !item.ok).map(item => ({
        label: item.label || item.key || "Release requirement",
        detail: item.detail || "This requirement is not complete.",
        blocker: Boolean(item.blocker)
    }));
    return {
        status: config?.status || "unknown",
        funnelType: config?.funnelType || "not declared",
        compositionVersion: config?.editable?.composition?.version || config?.compositionVersion || null,
        canonicalUrl: authoritativeProductionUrl(config),
        issues: issues
    };
}

const PROMOTION_DIGEST = /^[a-f0-9]{64}$/;

const PROMOTION_SECRET_FIELD = /(token|secret|password|credential|api[-_]?key)/i;

function promotionReviewBinding(status) {
    const candidate = status?.candidate;
    const plan = candidate?.changePlan;
    const validChange = change => change && typeof change.path === "string" && [ "added", "removed", "changed" ].includes(change.kind) && (change.redacted === undefined || typeof change.redacted === "boolean");
    const validEffect = effect => effect && typeof effect.key === "string" && typeof effect.locationId === "string" && typeof effect.id === "string" && typeof effect.writeRequired === "boolean" && effect.when === "after_verified_deployment";
    const validFile = file => file && typeof file.path === "string" && PROMOTION_DIGEST.test(file.sha256 || "");
    const validGrouped = grouped => grouped && [ "added", "changed", "removed" ].every(kind => Array.isArray(grouped[kind]) && grouped[kind].every(validChange));
    if (!candidate || !plan || plan.schemaVersion !== 1 || !PROMOTION_DIGEST.test(plan.candidateId || "") || plan.candidateId !== candidate.candidateId || !PROMOTION_DIGEST.test(plan.sourceConfigHash || "") || !PROMOTION_DIGEST.test(plan.liveBeforeHash || "") || !PROMOTION_DIGEST.test(plan.prospectiveHash || "") || !PROMOTION_DIGEST.test(plan.planHash || "") || !PROMOTION_DIGEST.test(plan.backendPlanHash || "") || !Number.isFinite(Date.parse(plan.generatedAt)) || plan.mongo?.collection !== "demo_funnels" || typeof plan.mongo?.slug !== "string" || !Array.isArray(plan.mongo?.changes) || !plan.mongo.changes.every(validChange) || !Array.isArray(plan.mongo?.changedPaths) || !plan.mongo.changedPaths.every(path => typeof path === "string") || !validGrouped(plan.mongo?.grouped) || plan.externalEffects?.ready !== true || typeof plan.externalEffects?.bindingHash !== "string" || !Array.isArray(plan.externalEffects?.publicPageValues) || !plan.externalEffects.publicPageValues.every(validEffect) || plan.codePublication?.target !== "main" || !PROMOTION_DIGEST.test(plan.codePublication?.pageTreeHash || "") || !Array.isArray(plan.codePublication?.files) || !plan.codePublication.files.every(validFile)) return null;
    const review = {
        candidateId: plan.candidateId,
        liveBeforeHash: plan.liveBeforeHash,
        planHash: plan.planHash
    };
    return {
        plan: plan,
        review: review,
        fingerprint: `${review.candidateId}:${review.liveBeforeHash}:${review.planHash}`
    };
}

function promotionChangeGroup(path) {
    const value = String(path || "").toLowerCase();
    if (/(^|\.)(name|description|slug|funneltype|matchurls?)(\.|$)/.test(value)) return "Funnel identity";
    if (/(^|\.)(webinar|calendar|schedule)(\.|$)/.test(value)) return "Webinar and booking";
    if (/(^|\.)(content|questions?|videos?|composition)(\.|$)/.test(value)) return "Page and form";
    if (/(^|\.)(journeys?|sequences?|delivery|crm|leadtag)(\.|$)/.test(value)) return "Delivery and journeys";
    return "Other config";
}

function promotionFieldLabel(path) {
    const value = String(path || "");
    const exact = {
        "webinar.enabled": "Webinar registration",
        "calendar.calendarId": "Calendar",
        calendarId: "Calendar",
        leadTag: "Lead tag",
        matchUrls: "Canonical match URLs",
        "delivery.enabled": "Optional delivery"
    };
    if (exact[value]) return exact[value];
    if (value.endsWith(".webinarId") || value === "webinarId") return "Webinar ID";
    const last = value.split(".").filter(Boolean).at(-1) || "Config value";
    return last.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replaceAll("_", " ").replace(/^./, letter => letter.toUpperCase());
}

function promotionPlanValue(path, value) {
    const scrub = (current, currentPath) => {
        if (PROMOTION_SECRET_FIELD.test(currentPath)) return "[redacted]";
        if (Array.isArray(current)) return current.map((item, index) => scrub(item, `${currentPath}.${index}`));
        if (current && typeof current === "object") return Object.fromEntries(Object.entries(current).map(([key, item]) => [ key, scrub(item, `${currentPath}.${key}`) ]));
        return current;
    };
    if (value === undefined) return "Not set";
    const safe = scrub(value, String(path || ""));
    if (safe === null) return "None";
    if (typeof safe === "string") return safe || "Empty";
    if (typeof safe === "number" || typeof safe === "boolean") return String(safe);
    try {
        return JSON.stringify(safe, null, 2);
    } catch {
        return "Value unavailable";
    }
}

function promotionReviewDialog(binding, {funnelName: funnelName, onCommit: onCommit, onClose: onClose} = {}) {
    const {plan: plan, review: review, fingerprint: fingerprint} = binding;
    const titleId = `promotion-review-${Math.random().toString(16).slice(2)}`;
    const dialog = el("dialog", {
        class: "promotion-review-dialog",
        "aria-labelledby": titleId
    });
    const headerClose = el("button", {
        class: "act",
        type: "button",
        onclick: () => dialog.close()
    }, "Close");
    const footerClose = el("button", {
        class: "act",
        type: "button",
        onclick: () => dialog.close()
    }, "Close");
    const title = el("h2", {
        id: titleId
    }, `Review changes for ${funnelName || plan.mongo.slug}`);
    const error = el("div", {
        class: "promotion-review-error err",
        hidden: true,
        role: "alert"
    });
    const setError = message => {
        error.hidden = !message;
        error.textContent = message || "";
    };
    const shortHash = value => String(value || "").slice(0, 12) || "Unavailable";
    const valuePair = (path, before, after) => el("div", {
        class: "promotion-value-pair"
    }, el("div", {
        class: "promotion-value"
    }, el("span", {
        class: "label"
    }, "Current Live"), el("pre", {}, promotionPlanValue(path, before))), el("span", {
        class: "promotion-arrow",
        "aria-hidden": "true"
    }, "→"), el("div", {
        class: "promotion-value"
    }, el("span", {
        class: "label"
    }, "Proposed Test draft"), el("pre", {}, promotionPlanValue(path, after))));
    const groupOrder = [ "Funnel identity", "Webinar and booking", "Page and form", "Delivery and journeys", "Other config" ];
    const grouped = new Map(groupOrder.map(group => [ group, [] ]));
    for (const change of plan.mongo.changes) grouped.get(promotionChangeGroup(change.path)).push(change);
    const mongoGroups = groupOrder.flatMap(group => {
        const changes = grouped.get(group);
        if (!changes.length) return [];
        return [ el("section", {
            class: "promotion-change-group"
        }, el("h4", {}, group), ...changes.map(change => el("div", {
            class: "promotion-change"
        }, el("div", {
            class: "promotion-change-title"
        }, el("strong", {}, promotionFieldLabel(change.path)), ...change.redacted ? [ el("span", {
            class: "pill blocker"
        }, "redacted") ] : [], el("span", {
            class: `pill ${change.kind === "removed" ? "blocker" : change.kind === "added" ? "live" : "draft"}`
        }, change.kind)), valuePair(change.path, change.before, change.after)))) ];
    });
    const effects = plan.externalEffects.publicPageValues;
    const externalRows = effects.length ? effects.map(effect => el("div", {
        class: "promotion-effect"
    }, el("div", {
        class: "promotion-change-title"
    }, el("strong", {}, effect.key || "Public page value"), el("span", {
        class: `pill ${effect.writeRequired ? "draft" : "live"}`
    }, effect.writeRequired ? "Write required" : "No write")), el("div", {
        class: "muted"
    }, `External fixture value ${effect.id} at location ${effect.locationId}. Writes remain disabled in this sandbox.`), valuePair(`externalEffects.publicPageValues.${effect.key}`, effect.before, effect.after))) : [ el("p", {
        class: "muted"
    }, "No external fixture writes are planned.") ];
    const code = plan.codePublication;
    const codeFiles = code.files.length ? code.files.map(file => el("div", {
        class: "promotion-file"
    }, el("span", {
        class: "mono"
    }, file.path), el("span", {
        class: "mono muted"
    }, file.sha256))) : [ el("p", {
        class: "muted"
    }, "No funnel page files are planned for publication.") ];
    const commit = el("button", {
        class: "act go",
        type: "button"
    }, "Commit reviewed changes");
    let invalidated = false;
    let committing = false;
    dialog.addEventListener("cancel", event => {
        if (committing) event.preventDefault();
    });
    commit.addEventListener("click", async () => {
        if (invalidated) return;
        committing = true;
        commit.disabled = true;
        headerClose.disabled = true;
        footerClose.disabled = true;
        commit.textContent = "Committing…";
        setError("");
        let result;
        try {
            result = await onCommit(review, fingerprint);
        } catch (err) {
            result = {
                ok: false,
                error: err?.message || "Commit was refused."
            };
        }
        if (result?.ok) {
            dialog.close();
            return;
        }
        setError(result?.error || "Commit was refused. Refresh the plan and review it again.");
        committing = false;
        commit.textContent = "Commit reviewed changes";
        commit.disabled = invalidated;
        headerClose.disabled = false;
        footerClose.disabled = false;
    });
    dialog.append(el("div", {
        class: "promotion-review-head"
    }, title, el("span", {
        class: "spacer"
    }), headerClose), el("div", {
        class: "promotion-review-scroll"
    }, el("div", {
        class: "promotion-review-intro"
    }, el("p", {}, "Current Live values are on the left. Proposed Test draft values are on the right. This exact plan came from protected release status."), el("div", {
        class: "stack"
    }, el("span", {
        class: "pill"
    }, `Candidate ${shortHash(plan.candidateId)}`), el("span", {
        class: "pill"
    }, `Plan ${shortHash(plan.planHash)}`), el("span", {
        class: "muted"
    }, `Generated ${when(plan.generatedAt)}`))), error, el("section", {
        class: "promotion-section"
    }, el("h3", {}, "Mongo config"), el("p", {
        class: "muted"
    }, `${plan.mongo.collection} record ${plan.mongo.slug}. Every planned database config change is shown below.`), ...mongoGroups.length ? mongoGroups : [ el("p", {
        class: "muted"
    }, "No Mongo config changes are planned.") ]), el("section", {
        class: "promotion-section"
    }, el("h3", {}, "External fixture writes"), el("p", {
        class: "muted"
    }, "These values are external side effects, separate from the Mongo config transition."), ...externalRows), el("section", {
        class: "promotion-section"
    }, el("h3", {}, "Deployment publication"), el("p", {
        class: "muted"
    }, `Publishes the candidate page tree to ${code.target}. Page tree ${shortHash(code.pageTreeHash)}.`), ...codeFiles), el("details", {
        class: "promotion-technical"
    }, el("summary", {}, "Technical binding and changed paths"), el("dl", {
        class: "promotion-hashes"
    }, el("dt", {}, "Candidate"), el("dd", {
        class: "mono"
    }, plan.candidateId), el("dt", {}, "Source config"), el("dd", {
        class: "mono"
    }, plan.sourceConfigHash), el("dt", {}, "Live before"), el("dd", {
        class: "mono"
    }, plan.liveBeforeHash), el("dt", {}, "Proposed config"), el("dd", {
        class: "mono"
    }, plan.prospectiveHash), el("dt", {}, "Plan"), el("dd", {
        class: "mono"
    }, plan.planHash), el("dt", {}, "Backend plan"), el("dd", {
        class: "mono"
    }, plan.backendPlanHash), el("dt", {}, "External binding"), el("dd", {
        class: "mono"
    }, plan.externalEffects.bindingHash)), el("div", {
        class: "promotion-paths"
    }, el("span", {
        class: "label"
    }, "Changed paths"), ...plan.mongo.changedPaths.length ? plan.mongo.changedPaths.map(path => el("code", {}, path)) : [ el("span", {
        class: "muted"
    }, "No Mongo config paths changed.") ]))), el("div", {
        class: "promotion-review-actions"
    }, el("span", {
        class: "muted"
    }, "Any candidate or Live config drift invalidates this review."), el("span", {
        class: "spacer"
    }), footerClose, commit));
    document.body.append(dialog);
    dialog.addEventListener("close", () => {
        dialog.remove();
        if (typeof onClose === "function") onClose();
    });
    if (dialog.showModal) dialog.showModal(); else dialog.setAttribute("open", "");
    commit.focus();
    return {
        dialog: dialog,
        fingerprint: fingerprint,
        invalidate(message = "The candidate or Live config changed. Close this review and open Commit again.") {
            invalidated = true;
            commit.disabled = true;
            setError(message);
        }
    };
}

const SPLIT_THUMB_WIDTH = 264;

const splitArmUrl = (canonicalUrl, arm) => `${canonicalUrl}${canonicalUrl.includes("?") ? "&" : "?"}split_force=${arm}`;

function splitArmPanel({flag: flag, name: name, weightPill: weightPill, url: url, editHref: editHref, canEdit: canEdit, visits: visits}) {
    return el("div", {
        class: "split-arm"
    }, el("span", {
        class: "split-flag"
    }, `⚑ ${flag}`, weightPill), name ? el("span", {
        class: "muted"
    }, name) : null, livePreviewThumb(url, `${flag} arm`, SPLIT_THUMB_WIDTH), el("div", {
        class: "split-actions"
    }, canEdit ? el("a", {
        class: "act go",
        href: editHref
    }, "Edit") : el("span", {
        class: "muted",
        title: "No Test draft is available to edit."
    }, "No draft"), el("a", {
        class: "act",
        href: url,
        target: "_blank",
        rel: "noopener",
        title: `Open the ${flag.toLowerCase()} page in its own tab.`
    }, "Open ↗")), visits != null ? el("span", {
        class: "mono muted"
    }, `${visits} randomised visits`) : null);
}

function splitTestCard(slug, canonicalUrl, splitResponse, canEdit) {
    const card = el("div", {
        class: "card"
    });
    const running = splitResponse.success && splitResponse.splitTest && splitResponse.splitTest.status === "running";
    card.append(el("h2", {}, "Split test", el("span", {
        class: "pill env"
    }, "Synthetic"), running ? el("span", {
        class: "pill live"
    }, "Running") : null));
    if (!splitResponse.success) {
        card.append(el("div", {
            class: "body err"
        }, `Split-test state is unavailable. ${splitResponse.error || "The Production API did not answer."}`));
        return card;
    }
    const notice = el("div", {
        class: "body muted split-notice",
        role: "status",
        "aria-live": "polite",
        hidden: true
    });
    const say = (text, bad = false) => {
        notice.hidden = !text;
        notice.className = `body split-notice ${bad ? "err" : "muted"}`;
        notice.textContent = text || "";
    };
    if (!running) {
        card.append(el("div", {
            class: "split-grid"
        }, splitArmPanel({
            flag: "Control",
            weightPill: el("span", {
                class: "pill env"
            }, "100%"),
            url: splitArmUrl(canonicalUrl, "control"),
            editHref: `#/funnels/${slug}/build`,
            canEdit: canEdit
        }), el("div", {
            class: "split-middle muted"
        }, el("strong", {}, "Start split test"), el("span", {}, "Send part of the randomised live traffic to an alternative page.")), el("div", {
            class: "split-create"
        }, el("button", {
            class: "act go",
            type: "button",
            onclick: async event => {
                event.target.disabled = true;
                const created = await api(`/funnels/${slug}/split-test`, {
                    mode: "production",
                    method: "POST",
                    body: {
                        name: "Variation B"
                    },
                    syncChrome: false
                });
                if (created.success) return route();
                event.target.disabled = false;
                say(created.error || "The variation could not be created.", true);
            }
        }, "＋ Create variation"))), notice);
        return card;
    }
    const split = splitResponse.splitTest;
    let controlWeight = split.controlWeight;
    const readout = el("span", {
        class: "mono"
    });
    const controlWeightPill = el("span", {
        class: "pill env"
    });
    const variationWeightPill = el("span", {
        class: "pill env"
    });
    const paintReadout = () => {
        readout.textContent = `Control ${controlWeight}% · ${split.variation.name} ${100 - controlWeight}%`;
        controlWeightPill.textContent = `${controlWeight}%`;
        variationWeightPill.textContent = `${100 - controlWeight}%`;
    };
    paintReadout();
    const slider = el("input", {
        type: "range",
        min: "0",
        max: "100",
        step: "5",
        value: String(controlWeight),
        "aria-label": "Percent of randomised traffic sent to the control page"
    });
    slider.addEventListener("input", () => {
        controlWeight = Number(slider.value);
        paintReadout();
    });
    slider.addEventListener("change", async () => {
        const saved = await api(`/funnels/${slug}/split-test`, {
            mode: "production",
            method: "PUT",
            body: {
                controlWeight: Number(slider.value)
            },
            syncChrome: false
        });
        if (saved.success) {
            controlWeight = saved.splitTest.controlWeight;
            say(`Saved. New randomised visitors now split ${controlWeight}/${100 - controlWeight}.`);
        } else {
            slider.value = String(split.controlWeight);
            controlWeight = split.controlWeight;
            say(saved.error || "The traffic split could not be saved.", true);
        }
        paintReadout();
    });
    card.append(el("div", {
        class: "split-grid"
    }, splitArmPanel({
        flag: "Control",
        weightPill: controlWeightPill,
        url: splitArmUrl(canonicalUrl, "control"),
        editHref: `#/funnels/${slug}/build`,
        canEdit: canEdit,
        visits: split.observed?.control
    }), el("div", {
        class: "split-middle"
    }, el("span", {
        class: "split-flag"
    }, "Traffic split"), slider, readout, el("span", {
        class: "muted"
    }, "Each new visitor is randomised to hold this split. Returning visitors keep the page they first saw."), el("button", {
        class: "act split-end",
        type: "button",
        onclick: async event => {
            if (!confirm("End this split test? All live traffic returns to the control page.")) return;
            event.target.disabled = true;
            const ended = await api(`/funnels/${slug}/split-test`, {
                mode: "production",
                method: "DELETE",
                syncChrome: false
            });
            if (ended.success) return route();
            event.target.disabled = false;
            say(ended.error || "The split test could not be ended.", true);
        }
    }, "End split test")), splitArmPanel({
        flag: "Variation",
        name: split.variation.name,
        weightPill: variationWeightPill,
        url: splitArmUrl(canonicalUrl, "variation"),
        editHref: `#/funnels/${slug}/build/variation`,
        canEdit: canEdit,
        visits: split.observed?.variation
    })), notice);
    return card;
}

function readOnlyConfigCard(config) {
    const summary = productionSummary(config);
    const card = el("div", {
        class: "card"
    }, el("h2", {}, "Live configuration", el("span", {
        class: "pill env"
    }, "Read only")), el("div", {
        class: "body stack"
    }, el("span", {
        class: `pill ${summary.status === "live" ? "live" : "draft"}`
    }, `Optional delivery: ${summary.status}`), el("span", {
        class: "muted"
    }, `Funnel type: ${summary.funnelType}`), summary.compositionVersion ? el("span", {
        class: "muted"
    }, `Page composition v${summary.compositionVersion}`) : null, el("span", {
        class: "spacer"
    }), summary.canonicalUrl ? el("a", {
        class: "act",
        href: summary.canonicalUrl,
        target: "_blank",
        rel: "noopener"
    }, "Open live funnel") : el("span", {
        class: "err"
    }, "Canonical live link unavailable.")), ...summary.issues.length ? summary.issues.map(issue => el("div", {
        class: `row v-${issue.blocker ? "broken" : "warn"}`
    }, el("span", {
        class: "dot"
    }), el("div", {
        class: "grow"
    }, el("div", {
        class: "label"
    }, issue.label, issue.blocker ? el("span", {
        class: "pill blocker"
    }, "blocks release") : null), el("div", {
        class: "headline"
    }, issue.detail)))) : [ el("div", {
        class: "body muted"
    }, "No configuration issues are reported.") ]);
    return card;
}

function describeRelease(release) {
    const version = release?.version == null ? "unknown version" : `v${release.version}`;
    const id = typeof release?.id === "string" && release.id ? release.id.slice(0, 12) : "unknown SHA";
    const status = typeof release?.status === "string" && release.status ? release.status : "status_unavailable";
    const prefix = `Release ${version} (${id}) - ${status}. Public page values: ${publicPageValuesSummary(release)}.`;
    if (status === "deployed_verified") {
        return {
            status: status,
            text: `${prefix} The synthetic release record is marked verified.`
        };
    }
    if (status === "published_public_values_unverified") {
        return {
            status: status,
            text: `${prefix} The synthetic release record has incomplete fixture checks.`
        };
    }
    if (status === "published_deployment_unverified") {
        return {
            status: status,
            text: `${prefix} Main contains the release, but deployed revision/health proof has not passed.`
        };
    }
    if (status === "push_unverified") {
        return {
            status: status,
            text: `${prefix} The push returned, but origin/main containment could not be verified; publication and deployment remain unproved.`
        };
    }
    return {
        status: status,
        text: `${prefix} Publication and deployment remain unproved.`
    };
}

function describeSync(sync, now = Date.now()) {
    if (!sync || !sync.result) return null;
    if (sync.result === "never run") return null;
    const ago = sync.at ? Math.max(0, Math.round((now - sync.at) / 6e4)) : null;
    const when = ago === null ? "" : ago < 1 ? " just now" : ` ${ago}m ago`;
    if (sync.result === "level") return null;
    if (sync.result === "updated") return `Brought${when}: ${sync.detail}.`;
    if (sync.result === "refused") return `Not levelled${when}: ${sync.detail}`;
    return `Levelling skipped${when}: ${sync.detail}.`;
}

const CHAT_LATEST_THRESHOLD = 72;

function chatNearLatest(metrics, threshold = CHAT_LATEST_THRESHOLD) {
    if (!metrics) return true;
    const remaining = Number(metrics.scrollHeight || 0) - Number(metrics.clientHeight || 0) - Number(metrics.scrollTop || 0);
    return remaining <= threshold;
}

const historyKind = message => ({
    user: "to",
    assistant: "from",
    tool: "tool",
    error: "bad",
    system: "note"
}[message?.role] || "note");

function conversationRenderModel(messages) {
    if (!Array.isArray(messages)) return [];
    return messages.map(message => ({
        kind: historyKind(message),
        text: String(message?.text || message?.name || "")
    }));
}

function coauthorMissingCard() {
    return el("div", {
        class: "card"
    }, el("h2", {}, "The co-author is not connected to this console"), el("div", {
        class: "body muted"
    }, "Simulated chat is unavailable. Refresh the local sandbox and try again."));
}

async function renderBuild(view, slug, request, arm = "control") {
    const cfg = await api(`/funnels/${slug}/config`, {
        mode: "test",
        syncChrome: false
    });
    if (!routeResponseIsCurrent(request)) return;
    if (!cfg.success) return view.replaceChildren(errorCard(cfg));
    const c = cfg.config;
    document.body.classList.add("builder-route");
    view.classList.add("builder-view");
    if (!state.coauthorConfigured) {
        return view.replaceChildren(el("div", {
            class: "card"
        }, el("h2", {}, el("a", {
            href: `#/funnels/${slug}`
        }, "← Back"), c.name || slug)), coauthorMissingCard());
    }
    const previewUrl = previewPath(slug, "test", "");
    if (!previewUrl) {
        return view.replaceChildren(el("div", {
            class: "card"
        }, el("h2", {}, el("a", {
            href: `#/funnels/${slug}`
        }, "← Back"), c.name || slug)), el("div", {
            class: "card"
        }, el("h2", {}, "The Test preview address is invalid"), el("div", {
            class: "body err"
        }, "Test preview uses this builder host with an enforced read-only sandbox. Check the console origin configuration.")));
    }
    const frame = el("iframe", {
        class: "preview",
        title: "Read-only Test preview",
        scrolling: "yes",
        ...previewFrameAttributes(previewUrl)
    });
    const tabs = el("span", {
        class: "stack"
    });
    const previewPane = el("div", {
        class: "card pane preview-pane"
    });
    const studio = el("div", {
        class: "studio"
    });
    let activePage = "";
    let activeDevice = "desktop";
    let activePane = "chat";
    const dimensions = el("span", {
        class: "viewport-dimensions mono"
    });
    const previewStage = el("div", {
        class: "preview-stage"
    });
    const previewScaler = el("div", {
        class: "preview-scaler"
    });
    const previewCanvas = el("div", {
        class: "preview-canvas"
    });
    previewScaler.append(frame);
    previewStage.append(previewScaler);
    previewCanvas.append(previewStage);
    const resizePreview = () => {
        if (!frame) return;
        const geometry = previewGeometry(activeDevice, previewCanvas.clientWidth, previewCanvas.clientHeight);
        frame.style.width = `${geometry.width}px`;
        frame.style.height = `${geometry.height}px`;
        previewScaler.style.width = `${geometry.width}px`;
        previewScaler.style.height = `${geometry.height}px`;
        previewScaler.style.transform = `scale(${geometry.scale})`;
        previewStage.style.width = `${geometry.renderedWidth}px`;
        previewStage.style.height = `${geometry.renderedHeight}px`;
        dimensions.textContent = `${geometry.width} × ${geometry.height}`;
    };
    const deviceButtons = Object.values(PREVIEW_DEVICES).map(device => el("button", {
        type: "button",
        class: `tab device${activeDevice === device.key ? " on" : ""}`,
        "aria-pressed": String(activeDevice === device.key),
        title: `${device.label} CSS viewport: ${device.width} × ${device.height}`,
        onclick: () => {
            activeDevice = device.key;
            for (const button of deviceButtons) {
                const selected = button.dataset.device === activeDevice;
                button.classList.toggle("on", selected);
                button.setAttribute("aria-pressed", String(selected));
            }
            resizePreview();
        },
        "data-device": device.key
    }, device.label));
    const paneButtons = [ "chat", "preview" ].map(pane => el("button", {
        type: "button",
        class: `tab${activePane === pane ? " on" : ""}`,
        "aria-pressed": String(activePane === pane),
        "data-pane": pane,
        onclick: () => {
            activePane = pane;
            studio.dataset.activePane = pane;
            for (const button of paneButtons) {
                const selected = button.dataset.pane === pane;
                button.classList.toggle("on", selected);
                button.setAttribute("aria-pressed", String(selected));
            }
            requestAnimationFrame(resizePreview);
        }
    }, pane === "chat" ? "Chat" : "Preview"));
    studio.dataset.activePane = activePane;
    const reload = () => {
        if (frame) frame.src = `${previewPath(slug, "test", activePage)}?t=${Date.now()}`;
    };
    const openLocal = el("a", {
        class: "act",
        href: builderPageUrl(c, "test", slug, ""),
        target: "_blank",
        rel: "noopener",
        title: "View the read-only Test preview in its own tab. This does not run checks."
    }, "Open preview");
    const fullToggle = el("button", {
        type: "button",
        class: "tab full-toggle",
        "aria-pressed": "false"
    }, "Full screen");
    const syncFull = () => {
        const on = document.fullscreenElement === studio;
        setStudioFullscreen(studio, document.body, fullToggle, on);
        requestAnimationFrame(resizePreview);
    };
    fullToggle.disabled = typeof studio.requestFullscreen !== "function";
    fullToggle.addEventListener("click", async () => {
        try {
            await toggleNativeFullscreen(studio, document);
        } catch (err) {
            fullToggle.title = err.message;
        }
    });
    document.addEventListener("fullscreenchange", syncFull);
    let stopPreviewResize = () => {};
    let activePromotionReview = null;
    state.leaveScreen = () => {
        document.removeEventListener("fullscreenchange", syncFull);
        stopPreviewResize();
        if (document.fullscreenElement === studio) document.exitFullscreen().catch(() => {});
        document.body.classList.remove("builder-full-open");
        document.body.classList.remove("builder-route");
        view.classList.remove("builder-view");
        if (activePromotionReview?.dialog?.open) activePromotionReview.dialog.close();
    };
    syncFull();
    const drawTabs = pages => {
        tabs.replaceChildren(...(pages.length ? pages : [ {
            label: "no pages yet",
            path: ""
        } ]).map(pg => el("button", {
            class: `tab${activePage === pg.path ? " on" : ""}`,
            type: "button",
            onclick: () => {
                activePage = pg.path;
                const nextUrl = builderPageUrl(c, "test", slug, activePage);
                if (openLocal.tagName === "A" && nextUrl) openLocal.href = nextUrl;
                drawTabs(pages);
                reload();
            }
        }, pg.label)));
    };
    const refreshPages = async () => {
        const r = await coauthor(`/pages?funnel=${encodeURIComponent(slug)}`);
        drawTabs(r.ok ? r.pages || [] : []);
    };
    const workLine = el("span", {
        class: "pill lifecycle work-state draft"
    }, "Reading status…");
    const workTechnical = el("p", {
        class: "muted"
    }, "Reading working-copy status…");
    const syncTechnical = el("p", {
        class: "muted"
    });
    const dot = el("span", {
        class: "conn",
        title: "Connecting to the co-author…"
    });
    const verifyBrowser = el("button", {
        type: "button",
        class: "act",
        disabled: true
    }, "Checks disabled");
    const promote = el("button", {
        type: "button",
        class: "act go",
        disabled: true
    }, "Commit disabled");
    const actionLine = el("div", {
        class: "toolbar-notice",
        hidden: true,
        role: "status",
        "aria-live": "polite"
    });
    const setActionNotice = (text, kind = "muted") => {
        actionLine.hidden = !text;
        actionLine.className = `toolbar-notice ${kind}`;
        actionLine.setAttribute("role", kind === "err" ? "alert" : "status");
        actionLine.textContent = text || "";
    };
    const REVIEW_PLAN_MISSING = "Commit review is unavailable. Refresh status after the server prepares the exact Live-to-Test change plan.";
    const invalidatePromotionReview = message => {
        if (!activePromotionReview) return;
        activePromotionReview.invalidate(message);
        promote.disabled = true;
    };
    const releasesBody = el("div", {
        class: "release-list"
    }, el("div", {
        class: "body muted"
    }, "Loading release history…"));
    const releaseState = el("span", {
        class: "pill lifecycle release-state"
    }, "Release history…");
    let busy = false;
    let latestGit = null;
    const refreshGit = async () => {
        const git = await coauthor(`/status?funnel=${encodeURIComponent(slug)}&env=test`);
        latestGit = git.ok ? git : null;
        const work = describeWork(git.ok ? git : null);
        const reviewBinding = promotionReviewBinding(latestGit);
        if (activePromotionReview && activePromotionReview.fingerprint !== reviewBinding?.fingerprint) {
            invalidatePromotionReview("The candidate or Live config changed. Close this review and open Commit again.");
        }
        workLine.textContent = work.label;
        workLine.className = `pill lifecycle work-state ${work.kind === "bad" ? "blocker" : work.kind === "ok" ? "live" : work.kind === "warn" ? "draft" : ""}`;
        workTechnical.textContent = git.ok ? work.text : git.error || work.text;
        const sync = git.ok ? describeSync(git.sync) : null;
        syncTechnical.textContent = sync || "Working copy is level with main.";
        syncTechnical.className = git.ok && git.sync && git.sync.result === "refused" ? "err" : "muted";
        if (!git.ok) setActionNotice(git.error || work.text, "err"); else if (git.sync?.result === "refused") setActionNotice(sync || "Working copy and main have diverged.", "err"); else if (work.kind === "bad") setActionNotice(work.text, "err"); else if (work.ready && !reviewBinding) setActionNotice(REVIEW_PLAN_MISSING, "err"); else if (actionLine.textContent === REVIEW_PLAN_MISSING) setActionNotice("");
        if (work.ready && !reviewBinding) {
            workLine.textContent = "Commit review unavailable";
            workLine.className = "pill lifecycle work-state blocker";
            workTechnical.textContent = REVIEW_PLAN_MISSING;
        }
        promote.disabled = busy || !work.ready || !reviewBinding || Boolean(activePromotionReview);
        verifyBrowser.disabled = busy || !git.ok || !git.candidate?.candidateId || !(git.candidate.configChanged || git.candidate.pagesChanged);
        verifyBrowser.title = verifyBrowser.disabled ? "A current Test page/config candidate is required." : "Run automated page and resource checks for the exact candidate at desktop and mobile sizes.";
        promote.title = work.ready && reviewBinding ? "Review the exact Live-to-Test plan before publishing changes live." : work.ready ? REVIEW_PLAN_MISSING : "Nothing to publish. Ask the co-author to change something and this re-arms.";
        if (SANDBOX.enabled) {
            verifyBrowser.disabled = true;
            promote.disabled = true;
            verifyBrowser.title = "Disabled: this local sandbox does not create release verification evidence.";
            promote.title = "Disabled: this local sandbox cannot commit, deploy, or call providers.";
        }
    };
    const refreshReleases = async () => {
        const history = await coauthor(`/releases?funnel=${encodeURIComponent(slug)}`);
        if (!history.ok) {
            releaseState.className = "pill lifecycle release-state blocker";
            releaseState.textContent = "Release history unavailable";
            releasesBody.replaceChildren(el("div", {
                class: "body err"
            }, history.error || "Release history is unavailable."));
            return;
        }
        const releases = history.releases || [];
        const latest = releases[0];
        if (latest) {
            const status = String(latest.status || "status unavailable");
            const shortStatus = {
                deployed_verified: "verified",
                published_unverified: "unverified",
                published_public_values_unverified: "value checks pending",
                published_deployment_unverified: "deployment checks pending",
                push_unverified: "push checks pending"
            }[status] || status.replaceAll("_", " ");
            releaseState.className = `pill lifecycle release-state ${status === "deployed_verified" ? "live" : "blocker"}`;
            releaseState.textContent = `Release ${shortStatus}`;
            releaseState.title = describeRelease(latest).text;
        } else {
            releaseState.className = "pill lifecycle release-state";
            releaseState.textContent = "No releases yet";
        }
        releasesBody.replaceChildren(...releases.length ? releases.map(release => {
            const restore = el("button", {
                class: "act",
                type: "button",
                disabled: true,
                title: "Disabled: release restoration is outside this localhost sandbox."
            }, "Restore disabled");
            restore.addEventListener("click", async () => {
                if (SANDBOX.enabled) return;
                if (!window.confirm(`Restore v${release.version ?? "-"} (${String(release.id || "").slice(0, 12)}) into the Test working copy?\n\n` + "This does not publish. Inspect the resulting page and config, then use Commit separately.")) return;
                restore.disabled = true;
                const result = await coauthor("/restore", {
                    method: "POST",
                    body: {
                        slug: slug,
                        env: "test",
                        releaseId: release.id
                    }
                });
                if (result.ok) {
                    setActionNotice("Restored as a Test candidate. Review it, run checks, then Commit separately.");
                    reload();
                    await Promise.all([ refreshGit(), refreshPages(), refreshReleases() ]);
                } else {
                    setActionNotice(result.error || "The restore candidate was refused.", "err");
                    restore.disabled = false;
                }
            });
            return el("div", {
                class: "row"
            }, el("div", {
                class: "grow"
            }, el("div", {
                class: "label"
            }, `v${release.version ?? "-"} · ${String(release.id || "").slice(0, 12) || "unknown SHA"}`), el("div", {
                class: "headline"
            }, describeRelease(release).text), el("div", {
                class: "muted"
            }, release.committedAt ? when(release.committedAt) : "Commit time unavailable")), restore);
        }) : [ el("div", {
            class: "body muted"
        }, "No releases recorded.") ]);
    };
    verifyBrowser.addEventListener("click", async () => {
        if (SANDBOX.enabled) return;
        if (busy || !latestGit?.candidate?.candidateId) return;
        verifyBrowser.disabled = true;
        promote.disabled = true;
        verifyBrowser.textContent = "Running checks…";
        setActionNotice("Checking every Test page at 1440×900 and 390×844.");
        setBusy(true);
        try {
            const current = await coauthor(`/verification?funnel=${encodeURIComponent(slug)}&env=test`);
            if (!current.ok) throw new Error(current.error || "The exact candidate fingerprint is unavailable.");
            const candidateId = current.candidate.id;
            const origin = new URL(previewUrl).origin;
            const runs = [];
            for (const pagePath of current.pagePaths || []) {
                for (const viewport of current.requiredViewports || []) {
                    runs.push(await verifyPreviewFrame(frame, {
                        origin: origin,
                        candidateId: candidateId,
                        pagePath: pagePath,
                        viewport: viewport,
                        src: previewPath(slug, "test", pagePath)
                    }));
                }
            }
            const recorded = await coauthor("/verification/browser", {
                method: "POST",
                body: {
                    slug: slug,
                    env: "test",
                    candidateId: candidateId,
                    runs: runs
                }
            });
            if (!recorded.ok) throw new Error(recorded.error || "The browser evidence was refused.");
            setActionNotice(`Checks passed for candidate ${candidateId.slice(0, 12)}. Commit will recompute and refuse if anything changes.`);
        } catch (err) {
            setActionNotice(err.message || "Automated checks failed.", "err");
        } finally {
            verifyBrowser.textContent = "Run checks";
            setBusy(false);
            activePage = "";
            activeDevice = "desktop";
            drawTabs((await coauthor(`/pages?funnel=${encodeURIComponent(slug)}`)).pages || []);
            reload();
            resizePreview();
            await refreshGit();
        }
    });
    promote.addEventListener("click", async () => {
        if (SANDBOX.enabled) return;
        if (busy || activePromotionReview) return;
        const binding = promotionReviewBinding(latestGit);
        if (!binding) {
            promote.disabled = true;
            setActionNotice(REVIEW_PLAN_MISSING, "err");
            return;
        }
        activePromotionReview = promotionReviewDialog(binding, {
            funnelName: c.name || slug,
            onClose: () => {
                activePromotionReview = null;
                refreshGit();
            },
            onCommit: async (review, fingerprint) => {
                const fresh = await coauthor(`/status?funnel=${encodeURIComponent(slug)}&env=test`);
                const freshBinding = promotionReviewBinding(fresh.ok ? fresh : null);
                latestGit = fresh.ok ? fresh : null;
                if (!freshBinding || freshBinding.fingerprint !== fingerprint) {
                    invalidatePromotionReview("The candidate or Live config changed. Close this review and open Commit again.");
                    setActionNotice("Commit review expired because the candidate or Live config changed.", "err");
                    return {
                        ok: false,
                        error: "This review is stale. Close it and review the current plan."
                    };
                }
                promote.disabled = true;
                promote.textContent = "Committing…";
                setActionNotice("Rechecking the reviewed plan, then running the audited release transaction.");
                const res = await coauthor("/promote", {
                    method: "POST",
                    body: {
                        slug: slug,
                        env: "test",
                        message: `release(${slug}): funnel pages and config`,
                        review: review
                    }
                });
                promote.textContent = "Commit";
                if (res.ok) {
                    const release = describeRelease(res.release);
                    setActionNotice(release.text, release.status === "deployed_verified" ? "" : "err");
                } else {
                    setActionNotice(res.error || "The commit was refused.", "err");
                }
                await Promise.all([ refreshGit(), refreshReleases() ]);
                return res;
            }
        });
        promote.disabled = true;
    });
    const persistedHistory = await coauthor(`/history?funnel=${encodeURIComponent(slug)}&env=test`);
    if (!routeResponseIsCurrent(request)) return;
    const emptyConversation = () => el("p", {
        class: "muted"
    }, "Tell it what to build. For example: “Build the landing page for this funnel: a headline, one video, " + "and the questions from the config.” It reads the repo’s own rules first, and the pane on the right " + "is the page it is writing.");
    const log = el("div", {
        class: "chat-log",
        role: "log",
        "aria-label": "Co-author conversation"
    });
    const latestButton = el("button", {
        type: "button",
        class: "chat-latest",
        hidden: true
    }, "View latest");
    const messageNode = (kind, text) => el("div", {
        class: `msg ${kind}`
    }, text);
    const scrollToLatest = (behavior = "smooth") => {
        latestButton.hidden = true;
        latestButton.classList.remove("bad");
        try {
            log.scrollTo({
                top: log.scrollHeight,
                behavior: behavior
            });
        } catch {
            log.scrollTop = log.scrollHeight;
        }
    };
    latestButton.addEventListener("click", () => scrollToLatest("smooth"));
    log.addEventListener("scroll", () => {
        if (chatNearLatest(log)) latestButton.hidden = true;
    }, {
        passive: true
    });
    const say = (kind, text, {forceLatest: forceLatest = false} = {}) => {
        const follow = forceLatest || chatNearLatest(log);
        if (log.firstChild && log.firstChild.tagName === "P") log.replaceChildren();
        log.append(messageNode(kind, text));
        if (follow) requestAnimationFrame(() => scrollToLatest("smooth")); else {
            latestButton.hidden = false;
            latestButton.textContent = kind === "bad" ? "New error. View latest" : "New message. View latest";
            latestButton.classList.toggle("bad", kind === "bad");
        }
    };
    if (persistedHistory.ok && persistedHistory.messages?.length) {
        for (const message of conversationRenderModel(persistedHistory.messages)) {
            log.append(messageNode(message.kind, message.text));
        }
    } else {
        log.append(emptyConversation());
    }
    const changesBody = el("div", {
        class: "change-ledger"
    });
    const drawChanges = changes => {
        changesBody.replaceChildren(...(changes || []).length ? [ ...changes ].reverse().map(change => el("div", {
            class: "row"
        }, el("div", {
            class: "grow"
        }, el("div", {
            class: "label"
        }, change.requested || "Request unavailable"), el("div", {
            class: "headline"
        }, change.changed?.length ? `Changed: ${change.changed.join(", ")}` : change.completedAt ? "No file or Test-config write was recorded." : "Co-author run in progress…"), change.answered?.length ? el("div", {
            class: "muted"
        }, `Answered: ${change.answered.at(-1)}`) : null, el("div", {
            class: "muted mono"
        }, `candidate ${change.beforeCandidate?.id?.slice(0, 12) || "-"} → ${change.afterCandidate?.id?.slice(0, 12) || "-"}`)))) : [ el("div", {
            class: "body muted"
        }, "No candidate changes recorded yet.") ]);
    };
    drawChanges(persistedHistory.ok ? persistedHistory.changes : []);
    const refreshConversationLedger = async () => {
        const history = await coauthor(`/history?funnel=${encodeURIComponent(slug)}&env=test`);
        if (history.ok) drawChanges(history.changes || []);
    };
    const input = el("textarea", {
        class: "chat-input",
        rows: "1",
        placeholder: "Describe what you want…",
        "aria-label": "Message the co-author"
    });
    const send = el("button", {
        type: "button",
        class: "act",
        disabled: true
    }, "Send");
    const attachments = [];
    const attachBar = el("div", {
        class: "attachments"
    });
    const resizeComposer = () => {
        input.style.height = "auto";
        const max = 160;
        input.style.height = `${Math.min(input.scrollHeight, max)}px`;
        input.style.overflowY = input.scrollHeight > max ? "auto" : "hidden";
    };
    const drawAttachments = () => {
        attachBar.replaceChildren(...attachments.map((a, i) => el("span", {
            class: "chip"
        }, a.name, el("button", {
            type: "button",
            class: "x",
            title: "Remove",
            onclick: () => {
                attachments.splice(i, 1);
                drawAttachments();
            }
        }, "×"))));
    };
    const addFiles = files => {
        for (const f of Array.from(files || [])) {
            if (!f.type.startsWith("image/") || attachments.length >= 4) continue;
            const reader = new FileReader;
            reader.onload = () => {
                const data = String(reader.result || "").split(",")[1] || "";
                if (data) {
                    attachments.push({
                        name: f.name || "pasted.png",
                        data: data
                    });
                    drawAttachments();
                }
            };
            reader.readAsDataURL(f);
        }
    };
    const ws = openCoauthorChat(slug, "test");
    state.chat = ws;
    let connected = false;
    const setBusy = v => {
        busy = v;
        send.disabled = v || !connected || !input.value.trim();
        input.placeholder = v ? "The co-author is working…" : "Describe what you want…";
    };
    ws.onopen = () => {
        connected = true;
        dot.className = "conn on";
        dot.title = "Connected";
        setBusy(false);
    };
    ws.onclose = () => {
        connected = false;
        dot.className = "conn";
        dot.title = "Not connected";
        send.disabled = true;
    };
    ws.onmessage = e => {
        let m;
        try {
            m = JSON.parse(String(e.data));
        } catch {
            return;
        }
        if (m.type === "assistant" && m.text) say("from", m.text);
        if (m.type === "system" && m.text) say("note", m.text);
        if (m.type === "error" && m.text) say("bad", m.text);
        if (m.type === "tool") {
            say("tool", `${m.name}${m.detail ? ` · ${m.detail}` : ""}`);
            if (m.name === "Edit" || m.name === "Write" || m.name === "mcp__funnel_test__update_funnel_config") {
                invalidatePromotionReview("The Test draft changed. Close this review and open Commit again.");
                reload();
            }
        }
        if (m.type === "started") setBusy(true);
        if (m.type === "done") {
            setBusy(false);
            reload();
            refreshGit();
            refreshPages();
            setTimeout(refreshConversationLedger, 100);
        }
    };
    const sendMessage = () => {
        const text = input.value.trim();
        if (!text || busy || !connected) return;
        ws.send(JSON.stringify({
            type: "chat",
            text: text,
            images: attachments.slice()
        }));
        say("to", attachments.length ? `${text}\n(${attachments.length} image attached)` : text, {
            forceLatest: true
        });
        input.value = "";
        resizeComposer();
        attachments.length = 0;
        drawAttachments();
        setBusy(true);
    };
    send.addEventListener("click", sendMessage);
    input.addEventListener("input", () => {
        send.disabled = busy || !connected || !input.value.trim();
        resizeComposer();
    });
    input.addEventListener("keydown", e => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });
    input.addEventListener("paste", e => {
        if (e.clipboardData && e.clipboardData.files.length) {
            e.preventDefault();
            addFiles(e.clipboardData.files);
        }
    });
    previewPane.replaceChildren(el("h2", {}, "Read-only preview", el("span", {
        class: "count muted"
    }, "submissions and tracking blocked"), el("span", {
        class: "spacer"
    }), tabs, el("span", {
        class: "viewport-controls",
        role: "group",
        "aria-label": "Preview viewport"
    }, ...deviceButtons, dimensions), el("button", {
        type: "button",
        class: "tab",
        onclick: reload,
        title: "Reload the selected Test page"
    }, "Reload"), fullToggle), previewCanvas);
    const chatScroll = el("div", {
        class: "chat-scroll"
    }, log, latestButton);
    const composer = el("div", {
        class: "chat-composer"
    }, attachBar, el("div", {
        class: "composer-row"
    }, input, send), el("button", {
        type: "button",
        class: "fresh",
        title: "Forget this funnel’s visible conversation and start a new one. Pages and the candidate change ledger are untouched.",
        onclick: () => {
            ws.send(JSON.stringify({
                type: "new_conversation"
            }));
            log.replaceChildren(emptyConversation());
            latestButton.hidden = true;
        }
    }, "Start a fresh conversation"));
    const coauthorPane = el("div", {
        class: "card pane chat-pane"
    }, el("h2", {}, dot, "Co-author ", el("span", {
        class: "pill draft"
    }, "SIMULATED")), chatScroll, composer);
    studio.replaceChildren(coauthorPane, previewPane);
    const workspaceDetails = el("details", {
        class: "workspace-details"
    }, el("summary", {}, "Details"), el("div", {
        class: "workspace-details-panel"
    }, el("section", {
        class: "workspace-detail-section"
    }, el("h3", {}, "Working copy"), workTechnical, syncTechnical), el("div", {
        class: "workspace-detail-grid"
    }, el("section", {
        class: "workspace-detail-section"
    }, el("h3", {}, "Co-author change ledger"), changesBody), el("section", {
        class: "workspace-detail-section"
    }, el("h3", {}, "Release history"), releasesBody)), el("details", {
        class: "draft-tools"
    }, el("summary", {}, "Draft settings and Test tools"), el("div", {
        class: "draft-tools-grid"
    }, el("section", {
        class: "workspace-detail-section"
    }, el("h3", {}, "Test funnel state"), el("div", {
        class: "body stack"
    }, el("span", {
        class: "mono muted"
    }, `status: ${c.status || "draft"}`), deliveryToggle(slug, c, "test"), el("button", {
        class: "act go",
        type: "button",
        disabled: !c.canGoLive || c.status === "live",
        onclick: async event => {
            event.target.disabled = true;
            const result = await api(`/funnels/${slug}/go-live`, {
                method: "POST",
                mode: "test",
                syncChrome: false
            });
            if (!result.success) setActionNotice(result.error || "The Test funnel state was refused.", "err");
            route();
        }
    }, c.status === "live" ? "Test funnel enabled" : "Enable Test funnel"), el("button", {
        class: "act",
        type: "button",
        disabled: c.status !== "live",
        onclick: async () => {
            const result = await api(`/funnels/${slug}/pause`, {
                method: "POST",
                mode: "test",
                syncChrome: false
            });
            if (!result.success) setActionNotice(result.error || "The Test funnel state was refused.", "err");
            route();
        }
    }, "Pause Test funnel"))), publicPageValueCard(c, "test"), identityCard(c, "test"), duplicateCard(c, "test"), robotCard(slug)))));
    const toolbar = el("section", {
        class: "builder-toolbar",
        "aria-label": "Funnel builder controls"
    }, el("div", {
        class: "builder-title-row"
    }, el("a", {
        class: "back-link",
        href: `#/funnels/${slug}`
    }, "← Funnels"), el("strong", {
        class: "builder-name"
    }, c.name || slug), el("span", {
        class: "muted mono builder-slug"
    }, slug), arm === "variation" ? el("span", {
        class: "pill draft",
        title: "You entered the builder from the split-test variation. In this sandbox both arms share the same Test draft."
    }, "Editing: Variation") : null, el("span", {
        class: "spacer"
    }), el("span", {
        class: "pill env"
    }, "Test mode"), workLine, releaseState, workspaceDetails), el("div", {
        class: "builder-action-row"
    }, el("div", {
        class: "release-steps",
        "aria-label": "Release sequence"
    }, el("span", {
        class: "on"
    }, "Edit Test"), el("span", {
        "aria-hidden": "true"
    }, "→"), el("span", {}, "Checks disabled"), el("span", {
        "aria-hidden": "true"
    }, "→"), el("span", {}, "Commit disabled")), el("span", {
        class: "spacer"
    }), el("span", {
        class: "mobile-pane-switch",
        role: "group",
        "aria-label": "Workspace pane"
    }, ...paneButtons), openLocal, verifyBrowser, promote), actionLine);
    view.replaceChildren(toolbar, studio);
    if (typeof ResizeObserver !== "undefined") {
        const observer = new ResizeObserver(resizePreview);
        observer.observe(previewCanvas);
        stopPreviewResize = () => observer.disconnect();
    } else {
        window.addEventListener("resize", resizePreview);
        stopPreviewResize = () => window.removeEventListener("resize", resizePreview);
    }
    requestAnimationFrame(() => {
        resizePreview();
        resizeComposer();
        scrollToLatest("auto");
    });
    refreshGit();
    refreshPages();
    refreshReleases();
    return undefined;
}

const ROBOT_SAFETY_SUMMARY = "Robot-run automation is intentionally unavailable in this localhost sandbox.";

function robotDoneSummary() {
    return ROBOT_SAFETY_SUMMARY;
}

function robotCard() {
    return el("div", {
        class: "card"
    }, el("h2", {}, "Robot run unavailable"), el("div", {
        class: "body muted"
    }, ROBOT_SAFETY_SUMMARY), el("button", {
        class: "act",
        type: "button",
        disabled: true,
        title: "Disabled: external forms, contact creation, and delivery services are outside this sandbox."
    }, "Automation disabled"));
}

function timeValue(value) {
    const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
}

function utcWhen(value) {
    const parsed = timeValue(value);
    if (parsed == null) return "Time unavailable";
    return new Date(parsed).toLocaleString(undefined, {
        timeZone: "UTC",
        timeZoneName: "short"
    });
}

function errorCard(res, title = "Could not load") {
    return el("div", {
        class: "card"
    }, el("h2", {}, title), el("div", {
        class: "body err"
    }, res.error || "unknown error"), ...(res.rejections || []).map(r => el("div", {
        class: "row"
    }, el("div", {
        class: "grow"
    }, el("div", {
        class: "label mono"
    }, r.field || "-"), el("div", {
        class: "headline"
    }, r.reason)))));
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = {
        FUNNEL_COLUMNS,
        compareFunnels,
        sortFunnels,
        renderFunnels,
        renderBuild,
        promotionReviewDialog,
        SimulatedChatSocket,
        previewPath,
        previewFrameAttributes,
        PREVIEW_DEVICES,
        previewGeometry,
        describeWork,
        describeRelease,
        draftWorkspaceState,
        mergeFunnelWorkspace,
        openingMode,
        MODE_KEY
    };
}

if (typeof document !== "undefined") (async () => {
    const cfg = await fetch("/api/console").then(r => r.json()).catch(() => null);
    if (!cfg || !cfg.success) {
        document.getElementById("view").replaceChildren(el("div", {
            class: "card"
        }, el("h2", {}, "Console not configured"), el("div", {
            class: "body err"
        }, cfg && cfg.error || "the console could not describe itself")));
        return;
    }
    buildChrome(cfg);
    window.addEventListener("hashchange", route);
    route();
})();
