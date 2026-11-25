/**
 * Настройки: LLM-провайдеры, маршрутизация операций, поиск, умолчания, расход.
 * Ключи показываются только маской — сервер не отдаёт их клиенту.
 */
import { api } from '../api.js';
import {
  h,
  clear,
  pageHead,
  field,
  toast,
  errorMessage,
  chip,
  fmtDate,
  fmtNumber,
  openModal,
  confirmDialog,
  busyState,
  banner,
  emptyState,
  checkbox,
  select,
  statusChip,
  CONNECTION_TEXT,
  MODE_LABELS,
} from '../ui.js';

const TABS = [
  { key: 'providers', label: 'LLM-провайдеры' },
  { key: 'routes', label: 'Маршрутизация' },
  { key: 'search', label: 'Поиск' },
  { key: 'defaults', label: 'Умолчания' },
  { key: 'usage', label: 'Использование' },
];

const TYPE_LABELS = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  openrouter: 'OpenRouter',
  omniroute: 'OmniRoute',
  custom: 'Совместимый API',
};

const PROTOCOL_HINTS = {
  'openai-chat': 'POST /chat/completions — самый распространённый вариант (OpenAI, OpenRouter, OmniRoute, vLLM, LM Studio).',
  'openai-responses': 'POST /responses — новый протокол OpenAI.',
  'anthropic-messages': 'POST /v1/messages — Anthropic Claude.',
  gemini: 'generateContent — Google Gemini.',
};

