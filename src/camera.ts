import * as http from 'node:http';
import * as https from 'node:https';
import { createHash, randomBytes } from 'node:crypto';

/**
 * Camera connection. The plugin talks DIRECTLY to the camera (no gateway).
 * LAN use; HTTP digest auth handled here since Node's fetch can't do digest.
 * Ported from the Stream Deck plugin's gateway.ts, with the Stream Deck
 * settings store replaced by a plain in-memory Conn object fed from Touch
 * Portal plugin settings.
 */
export type Conn = {
    cameraIp?: string;
    cameraPort?: number;
    cameraUser?: string;
    cameraPass?: string;
    cameraTls?: boolean;
};

export type Section<T> = { available: boolean; items: T[]; error?: string };
export type Catalog = {
    ptz_presets: Section<{ channel: number | null; no: number; name: string }>;
    guard_tours: Section<{ channel: number | null; id: string; name: string; running: boolean }>;
    overlay_services: Section<{ service_id: number; name: string; enabled: boolean | null }>;
    streams: Section<{ stream_id: string; name: string; enabled: boolean | null }>;
    views: Section<{ name: string; label: string }>;
};
export type CamState = {
    ok: boolean;
    streams: Record<string, boolean | null>;
    overlays: Record<string, boolean | null>;
    tours: Record<string, boolean>;
    active_view: string | null;
};

/** True when the IP is empty or points at the local machine (can't reach the camera). */
export function isLoopbackOrEmpty(ip?: string): boolean {
    const s = (ip ?? '').trim().toLowerCase();
    return !s || s === 'localhost' || s === '::1' || s.startsWith('127.');
}

// ---- HTTP with digest/basic auth -------------------------------------------
const TIMEOUT_MS = 6000;
const md5 = (s: string) => createHash('md5').update(s).digest('hex');

type RawRes = { status: number; headers: http.IncomingHttpHeaders; text: string };

function rawRequest(opts: http.RequestOptions, tls: boolean, body?: string): Promise<RawRes> {
    return new Promise((resolve, reject) => {
        const lib = tls ? https : http;
        const req = lib.request({ ...opts, rejectUnauthorized: false } as https.RequestOptions, (res) => {
            let d = '';
            res.on('data', (c) => (d += c));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: d }));
        });
        req.on('error', reject);
        req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('timeout')));
        if (body) req.write(body);
        req.end();
    });
}

