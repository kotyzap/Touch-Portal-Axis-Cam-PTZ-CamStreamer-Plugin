'use strict';

var net = require('node:net');
var node_events = require('node:events');
var http = require('node:http');
var https = require('node:https');
var node_crypto = require('node:crypto');

function _interopNamespaceDefault(e) {
    var n = Object.create(null);
    if (e) {
        Object.keys(e).forEach(function (k) {
            if (k !== 'default') {
                var d = Object.getOwnPropertyDescriptor(e, k);
                Object.defineProperty(n, k, d.get ? d : {
                    enumerable: true,
                    get: function () { return e[k]; }
                });
            }
        });
    }
    n.default = e;
    return Object.freeze(n);
}

var net__namespace = /*#__PURE__*/_interopNamespaceDefault(net);
var http__namespace = /*#__PURE__*/_interopNamespaceDefault(http);
var https__namespace = /*#__PURE__*/_interopNamespaceDefault(https);

const HOST = '127.0.0.1';
const PORT = 12136;
class TpClient extends node_events.EventEmitter {
    pluginId;
    socket;
    buffer = '';
    constructor(pluginId) {
        super();
        this.pluginId = pluginId;
    }
    connect() {
        const socket = net__namespace.createConnection({ host: HOST, port: PORT }, () => {
            this.send({ type: 'pair', id: this.pluginId });
        });
        socket.setEncoding('utf8');
        socket.on('data', (chunk) => this.onData(String(chunk)));
        socket.on('error', (err) => this.log(`socket error: ${err.message}`));
        socket.on('close', () => {
            this.log('socket closed');
            this.emit('close');
        });
        this.socket = socket;
    }
    onData(chunk) {
        this.buffer += chunk;
        let idx;
        while ((idx = this.buffer.indexOf('\n')) >= 0) {
            const line = this.buffer.slice(0, idx).trim();
            this.buffer = this.buffer.slice(idx + 1);
            if (line)
                this.dispatch(line);
        }
    }
    dispatch(line) {
        let msg;
        try {
            msg = JSON.parse(line);
        }
        catch {
            return;
        }
        switch (msg.type) {
            case 'info':
                this.emit('info', settingsToMap(msg.settings));
                break;
            case 'settings':
                this.emit('settings', settingsToMap(msg.values));
                break;
            case 'action':
            case 'up':
            case 'down':
                this.emit('action', msg);
                break;
            case 'listChange':
                this.emit('listChange', msg);
                break;
            case 'closePlugin':
                this.emit('close');
                break;
        }
    }
    send(obj) {
        if (!this.socket)
            return;
        this.socket.write(JSON.stringify(obj) + '\n');
    }
    /** Update a (declared or dynamic) state value. */
    stateUpdate(id, value) {
        this.send({ type: 'stateUpdate', id, value });
    }
    /** Create a dynamic state at runtime (e.g. one per discovered stream/tour). */
    createState(id, desc, defaultValue = '', parentGroup = 'Axis Cam + CamStreamer') {
        this.send({ type: 'createState', id, desc, defaultValue, parentGroup });
    }
    removeState(id) {
        this.send({ type: 'removeState', id });
    }
    /** Replace the choice list for an action's choice data field. */
    choiceUpdate(id, value) {
        this.send({ type: 'choiceUpdate', id, value });
    }
    /** Replace the choice list for one specific in-flight action instance. */
    choiceUpdateSpecific(id, instanceId, value) {
        this.send({ type: 'choiceUpdateSpecific', id, instanceId, value });
    }
    log(message) {
        // Touch Portal captures the plugin's stdout into its log file.
        process.stdout.write(`[axis-tp] ${message}\n`);
    }
}
/** Touch Portal sends settings as an array of single-key objects. */
function settingsToMap(arr) {
    const out = {};
    if (Array.isArray(arr)) {
        for (const entry of arr) {
            for (const [k, v] of Object.entries(entry))
                out[k] = v;
        }
    }
    return out;
}