export async function renderSettings(container, params) {
  const tab = params.tab && TABS.some((item) => item.key === params.tab) ? params.tab : 'providers';

  let catalog = null;
  let health = null;
  try {
    [catalog, health] = await Promise.all([api.catalog(), api.health()]);
  } catch (error) {
    container.append(
      emptyState({
        title: 'Настройки недоступны',
        text: errorMessage(error),
        action: h('button', { class: 'btn', type: 'button', onclick: () => location.reload() }, 'Повторить'),
      }),
    );
    return;
  }

  const contentSlot = h('div', { class: 'stack gap-16' });
  const layout = h('div', { class: 'settings-layout' });

  function renderNav() {
    const nav = h('div', { class: 'settings-nav' });
    for (const item of TABS) {
      nav.append(
        h(
          'button',
          {
            class: tab === item.key ? 'active' : '',
            type: 'button',
            onclick: () => {
              location.hash = `#/settings/${item.key}`;
            },
          },
          item.label,
        ),
      );
    }
    return nav;
  }

  const statusBar = h(
    'div',
    { class: 'row gap-8 wrap' },
    chip(`провайдеров: ${health.providers?.enabled ?? 0}/${health.providers?.total ?? 0}`, (health.providers?.enabled ?? 0) > 0 ? 'ok' : 'warn'),
    chip(`поиск: ${health.search?.configured ? 'настроен' : 'нет'}`, health.search?.configured ? 'ok' : 'warn'),
    chip(`токен доступа: ${health.security?.tokenRequired ? 'включён' : 'выключен'}`, health.security?.tokenRequired ? 'info' : ''),
    health.security?.allowPrivateProviders ? chip('приватные адреса разрешены', 'warn') : null,
  );

  container.append(
    pageHead(
      'Настройки',
      'Провайдеры и модели выбираются здесь и не требуют правки кода. Ключи хранятся в зашифрованном виде и не возвращаются в интерфейс.',
      statusBar,
    ),
    h('div', { class: 'stack gap-16' }, layout),
  );
  layout.append(renderNav(), contentSlot);

  const reloadTab = () => {
    clear(contentSlot).append(h('div', { class: 'skeleton', style: { height: '120px' } }));
    const render = {
      providers: renderProviders,
      routes: renderRoutes,
      search: renderSearch,
      defaults: renderDefaults,
      usage: renderUsage,
    }[tab];
    void render(contentSlot);
  };

  reloadTab();

  /* ═══════════════════════════ Провайдеры ═══════════════════════════ */

  async function renderProviders(slot) {
    let data;
    try {
      data = await api.providers();
    } catch (error) {
      clear(slot).append(banner(errorMessage(error), 'warn'));
      return;
    }

    const { providers, defaultProviderId } = data;
    const list = h('div', { class: 'stack gap-8' });

    if (!providers.length) {
      list.append(
        emptyState({
          title: 'Провайдеры не подключены',
          text: 'Добавьте OpenAI-совместимый endpoint, OpenRouter, OmniRoute, Anthropic или Gemini. Без провайдера интервью и синтез работают в резервном режиме без модели.',
        }),
      );
    }

    for (const provider of providers) {
      list.append(providerCard(provider, provider.id === defaultProviderId, slot));
    }

    clear(slot).append(
      h(
        'div',
        { class: 'stack gap-16' },
        banner(
          h(
            'div',
            {},
            h('strong', {}, 'Ключи не покидают сервер. '),
            'Интерфейс получает только маску. Шифрование — AES-256-GCM, мастер-ключ хранится вне базы (data/master.key или APP_MASTER_KEY).',
          ),
        ),
        h(
          'div',
          { class: 'row-between' },
          h('div', { class: 'card-title' }, `Провайдеры (${providers.length})`),
          h('button', { class: 'btn btn-primary', type: 'button', onclick: () => openProviderDialog(null, slot) }, '+ Добавить провайдера'),
        ),
        list,
      ),
    );
  }

  function providerCard(provider, isDefault, slot) {
    const testSlot = h('div', { class: 'stack gap-8' });

    const testBtn = h('button', { class: 'btn btn-sm', type: 'button' }, 'Проверить');
    testBtn.addEventListener('click', async () => {
      const busy = busyState(testBtn);
      busy.start('Проверка…');
      clear(testSlot);
      try {
        const result = await api.testProvider(provider.id, provider.defaultModel || undefined);
        testSlot.append(renderConnectionResult(result));
      } catch (error) {
        testSlot.append(h('div', { class: 'status-line', dataset: { tone: 'error' } }, errorMessage(error)));
      } finally {
        busy.stop();
      }
    });

    const modelsBtn = h('button', { class: 'btn btn-sm', type: 'button' }, 'Модели');
    modelsBtn.addEventListener('click', async () => {
      const busy = busyState(modelsBtn);
      busy.start('…');
      clear(testSlot);
      try {
        const result = await api.providerModels(provider.id);
        testSlot.append(renderModels(result));
      } catch (error) {
        testSlot.append(h('div', { class: 'status-line', dataset: { tone: 'error' } }, errorMessage(error)));
      } finally {
        busy.stop();
      }
    });

    const defaultBtn = isDefault
      ? chip('по умолчанию', 'ok')
      : h(
          'button',
          {
            class: 'btn btn-sm btn-ghost',
            type: 'button',
            onclick: async () => {
              try {
                await api.setDefaultProvider(provider.id);
                toast('Провайдер назначен по умолчанию', 'ok');
                renderProviders(slot);
              } catch (error) {
                toast(errorMessage(error), 'error');
              }
            },
          },
          'Сделать основным',
        );

    const lastCheck = provider.lastCheck ?? {};

    return h(
      'div',
      { class: 'card' },
      h(
        'div',
        { class: 'row-between wrap', style: { alignItems: 'flex-start' } },
        h(
          'div',
          { class: 'stack gap-4', style: { minWidth: '0' } },
          h(
            'div',
            { class: 'row gap-8 wrap' },
            h('strong', { style: { fontSize: '14px' } }, provider.name),
            chip(TYPE_LABELS[provider.type] ?? provider.type, 'info'),
            chip(provider.protocol),
            provider.enabled ? null : chip('отключён', 'warn'),
            defaultBtn,
          ),
          h('div', { class: 'mono faint truncate', style: { fontSize: '11.5px' } }, provider.baseUrl),
          h(
            'div',
            { class: 'row gap-8 wrap', style: { fontSize: '11px' } },
            h('span', { class: 'faint' }, provider.defaultModel ? `модель: ${provider.defaultModel}` : 'модель не задана'),
            h('span', { class: 'faint' }, provider.hasApiKey ? `ключ: ${provider.apiKeyMasked}` : 'ключ не задан'),
            lastCheck.status ? h('span', { class: 'faint' }, `проверка: ${CONNECTION_TEXT[lastCheck.status] ?? lastCheck.status} · ${fmtDate(lastCheck.checkedAt)}`) : null,
          ),
        ),
        h(
          'div',
          { class: 'row gap-6 wrap' },
          testBtn,
          modelsBtn,
          h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => openProviderDialog(provider, slot) }, 'Изменить'),
          h(
            'button',
            {
              class: 'btn btn-sm btn-danger',
              type: 'button',
              onclick: async () => {
                const ok = await confirmDialog(`Провайдер «${provider.name}» будет удалён. Маршруты, ссылающиеся на него, потеряют привязку.`, {
                  title: 'Удалить провайдера',
                });
                if (!ok) return;
                try {
                  await api.deleteProvider(provider.id);
                  toast('Провайдер удалён', 'ok');
                  renderProviders(slot);
                } catch (error) {
                  toast(errorMessage(error), 'error');
                }
              },
            },
            'Удалить',
          ),
        ),
      ),
      testSlot,
    );
  }

  function renderConnectionResult(result) {
    const status = result.status;
    const tone = status === 'connected' ? 'ok' : 'error';
    const box = h(
      'div',
      { class: 'stack gap-8' },
      h(
        'div',
        { class: 'status-line', dataset: { tone } },
        h('strong', {}, CONNECTION_TEXT[status] ?? status),
        h('span', { style: { marginLeft: '8px' } }, result.summary ?? ''),
      ),
    );

    if (result.steps?.length) {
      const steps = h('div', { class: 'steps' });
      for (const step of result.steps) {
        const marker = step.status === 'ok' ? '✓' : step.status === 'failed' ? '✕' : '–';
        steps.append(
          h(
            'div',
            { class: 'step', dataset: { status: step.status } },
            h('span', { class: 'marker' }, marker),
            h('span', {}, `${step.name}: ${step.message}${step.durationMs ? ` (${step.durationMs} мс)` : ''}`),
          ),
        );
      }
      box.append(steps);
    }

    if (result.models?.length) box.append(renderModels({ models: result.models, supported: true }));
    if (result.reply) box.append(h('div', { class: 'faint', style: { fontSize: '11.5px' } }, `Ответ модели: «${result.reply}»`));
    if (status === 'model_not_found' && !result.modelUsed) {
      box.append(h('div', { class: 'hint' }, 'Укажите Model ID — без него тестовый запрос не выполняется.'));
    }
    return box;
  }

  function renderModels(result) {
    if (!result.models?.length) {
      return h(
        'div',
        { class: 'status-line', dataset: { tone: 'warn' } },
        result.message ?? 'Список моделей недоступен — введите Model ID вручную.',
      );
    }
    const box = h('div', { class: 'stack gap-4' });
    box.append(h('div', { class: 'faint', style: { fontSize: '11.5px' } }, `Моделей: ${result.models.length} (клик — скопировать ID)`));
    const row = h('div', { class: 'row gap-4 wrap', style: { maxHeight: '160px', overflowY: 'auto' } });
    for (const model of result.models.slice(0, 120)) {
      row.append(
        h(
          'button',
          {
            class: 'chip',
            type: 'button',
            style: { cursor: 'pointer' },
            onclick: () => {
              void navigator.clipboard?.writeText(model.id).then(
                () => toast(`Скопировано: ${model.id}`, 'ok'),
                () => toast(model.id, 'ok'),
              );
            },
          },
          model.id,
        ),
      );
    }
    box.append(row);
    return box;
  }

  function openProviderDialog(provider, slot) {
    const isEdit = Boolean(provider);
    const providerNames = [
      ...(catalog?.providerTypes ?? ['openai', 'anthropic', 'google', 'openrouter', 'omniroute', 'custom']),
    ].map((value) => ({ value, label: TYPE_LABELS[value] ?? value }));

    const nameInput = h('input', { type: 'text', value: provider?.name ?? '', placeholder: 'Например: OpenRouter', maxlength: 80 });
    const typeSelect = select(providerNames, provider?.type ?? 'openrouter');
    const protocolSelect = select(
      (catalog?.apiProtocols ?? ['openai-chat', 'openai-responses', 'anthropic-messages', 'gemini']).map((value) => ({
        value,
        label: value,
      })),
      provider?.protocol ?? 'openai-chat',
    );
    const baseUrlInput = h('input', { type: 'url', value: provider?.baseUrl ?? '', placeholder: 'https://openrouter.ai/api/v1' });
    const modelInput = h('input', { type: 'text', value: provider?.defaultModel ?? '', placeholder: 'например: openai/gpt-4.1-mini' });
    const apiKeyInput = h('input', {
      type: 'password',
      placeholder: isEdit ? (provider.hasApiKey ? `сохранён: ${provider.apiKeyMasked} — оставьте пустым, чтобы не менять` : 'ключ не задан') : 'sk-…',
      autocomplete: 'off',
    });
    const organizationInput = h('input', { type: 'text', value: provider?.organizationId ?? '', placeholder: 'необязательно' });
    const timeoutInput = h('input', { type: 'number', min: '1000', max: '600000', step: '1000', value: String(provider?.timeoutMs ?? 120000) });
    const retriesInput = h('input', { type: 'number', min: '0', max: '5', step: '1', value: String(provider?.maxRetries ?? 2) });
    const enabledInput = h('input', { type: 'checkbox', checked: provider?.enabled ?? true });
    const protocolHint = h('div', { class: 'hint' }, PROTOCOL_HINTS[protocolSelect.value] ?? '');
    protocolSelect.addEventListener('change', () => {
      protocolHint.textContent = PROTOCOL_HINTS[protocolSelect.value] ?? '';
    });

    const testSlot = h('div');
    const testBtn = h('button', { class: 'btn', type: 'button' }, 'Проверить до сохранения');
    testBtn.addEventListener('click', async () => {
      const busy = busyState(testBtn);
      busy.start('Проверка…');
      clear(testSlot);
      try {
        const result = await api.testProviderDraft({
          protocol: protocolSelect.value,
          baseUrl: baseUrlInput.value.trim(),
          apiKey: apiKeyInput.value.trim() || undefined,
          model: modelInput.value.trim(),
          defaultModel: modelInput.value.trim(),
          organizationId: organizationInput.value.trim() || undefined,
          timeoutMs: Number(timeoutInput.value) || 60000,
        });
        testSlot.append(renderConnectionResult(result));
      } catch (error) {
        testSlot.append(h('div', { class: 'status-line', dataset: { tone: 'error' } }, errorMessage(error)));
      } finally {
        busy.stop();
      }
    });

    const saveBtn = h('button', { class: 'btn btn-primary', type: 'button' }, isEdit ? 'Сохранить' : 'Добавить');
    const dialog = openModal({
      title: isEdit ? `Провайдер: ${provider.name}` : 'Новый провайдер',
      body: h(
        'div',
        { class: 'stack gap-4' },
        h(
          'div',
          { class: 'grid-2' },
          field('Название', nameInput),
          field('Тип', typeSelect, 'Влияет только на подписи — протокол задаёт способ вызова.'),
        ),
        field('Протокол API', protocolSelect),
        protocolHint,
        field('Base URL', baseUrlInput, 'Например https://api.openai.com/v1 или http://localhost:20128/v1'),
        h(
          'div',
          { class: 'grid-2' },
          field('Модель по умолчанию', modelInput, 'Model ID. Можно ввести вручную.'),
          field('API-ключ', apiKeyInput, isEdit ? 'Пустое поле — ключ не меняется.' : 'Хранится в зашифрованном виде.'),
        ),
        h(
          'div',
          { class: 'grid-3' },
          field('Организация', organizationInput),
          field('Таймаут, мс', timeoutInput),
          field('Повторы', retriesInput),
        ),
        h('label', { class: 'checkbox' }, enabledInput, 'Провайдер включён'),
        h('div', { class: 'row gap-8 mt-8' }, testBtn),
        testSlot,
      ),
      footer: h(
        'div',
        { class: 'row gap-8' },
        h('button', { class: 'btn', type: 'button', onclick: () => dialog.close() }, 'Отмена'),
        saveBtn,
      ),
      width: '700px',
    });

    saveBtn.addEventListener('click', async () => {
      const payload = {
        name: nameInput.value.trim(),
        type: typeSelect.value,
        protocol: protocolSelect.value,
        baseUrl: baseUrlInput.value.trim(),
        defaultModel: modelInput.value.trim(),
        organizationId: organizationInput.value.trim(),
        timeoutMs: Number(timeoutInput.value) || 120000,
        maxRetries: Number(retriesInput.value) || 0,
        enabled: enabledInput.checked,
      };
      if (!payload.name) {
        toast('Укажите название провайдера', 'error');
        return;
      }
      if (!payload.baseUrl) {
        toast('Укажите Base URL', 'error');
        return;
      }
      const apiKey = apiKeyInput.value.trim();

      const busy = busyState(saveBtn);
      busy.start('Сохранение…');
      try {
        if (isEdit) {
          await api.updateProvider(provider.id, { ...payload, ...(apiKey ? { apiKey } : {}) });
        } else {
          await api.createProvider({ ...payload, apiKey });
        }
        dialog.close();
        toast(isEdit ? 'Провайдер обновлён' : 'Провайдер добавлен', 'ok');
        renderProviders(slot);
      } catch (error) {
        toast(errorMessage(error), 'error');
        busy.stop();
      }
    });

    if (isEdit && provider.hasApiKey) {
      const clearBtn = h(
        'button',
        {
          class: 'btn btn-sm btn-ghost',
          type: 'button',
          onclick: async () => {
            const ok = await confirmDialog('Сохранённый API-ключ будет удалён.', { title: 'Удалить ключ', confirmLabel: 'Удалить ключ' });
            if (!ok) return;
            try {
              await api.updateProvider(provider.id, { clearApiKey: true });
              toast('Ключ удалён', 'ok');
              dialog.close();
              renderProviders(slot);
            } catch (error) {
              toast(errorMessage(error), 'error');
            }
          },
        },
        'Удалить сохранённый ключ',
      );
      dialog.element.querySelector('.modal-body')?.append(clearBtn);
    }
  }

  /* ═══════════════════════════ Маршрутизация ═══════════════════════════ */

  async function renderRoutes(slot) {
    let routesData;
    let providersData;
    try {
      [routesData, providersData] = await Promise.all([api.routes(), api.providers()]);
    } catch (error) {
      clear(slot).append(banner(errorMessage(error), 'warn'));
      return;
    }

    const providers = providersData.providers;
    const providerOptions = [
      { value: '', label: 'наследовать основной провайдер' },
      ...providers.map((provider) => ({ value: provider.id, label: provider.name })),
    ];

    if (!providers.length) {
      clear(slot).append(
        banner(
          h('div', {}, h('strong', {}, 'Сначала добавьте провайдера. '), 'Пока провайдеров нет, все операции работают в резервном режиме без модели.'),
          'warn',
        ),
      );
      return;
    }

    const rows = new Map();
    for (const route of routesData.routes) rows.set(route.operation, route);

    const body = h('tbody');
    for (const operation of routesData.operations) {
      const route = rows.get(operation.key) ?? {
        providerId: null,
        model: '',
        params: {},
        fallbackProviderId: null,
        fallbackModel: '',
        useFallback: false,
      };

      const providerSelect = select(providerOptions, route.providerId ?? '');
      const modelInput = h('input', {
        type: 'text',
        value: route.model ?? '',
        placeholder: 'Model ID',
        style: { minWidth: '160px' },
      });
      const temperature = h('input', {
        type: 'number',
        step: '0.1',
        min: '0',
        max: '2',
        value: route.params?.temperature !== undefined ? String(route.params.temperature) : '',
        placeholder: '—',
        style: { width: '76px' },
      });
      const maxTokens = h('input', {
        type: 'number',
        step: '100',
        min: '1',
        value: route.params?.maxOutputTokens !== undefined ? String(route.params.maxOutputTokens) : '',
        placeholder: '—',
        style: { width: '94px' },
      });
      const fallbackSelect = select(providerOptions, route.fallbackProviderId ?? '');
      const fallbackModel = h('input', {
        type: 'text',
        value: route.fallbackModel ?? '',
        placeholder: 'Model ID',
        style: { minWidth: '130px' },
      });
      const useFallback = h('input', { type: 'checkbox', checked: route.useFallback });

      const saveBtn = h('button', { class: 'btn btn-sm', type: 'button' }, 'Сохранить');
      saveBtn.addEventListener('click', async () => {
        const params = {};
        if (temperature.value.trim() !== '') params.temperature = Number(temperature.value);
        if (maxTokens.value.trim() !== '') params.maxOutputTokens = Number(maxTokens.value);

        const busy = busyState(saveBtn);
        busy.start('…');
        try {
          await api.saveRoute(operation.key, {
            providerId: providerSelect.value || null,
            model: modelInput.value.trim(),
            params,
            fallbackProviderId: fallbackSelect.value || null,
            fallbackModel: fallbackModel.value.trim(),
            useFallback: useFallback.checked,
          });
          toast(`Маршрут «${operation.label}» сохранён`, 'ok');
        } catch (error) {
          toast(errorMessage(error), 'error');
        } finally {
          busy.stop();
        }
      });

      body.append(
        h(
          'tr',
          {},
          h('td', {}, h('div', { style: { fontWeight: '600' } }, operation.label), h('div', { class: 'faint mono', style: { fontSize: '10.5px' } }, operation.key)),
          h('td', {}, providerSelect),
          h('td', {}, modelInput),
          h('td', {}, temperature),
          h('td', {}, maxTokens),
          h('td', {}, h('div', { class: 'stack gap-4' }, fallbackSelect, fallbackModel, h('label', { class: 'checkbox' }, useFallback, 'включён'))),
          h('td', {}, saveBtn),
        ),
      );
    }

    clear(slot).append(
      h(
        'div',
        { class: 'stack gap-16' },
        banner(
          h(
            'div',
            {},
            h('strong', {}, 'Каждая операция может идти на свою модель. '),
            'Пустой провайдер означает наследование основного. Дешёвые модели разумно ставить на анализ ответов и планирование вопросов, сильные — на синтез разделов и финальную сборку.',
          ),
        ),
        h('div', { class: 'table-wrap' }, h('table', {},
          h('thead', {}, h('tr', {},
            h('th', {}, 'Операция'),
            h('th', {}, 'Провайдер'),
            h('th', {}, 'Модель'),
            h('th', {}, 'temp'),
            h('th', {}, 'max tok'),
            h('th', {}, 'Fallback'),
            h('th', {}, ''),
          )),
          body,
        )),
      ),
    );
  }

  /* ═══════════════════════════ Поиск ═══════════════════════════ */

  async function renderSearch(slot) {
    let data;
    try {
      data = await api.searchProviders();
    } catch (error) {
      clear(slot).append(banner(errorMessage(error), 'warn'));
      return;
    }

    const types = catalog?.searchTypes ?? [];
    const list = h('div', { class: 'stack gap-8' });

    if (!data.providers.length) {
      list.append(
        emptyState({
          title: 'Поиск не настроен',
          text: 'Исследование разделов обращается к реальным источникам. Подключите Tavily, Brave, SerpAPI, Google CSE или собственный SearXNG. Без поиска синтез работает на требованиях и варианте модели — без выдуманных источников.',
        }),
      );
    }

    for (const provider of data.providers) {
      const availability = data.status?.find((item) => item.providerId === provider.id);
      const testSlot = h('div');
      const testBtn = h('button', { class: 'btn btn-sm', type: 'button' }, 'Пробный поиск');
      testBtn.addEventListener('click', async () => {
        const busy = busyState(testBtn);
        busy.start('Поиск…');
        clear(testSlot);
        try {
          const result = await api.testSearchProvider(provider.id, 'prompt engineering best practices');
          if (result.error) {
            testSlot.append(h('div', { class: 'status-line', dataset: { tone: 'error' } }, result.error));
          } else if (!result.hits?.length) {
            testSlot.append(h('div', { class: 'status-line', dataset: { tone: 'warn' } }, 'Поиск выполнен, но результатов нет.'));
          } else {
            const hits = h('div', { class: 'stack gap-8' });
            for (const hit of result.hits) {
              hits.append(
                h(
                  'div',
                  { class: 'source-item' },
                  h('a', { class: 'src-title', href: hit.url, target: '_blank', rel: 'noreferrer noopener' }, hit.title || hit.url),
                  h('div', { class: 'src-meta' }, h('span', {}, hit.url), h('span', {}, `${result.durationMs} мс`)),
                  hit.snippet ? h('div', { class: 'src-snippet' }, hit.snippet) : null,
                ),
              );
            }
            testSlot.append(h('div', { class: 'status-line', dataset: { tone: 'ok' } }, `Найдено: ${result.hits.length} · провайдер: ${result.providerName}`), hits);
          }
        } catch (error) {
          testSlot.append(h('div', { class: 'status-line', dataset: { tone: 'error' } }, errorMessage(error)));
        } finally {
          busy.stop();
        }
      });

      list.append(
        h(
          'div',
          { class: 'card' },
          h(
            'div',
            { class: 'row-between wrap', style: { alignItems: 'flex-start' } },
            h(
              'div',
              { class: 'stack gap-4' },
              h(
                'div',
                { class: 'row gap-8 wrap' },
                h('strong', { style: { fontSize: '14px' } }, provider.name),
                chip(provider.type, 'info'),
                provider.enabled ? null : chip('отключён', 'warn'),
                availability && !availability.available ? chip(availability.reason || 'недоступен', 'warn') : null,
                provider.hasApiKey ? chip(`ключ: ${provider.apiKeyMasked}`) : chip('без ключа', 'warn'),
              ),
              h('div', { class: 'mono faint truncate', style: { fontSize: '11.5px' } }, provider.baseUrl || 'базовый URL по умолчанию'),
            ),
            h(
              'div',
              { class: 'row gap-6 wrap' },
              testBtn,
              h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => openSearchDialog(provider, types, slot) }, 'Изменить'),
              h(
                'button',
                {
                  class: 'btn btn-sm btn-danger',
                  type: 'button',
                  onclick: async () => {
                    const ok = await confirmDialog(`Поисковый провайдер «${provider.name}» будет удалён.`, { title: 'Удалить провайдера' });
                    if (!ok) return;
                    try {
                      await api.deleteSearchProvider(provider.id);
                      toast('Провайдер удалён', 'ok');
                      renderSearch(slot);
                    } catch (error) {
                      toast(errorMessage(error), 'error');
                    }
                  },
                },
                'Удалить',
              ),
            ),
          ),
          testSlot,
        ),
      );
    }

    clear(slot).append(
      h(
        'div',
        { class: 'stack gap-16' },
        banner(
          h(
            'div',
            {},
            h('strong', {}, 'Источники только реальные. '),
            'Если поиск недоступен, раздел помечается как неисследованный, а синтез явно указывает, что опирается на требования и общую практику. Приложение не придумывает ссылки.',
          ),
        ),
        h(
          'div',
          { class: 'row-between' },
          h('div', { class: 'card-title' }, `Поисковые провайдеры (${data.providers.length})`),
          h('button', { class: 'btn btn-primary', type: 'button', onclick: () => openSearchDialog(null, types, slot) }, '+ Добавить'),
        ),
        list,
      ),
    );
  }

  function openSearchDialog(provider, types, slot) {
    const isEdit = Boolean(provider);
    const typeOptions = types.length
      ? types.map((item) => ({ value: item.type, label: `${item.label}${item.requiresKey ? ' · нужен ключ' : ''}` }))
      : (catalog?.searchProviderTypes ?? []).map((value) => ({ value, label: value }));

    const nameInput = h('input', { type: 'text', value: provider?.name ?? '', placeholder: 'Например: Tavily', maxlength: 80 });
    const typeSelect = select(typeOptions, provider?.type ?? 'tavily');
    const baseUrlInput = h('input', { type: 'url', value: provider?.baseUrl ?? '', placeholder: 'оставьте пустым для URL по умолчанию' });
    const apiKeyInput = h('input', {
      type: 'password',
      placeholder: isEdit && provider.hasApiKey ? `сохранён: ${provider.apiKeyMasked}` : 'API-ключ',
      autocomplete: 'off',
    });
    const optionsInput = h('textarea', {
      rows: 4,
      placeholder: '{"cx": "идентификатор поисковой системы"}',
      style: { fontFamily: 'var(--mono)', fontSize: '12px' },
    });
    if (provider?.options && Object.keys(provider.options).length) {
      optionsInput.value = JSON.stringify(provider.options, null, 2);
    }
    const enabledInput = h('input', { type: 'checkbox', checked: provider?.enabled ?? true });
    const hintSlot = h('div', { class: 'hint' });

    const updateHint = () => {
      const meta = types.find((item) => item.type === typeSelect.value);
      if (!meta) {
        hintSlot.textContent = '';
        return;
      }
      hintSlot.textContent = [
        meta.requiresKey ? 'требуется API-ключ' : 'ключ не обязателен',
        meta.defaultBaseUrl ? `URL по умолчанию: ${meta.defaultBaseUrl}` : 'нужен собственный URL',
      ].join(' · ');
      if (!baseUrlInput.value && meta.defaultBaseUrl) baseUrlInput.placeholder = meta.defaultBaseUrl;
    };
    typeSelect.addEventListener('change', updateHint);
    updateHint();

    const saveBtn = h('button', { class: 'btn btn-primary', type: 'button' }, isEdit ? 'Сохранить' : 'Добавить');
    const dialog = openModal({
      title: isEdit ? `Поиск: ${provider.name}` : 'Новый поисковый провайдер',
      body: h(
        'div',
        { class: 'stack gap-4' },
        h('div', { class: 'grid-2' }, field('Название', nameInput), field('Тип', typeSelect)),
        hintSlot,
        field('Base URL', baseUrlInput, 'Для SearXNG и собственных шлюзов.'),
        field('API-ключ', apiKeyInput, isEdit ? 'Пустое поле — ключ не меняется.' : 'Хранится в зашифрованном виде.'),
        field('Дополнительные параметры (JSON)', optionsInput, 'Например {"cx": "…"} для Google CSE или {"engine": "…"} для SearXNG.'),
        h('label', { class: 'checkbox' }, enabledInput, 'Провайдер включён'),
      ),
      footer: h(
        'div',
        { class: 'row gap-8' },
        h('button', { class: 'btn', type: 'button', onclick: () => dialog.close() }, 'Отмена'),
        saveBtn,
      ),
    });

    saveBtn.addEventListener('click', async () => {
      let options = {};
      if (optionsInput.value.trim()) {
        try {
          options = JSON.parse(optionsInput.value);
        } catch {
          toast('Параметры должны быть корректным JSON', 'error');
          return;
        }
      }
      const payload = {
        name: nameInput.value.trim(),
        type: typeSelect.value,
        baseUrl: baseUrlInput.value.trim(),
        options,
        enabled: enabledInput.checked,
      };
      if (!payload.name) {
        toast('Укажите название', 'error');
        return;
      }
      const apiKey = apiKeyInput.value.trim();

      const busy = busyState(saveBtn);
      busy.start('Сохранение…');
      try {
        if (isEdit) {
          await api.updateSearchProvider(provider.id, { ...payload, ...(apiKey ? { apiKey } : {}) });
        } else {
          await api.createSearchProvider({ ...payload, apiKey });
        }
        dialog.close();
        toast(isEdit ? 'Провайдер обновлён' : 'Провайдер добавлен', 'ok');
        renderSearch(slot);
      } catch (error) {
        toast(errorMessage(error), 'error');
        busy.stop();
      }
    });
  }

  /* ═══════════════════════════ Умолчания ═══════════════════════════ */

  async function renderDefaults(slot) {
    let data;
    try {
      data = await api.settings();
    } catch (error) {
      clear(slot).append(banner(errorMessage(error), 'warn'));
      return;
    }

    const defaults = data.defaults ?? {};
    const modeSelect = select(
      [
        { value: 'quick', label: 'Quick — быстро, без исследования' },
        { value: 'professional', label: 'Professional — исследование и контроль качества' },
        { value: 'expert', label: 'Expert — глубоко, с тестированием' },
      ],
      defaults.mode ?? 'professional',
    );
    const languageInput = h('input', { type: 'text', value: defaults.language ?? 'ru', maxlength: 8 });
    const sourcesInput = h('input', { type: 'number', min: '1', max: '10', value: String(defaults.maxSourcesPerSection ?? 4) });
    const thresholdInput = h('input', { type: 'number', min: '0', max: '100', value: String(defaults.qualityThreshold ?? 80) });
    const researchInput = h('input', { type: 'checkbox', checked: defaults.researchEnabled ?? true });
    const autoTestInput = h('input', { type: 'checkbox', checked: defaults.autoTest ?? false });

    const saveBtn = h('button', { class: 'btn btn-primary', type: 'button' }, 'Сохранить умолчания');
    saveBtn.addEventListener('click', async () => {
      const busy = busyState(saveBtn);
      busy.start('Сохранение…');
      try {
        await api.saveDefaults({
          mode: modeSelect.value,
          language: languageInput.value.trim() || 'ru',
          researchEnabled: researchInput.checked,
          maxSourcesPerSection: Number(sourcesInput.value) || 4,
          qualityThreshold: Number(thresholdInput.value) || 80,
          autoTest: autoTestInput.checked,
        });
        toast('Умолчания сохранены', 'ok');
      } catch (error) {
        toast(errorMessage(error), 'error');
      } finally {
        busy.stop();
      }
    });

    clear(slot).append(
      h(
        'div',
        { class: 'stack gap-16' },
        h(
          'div',
          { class: 'card card-pad-lg' },
          h('div', { class: 'card-title', style: { marginBottom: '14px' } }, 'Новый проект'),
          field('Режим по умолчанию', modeSelect),
          h('div', { class: 'grid-3' },
            field('Язык промта', languageInput, 'Код языка: ru, en.'),
            field('Источников на раздел', sourcesInput, '1–10.'),
            field('Порог качества', thresholdInput, '0–100. Ниже порога раздел считается требующим доработки.'),
          ),
          h('div', { class: 'stack gap-8 mt-8' },
            h('label', { class: 'checkbox' }, researchInput, 'Исследование разделов включено'),
            h('label', { class: 'checkbox' }, autoTestInput, 'Тестировать промт на целевой модели автоматически после сборки'),
          ),
          h('div', { class: 'row gap-8 mt-16' }, saveBtn),
        ),
        h(
          'div',
          { class: 'card' },
          h('div', { class: 'card-title', style: { marginBottom: '10px' } }, 'Среда'),
          h('div', { class: 'stack gap-8' },
            h('div', { class: 'row-between' }, h('span', { class: 'muted' }, 'Токен доступа (APP_TOKEN)'), statusChip(data.security?.tokenRequired ? 'ready' : 'not_started')),
            h('div', { class: 'row-between' }, h('span', { class: 'muted' }, 'Приватные адреса провайдеров'), statusChip(data.security?.allowPrivateProviders ? 'ready' : 'not_started')),
            h('div', { class: 'row-between' }, h('span', { class: 'muted' }, 'Мастер-ключ из окружения'), statusChip(data.security?.masterKeyFromEnv ? 'ready' : 'not_started')),
            h('div', { class: 'row-between' }, h('span', { class: 'muted' }, 'Версия'), h('span', { class: 'mono faint' }, data.version ?? '—')),
          ),
          h('p', { class: 'faint mt-12', style: { fontSize: '11.5px', margin: 0 } },
            'Приватные адреса разрешаются только при ALLOW_PRIVATE_PROVIDERS=1 — это нужно для локальных моделей (LM Studio, vLLM, Ollama).',
          ),
        ),
      ),
    );
  }

  /* ═══════════════════════════ Использование ═══════════════════════════ */

  async function renderUsage(slot) {
    let data;
    try {
      data = await api.usage();
    } catch (error) {
      clear(slot).append(banner(errorMessage(error), 'warn'));
      return;
    }

    const { summary, events } = data;

    const stats = h(
      'div',
      { class: 'grid-3' },
      statCard('Запросов к моделям', fmtNumber(summary.requests)),
      statCard('Ошибок', fmtNumber(summary.errors), summary.errors > 0 ? 'warn' : ''),
      statCard('Среднее время', `${fmtNumber(summary.avgDurationMs)} мс`),
      statCard('Входные токены', fmtNumber(summary.inputTokens)),
      statCard('Выходные токены', fmtNumber(summary.outputTokens)),
      statCard('Всего токенов', fmtNumber(summary.inputTokens + summary.outputTokens)),
    );

    const providerRows = h('tbody');
    for (const item of summary.byProvider ?? []) {
      providerRows.append(
        h('tr', {},
          h('td', {}, item.providerName || '—'),
          h('td', { class: 'mono faint' }, item.model || '—'),
          h('td', { class: 'num' }, fmtNumber(item.requests)),
          h('td', { class: 'num' }, fmtNumber(item.inputTokens)),
          h('td', { class: 'num' }, fmtNumber(item.outputTokens)),
          h('td', { class: 'num' }, item.errors ? h('span', { style: { color: 'var(--red)' } }, String(item.errors)) : '0'),
        ),
      );
    }
    if (!summary.byProvider?.length) {
      providerRows.append(h('tr', {}, h('td', { colspan: '6', class: 'faint' }, 'Пока нет запросов к моделям.')));
    }

    const operationRows = h('tbody');
    for (const item of summary.byOperation ?? []) {
      operationRows.append(
        h('tr', {},
          h('td', {}, item.operation),
          h('td', { class: 'num' }, fmtNumber(item.requests)),
          h('td', { class: 'num' }, fmtNumber(item.inputTokens)),
          h('td', { class: 'num' }, fmtNumber(item.outputTokens)),
          h('td', { class: 'num' }, item.errors ? h('span', { style: { color: 'var(--red)' } }, String(item.errors)) : '0'),
        ),
      );
    }
    if (!summary.byOperation?.length) {
      operationRows.append(h('tr', {}, h('td', { colspan: '5', class: 'faint' }, 'Пока нет запросов.')));
    }

    const eventRows = h('tbody');
    for (const event of (events ?? []).slice(0, 40)) {
      eventRows.append(
        h('tr', {},
          h('td', { class: 'nowrap faint' }, fmtDate(event.createdAt)),
          h('td', { class: 'mono' }, event.operation),
          h('td', {}, event.providerName || '—'),
          h('td', { class: 'mono faint truncate', style: { maxWidth: '180px' } }, event.model || '—'),
          h('td', { class: 'num' }, fmtNumber(event.inputTokens + event.outputTokens)),
          h('td', { class: 'num' }, `${fmtNumber(event.durationMs)} мс`),
          h('td', {}, event.status === 'ok' ? chip('ok', 'ok') : chip(event.status, event.status === 'error' ? 'error' : '')),
        ),
      );
    }
    if (!events?.length) {
      eventRows.append(h('tr', {}, h('td', { colspan: '7', class: 'faint' }, 'Журнал пуст.')));
    }

    clear(slot).append(
      h(
        'div',
        { class: 'stack gap-16' },
        stats,
        h('div', { class: 'card' },
          h('div', { class: 'card-title', style: { marginBottom: '10px' } }, 'По провайдерам и моделям'),
          h('div', { class: 'table-wrap' }, h('table', {},
            h('thead', {}, h('tr', {},
              h('th', {}, 'Провайдер'), h('th', {}, 'Модель'), h('th', { class: 'num' }, 'Запросов'),
              h('th', { class: 'num' }, 'Вход'), h('th', { class: 'num' }, 'Выход'), h('th', { class: 'num' }, 'Ошибок'),
            )),
            providerRows,
          )),
        ),
        h('div', { class: 'card' },
          h('div', { class: 'card-title', style: { marginBottom: '10px' } }, 'По операциям'),
          h('div', { class: 'table-wrap' }, h('table', {},
            h('thead', {}, h('tr', {},
              h('th', {}, 'Операция'), h('th', { class: 'num' }, 'Запросов'),
              h('th', { class: 'num' }, 'Вход'), h('th', { class: 'num' }, 'Выход'), h('th', { class: 'num' }, 'Ошибок'),
            )),
            operationRows,
          )),
        ),
        h('div', { class: 'card' },
          h('div', { class: 'card-title', style: { marginBottom: '10px' } }, 'Последние запросы'),
          h('div', { class: 'table-wrap' }, h('table', {},
            h('thead', {}, h('tr', {},
              h('th', {}, 'Время'), h('th', {}, 'Операция'), h('th', {}, 'Провайдер'),
              h('th', {}, 'Модель'), h('th', { class: 'num' }, 'Токены'), h('th', { class: 'num' }, 'Время, мс'), h('th', {}, 'Статус'),
            )),
            eventRows,
          )),
        ),
      ),
    );
  }

  function statCard(label, value, tone = '') {
    return h(
      'div',
      { class: 'card' },
      h('div', { class: 'faint', style: { fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.4px' } }, label),
      h('div', { style: { fontSize: '22px', fontWeight: '700', marginTop: '4px' }, dataset: tone ? { tone } : {} }, value),
    );
  }

  return () => {
    // Ничего не удерживаем: все запросы завершаются самостоятельно.
  };
}

export { MODE_LABELS, checkbox };