function buildDigest(challenge: string, method: string, uri: string, user: string, pass: string): string {
    const get = (k: string) => {
        const m = challenge.match(new RegExp(`${k}="?([^",]+)"?`, 'i'));
        return m ? m[1] : '';
    };
    const realm = get('realm'), nonce = get('nonce'), qop = get('qop'), opaque = get('opaque');
    const algorithm = get('algorithm') || 'MD5';
    const ha1 = md5(`${user}:${realm}:${pass}`);
    const ha2 = md5(`${method}:${uri}`);
    const cnonce = randomBytes(8).toString('hex');
    const nc = '00000001';
    const response = qop
        ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`)
        : md5(`${ha1}:${nonce}:${ha2}`);
    let h = `Digest username="${user}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}"`;
    if (qop) h += `, qop=auth, nc=${nc}, cnonce="${cnonce}"`;
    if (opaque) h += `, opaque="${opaque}"`;
    if (algorithm) h += `, algorithm=${algorithm}`;
    return h;
}

type CamRes = { ok: boolean; status: number; text: string };

async function request(method: string, conn: Conn, path: string, body?: string, contentType?: string): Promise<CamRes> {
    const ip = conn.cameraIp ?? '';
    const tls = !!conn.cameraTls;
    const port = conn.cameraPort || (tls ? 443 : 80);
    const user = conn.cameraUser ?? 'root';
    const pass = conn.cameraPass ?? '';
    const base: http.RequestOptions = {
        hostname: ip, port, path, method,
        headers: contentType ? { 'Content-Type': contentType } : {},
    };
    try {
        let res = await rawRequest(base, tls, body);
        if (res.status === 401) {
            const wa = String(res.headers['www-authenticate'] ?? '');
            const headers: Record<string, string> = contentType ? { 'Content-Type': contentType } : {};
            if (/^digest/i.test(wa)) headers.Authorization = buildDigest(wa, method, path, user, pass);
            else headers.Authorization = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
            res = await rawRequest({ ...base, headers }, tls, body);
        }
        return { ok: res.status >= 200 && res.status < 300, status: res.status, text: res.text };
    } catch (err) {
        return { ok: false, status: 0, text: err instanceof Error ? err.message : String(err) };
    }
}
const camGet = (conn: Conn, path: string) => request('GET', conn, path);
const camPost = (conn: Conn, path: string, body: string) => request('POST', conn, path, body, 'application/json');

// ---- helpers ----------------------------------------------------------------
function tryParse(text: string): any { try { return JSON.parse(text); } catch { return undefined; } }
function toBool(v: unknown): boolean | null {
    if (typeof v === 'boolean') return v;
    if (v === 1 || v === '1') return true;
    if (v === 0 || v === '0') return false;
    return null;
}
function fail<T>(error: string): Section<T> { return { available: false, items: [], error }; }

// ---- discovery (direct VAPIX + product CGIs) --------------------------------
async function discoverPresets(conn: Conn): Promise<Section<{ channel: number | null; no: number; name: string }>> {
    const res = await camGet(conn, '/axis-cgi/com/ptz.cgi?query=presetposall');
    if (!res.ok) return fail(`ptz.cgi returned ${res.status}`);
    const items: { channel: number | null; no: number; name: string }[] = [];
    let channel: number | null = null;
    for (const raw of res.text.split(/\r?\n/)) {
        const line = raw.trim();
        const h = line.match(/^Preset Positions for camera\s+(\d+)/i);
        if (h) { channel = parseInt(h[1], 10); continue; }
        const m = line.match(/^presetposno(\d+)=(.*)$/);
        if (m) items.push({ channel, no: parseInt(m[1], 10), name: m[2].trim() });
    }
    return { available: true, items };
}

async function discoverGuardTours(conn: Conn): Promise<Section<{ channel: number | null; id: string; name: string; running: boolean }>> {
    const res = await camGet(conn, '/axis-cgi/param.cgi?action=list&group=GuardTour');
    if (!res.ok) return fail(`param.cgi returned ${res.status}`);
    type T = { channel: number | null; id: string; name: string; running: boolean; active: boolean };
    const tours = new Map<string, T>();
    for (const raw of res.text.split(/\r?\n/)) {
        const m = raw.trim().match(/^root\.GuardTour\.(G\d+)\.(\w+)=(.*)$/);
        if (!m) continue;
        const [, id, key, val] = m;
        let t = tours.get(id);
        if (!t) { t = { channel: null, id, name: '', running: false, active: false }; tours.set(id, t); }
        if (/^Name$/i.test(key)) t.name = val.trim();
        else if (/^CamNbr$/i.test(key)) { const n = parseInt(val, 10); t.channel = Number.isFinite(n) ? n : null; }
        else if (/^Running$/i.test(key)) t.running = /^yes$/i.test(val.trim());
        else if (/^Active$/i.test(key)) t.active = /^yes$/i.test(val.trim());
    }
    const items = [...tours.values()]
        .filter((t) => t.active || t.name.length > 0)
        .map((t) => ({ channel: t.channel, id: t.id, name: t.name || t.id, running: t.running }));
    return { available: true, items };
}

async function discoverOverlays(conn: Conn): Promise<Section<{ service_id: number; name: string; enabled: boolean | null }>> {
    const res = await camGet(conn, '/local/camoverlay/api/services.cgi?action=get');
    if (!res.ok) return fail(`services.cgi returned ${res.status}`);
    const data = tryParse(res.text);
    const list: any[] = Array.isArray(data?.services) ? data.services : Array.isArray(data) ? data : [];
    if (!list.length && !Array.isArray(data?.services) && !Array.isArray(data)) return fail('CamOverlay not available');
    return {
        available: true,
        items: list
            .map((s) => ({ service_id: Number(s.id ?? s.service_id ?? s.serviceID), name: String(s.customName || s.name || s.title || `Service ${s.id ?? '?'}`), enabled: toBool(s.enabled) }))
            .filter((s) => Number.isFinite(s.service_id)),
    };
}

async function discoverStreams(conn: Conn): Promise<Section<{ stream_id: string; name: string; enabled: boolean | null }>> {
    const tryEp = async (path: string) => {
        const res = await camGet(conn, path);
        if (!res.ok) return null;
        const data = tryParse(res.text);
        if (!data || typeof data !== 'object') return null;
        const arr: any[] | null = Array.isArray(data.streamList) ? data.streamList
            : Array.isArray(data?.data?.streamList) ? data.data.streamList
            : Array.isArray(data) ? data : null;
        if (arr) {
            return arr.map((s: any) => ({ stream_id: String(s.streamId ?? s.stream_id ?? s.id ?? ''), name: String(s.title || s.name || `Stream ${s.streamId ?? '?'}`), enabled: toBool(s.enabled) }))
                .filter((s: any) => s.stream_id.length > 0);
        }
        const dict = data.data && typeof data.data === 'object' && !Array.isArray(data.data) ? data.data : data;
        const entries = Object.entries(dict as Record<string, any>).filter(([, v]) => v && typeof v === 'object' && !Array.isArray(v) && ('title' in v || 'enabled' in v || 'name' in v || 'mediaServerUrl' in v));
        return entries.length ? entries.map(([id, v]) => ({ stream_id: String(v.streamId ?? v.stream_id ?? id), name: String(v.title || v.name || `Stream ${id}`), enabled: toBool(v.enabled) })) : null;
    };
    const items = (await tryEp('/local/camstreamer/stream_list.cgi?action=get')) ?? (await tryEp('/local/camstreamer/stream/list.cgi?action=get'));
    return items ? { available: true, items } : fail('CamStreamer not available');
}

async function discoverViews(conn: Conn): Promise<Section<{ name: string; label: string }>> {
    const res = await camGet(conn, '/local/camswitcher/playlists.cgi?action=get');
    if (!res.ok) return fail(`playlists.cgi returned ${res.status}`);
    const data = tryParse(res.text);
    const dict = data?.data;
    if (!dict || typeof dict !== 'object') return fail('CamSwitcher not available');
    return {
        available: true,
        items: Object.entries(dict as Record<string, any>).map(([uuid, v]) => ({ name: uuid, label: String(v?.niceName || v?.name || uuid) })).filter((v) => v.name.length > 0),
    };
}

export async function discover(conn: Conn): Promise<Catalog> {
    if (!conn.cameraIp) throw new Error('Camera IP not set (open the plugin settings)');
    const [ptz_presets, guard_tours, overlay_services, streams, views] = await Promise.all([
        discoverPresets(conn), discoverGuardTours(conn), discoverOverlays(conn), discoverStreams(conn), discoverViews(conn),
    ]);
    return { ptz_presets, guard_tours, overlay_services, streams, views };
}

export async function fetchState(conn: Conn): Promise<CamState> {
    if (!conn.cameraIp) return { ok: false, streams: {}, overlays: {}, tours: {}, active_view: null };
    const [streams, overlays, tours] = await Promise.all([discoverStreams(conn), discoverOverlays(conn), discoverGuardTours(conn)]);
    const streamState: Record<string, boolean | null> = {};
    for (const s of streams.items) streamState[String(s.stream_id)] = s.enabled;
    const overlayState: Record<string, boolean | null> = {};
    for (const o of overlays.items) overlayState[String(o.service_id)] = o.enabled;
    const tourState: Record<string, boolean> = {};
    for (const t of tours.items) tourState[t.id] = t.running;
    const ok = streams.available || overlays.available || tours.available;
    return { ok, streams: streamState, overlays: overlayState, tours: tourState, active_view: null };
}

const PTZ = '/axis-cgi/com/ptz.cgi';
const bool = (v?: string) => (v === '1' || v === 'true' || v === 'on' || v === 'yes' ? '1' : '0');
const withCam = (q: string, cam?: string) => (cam ? `${q}&camera=${encodeURIComponent(cam)}` : q);

/** Stop any guard tour running on the given PTZ channel (keep one PTZ action at a time). */
async function stopToursOnChannel(conn: Conn, camera?: string): Promise<void> {
    const sec = await discoverGuardTours(conn);
    if (!sec.available) return;
    const ch = camera != null && camera !== '' ? parseInt(camera, 10) : null;
    for (const t of sec.items) {
        if (!t.running) continue;
        if (ch != null && t.channel != null && t.channel !== ch) continue;
        await camGet(conn, `/axis-cgi/param.cgi?action=update&GuardTour.${t.id}.Running=no`);
    }
}

export type CmdParams = Record<string, string>;

export async function sendCmd(conn: Conn, params: CmdParams): Promise<{ ok: boolean; error?: string }> {
    if (!conn.cameraIp) return { ok: false, error: 'Camera IP not set' };
    const a = params.action;
    let res: CamRes;
    switch (a) {
        case 'ptz.preset':
            await stopToursOnChannel(conn, params.camera);
            if (params.name) res = await camGet(conn, withCam(`${PTZ}?gotoserverpresetname=${encodeURIComponent(params.name)}`, params.camera));
            else if (params.no) res = await camGet(conn, withCam(`${PTZ}?gotoserverpresetno=${encodeURIComponent(params.no)}`, params.camera));
            else return { ok: false, error: 'preset requires name or no' };
            break;
        case 'ptz.home':
            await stopToursOnChannel(conn, params.camera);
            res = await camGet(conn, withCam(`${PTZ}?move=home`, params.camera));
            break;
        case 'guardtour.start':
            if (!params.guardtour_id) return { ok: false, error: 'guardtour.start requires guardtour_id' };
            await stopToursOnChannel(conn, params.camera);
            res = await camGet(conn, `/axis-cgi/param.cgi?action=update&GuardTour.${encodeURIComponent(params.guardtour_id)}.Running=yes`);
            break;
        case 'guardtour.stop':
            if (!params.guardtour_id) return { ok: false, error: 'guardtour.stop requires guardtour_id' };
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
async function overlayToggle(conn: Conn, id: number, want: boolean): Promise<{ ok: boolean; error?: string }> {
    const list = await camGet(conn, '/local/camoverlay/api/services.cgi?action=get');
    if (!list.ok) return { ok: false, error: `services.cgi get ${list.status}` };
    const data = tryParse(list.text);
    const services: any[] = Array.isArray(data?.services) ? data.services : Array.isArray(data) ? data : [];
    let found = false;
    for (const s of services) if (Number(s.id ?? s.service_id ?? s.serviceID) === id) { s.enabled = want ? 1 : 0; found = true; }
    if (!found) return { ok: false, error: `service ${id} not found` };
    const post = await camPost(conn, '/local/camoverlay/api/services.cgi?action=set', JSON.stringify({ services }));
    return { ok: post.ok, error: post.ok ? undefined : `services.cgi set ${post.status}` };
}
