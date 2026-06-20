import { TpClient, TpActionMessage, TpSetting } from './tp';
import { Conn, Catalog, CamState, discover, fetchState, sendCmd } from './camera';

const PLUGIN_ID = 'com.4xsdev.axis-tp';
const D = (s: string) => `${PLUGIN_ID}.data.${s}`;
const A = (s: string) => `${PLUGIN_ID}.act.${s}`;
const ST = (s: string) => `${PLUGIN_ID}.state.${s}`;

const tp = new TpClient(PLUGIN_ID);

let conn: Conn = {};
let catalog: Catalog | null = null;
let state: CamState | null = null;
let pollMs = 3000;
let pollTimer: NodeJS.Timeout | undefined;

// Tally blink: a fast timer flips a phase so live items can "blink" via state.
const BLINK_MS = 600;
let blinkTimer: NodeJS.Timeout | undefined;
let blinkPhase = false;

/** Maps the human label shown in a dropdown back to command parameters. */
type LabelMap = Map<string, Record<string, string>>;
const presetMap: LabelMap = new Map();
const tourMap: LabelMap = new Map();
const streamMap: LabelMap = new Map();   // label -> { stream_id }
const overlayMap: LabelMap = new Map();  // label -> { service_id }
const viewMap: LabelMap = new Map();     // label -> { name }

// id -> friendly name, so dynamic states show readable descriptions in TP.
const streamNames = new Map<string, string>();
const overlayNames = new Map<string, string>();
const tourNames = new Map<string, string>();

// Stable, name-derived key so buttons can bind to a state by the item's name
// (the label shown in the dropdown) instead of an internal id.
function slugify(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

// ---- settings ---------------------------------------------------------------
function applySettings(s: TpSetting): void {
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
async function refresh(): Promise<void> {
    if (!conn.cameraIp) {
        tp.stateUpdate(ST('connection'), 'error');
        tp.stateUpdate(ST('lastResult'), 'Camera IP not set');
        return;
    }
    try {
        catalog = await discover(conn);
    } catch (err) {
        tp.stateUpdate(ST('connection'), 'error');
        tp.stateUpdate(ST('lastResult'), err instanceof Error ? err.message : String(err));
        return;
    }

    // PTZ presets (+ Home per channel).
    presetMap.clear();
    const presetChoices: string[] = [];
    const channels = new Set<number | null>();
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
    } else {
        for (const ch of channels) {
            if (ch == null) continue;
            const label = `🏠 Home [cam ${ch}]`;
            presetMap.set(label, { action: 'ptz.home', camera: String(ch) });
            presetChoices.unshift(label);
        }
    }
    tp.choiceUpdate(D('preset'), presetChoices.length ? presetChoices : ['(none found)']);

    // Guard tours.
    tourMap.clear();
    tourNames.clear();
    const tourChoices: string[] = [];
    for (const t of catalog.guard_tours.items) {
        const label = t.channel != null ? `${t.name} [cam ${t.channel}]` : t.name;
        const params: Record<string, string> = { guardtour_id: t.id };
        if (t.channel != null) params.camera = String(t.channel);
        tourMap.set(label, params);
        tourNames.set(String(t.id), label);
        tourChoices.push(label);
    }
    tp.choiceUpdate(D('tour'), tourChoices.length ? tourChoices : ['(none found)']);

    // Streams.
    streamMap.clear();
    const streamChoices: string[] = [];
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
    const overlayChoices: string[] = [];
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
    const viewChoices: string[] = [];
    for (const v of catalog.views.items) {
        viewMap.set(v.label, { name: v.name });
        viewChoices.push(v.label);
    }
    tp.choiceUpdate(D('view'), viewChoices.length ? viewChoices : ['(none found)']);

    tp.log(`discovered: ${catalog.ptz_presets.items.length} presets, ${catalog.guard_tours.items.length} tours, ${catalog.streams.items.length} streams, ${catalog.overlay_services.items.length} overlays, ${catalog.views.items.length} views`);
    await poll();
}

// ---- polling → live state ---------------------------------------------------
async function poll(): Promise<void> {
    if (!conn.cameraIp) return;
    try {
        state = await fetchState(conn);
    } catch {
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

function startPolling(): void {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => void poll(), pollMs);
}

// Drives the per-stream TALLY state: alternates "blink"/"dark" while a stream
// is live so a button bound to it flashes; "idle" when the stream is off.
function tickTally(): void {
    blinkPhase = !blinkPhase;
    if (!state || !state.ok) return;
    for (const [id, on] of Object.entries(state.streams)) {
        const name = streamNames.get(String(id)) ?? `Stream ${id}`;
        const value = on === true ? (blinkPhase ? 'blink' : 'dark') : 'idle';
        tp.stateUpdate(ST(`tally.${slugify(name)}`), value);
    }
}

function startBlink(): void {
    if (blinkTimer) clearInterval(blinkTimer);
    blinkTimer = setInterval(tickTally, BLINK_MS);
}

// ---- action dispatch --------------------------------------------------------
function dataValue(msg: TpActionMessage, id: string): string {
    return msg.data.find((d) => d.id === id)?.value ?? '';
}

async function handleAction(msg: TpActionMessage): Promise<void> {
    let params: Record<string, string> | undefined;

    switch (msg.actionId) {
        case A('refresh'):
            await refresh();
            tp.stateUpdate(ST('lastResult'), 'refreshed');
            return;

        case A('preset'): {
            const label = dataValue(msg, D('preset'));
            params = presetMap.get(label);
            if (params) tp.stateUpdate(ST('activePreset'), label); // radio highlight
            break;
        }
        case A('guardtour'): {
            const label = dataValue(msg, D('tour'));
            const mode = dataValue(msg, D('gtmode'));
            const base = tourMap.get(label);
            if (base) params = { ...base, action: mode === 'Stop' ? 'guardtour.stop' : 'guardtour.start' };
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
function resolveToggle(mode: string, current: boolean | null): string {
    if (mode === 'On') return '1';
    if (mode === 'Off') return '0';
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
    if (pollTimer) clearInterval(pollTimer);
    if (blinkTimer) clearInterval(blinkTimer);
    process.exit(0);
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

tp.connect();
