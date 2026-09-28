import { ID, normalizeSettings, makeQuery, searchGoogle, evidencePrompt, disableNativeSearch } from './search.js';

const TYPES = new Set(['normal', 'regenerate', 'swipe', 'continue', '']);

export class SearchBridge {
    constructor(getContext, onChange = () => {}, search = searchGoogle) {
        this.getContext = getContext;
        this.onChange = onChange;
        this.searchImpl = search;
        this.state = { busy: false, result: null, pending: false, status: '填写问题，开始搜索。', error: false };
        this.revision = 0;
        this.controller = null;
        this.snapshot = null;
        this.resultChat = null;
        this.pendingResult = null;
        this.generationSearch = false;
    }
    get settings() { return normalizeSettings(this.getContext().extensionSettings[ID]); }
    chatKey() {
        const context = this.getContext();
        return JSON.stringify([context.groupId ?? '', context.characterId ?? '', context.chatId ?? '']);
    }
    update(patch) {
        Object.assign(this.state, patch);
        this.onChange(this.state);
    }
    clearPrompt() { this.getContext().setExtensionPrompt(ID, '', 1, 0, false, 1); }
    cancel() {
        this.revision++;
        this.controller?.abort();
        this.controller = null;
        this.update({ busy: false, status: '搜索已取消。' });
    }
    reset() {
        this.cancel();
        this.clearPrompt();
        this.pendingResult = null;
        this.resultChat = null;
        this.snapshot = null;
        this.update({ result: null, pending: false, status: '临时资料已清空。', error: false });
    }
    start(type, options, dryRun, hadInput) {
        if (dryRun || !TYPES.has(String(type || ''))) return;
        this.snapshot = { chat: this.chatKey(), hadInput, signal: options?.signal };
    }
    finish() {
        if (this.generationSearch) this.cancel();
        this.clearPrompt();
        this.snapshot = null;
    }
    async search(value, externalSignal) {
        if (this.state.busy) throw new Error('已有搜索正在进行，请等它结束或先取消。');
        const settings = this.settings;
        if (!settings.enabled) throw new Error('请先启用 Gemini 独立搜索。');
        const query = makeQuery(value, settings.topic);
        const context = this.getContext();
        const chat = this.chatKey();
        const revision = ++this.revision;
        const controller = new AbortController();
        this.controller = controller;
        let timedOut = false;
        const cancelFromHost = () => controller.abort();
        externalSignal?.addEventListener('abort', cancelFromHost, { once: true });
        if (externalSignal?.aborted) controller.abort();
        const timer = setTimeout(() => { timedOut = true; controller.abort(); }, settings.timeoutSeconds * 1000);
        this.pendingResult = null;
        this.update({ busy: true, result: null, pending: false, error: false, status: '正在独立调用 Google 搜索…' });
        try {
            const result = await this.searchImpl({ query, settings,
                hostSettings: context.chatCompletionSettings, headers: context.getRequestHeaders(), signal: controller.signal });
            controller.signal.throwIfAborted();
            if (revision !== this.revision || chat !== this.chatKey()) throw new DOMException('已切换聊天', 'AbortError');
            this.resultChat = chat;
            this.update({ result, status: `已取得 ${result.sources.length} 个来源；尚未交给正文。` });
            return result;
        } catch (error) {
            if (revision === this.revision) this.update({ error: true, status: timedOut
                ? '搜索超时。没有自动重试；可检查网络后手动再试。'
                : controller.signal.aborted ? '搜索已取消。' : String(error.message || '搜索失败，请检查网络。') });
            throw error;
        } finally {
            clearTimeout(timer);
            externalSignal?.removeEventListener('abort', cancelFromHost);
            if (revision === this.revision) {
                this.controller = null;
                this.update({ busy: false });
            }
        }
    }
    queue() {
        const context = this.getContext();
        if (!this.settings.enabled) throw new Error('请先启用扩展。');
        if (!context.chatId || context.groupId) throw new Error('请打开一个单人聊天，再把资料交给下一次回复。');
        if (context.mainApi !== 'openai') throw new Error('当前版本的正文连接需要使用“聊天补全”。');
        if (!this.state.result || this.resultChat !== this.chatKey()) throw new Error('请在当前聊天重新搜索资料。');
        this.pendingResult = { result: this.state.result, chat: this.chatKey() };
        this.update({ pending: true, error: false, status: '资料已准备好，将用于当前聊天的下一次回复。' });
    }
    async prepare(_chat, _size, abortGeneration, type) {
        if (!this.settings.enabled || !TYPES.has(String(type || ''))) return;
        this.clearPrompt();
        const context = this.getContext();
        const chat = this.chatKey();
        const snapshot = this.snapshot;
        this.snapshot = null;
        if (!context.chatId || context.groupId || context.mainApi !== 'openai') return;
        if (['normal', ''].includes(String(type || '')) && !snapshot?.hadInput) return;
        let result = this.pendingResult?.chat === chat ? this.pendingResult.result : null;
        if (!result && this.settings.autoSearch && ['normal', ''].includes(String(type || ''))
            && snapshot?.chat === chat && snapshot.hadInput) {
            const userMessage = context.chat.findLast(message => message.is_user && !message.is_system);
            if (!userMessage?.mes) return;
            this.generationSearch = true;
            try { result = await this.search(userMessage.mes, snapshot.signal); }
            catch {
                abortGeneration(true);
                if (chat === this.chatKey()) this.update({ status: `${this.state.status} 本轮正文未发送。` });
                return;
            }
            finally { this.generationSearch = false; }
        }
        if (!result || chat !== this.chatKey() || !this.settings.enabled) return;
        // USER / IN_CHAT / depth 0 keeps the stable system prefix and token budgeting intact.
        this.getContext().setExtensionPrompt(ID, evidencePrompt(result), 1, 0, false, 1);
        this.pendingResult = null;
        this.update({ pending: false, status: '资料已交给本轮正文，正文请求关闭原生联网。' });
    }
    requestReady(payload) {
        if (!this.settings.enabled || !TYPES.has(String(payload.type || ''))) return;
        disableNativeSearch(payload);
    }
}
