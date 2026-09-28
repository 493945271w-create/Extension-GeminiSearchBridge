import { ID, DEFAULTS, normalizeSettings } from './search.js';
import { SearchBridge } from './bridge.js';
import { createPanel } from './ui.js';

let bridge, view;
const disposers = [];
const context = () => globalThis.SillyTavern.getContext();

function listen(name, listener) {
    const host = context();
    const event = host.eventTypes[name];
    if (!event) throw new Error(`Gemini 独立搜索：酒馆缺少 ${name} 事件。`);
    host.eventSource.on(event, listener);
    disposers.push(() => host.eventSource.removeListener(event, listener));
}
function mount() {
    if (view) return;
    const target = document.querySelector('#extensions_settings2') || document.querySelector('#extensions_settings');
    if (target) view = createPanel(bridge, context, target);
}

export function onActivate() {
    if (bridge) return;
    const host = context();
    for (const name of ['getRequestHeaders', 'saveSettingsDebounced', 'setExtensionPrompt']) {
        if (typeof host[name] !== 'function') throw new Error(`Gemini 独立搜索：缺少酒馆能力 ${name}`);
    }
    if (!host.chatCompletionSettings || !host.extensionSettings || !host.eventSource) throw new Error('Gemini 独立搜索：酒馆接口不完整。');
    for (const name of ['GENERATION_STARTED', 'CHAT_COMPLETION_SETTINGS_READY', 'GENERATION_ENDED', 'GENERATION_STOPPED', 'CHAT_CHANGED', 'APP_READY', 'CHATCOMPLETION_SOURCE_CHANGED', 'CHATCOMPLETION_MODEL_CHANGED']) {
        if (!host.eventTypes?.[name]) throw new Error(`Gemini 独立搜索：酒馆缺少 ${name} 事件。`);
    }
    host.extensionSettings[ID] = normalizeSettings(host.extensionSettings[ID] || {
        ...DEFAULTS, provider: host.chatCompletionSettings.chat_completion_source === 'makersuite' ? 'makersuite' : 'vertexai',
    });
    bridge = new SearchBridge(context, state => view?.render(state));
    const interceptor = bridge.prepare.bind(bridge);
    globalThis.GeminiSearchBridge_Intercept = interceptor;
    disposers.push(() => {
        if (globalThis.GeminiSearchBridge_Intercept === interceptor) delete globalThis.GeminiSearchBridge_Intercept;
    });
    listen('GENERATION_STARTED', (type, options, dryRun) => bridge.start(type, options, dryRun,
        Boolean(document.querySelector('#send_textarea')?.value.trim())));
    listen('CHAT_COMPLETION_SETTINGS_READY', payload => bridge.requestReady(payload));
    listen('GENERATION_ENDED', () => bridge.finish());
    listen('GENERATION_STOPPED', () => { bridge.cancel(); bridge.finish(); });
    listen('CHAT_CHANGED', () => bridge.reset());
    listen('APP_READY', mount);
    listen('CHATCOMPLETION_SOURCE_CHANGED', () => view?.connectionInfo());
    listen('CHATCOMPLETION_MODEL_CHANGED', () => view?.connectionInfo());
    mount();
}

export function onDisable() {
    if (!bridge) return;
    for (const dispose of disposers.splice(0)) dispose();
    bridge.reset();
    bridge = null;
    view?.remove();
    view = null;
}
