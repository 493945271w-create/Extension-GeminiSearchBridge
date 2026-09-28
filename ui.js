import { ID, normalizeSettings } from './search.js';

export function createPanel(bridge, context, target) {
    const panel = document.createElement('section');
    panel.id = ID;
    panel.innerHTML = `
      <details class="gsb-drawer" open>
        <summary><span>Gemini 独立搜索</span><span class="gsb-badge">资料 → 正文</span></summary>
        <div class="gsb-content">
          <label class="gsb-check"><input type="checkbox" data-setting="enabled">启用独立搜索</label>
          <p class="gsb-note">搜索模型只整理资料。启用期间，正文请求关闭原生联网。</p>
          <div class="gsb-grid">
            <label>搜索连接<select data-setting="provider"><option value="vertexai">Google Vertex AI</option><option value="makersuite">Google AI Studio</option></select></label>
            <label>搜索模型<input data-setting="model" type="text" maxlength="160" autocomplete="off"></label>
          </div>
          <p class="gsb-note" data-role="connection"></p>
          <label class="gsb-stack">搜索问题<textarea data-role="query" rows="3" maxlength="2000" placeholder="例如：某个人物的生平，有哪些原作依据？"></textarea></label>
          <div class="gsb-actions"><button type="button" data-action="search" class="gsb-primary">搜索资料</button><button type="button" data-action="cancel" hidden>取消</button><button type="button" data-action="clear">清空</button></div>
          <p class="gsb-status" data-role="status" role="status" aria-live="polite"></p>
          <section class="gsb-result" data-role="result" hidden>
            <div class="gsb-result-head"><strong>本次资料</strong><span data-role="result-info"></span></div>
            <p class="gsb-note" data-role="result-query"></p>
            <div data-role="answer" class="gsb-answer"></div>
            <details class="gsb-sources" open><summary data-role="source-count">来源</summary><ol data-role="sources"></ol></details>
            <details data-role="queries-box"><summary>Google 实际查询词</summary><div data-role="queries" class="gsb-note"></div></details>
            <div data-role="suggestions"></div>
            <div class="gsb-actions"><button type="button" data-action="queue" class="gsb-primary">交给下一次回复</button><button type="button" data-action="copy">复制资料</button></div>
          </section>
          <details class="gsb-options"><summary>自动检索与更多设置</summary>
            <label class="gsb-check"><input type="checkbox" data-setting="autoSearch">每次发送新消息前自动检索</label>
            <p class="gsb-note">默认关闭。开启后，每条新消息会作为查询交给 Google；只处理单人聊天的新消息，不自动重搜滑动、重新生成或续写。搜索失败时，本轮正文暂停发送。</p>
            <label class="gsb-stack">固定检索背景（可留空）<input data-setting="topic" maxlength="200" placeholder="例如：作品名称、只参考原作小说"></label>
            <div class="gsb-grid"><label>搜索输出上限（tokens）<input data-setting="maxTokens" type="number" min="1024" max="8192" step="512"></label><label>超时（秒）<input data-setting="timeoutSeconds" type="number" min="15" max="180"></label></div>
            <label class="gsb-check"><input data-setting="useProxy" type="checkbox">使用酒馆当前 Google 反代</label>
            <p class="gsb-note">反代选项仅在正文当前也是同一个 Google 来源时可用。未勾选时，使用酒馆保存的官方 Google 凭据。</p>
          </details>
          <p class="gsb-note gsb-foot">每次检索会产生独立的 Gemini API 用量，Google 可能执行多条搜索查询。资料仅保留在本页；切换聊天或刷新后清空。主模型自身是否思考仍取决于它的设置。</p>
        </div>
      </details>`;
    target.append(panel);
    const role = name => panel.querySelector(`[data-role="${name}"]`);
    let renderedResult;
    function connectionInfo() {
        const settings = bridge.settings;
        const host = context().chatCompletionSettings;
        const model = host[settings.provider === 'vertexai' ? 'vertexai_model' : 'google_model'];
        panel.querySelector('[data-setting="model"]').placeholder = model ? `留空沿用 ${model}` : '填入支持 Google Search 的模型 ID';
        role('connection').textContent = settings.provider === 'vertexai'
            ? `复用酒馆已保存的 Vertex 凭据 · 区域 ${host.vertexai_region || 'global'} · 认证 ${host.vertexai_auth_mode || 'express'}`
            : '复用酒馆已保存的 Google AI Studio 凭据。';
    }
    function render(state) {
        role('status').textContent = state.status;
        role('status').classList.toggle('gsb-error', state.error);
        panel.querySelector('[data-action="search"]').disabled = state.busy || !bridge.settings.enabled;
        panel.querySelector('[data-action="cancel"]').hidden = !state.busy;
        panel.querySelector('[data-action="queue"]').disabled = state.pending || !bridge.settings.enabled || state.busy;
        role('result').hidden = !state.result;
        if (renderedResult === state.result) return;
        renderedResult = state.result;
        role('sources').replaceChildren();
        role('suggestions').replaceChildren();
        if (!state.result) { role('answer').textContent = ''; return; }
        const result = state.result;
        role('answer').textContent = result.text;
        role('result-info').textContent = result.model;
        role('result-query').textContent = result.query;
        role('source-count').textContent = `来源（${result.sources.length}）`;
        for (const source of result.sources) {
            const item = document.createElement('li');
            const link = document.createElement('a');
            link.textContent = source.title;
            link.href = source.url;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            item.append(link);
            role('sources').append(item);
        }
        role('queries-box').hidden = !result.queries.length;
        role('queries').textContent = result.queries.join(' · ');
        if (result.suggestions) {
            const iframe = document.createElement('iframe');
            iframe.title = 'Google Search Suggestions';
            iframe.setAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox');
            iframe.referrerPolicy = 'no-referrer';
            iframe.srcdoc = '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src https: data:; font-src https:; base-uri \'none\'; form-action \'none\'; script-src \'none\'"></head><body>' + result.suggestions + '</body></html>';
            role('suggestions').append(iframe);
        }
    }
    for (const input of panel.querySelectorAll('[data-setting]')) {
        const name = input.dataset.setting;
        const value = bridge.settings[name];
        if (input.type === 'checkbox') input.checked = Boolean(value);
        else input.value = value;
        input.addEventListener('change', () => {
            const raw = input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value;
            context().extensionSettings[ID] = normalizeSettings({ ...bridge.settings, [name]: raw });
            context().saveSettingsDebounced();
            if (name === 'enabled' && !raw) bridge.reset();
            connectionInfo();
            render(bridge.state);
        });
    }
    const actions = {
        search: () => bridge.search(role('query').value), cancel: () => bridge.cancel(),
        clear: () => bridge.reset(), queue: () => bridge.queue(),
        copy: async () => {
            const result = bridge.state.result;
            if (!result) return;
            await navigator.clipboard.writeText(`${result.query}\n\n${result.text}\n\n来源\n${result.sources.map((source, index) => `${index + 1}. ${source.title}\n${source.url}`).join('\n')}`);
            bridge.update({ status: '资料已复制。' });
        },
    };
    for (const button of panel.querySelectorAll('[data-action]')) {
        button.addEventListener('click', async () => {
            try { await actions[button.dataset.action](); }
            catch (error) { if (error.name !== 'AbortError') bridge.update({ error: true, status: String(error.message || '操作失败。') }); }
        });
    }
    connectionInfo();
    render(bridge.state);
    return { render, connectionInfo, remove: () => panel.remove() };
}