// ---- HTTP with digest/basic auth -------------------------------------------
const TIMEOUT_MS = 6000;
const md5 = (s) => node_crypto.createHash('md5').update(s).digest('hex');
function rawRequest(opts, tls, body) {
    return new Promise((resolve, reject) => {
        const lib = tls ? https__namespace : http__namespace;
        const req = lib.request({ ...opts, rejectUnauthorized: false }, (res) => {
            let d = '';
            res.on('data', (c) => (d += c));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: d }));
        });
        req.on('error', reject);
        req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('timeout')));
        if (body)
            req.write(body);
        req.end();
    });
}
function buildDigest(challenge, method, uri, user, pass) {
    const get = (k) => {
        const m = challenge.match(new RegExp(`${k}="?([^",]+)"?`, 'i'));
        return m ? m[1] : '';
    };
    const realm = get('realm'), nonce = get('nonce'), qop = get('qop'), opaque = get('opaque');
    const algorithm = get('algorithm') || 'MD5';
    const ha1 = md5(`${user}:${realm}:${pass}`);
    const ha2 = md5(`${method}:${uri}`);
    const cnonce = node_crypto.randomBytes(8).toString('hex');
    const nc = '00000001';
    const response = qop
        ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`)
        : md5(`${ha1}:${nonce}:${ha2}`);
    let h = `Digest username="${user}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}"`;
    if (qop)
        h += `, qop=auth, nc=${nc}, cnonce="${cnonce}"`;
    if (opaque)
        h += `, opaque="${opaque}"`;
    h += `, algorithm=${algorithm}`;
    return h;
}
async function request(method, conn, path, body, contentType) {
    const ip = conn.cameraIp ?? '';
    const tls = !!conn.cameraTls;
    const port = conn.cameraPort || (tls ? 443 : 80);
    const user = conn.cameraUser ?? 'root';
    const pass = conn.cameraPass ?? '';
    const base = {
        hostname: ip, port, path, method,
        headers: contentType ? { 'Content-Type': contentType } : {},
    };
    try {
        let res = await rawRequest(base, tls, body);
        if (res.status === 401) {
            const wa = String(res.headers['www-authenticate'] ?? '');
            const headers = contentType ? { 'Content-Type': contentType } : {};
            if (/^digest/i.test(wa))
                headers.Authorization = buildDigest(wa, method, path, user, pass);
            else
                headers.Authorization = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
            res = await rawRequest({ ...base, headers }, tls, body);
        }
        return { ok: res.status >= 200 && res.status < 300, status: res.status, text: res.text };
    }
    catch (err) {
        return { ok: false, status: 0, text: err instanceof Error ? err.message : String(err) };
    }
}
const camGet = (conn, path) => request('GET', conn, path);
const camPost = (conn, path, body) => request('POST', conn, path, body, 'application/json');
// ---- helpers ----------------------------------------------------------------
function tryParse(text) { try {
    return JSON.parse(text);
}
catch {
    return undefined;
} }
function toBool(v) {
    if (typeof v === 'boolean')
        return v;
    if (v === 1 || v === '1')
        return true;
    if (v === 0 || v === '0')
        return false;
    return null;
}
function fail(error) { return { available: false, items: [], error }; }
// ---- discovery (direct VAPIX + product CGIs) --------------------------------
async function discoverPresets(conn) {
    const res = await camGet(conn, '/axis-cgi/com/ptz.cgi?query=presetposall');
    if (!res.ok)
        return fail(`ptz.cgi returned ${res.status}`);
    const items = [];
    let channel = null;
    for (const raw of res.text.split(/\r?\n/)) {
        const line = raw.trim();
        const h = line.match(/^Preset Positions for camera\s+(\d+)/i);
        if (h) {
            channel = parseInt(h[1], 10);
            continue;
        }
        const m = line.match(/^presetposno(\d+)=(.*)$/);
        if (m)
            items.push({ channel, no: parseInt(m[1], 10), name: m[2].trim() });
    }
    return { available: true, items };
}
async function discoverGuardTours(conn) {
    const res = await camGet(conn, '/axis-cgi/param.cgi?action=list&group=GuardTour');
    if (!res.ok)
        return fail(`param.cgi returned ${res.status}`);
    const tours = new Map();
    for (const raw of res.text.split(/\r?\n/)) {
        const m = raw.trim().match(/^root\.GuardTour\.(G\d+)\.(\w+)=(.*)$/);
        if (!m)
            continue;
        const [, id, key, val] = m;
        let t = tours.get(id);
        if (!t) {
            t = { channel: null, id, name: '', running: false, active: false };
            tours.set(id, t);
        }
        if (/^Name$/i.test(key))
            t.name = val.trim();
        else if (/^CamNbr$/i.test(key)) {
            const n = parseInt(val, 10);
            t.channel = Number.isFinite(n) ? n : null;
        }
        else if (/^Running$/i.test(key))
            t.running = /^yes$/i.test(val.trim());
        else if (/^Active$/i.test(key))
            t.active = /^yes$/i.test(val.trim());
    }
    const items = [...tours.values()]
        .filter((t) => t.active || t.name.length > 0)
        .map((t) => ({ channel: t.channel, id: t.id, name: t.name || t.id, running: t.running }));
    return { available: true, items };
}
async function discoverOverlays(conn) {
    const res = await camGet(conn, '/local/camoverlay/api/services.cgi?action=get');
    if (!res.ok)
        return fail(`services.cgi returned ${res.status}`);
    const data = tryParse(res.text);
    const list = Array.isArray(data?.services) ? data.services : Array.isArray(data) ? data : [];
    if (!list.length && !Array.isArray(data?.services) && !Array.isArray(data))
        return fail('CamOverlay not available');
    return {
        available: true,
        items: list
            .map((s) => ({ service_id: Number(s.id ?? s.service_id ?? s.serviceID), name: String(s.customName || s.name || s.title || `Service ${s.id ?? '?'}`), enabled: toBool(s.enabled) }))
            .filter((s) => Number.isFinite(s.service_id)),
    };
}
async function discoverStreams(conn) {
    const tryEp = async (path) => {
        const res = await camGet(conn, path);
        if (!res.ok)
            return null;
        const data = tryParse(res.text);
        if (!data || typeof data !== 'object')
            return null;
        const arr = Array.isArray(data.streamList) ? data.streamList
            : Array.isArray(data?.data?.streamList) ? data.data.streamList
                : Array.isArray(data) ? data : null;
        if (arr) {
            return arr.map((s) => ({ stream_id: String(s.streamId ?? s.stream_id ?? s.id ?? ''), name: String(s.title || s.name || `Stream ${s.streamId ?? '?'}`), enabled: toBool(s.enabled) }))
                .filter((s) => s.stream_id.length > 0);
        }
        const dict = data.data && typeof data.data === 'object' && !Array.isArray(data.data) ? data.data : data;
        const entries = Object.entries(dict).filter(([, v]) => v && typeof v === 'object' && !Array.isArray(v) && ('title' in v || 'enabled' in v || 'name' in v || 'mediaServerUrl' in v));
        return entries.length ? entries.map(([id, v]) => ({ stream_id: String(v.streamId ?? v.stream_id ?? id), name: String(v.title || v.name || `Stream ${id}`), enabled: toBool(v.enabled) })) : null;
    };
    const items = (await tryEp('/local/camstreamer/stream_list.cgi?action=get')) ?? (await tryEp('/local/camstreamer/stream/list.cgi?action=get'));
    return items ? { available: true, items } : fail('CamStreamer not available');
}
async function discoverViews(conn) {
    const res = await camGet(conn, '/local/camswitcher/playlists.cgi?action=get');
    if (!res.ok)
        return fail(`playlists.cgi returned ${res.status}`);
    const data = tryParse(res.text);
    const dict = data?.data;
    if (!dict || typeof dict !== 'object')
        return fail('CamSwitcher not available');
    return {
        available: true,
        items: Object.entries(dict).map(([uuid, v]) => ({ name: uuid, label: String(v?.niceName || v?.name || uuid) })).filter((v) => v.name.length > 0),
    };
}
async function discover(conn) {
    if (!conn.cameraIp)
        throw new Error('Camera IP not set (open the plugin settings)');
    const [ptz_presets, guard_tours, overlay_services, streams, views] = await Promise.all([
        discoverPresets(conn), discoverGuardTours(conn), discoverOverlays(conn), discoverStreams(conn), discoverViews(conn),
    ]);
    return { ptz_presets, guard_tours, overlay_services, streams, views };
}
async function fetchState(conn) {
    if (!conn.cameraIp)
        return { ok: false, streams: {}, overlays: {}, tours: {}, active_view: null };
    const [streams, overlays, tours] = await Promise.all([discoverStreams(conn), discoverOverlays(conn), discoverGuardTours(conn)]);
    const streamState = {};
    for (const s of streams.items)
        streamState[String(s.stream_id)] = s.enabled;
    const overlayState = {};
    for (const o of overlays.items)
        overlayState[String(o.service_id)] = o.enabled;
    const tourState = {};
    for (const t of tours.items)
        tourState[t.id] = t.running;
    const ok = streams.available || overlays.available || tours.available;
    return { ok, streams: streamState, overlays: overlayState, tours: tourState, active_view: null };
}
const PTZ = '/axis-cgi/com/ptz.cgi';
const bool = (v) => (v === '1' || v === 'true' || v === 'on' || v === 'yes' ? '1' : '0');
const withCam = (q, cam) => (cam ? `${q}&camera=${encodeURIComponent(cam)}` : q);
/** Stop any guard tour running on the given PTZ channel (keep one PTZ action at a time). */
async function stopToursOnChannel(conn, camera) {
    const sec = await discoverGuardTours(conn);
    if (!sec.available)
        return;
    const ch = camera != null && camera !== '' ? parseInt(camera, 10) : null;
    for (const t of sec.items) {
        if (!t.running)
            continue;
        if (ch != null && t.channel != null && t.channel !== ch)
            continue;
        await camGet(conn, `/axis-cgi/param.cgi?action=update&GuardTour.${t.id}.Running=no`);
    }
}
async function sendCmd(conn, params) {
    if (!conn.cameraIp)
        return { ok: false, error: 'Camera IP not set' };
    const a = params.action;
    let res;
    switch (a) {
        case 'ptz.preset':
            await stopToursOnChannel(conn, params.camera);
            if (params.name)
                res = await camGet(conn, withCam(`${PTZ}?gotoserverpresetname=${encodeURIComponent(params.name)}`, params.camera));
            else if (params.no)
                res = await camGet(conn, withCam(`${PTZ}?gotoserverpresetno=${encodeURIComponent(params.no)}`, params.camera));
            else
                return { ok: false, error: 'preset requires name or no' };
            break;
        case 'ptz.home':
            await stopToursOnChannel(conn, params.camera);
            res = await camGet(conn, withCam(`${PTZ}?move=home`, params.camera));
            break;
        case 'guardtour.start':
            if (!params.guardtour_id)
                return { ok: false, error: 'guardtour.start requires guardtour_id' };
            await stopToursOnChannel(conn, params.camera);
            res = await camGet(conn, `/axis-cgi/param.cgi?action=update&GuardTour.${encodeURIComponent(params.guardtour_id)}.Running=yes`);
            break;
        case 'guardtour.stop':
            if (!params.guardtour_id)
                return { ok: false, error: 'guardtour.stop requires guardtour_id' };
            res = await camGet(conn, `/axis-cgi/param.cgi?action=update&GuardTour.${encodeURIComponent(params.guardtour_id)}.Running=no`);
            break;
        case 'stream.set':
            res = await camGet(conn, `/local/camstreamer/set_stream_enabled.cgi?stream_id=${encodeURIComponent(params.stream_id)}&enabled=${bool(params.enabled)}`);
            break;
        case 'overlay.toggle':
            return overlayToggle(conn, Number(params.service_id), bool(params.enabled) === '1');
        case 'view.switch':
            res = await camGet(conn, `/local/camswitcher/playlist_switch.cgi?playlist_name=${encodeURIComponent(params.name)}`);
            break;
        default:
            return { ok: false, error: `unknown action ${a}` };
    }
    return { ok: res.ok, error: res.ok ? undefined : `camera returned ${res.status}` };
}
// CamOverlay show/hide: persistent full-list write-back.
async function overlayToggle(conn, id, want) {
    const list = await camGet(conn, '/local/camoverlay/api/services.cgi?action=get');
    if (!list.ok)
        return { ok: false, error: `services.cgi get ${list.status}` };
    const data = tryParse(list.text);
    const services = Array.isArray(data?.services) ? data.services : Array.isArray(data) ? data : [];
    let found = false;
    for (const s of services)
        if (Number(s.id ?? s.service_id ?? s.serviceID) === id) {
            s.enabled = want ? 1 : 0;
            found = true;
        }
    if (!found)
        return { ok: false, error: `service ${id} not found` };
    const post = await camPost(conn, '/local/camoverlay/api/services.cgi?action=set', JSON.stringify({ services }));
    return { ok: post.ok, error: post.ok ? undefined : `services.cgi set ${post.status}` };
}

const PLUGIN_ID = 'com.4xsdev.axis-tp';
const D = (s) => `${PLUGIN_ID}.data.${s}`;
const A = (s) => `${PLUGIN_ID}.act.${s}`;
const ST = (s) => `${PLUGIN_ID}.state.${s}`;
const tp = new TpClient(PLUGIN_ID);
let conn = {};
let catalog = null;
let state = null;
let pollMs = 3000;
let pollTimer;
// Tally blink: a fast timer flips a phase so live items can "blink" via state.
const BLINK_MS = 600;
let blinkTimer;
let blinkPhase = false;
const presetMap = new Map();
const tourMap = new Map();
const streamMap = new Map(); // label -> { stream_id }
const overlayMap = new Map(); // label -> { service_id }
const viewMap = new Map(); // label -> { name }
// id -> friendly name, so dynamic states show readable descriptions in TP.
const streamNames = new Map();
const overlayNames = new Map();
const tourNames = new Map();
// Stable, name-derived key so buttons can bind to a state by the item's name
// (the label shown in the dropdown) instead of an internal id.
function slugify(name) {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}
// ---- settings ---------------------------------------------------------------
function applySettings(s) {
    const tls = /^(yes|true|1|on)$/i.test((s['Use HTTPS (yes/no)'] ?? 'no').trim());
    const port = parseInt(s['Port'] ?? '', 10);
    conn = {
        cameraIp: (s['Camera IP / hostname'] ?? '').trim(),
        cameraPort: Number.isFinite(port) ? port : undefined,
        cameraUser: (s['Username'] ?? 'root').trim(),
        cameraPass: s['Password'] ?? '',
        cameraTls: tls,
    };
    const poll = parseInt(s['Poll interval (seconds)'] ?? '', 10);
    pollMs = Number.isFinite(poll) ? Math.max(1, poll) * 1000 : 3000;
}
// ---- discovery → choice lists ----------------------------------------------
async function refresh() {
    if (!conn.cameraIp) {
        tp.stateUpdate(ST('connection'), 'error');
        tp.stateUpdate(ST('lastResult'), 'Camera IP not set');
        return;
    }
    try {
        catalog = await discover(conn);
    }
    catch (err) {
        tp.stateUpdate(ST('connection'), 'error');
        tp.stateUpdate(ST('lastResult'), err instanceof Error ? err.message : String(err));
        return;
    }
    // PTZ presets (+ Home per channel).
    presetMap.clear();
    const presetChoices = [];
    const channels = new Set();
    for (const p of catalog.ptz_presets.items) {
        const label = p.channel != null ? `${p.name} [cam ${p.channel}]` : p.name;
        presetMap.set(label, p.channel != null
            ? { action: 'ptz.preset', name: p.name, camera: String(p.channel) }
            : { action: 'ptz.preset', name: p.name });
        presetChoices.push(label);
        channels.add(p.channel);
    }
    if (channels.size <= 1) {
        presetMap.set('🏠 Home', { action: 'ptz.home' });
        presetChoices.unshift('🏠 Home');
    }
    else {
        for (const ch of channels) {
            if (ch == null)
                continue;
            const label = `🏠 Home [cam ${ch}]`;
            presetMap.set(label, { action: 'ptz.home', camera: String(ch) });
            presetChoices.unshift(label);
        }
    }
    tp.choiceUpdate(D('preset'), presetChoices.length ? presetChoices : ['(none found)']);
    // Guard tours.
    tourMap.clear();
    tourNames.clear();
    const tourChoices = [];
    for (const t of catalog.guard_tours.items) {
        const label = t.channel != null ? `${t.name} [cam ${t.channel}]` : t.name;
        const params = { guardtour_id: t.id };
        if (t.channel != null)
            params.camera = String(t.channel);
        tourMap.set(label, params);
        tourNames.set(String(t.id), label);
        tourChoices.push(label);
    }
    tp.choiceUpdate(D('tour'), tourChoices.length ? tourChoices : ['(none found)']);
    // Streams.
    streamMap.clear();
    const streamChoices = [];
    streamNames.clear();
    for (const s of catalog.streams.items) {
        const label = s.name;
        streamMap.set(label, { stream_id: s.stream_id });
        streamNames.set(String(s.stream_id), s.name);
        streamChoices.push(label);
    }
    tp.choiceUpdate(D('stream'), streamChoices.length ? streamChoices : ['(none found)']);
    // Overlays.
    overlayMap.clear();
    const overlayChoices = [];
    overlayNames.clear();
    for (const o of catalog.overlay_services.items) {
        const label = o.name;
        overlayMap.set(label, { service_id: String(o.service_id) });
        overlayNames.set(String(o.service_id), o.name);
        overlayChoices.push(label);
    }
    tp.choiceUpdate(D('overlay'), overlayChoices.length ? overlayChoices : ['(none found)']);
    // Views.
    viewMap.clear();
    const viewChoices = [];
    for (const v of catalog.views.items) {
        viewMap.set(v.label, { name: v.name });
        viewChoices.push(v.label);
    }
    tp.choiceUpdate(D('view'), viewChoices.length ? viewChoices : ['(none found)']);
    tp.log(`discovered: ${catalog.ptz_presets.items.length} presets, ${catalog.guard_tours.items.length} tours, ${catalog.streams.items.length} streams, ${catalog.overlay_services.items.length} overlays, ${catalog.views.items.length} views`);
    await poll();
}
// ---- polling → live state ---------------------------------------------------
async function poll() {
    if (!conn.cameraIp)
        return;
    try {
        state = await fetchState(conn);
    }
    catch {
        state = null;
    }
    if (!state || !state.ok) {
        tp.stateUpdate(ST('connection'), 'error');
        return;
    }
    tp.stateUpdate(ST('connection'), 'ok');
    // Dynamic per-item states so users can drive button visuals.
    for (const [id, on] of Object.entries(state.streams)) {
        const name = streamNames.get(String(id)) ?? `Stream ${id}`;
        const k = slugify(name);
        tp.createState(ST(`stream.${k}`), `Axis: Stream "${name}" on/off`, 'off');
        tp.stateUpdate(ST(`stream.${k}`), on === null ? 'unknown' : on ? 'on' : 'off');
        // Tally state for blinking button visuals (blink/dark while live, idle when off).
        tp.createState(ST(`tally.${k}`), `Axis: Stream "${name}" TALLY (blink)`, 'idle');
    }
    for (const [id, on] of Object.entries(state.overlays)) {
        const name = overlayNames.get(String(id)) ?? `Overlay ${id}`;
        const k = slugify(name);
        tp.createState(ST(`overlay.${k}`), `Axis: Overlay "${name}" on/off`, 'off');
        tp.stateUpdate(ST(`overlay.${k}`), on === null ? 'unknown' : on ? 'on' : 'off');
    }
    for (const [id, on] of Object.entries(state.tours)) {
        const name = tourNames.get(String(id)) ?? `Guard tour ${id}`;
        const k = slugify(name);
        tp.createState(ST(`tour.${k}`), `Axis: Guard tour "${name}" running/stopped`, 'stopped');
        tp.stateUpdate(ST(`tour.${k}`), on ? 'running' : 'stopped');
    }
}
function startPolling() {
    if (pollTimer)
        clearInterval(pollTimer);
    pollTimer = setInterval(() => void poll(), pollMs);
}
// Drives the per-stream TALLY state: alternates "blink"/"dark" while a stream
// is live so a button bound to it flashes; "idle" when the stream is off.
function tickTally() {
    blinkPhase = !blinkPhase;
    if (!state || !state.ok)
        return;
    for (const [id, on] of Object.entries(state.streams)) {
        const name = streamNames.get(String(id)) ?? `Stream ${id}`;
        const value = on === true ? (blinkPhase ? 'blink' : 'dark') : 'idle';
        tp.stateUpdate(ST(`tally.${slugify(name)}`), value);
    }
}
function startBlink() {
    if (blinkTimer)
        clearInterval(blinkTimer);
    blinkTimer = setInterval(tickTally, BLINK_MS);
}
// ---- action dispatch --------------------------------------------------------
function dataValue(msg, id) {
    return msg.data.find((d) => d.id === id)?.value ?? '';
}
async function handleAction(msg) {
    let params;
    switch (msg.actionId) {
        case A('refresh'):
            await refresh();
            tp.stateUpdate(ST('lastResult'), 'refreshed');
            return;
        case A('preset'): {
            const label = dataValue(msg, D('preset'));
            params = presetMap.get(label);
            if (params)
                tp.stateUpdate(ST('activePreset'), label); // radio highlight
            break;
        }
        case A('guardtour'): {
            const label = dataValue(msg, D('tour'));
            const mode = dataValue(msg, D('gtmode'));
            const base = tourMap.get(label);
            if (base)
                params = { ...base, action: mode === 'Stop' ? 'guardtour.stop' : 'guardtour.start' };
            break;
        }
        case A('stream'): {
            const label = dataValue(msg, D('stream'));
            const mode = dataValue(msg, D('stmode'));
            const base = streamMap.get(label);
            if (base) {
                const enabled = resolveToggle(mode, state?.streams[base.stream_id] ?? null);
                params = { action: 'stream.set', stream_id: base.stream_id, enabled };
            }
            break;
        }
        case A('overlay'): {
            const label = dataValue(msg, D('overlay'));
            const mode = dataValue(msg, D('ovmode'));
            const base = overlayMap.get(label);
            if (base) {
                const cur = state?.overlays[base.service_id] ?? null;
                const enabled = resolveToggle(mode === 'Show' ? 'On' : mode === 'Hide' ? 'Off' : 'Toggle', cur);
                params = { action: 'overlay.toggle', service_id: base.service_id, enabled };
            }
            break;
        }
        case A('view'): {
            const label = dataValue(msg, D('view'));
            const base = viewMap.get(label);
            if (base) {
                params = { action: 'view.switch', name: base.name };
                tp.stateUpdate(ST('activeView'), label);
            }
            break;
        }
        default:
            tp.log(`unknown action ${msg.actionId}`);
            return;
    }
    if (!params) {
        tp.stateUpdate(ST('lastResult'), 'selection not found — press Refresh');
        return;
    }
    const res = await sendCmd(conn, params);
    tp.stateUpdate(ST('lastResult'), res.ok ? `ok: ${params.action}` : `error: ${res.error}`);
    // Reflect the change quickly rather than waiting for the next poll tick.
    void poll();
}
/** On/Off/Toggle -> "1"/"0" given the current known state. */
function resolveToggle(mode, current) {
    if (mode === 'On')
        return '1';
    if (mode === 'Off')
        return '0';
    return current ? '0' : '1'; // Toggle (unknown -> turn on)
}
// ---- wire up ----------------------------------------------------------------
tp.on('info', (settings) => {
    tp.log('paired with Touch Portal');
    applySettings(settings);
    startPolling();
    startBlink();
    void refresh();
});
tp.on('settings', (settings) => {
    applySettings(settings);
    startPolling();
    startBlink();
    void refresh();
});
tp.on('action', (msg) => void handleAction(msg));
tp.on('close', () => {
    if (pollTimer)
        clearInterval(pollTimer);
    if (blinkTimer)
        clearInterval(blinkTimer);
    process.exit(0);
});
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
tp.connect();
