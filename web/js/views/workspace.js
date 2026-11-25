/**
 * Рабочее пространство проекта: разделы · диалог · инспектор.
 * Все действия идут через API; состояние перечитывается после мутаций.
 */
import { api, streamSectionPipeline } from '../api.js';
import {
  h,
  clear,
  toast,
  errorMessage,
  field,
  md,
  chip,
  statusChip,
  progressBar,
  busyState,
  fmtDate,
  fmtNumber,
  openModal,
  confirmDialog,
  scoreValue,
  MODE_LABELS,
  STATUS_TEXT,
  CONNECTION_TEXT,
  banner,
  emptyState,
  select,
} from '../ui.js';

const TABS = [
  { key: 'draft', label: 'Черновик' },
  { key: 'quality', label: 'Качество' },
  { key: 'sources', label: 'Источники' },
  { key: 'research', label: 'Исследование' },
];

export async function renderWorkspace(container, params) {
  const projectId = params.id;
  let data = await api.getProject(projectId);
  let activeKey = params.section && data.sections.some((s) => s.key === params.section)
    ? params.section
    : data.sections[0]?.key ?? null;
  let activeTab = 'draft';
  let pipelineHandle = null;
  let streaming = false;

  const root = h('div', { class: 'stack gap-16' });
  container.append(root);

  /* ─────────────────────────── Шапка ─────────────────────────── */

  const headerSlot = h('div');
  const sectionsSlot = h('div', { class: 'panel-body' });
  const chatSlot = h('div', { class: 'chat' });
  const inspectorSlot = h('div', { class: 'inspector' });

  const sectionsPanel = h(
    'div',
    { class: 'panel' },
    h('div', { class: 'panel-head' }, h('div', { class: 'panel-title' }, 'Разделы'), h('span', { class: 'faint', id: 'sections-count' }, '')),
    sectionsSlot,
  );

  const chatPanel = h('div', { class: 'panel' }, chatSlot);
  const workspace = h('div', { class: 'workspace' }, sectionsPanel, chatPanel, inspectorSlot);
  root.append(headerSlot, workspace);

  /* ─────────────────────────── Загрузка ─────────────────────────── */

  async function reload({ keepScroll = true } = {}) {
    const scrollTop = chatScroll?.scrollTop ?? 0;
    data = await api.getProject(projectId);
    if (!data.sections.some((section) => section.key === activeKey)) {
      activeKey = data.sections[0]?.key ?? null;
    }
    renderHeader();
    renderSections();
    renderChat(keepScroll ? scrollTop : undefined);
    renderInspector();
  }

  function currentSection() {
    return data.sections.find((section) => section.key === activeKey) ?? null;
  }

  /* ─────────────────────────── Шапка ─────────────────────────── */

  function renderHeader() {
    const { project, sections, progress, policy } = data;
    const statusChips = h(
      'div',
      { class: 'row gap-6 wrap' },
      chip(MODE_LABELS[project.mode] ?? project.mode, 'info'),
      statusChip(project.status),
      project.targetModel ? chip(`модель: ${project.targetModel}`) : null,
      chip(`${progress.ready}/${progress.total} разделов`, progress.ready === progress.total && progress.total > 0 ? 'ok' : ''),
    );

    const assembleBtn = h('button', { class: 'btn btn-primary', type: 'button' }, 'Собрать промт');
    const testBtn = h('button', { class: 'btn', type: 'button' }, 'Тестировать');
    const versionsBtn = h('button', { class: 'btn', type: 'button' }, `Версии${data.versions.length ? ` (${data.versions.length})` : ''}`);
    const exportBtn = h('button', { class: 'btn', type: 'button' }, 'Экспорт');
    const settingsBtn = h('button', { class: 'btn btn-ghost btn-icon', type: 'button', title: 'Настройки проекта' }, '⚙');

    assembleBtn.addEventListener('click', () => void runAssemble(assembleBtn));
    testBtn.addEventListener('click', () => void openTestDialog(testBtn));
    versionsBtn.addEventListener('click', () => openVersions());
    exportBtn.addEventListener('click', () => openExport());
    settingsBtn.addEventListener('click', () => openProjectSettings());

    clear(headerSlot).append(
      h(
        'div',
        { class: 'page-head', style: { marginBottom: '0' } },
        h(
          'div',
          { style: { minWidth: '0' } },
          h(
            'div',
            { class: 'row gap-8', style: { alignItems: 'center' } },
            h('h1', { class: 'truncate', style: { maxWidth: '70ch' } }, project.title),
            h('button', {
              class: 'btn btn-ghost btn-sm',
              type: 'button',
              title: 'Переименовать',
              onclick: () => openProjectSettings(),
            }, 'изменить'),
          ),
          h('p', { style: { marginTop: '6px' } }, project.idea.length > 320 ? `${project.idea.slice(0, 320)}…` : project.idea),
          h('div', { class: 'row gap-8 mt-8 wrap' }, statusChips),
        ),
        h('div', { class: 'stack gap-8', style: { alignItems: 'flex-end' } },
          h('div', { class: 'row gap-8 wrap' }, assembleBtn, testBtn, versionsBtn, exportBtn, settingsBtn),
          h('div', { class: 'faint', style: { fontSize: '11px', textAlign: 'right' } }, data.modeNotice),
        ),
      ),
      h('div', { class: 'mt-12' }, progressBar(progress.percent)),
    );
    void policy;
  }

  /* ─────────────────────────── Разделы ─────────────────────────── */

  function renderSections() {
    clear(sectionsSlot);
    const nav = h('div', { class: 'sections-nav' });
    const counter = document.getElementById('sections-count');
    if (counter) counter.textContent = `${data.sections.length}`;

    for (const section of data.sections) {
      const dot = h('span', { class: 'dot' });
      nav.append(
        h(
          'button',
          {
            class: `section-item${section.key === activeKey ? ' active' : ''}`,
            dataset: { status: section.status },
            type: 'button',
            onclick: () => {
              if (streaming) {
                toast('Дождитесь завершения текущей операции', 'error');
                return;
              }
              activeKey = section.key;
              renderSections();
              renderChat();
              renderInspector();
            },
          },
          h('span', { class: 'name' }, section.title.split(' — ')[0]),
          h(
            'span',
            { class: 'meta' },
            dot,
            STATUS_TEXT[section.status] ?? section.status,
            section.quality ? h('span', {}, ` · ${Math.round(section.quality.total)}`) : null,
            section.alternatives?.length ? h('span', {}, ` · ${section.alternatives.length} вар.`) : null,
          ),
        ),
      );
    }
    sectionsSlot.append(nav);
  }

  /* ─────────────────────────── Диалог ─────────────────────────── */

  const composerInput = h('textarea', {
    rows: 3,
    placeholder: 'Ответьте на вопрос или уточните требование…  Ctrl+Enter — отправить',
  });
  const sendBtn = h('button', { class: 'btn btn-primary', type: 'button' }, 'Отправить');
  const askBtn = h('button', { class: 'btn', type: 'button' }, 'Вопросы');
  const researchBtn = h('button', { class: 'btn', type: 'button' }, 'Исследовать');
  const synthBtn = h('button', { class: 'btn', type: 'button' }, 'Синтезировать');
  const pipelineBtn = h('button', { class: 'btn', type: 'button' }, 'Полный цикл');

  let chatScroll = null;

  function sectionMessages() {
    if (!activeKey) return [];
    return data.messages.filter((message) => message.sectionKey === activeKey || (message.sectionKey === '' && message.kind === 'event'));
  }

  function renderChat(scrollTop) {
    clear(chatSlot);
    chatScroll = h('div', { class: 'chat-scroll' });
    chatSlot.append(chatScroll);

    const messages = sectionMessages();
    const section = currentSection();

    if (!section) {
      chatScroll.append(
        emptyState({
          title: 'Нет разделов',
          text: 'Проект ещё не инициализирован. Запустите планирование, чтобы получить структуру промта.',
          action: h('button', {
            class: 'btn btn-primary',
            type: 'button',
            onclick: async (event) => {
              const busy = busyState(event.currentTarget);
              busy.start('Планируем…');
              try {
                await api.initialize(projectId);
                toast('План готов', 'ok');
                await reload();
              } catch (error) {
                toast(errorMessage(error), 'error');
                busy.stop();
              }
            },
          }, 'Составить план'),
        }),
      );
      renderComposer(null);
      return;
    }

    if (!messages.length) {
      chatScroll.append(
        h(
          'div',
          { class: 'chat-empty' },
          h('div', { style: { fontSize: '13px' } }, `Раздел «${section.title}»`),
          h(
            'p',
            { style: { marginTop: '8px' } },
            'Получите вопросы интервью или сразу перейдите к исследованию и синтезу. Ответы на вопросы становятся требованиями раздела.',
          ),
        ),
      );
    }

    for (const message of messages) chatScroll.append(renderMessage(message));

    renderComposer(section);

    if (scrollTop !== undefined) chatScroll.scrollTop = scrollTop;
    else chatScroll.scrollTop = chatScroll.scrollHeight;
  }

  function renderMessage(message) {
    const meta = message.meta ?? {};
    const role = message.role === 'user' ? 'user' : 'assistant';
    const kind = message.kind ?? 'chat';

    const options = Array.isArray(meta.options) ? meta.options : [];
    const optionsBox = options.length
      ? h(
          'div',
          { class: 'msg-options' },
          options.map((option, index) =>
            h(
              'button',
              {
                class: 'msg-option',
                type: 'button',
                onclick: () => {
                  const text = option.description ? `${option.label} — ${option.description}` : option.label;
                  composerInput.value = composerInput.value ? `${composerInput.value}\n${text}` : text;
                  composerInput.focus();
                },
              },
              h('strong', {}, `${index + 1}. ${option.label ?? ''}`),
              option.description ? ` — ${option.description}` : '',
            ),
          ),
        )
      : null;

    let body;
    if (kind === 'question' || kind === 'note') body = md(message.content);
    else body = md(message.content);

    const attribution = [meta.providerName, meta.model].filter(Boolean).join(' · ');

    return h(
      'div',
      { class: 'msg', dataset: { role, kind } },
      h('div', { class: 'msg-bubble' }, body, optionsBox),
      h(
        'div',
        { class: 'msg-meta' },
        [
          kind === 'question' ? 'вопрос' : kind === 'note' ? 'заметка' : kind === 'event' ? 'событие' : role === 'user' ? 'вы' : 'ассистент',
          attribution ? ` · ${attribution}` : '',
          meta.source === 'heuristic' ? ' · эвристика' : '',
          ` · ${new Date(message.createdAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`,
        ].join(''),
      ),
    );
  }

  function renderComposer(section) {
    chatSlot.querySelector('.chat-compose')?.remove();
    const disabled = !section || streaming;

    const compose = h(
      'div',
      { class: 'chat-compose' },
      composerInput,
      h(
        'div',
        { class: 'row gap-8 wrap' },
        sendBtn,
        h('div', { class: 'grow' }),
        askBtn,
        researchBtn,
        synthBtn,
        pipelineBtn,
      ),
      section
        ? h(
            'div',
            { class: 'faint', style: { fontSize: '11px' } },
            `Ответы сохраняются в требования раздела. Раздел: ${section.title}`,
          )
        : null,
    );

    sendBtn.disabled = disabled || composerInput.value.trim().length === 0;
    askBtn.disabled = disabled;
    researchBtn.disabled = disabled;
    synthBtn.disabled = disabled;
    pipelineBtn.disabled = disabled;

    chatSlot.append(compose);
  }

  composerInput.addEventListener('input', () => {
    sendBtn.disabled = streaming || !currentSection() || composerInput.value.trim().length === 0;
  });

  composerInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void submitAnswer();
    }
  });

  sendBtn.addEventListener('click', () => void submitAnswer());

  /** Отправка ответа и автоматический запрос следующего вопроса. */
  async function submitAnswer() {
    const section = currentSection();
    const answer = composerInput.value.trim();
    if (!section || !answer) return;

    const busy = busyState(sendBtn);
    busy.start('Отправка…');
    try {
      await api.submitAnswer(projectId, section.key, answer);
      composerInput.value = '';
      const ids = [...document.querySelectorAll('.msg[data-kind="question"]')];
      void ids;
      await reload({ keepScroll: false });

      // Продолжаем опрос, если раздел ещё не готов.
      const updated = currentSection();
      if (updated && ['awaiting_answer', 'needs_clarification', 'not_started'].includes(updated.status)) {
        try {
          await api.askQuestions(projectId, section.key);
          await reload({ keepScroll: false });
        } catch {
          /* вопросы — необязательный шаг: ответ уже сохранён */
        }
      }
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      busy.stop();
      composerInput.focus();
    }
  }

  askBtn.addEventListener('click', async () => {
    const section = currentSection();
    if (!section) return;
    const busy = busyState(askBtn);
    busy.start('Вопросы…');
    try {
      const result = await api.askQuestions(projectId, section.key);
      await reload({ keepScroll: false });
      if (!result.questions?.length) {
        toast('Вопросов больше нет — можно синтезировать раздел', 'ok');
      }
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      busy.stop();
    }
  });

  researchBtn.addEventListener('click', async () => {
    const section = currentSection();
    if (!section) return;
    const busy = busyState(researchBtn);
    busy.start('Поиск…');
    try {
      const outcome = await api.research(projectId, section.key, true);
      const status = outcome.research?.status;
      if (status === 'done') {
        toast(`Найдено источников: ${outcome.sources?.length ?? 0}`, 'ok');
      } else {
        toast(outcome.research?.message || 'Исследование недоступно', 'error');
      }
      await reload();
      activeTab = 'sources';
      renderInspector();
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      busy.stop();
    }
  });

  synthBtn.addEventListener('click', async () => {
    const section = currentSection();
    if (!section) return;
    const busy = busyState(synthBtn);
    busy.start('Синтез…');
    try {
      const result = await api.synthesize(projectId, section.key);
      toast(`Раздел синтезирован. Оценка: ${result.quality?.total ?? '—'}`, 'ok');
      if (result.affected?.length) {
        toast(`Помечены как требующие пересмотра: ${result.affected.length}`, 'warn');
      }
      await reload();
      activeTab = 'draft';
      renderInspector();
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      busy.stop();
    }
  });

  pipelineBtn.addEventListener('click', () => {
    const section = currentSection();
    if (!section || streaming) return;
    startPipeline(section);
  });

  /** Потоковый полный цикл: исследование → синтез → качество. */
  function startPipeline(section) {
    streaming = true;
    renderSections();
    renderChat();
    renderInspector();

    const log = h('div', { class: 'stack gap-8' });
    const states = {
      research: h('div', { class: 'step', dataset: { status: 'pending' } }, h('span', { class: 'marker' }, '·'), 'Исследование'),
      synthesis: h('div', { class: 'step', dataset: { status: 'pending' } }, h('span', { class: 'marker' }, '·'), 'Синтез раздела'),
      quality: h('div', { class: 'step', dataset: { status: 'pending' } }, h('span', { class: 'marker' }, '·'), 'Контроль качества'),
    };
    log.append(states.research, states.synthesis, states.quality);

    const cancelBtn = h('button', { class: 'btn btn-sm', type: 'button' }, 'Прервать');
    const dialog = openModal({
      title: `Полный цикл: ${section.title}`,
      body: h('div', { class: 'stack gap-12' }, log, h('div', { class: 'faint', style: { fontSize: '11.5px' } }, 'События приходят по мере выполнения.')),
      footer: h('div', { class: 'row' }, cancelBtn),
      width: '560px',
    });

    const finish = async (message, tone) => {
      streaming = false;
      pipelineHandle = null;
      if (message) toast(message, tone);
      try {
        await reload();
      } catch {
        /* состояние перечитается при следующем действии */
      }
      cancelBtn.textContent = 'Закрыть';
      cancelBtn.onclick = () => dialog.close();
    };

    cancelBtn.addEventListener('click', () => {
      if (pipelineHandle) {
        pipelineHandle.cancel();
        pipelineHandle = null;
        void finish('Цикл прерван пользователем', 'warn');
      } else {
        dialog.close();
      }
    });

    pipelineHandle = streamSectionPipeline(projectId, section.key, {
      onEvent(event) {
        if (event.type === 'start') {
          log.append(h('div', { class: 'faint', style: { fontSize: '11.5px' } }, 'Запуск…'));
        } else if (event.type === 'step') {
          const key = event.step === 'research' ? 'research' : 'synthesis';
          const el = states[key];
          if (el) {
            el.dataset.status = 'ok';
            el.querySelector('.marker').textContent = '▸';
            el.lastChild.textContent = ` ${event.message}`;
          }
        } else if (event.type === 'research') {
          const el = states.research;
          const failed = event.status !== 'done';
          el.dataset.status = failed ? 'skipped' : 'ok';
          el.querySelector('.marker').textContent = failed ? '!' : '✓';
          el.lastChild.textContent = ` Исследование: ${event.message} (источников: ${event.sources ?? 0}, выводов: ${(event.findings ?? []).length})`;
        } else if (event.type === 'section') {
          states.synthesis.dataset.status = 'ok';
          states.synthesis.querySelector('.marker').textContent = '✓';
          states.synthesis.lastChild.textContent = ' Синтез выполнен';
          states.quality.dataset.status = 'ok';
          states.quality.querySelector('.marker').textContent = '✓';
          states.quality.lastChild.textContent = ` Оценка: ${event.quality?.total ?? '—'} (${STATUS_TEXT[event.quality?.verdict] ?? event.quality?.verdict ?? '—'})`;
          if (event.affected?.length) {
            log.append(
              h('div', { class: 'issue' }, `Затронуты зависимые разделы: ${event.affected.map((item) => item.title ?? item.key).join(', ')}`),
            );
          }
        } else if (event.type === 'done') {
          void finish('Цикл завершён', 'ok');
        }
      },
      onError(error) {
        log.append(h('div', { class: 'status-line', dataset: { tone: 'error' } }, `Ошибка: ${error.message}`));
        void finish(`Ошибка: ${error.message}`, 'error');
      },
      onDone() {
        if (streaming) void finish('Цикл завершён', 'ok');
      },
    });
  }

  /* ─────────────────────────── Инспектор ─────────────────────────── */

  function renderInspector() {
    clear(inspectorSlot);
    const section = currentSection();
    if (!section) {
      inspectorSlot.append(
        h('div', { class: 'panel' }, h('div', { class: 'panel-body' }, h('p', { class: 'faint' }, 'Выберите раздел.'))),
      );
      return;
    }

    const tabs = h(
      'div',
      { class: 'tabs' },
      TABS.map((tab) =>
        h(
          'button',
          {
            class: `tab${tab.key === activeTab ? ' active' : ''}`,
            type: 'button',
            onclick: () => {
              activeTab = tab.key;
              renderInspector();
            },
          },
          tab.label,
          tab.key === 'sources' && section.research.sourceIds?.length ? ` (${section.research.sourceIds.length})` : '',
        ),
      ),
    );

    const body = h('div', { class: 'tab-body' });
    if (activeTab === 'draft') renderDraftTab(body, section);
    else if (activeTab === 'quality') renderQualityTab(body, section);
    else if (activeTab === 'sources') renderSourcesTab(body, section);
    else renderResearchTab(body, section);

    inspectorSlot.append(
      h(
        'div',
        { class: 'panel' },
        h(
          'div',
          { class: 'panel-head' },
          h('div', { class: 'panel-title' }, section.title.split(' — ')[0]),
          statusChip(section.status),
        ),
        tabs,
        body,
      ),
    );
  }

  function renderDraftTab(body, section) {
    const actions = h(
      'div',
      { class: 'row gap-6 wrap', style: { marginBottom: '10px' } },
      h('button', {
        class: 'btn btn-sm',
        type: 'button',
        onclick: () => openDraftEditor(section),
      }, 'Редактировать'),
      section.content
        ? h('button', {
            class: 'btn btn-sm',
            type: 'button',
            onclick: async (event) => {
              const busy = busyState(event.currentTarget);
              busy.start('…');
              try {
                await api.synthesize(projectId, section.key, {
                  feedback: window.prompt('Что улучшить в разделе?') ?? '',
                });
                await reload();
                toast('Раздел переработан', 'ok');
              } catch (error) {
                toast(errorMessage(error), 'error');
              } finally {
                busy.stop();
              }
            },
          }, 'Переработать')
        : null,
      h('button', {
        class: 'btn btn-sm btn-ghost',
        type: 'button',
        onclick: () => copyText(section.content),
      }, 'Копировать'),
    );

    body.append(actions);
    body.append(h('div', { class: 'draft-box' }, section.content || ''));

    if (section.summary) {
      body.append(h('div', { class: 'mt-12' }, h('div', { class: 'card-title' }, 'Резюме'), h('p', { class: 'muted', style: { fontSize: '12px', marginTop: '4px' } }, section.summary)));
    }

    if (section.requirements?.length) {
      body.append(
        h(
          'details',
          { class: 'accordion mt-12' },
          h('summary', {}, `Требования (${section.requirements.length})`),
          h(
            'div',
            { class: 'acc-body' },
            h('div', { class: 'checklist' }, section.requirements.map((item) => h('div', { class: 'check' }, h('span', {}, '·'), h('span', {}, item)))),
          ),
        ),
      );
    }

    if (section.alternatives?.length) {
      body.append(
        h('div', { class: 'mt-12' }, h('div', { class: 'card-title' }, `Варианты (${section.alternatives.length})`)),
        h(
          'div',
          { class: 'stack gap-8 mt-8' },
          section.alternatives.map((alternative, index) =>
            h(
              'details',
              { class: 'accordion' },
              h('summary', {}, alternative.label || `Вариант ${index + 1}`),
              h(
                'div',
                { class: 'acc-body' },
                h('div', { class: 'draft-box', style: { maxHeight: '220px' } }, alternative.content),
                alternative.rationale ? h('p', { class: 'muted mt-8', style: { fontSize: '11.5px' } }, alternative.rationale) : null,
                h(
                  'button',
                  {
                    class: 'btn btn-sm mt-8',
                    type: 'button',
                    onclick: async () => {
                      const ok = await confirmDialog('Текущий текст раздела будет заменён выбранным вариантом.', {
                        title: 'Принять вариант',
                        confirmLabel: 'Принять',
                      });
                      if (!ok) return;
                      try {
                        await api.acceptAlternative(projectId, section.key, index);
                        await reload();
                        toast('Вариант принят', 'ok');
                      } catch (error) {
                        toast(errorMessage(error), 'error');
                      }
                    },
                  },
                  'Принять этот вариант',
                ),
              ),
            ),
          ),
        ),
      );
    }

    if (section.openQuestions?.length) {
      body.append(
        h('div', { class: 'mt-12' }, h('div', { class: 'card-title' }, 'Открытые вопросы')),
        h('div', { class: 'stack gap-4 mt-8' }, section.openQuestions.map((question) => h('div', { class: 'issue' }, question))),
      );
    }
  }

  function openDraftEditor(section) {
    const textarea = h('textarea', { rows: 20, style: { minHeight: '320px', fontFamily: 'var(--mono)', fontSize: '12px' } }, section.content);
    const status = select(
      [
        { value: 'ready', label: 'готов' },
        { value: 'needs_revision', label: 'требует пересмотра' },
        { value: 'not_started', label: 'не начат' },
      ],
      section.status,
    );

    const saveBtn = h('button', { class: 'btn btn-primary', type: 'button' }, 'Сохранить');
    const dialog = openModal({
      title: `Редактирование: ${section.title}`,
      body: h('div', { class: 'stack gap-12' }, textarea, field('Статус раздела', status)),
      footer: h(
        'div',
        { class: 'row gap-8' },
        h('button', { class: 'btn', type: 'button', onclick: () => dialog.close() }, 'Отмена'),
        saveBtn,
      ),
      width: '760px',
    });

    saveBtn.addEventListener('click', async () => {
      const busy = busyState(saveBtn);
      busy.start('Сохранение…');
      try {
        await api.saveSection(projectId, section.key, { content: textarea.value, status: status.value });
        dialog.close();
        await reload();
        toast('Раздел сохранён', 'ok');
      } catch (error) {
        toast(errorMessage(error), 'error');
        busy.stop();
      }
    });
  }

  function renderQualityTab(body, section) {
    const quality = section.quality;
    if (!quality) {
      body.append(
        emptyState({
          title: 'Оценки пока нет',
          text: 'Оценка выставляется после синтеза раздела. Можно запустить проверку отдельно.',
          action: h('button', {
            class: 'btn btn-sm',
            type: 'button',
            onclick: async (event) => {
              const busy = busyState(event.currentTarget);
              busy.start('…');
              try {
                await api.synthesize(projectId, section.key, { evaluate: true });
                await reload();
              } catch (error) {
                toast(errorMessage(error), 'error');
              } finally {
                busy.stop();
              }
            },
          }, 'Синтезировать с оценкой'),
        }),
      );
      return;
    }

    body.append(
      h(
        'div',
        { class: 'score-ring' },
        scoreValue(quality.total, quality.verdict),
        h(
          'div',
          { class: 'stack gap-4' },
          h('div', { style: { fontWeight: '600' } }, STATUS_TEXT[quality.verdict] ?? quality.verdict),
          h('div', { class: 'faint', style: { fontSize: '11px' } }, `порог: ${data.defaults?.qualityThreshold ?? 80}${quality.heuristic ? ' · эвристическая оценка' : ''}`),
        ),
      ),
    );

    if (quality.criteria?.length) {
      const list = h('div', { class: 'criteria-list' });
      for (const criterion of quality.criteria) {
        const percent = Math.max(0, Math.min(100, (criterion.score / 10) * 100));
        list.append(
          h(
            'div',
            { class: 'criterion', dataset: { low: criterion.score < 6 ? 'true' : 'false' } },
            h('span', { title: criterion.note || '' }, `${criterion.label} ×${criterion.weight}`),
            h('span', { class: 'num', style: { textAlign: 'right' } }, String(Math.round(criterion.score * 10) / 10)),
            h('span', { class: 'bar' }, h('span', { style: { width: `${percent}%` } })),
          ),
        );
      }
      body.append(list);
    }

    if (quality.mandatory?.length) {
      body.append(
        h('div', { class: 'mt-12' }, h('div', { class: 'card-title' }, 'Обязательные проверки')),
        h(
          'div',
          { class: 'checklist mt-8' },
          quality.mandatory.map((check) =>
            h(
              'div',
              { class: 'check', dataset: { pass: check.passed ? 'true' : 'false' } },
              h('span', {}, check.passed ? '✓' : '✕'),
              h('span', {}, `${check.label}${check.note ? ` — ${check.note}` : ''}`),
            ),
          ),
        ),
      );
    }

    if (quality.issues?.length) {
      body.append(
        h('div', { class: 'mt-12' }, h('div', { class: 'card-title' }, 'Замечания')),
        h('div', { class: 'stack gap-4 mt-8' }, quality.issues.map((issue) => h('div', { class: 'issue' }, issue))),
      );
    }
  }

  function renderSourcesTab(body, section) {
    const sources = data.sources.filter((source) => source.sectionKey === section.key);
    if (!sources.length) {
      body.append(
        emptyState({
          title: 'Источников нет',
          text: 'Исследование не выполнялось или поисковые провайдеры не настроены. Без исследования синтез работает на требованиях и профессиональном варианте модели.',
          action: h('a', { class: 'btn btn-sm', href: '#/settings/search' }, 'Настроить поиск'),
        }),
      );
      return;
    }

    for (const source of sources) {
      body.append(
        h(
          'div',
          { class: 'source-item' },
          h('a', { class: 'src-title', href: source.url, target: '_blank', rel: 'noreferrer noopener' }, source.title || source.url),
          h(
            'div',
            { class: 'src-meta' },
            source.publisher ? h('span', {}, source.publisher) : null,
            source.publishedAt ? h('span', {}, source.publishedAt) : null,
            h('span', {}, source.provider),
            source.relevance !== null && source.relevance !== undefined ? h('span', {}, `релевантность ${source.relevance}`) : null,
          ),
          source.snippet ? h('div', { class: 'src-snippet' }, source.snippet) : null,
          source.analysis?.summary ? h('div', { class: 'src-snippet', style: { color: 'var(--text)' } }, source.analysis.summary) : null,
          source.analysis
            ? h(
                'div',
                { class: 'src-meta' },
                chip(`применимость: ${source.analysis.applicability}`, source.analysis.applicability === 'high' ? 'ok' : ''),
                source.analysis.weaknesses?.length ? h('span', {}, `ограничения: ${source.analysis.weaknesses.length}`) : null,
              )
            : null,
        ),
      );
    }
  }

  function renderResearchTab(body, section) {
    const research = section.research ?? {};
    body.append(
      h(
        'div',
        { class: 'row gap-6 wrap', style: { marginBottom: '10px' } },
        statusChip(research.status ?? 'pending'),
        h('span', { class: 'faint', style: { fontSize: '11px' } }, research.updatedAt ? fmtDate(research.updatedAt) : ''),
        research.providers?.length ? h('span', { class: 'faint', style: { fontSize: '11px' } }, research.providers.join(', ')) : null,
      ),
    );

    if (research.message) body.append(h('div', { class: 'status-line', dataset: { tone: research.status === 'done' ? 'ok' : 'warn' } }, research.message));

    if (research.queries?.length) {
      body.append(
        h('div', { class: 'mt-12' }, h('div', { class: 'card-title' }, 'Поисковые запросы')),
        h('div', { class: 'stack gap-4 mt-8' }, research.queries.map((query) => h('div', { class: 'mono faint' }, `· ${query}`))),
      );
    }

    if (research.summary) {
      body.append(h('div', { class: 'mt-12' }, h('div', { class: 'card-title' }, 'Резюме исследования'), h('p', { class: 'muted mt-8', style: { fontSize: '12px' } }, research.summary)));
    }

    if (research.findings?.length) {
      body.append(
        h('div', { class: 'mt-12' }, h('div', { class: 'card-title' }, `Выводы (${research.findings.length})`)),
        h('div', { class: 'checklist mt-8' }, research.findings.map((finding) => h('div', { class: 'check' }, h('span', {}, '·'), h('span', {}, finding)))),
      );
    }

    body.append(
      h('button', {
        class: 'btn btn-sm mt-12',
        type: 'button',
        onclick: async (event) => {
          const busy = busyState(event.currentTarget);
          busy.start('Поиск…');
          try {
            await api.research(projectId, section.key, true);
            await reload();
          } catch (error) {
            toast(errorMessage(error), 'error');
          } finally {
            busy.stop();
          }
        },
      }, 'Запустить исследование заново'),
    );
  }

  /* ─────────────────────────── Сборка ─────────────────────────── */

  async function runAssemble(button) {
    const busy = busyState(button);
    busy.start('Сборка…');
    try {
      const result = await api.assemble(projectId);
      await reload();
      openAssemblyResult(result);
      toast('Промт собран, версия сохранена', 'ok');
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      busy.stop();
    }
  }

  function openAssemblyResult(result) {
    const promptBox = h('div', { class: 'draft-box', style: { maxHeight: '300px' } }, result.prompt);
    const copyBtn = h('button', { class: 'btn btn-sm', type: 'button' }, 'Копировать');
    copyBtn.addEventListener('click', () => copyText(result.prompt));

    const downloadBtn = h('button', { class: 'btn btn-sm', type: 'button' }, 'Скачать .md');
    downloadBtn.addEventListener('click', () => downloadExport('md'));

    const details = [];
    if (result.purpose) details.push(h('div', { class: 'mt-12' }, h('div', { class: 'card-title' }, 'Назначение'), h('p', { class: 'muted mt-8', style: { fontSize: '12px' } }, result.purpose)));
    for (const [title, items] of [
      ['Допущения', result.assumptions],
      ['Ограничения', result.limitations],
      ['Рекомендации по улучшению', result.improvements],
      ['Разрешённые противоречия', result.conflictsResolved],
    ]) {
      if (Array.isArray(items) && items.length) {
        details.push(
          h('div', { class: 'mt-12' }, h('div', { class: 'card-title' }, `${title} (${items.length})`)),
          h('div', { class: 'checklist mt-8' }, items.map((item) => h('div', { class: 'check' }, h('span', {}, '·'), h('span', {}, String(item))))),
        );
      }
    }

    const usage = result.usage
      ? h(
          'div',
          { class: 'status-line mt-12', dataset: { tone: 'ok' } },
          `Использование: ${typeof result.usage === 'string' ? result.usage : JSON.stringify(result.usage)}`,
        )
      : null;

    openModal({
      title: `Промт собран · ${fmtNumber(result.prompt.length)} символов`,
      body: h(
        'div',
        { class: 'stack gap-8' },
        h(
          'div',
          { class: 'row gap-8 wrap' },
          chip(`оценка: ${result.quality?.total ?? '—'}`, result.quality?.verdict === 'pass' ? 'ok' : 'warn'),
          chip(`источник: ${result.source === 'llm' ? 'модель' : 'резервная сборка'}`, result.source === 'llm' ? '' : 'warn'),
          chip(`источников: ${result.sources?.length ?? 0}`),
          h('div', { class: 'grow' }),
          copyBtn,
          downloadBtn,
        ),
        promptBox,
        usage,
        details,
        h('div', { class: 'faint mt-12', style: { fontSize: '11px' } }, 'Полный текст доступен в разделе «Версии». Экспорт включает разделы, источники и историю.'),
      ),
      width: '760px',
    });
  }

  /* ─────────────────────────── Версии и дифф ─────────────────────────── */

  async function openVersions() {
    let versions = [];
    try {
      versions = (await api.versions(projectId)).versions;
    } catch (error) {
      toast(errorMessage(error), 'error');
      return;
    }
    await reload();

    if (!versions.length) {
      toast('Версий пока нет — выполните сборку промта', 'warn');
      return;
    }

    const list = h('div', { class: 'stack gap-8' });
    const preview = h('div', { class: 'draft-box', style: { maxHeight: '280px', marginTop: '10px' } });

    for (const [index, version] of versions.entries()) {
      list.append(
        h(
          'div',
          { class: 'row-between', style: { padding: '8px 10px', border: '1px solid var(--border-soft)', borderRadius: '7px' } },
          h(
            'div',
            { class: 'stack gap-4 grow' },
            h('div', { style: { fontSize: '13px', fontWeight: '600' } }, version.label || `Версия ${index + 1}`),
            h(
              'div',
              { class: 'faint', style: { fontSize: '11px' } },
              `${fmtDate(version.createdAt)} · ${fmtNumber(version.prompt.length)} символов · оценка ${version.quality?.total ?? '—'}`,
            ),
          ),
          h(
            'div',
            { class: 'row gap-6' },
            h('button', {
              class: 'btn btn-sm',
              type: 'button',
              onclick: () => {
                preview.textContent = version.prompt;
                preview.scrollTop = 0;
              },
            }, 'Просмотр'),
            h('button', {
              class: 'btn btn-sm',
              type: 'button',
              onclick: () => copyText(version.prompt),
            }, 'Копировать'),
            index > 0
              ? h('button', {
                  class: 'btn btn-sm',
                  type: 'button',
                  onclick: () => openDiff(versions[index].id, versions[0].id),
                }, 'Сравнить')
              : null,
          ),
        ),
      );
    }

    openModal({
      title: 'Версии промта',
      body: h('div', { class: 'stack gap-8' }, list, preview),
      width: '760px',
    });
  }

  async function openDiff(aId, bId) {
    try {
      const diff = await api.diff(projectId, aId, bId);
      const lines = h('div', { style: { background: 'var(--bg-input)', borderRadius: '7px', padding: '8px 0', maxHeight: '56vh', overflowY: 'auto' } });
      for (const line of diff.lines) {
        lines.append(
          h('div', { class: 'diff-line', dataset: { type: line.type } }, `${line.type === 'added' ? '+' : line.type === 'removed' ? '−' : ' '} ${line.text}`),
        );
      }
      openModal({
        title: `Сравнение: ${diff.a.label} → ${diff.b.label}`,
        body: h(
          'div',
          { class: 'stack gap-8' },
          h('div', { class: 'row gap-8' }, chip(`+${diff.added}`, 'ok'), chip(`−${diff.removed}`, 'error')),
          lines,
        ),
        width: '820px',
      });
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  /* ─────────────────────────── Тестирование ─────────────────────────── */

  function openTestDialog(button) {
    const countInput = h('input', { type: 'number', min: '1', max: '8', value: '3' });
    const resultsSlot = h('div');
    const runBtn = h('button', { class: 'btn btn-primary', type: 'button' }, 'Запустить тесты');

    const dialog = openModal({
      title: 'Практическое тестирование промта',
      body: h(
        'div',
        { class: 'stack gap-12' },
        h(
          'p',
          { class: 'muted', style: { fontSize: '12.5px', margin: '0' } },
          'Приложение отправит собранный промт как системную инструкцию и проверит ответы модели на тестовых запросах. Результат содержит фактические ответы: если запросы не выполнялись, это будет указано явно.',
        ),
        field('Количество тестовых запросов', countInput, 'От 1 до 8. По умолчанию 3 (5 для режима Expert).'),
        resultsSlot,
      ),
      footer: h(
        'div',
        { class: 'row gap-8' },
        h('button', { class: 'btn', type: 'button', onclick: () => dialog.close() }, 'Закрыть'),
        runBtn,
      ),
      width: '760px',
    });

    runBtn.addEventListener('click', async () => {
      const busy = busyState(runBtn);
      busy.start('Тестирование…');
      clear(resultsSlot);
      try {
        const outcome = await api.test(projectId, { count: Number(countInput.value) || 3 });
        resultsSlot.append(renderTestOutcome(outcome));
        await reload();
      } catch (error) {
        resultsSlot.append(h('div', { class: 'status-line', dataset: { tone: 'error' } }, errorMessage(error)));
      } finally {
        busy.stop();
        button.disabled = false;
      }
    });
  }

  function renderTestOutcome(outcome) {
    const box = h('div', { class: 'stack gap-8' });

    box.append(
      h(
        'div',
        { class: 'row gap-8 wrap' },
        chip(`вердикт: ${STATUS_TEXT[outcome.verdict] ?? outcome.verdict}`, outcome.verdict === 'pass' ? 'ok' : 'warn'),
        outcome.executed ? chip('запросы выполнены', 'ok') : chip('не выполнялись', 'warn'),
        outcome.providerName ? chip(`${outcome.providerName}${outcome.model ? ` · ${outcome.model}` : ''}`) : null,
      ),
    );

    if (outcome.summary) box.append(h('div', { class: 'status-line' }, outcome.summary));

    if (outcome.results?.length) {
      for (const result of outcome.results) {
        box.append(
          h(
            'details',
            { class: 'accordion' },
            h(
              'summary',
              {},
              h('span', {}, `${result.passed ? '✓' : '✕'} ${result.title}`),
              h('span', { class: 'faint', style: { fontSize: '11px' } }, `${result.score}/10`),
            ),
            h(
              'div',
              { class: 'acc-body stack gap-8' },
              h('div', { class: 'faint', style: { fontSize: '11px' } }, `Запрос: ${result.userMessage}`),
              h('div', { class: 'draft-box', style: { maxHeight: '200px', fontFamily: 'var(--font)' } }, result.response || '—'),
              result.error ? h('div', { class: 'status-line', dataset: { tone: 'error' } }, result.error) : null,
              result.violations?.length
                ? h('div', { class: 'stack gap-4' }, result.violations.map((violation) => h('div', { class: 'issue' }, violation)))
                : null,
              result.notes ? h('div', { class: 'muted', style: { fontSize: '11.5px' } }, result.notes) : null,
            ),
          ),
        );
      }
    }

    if (outcome.recommendations?.length) {
      box.append(
        h('div', { class: 'mt-8' }, h('div', { class: 'card-title' }, 'Рекомендации')),
        h('div', { class: 'checklist mt-8' }, outcome.recommendations.map((item) => h('div', { class: 'check' }, h('span', {}, '·'), h('span', {}, item)))),
      );
    }

    return box;
  }

  /* ─────────────────────────── Экспорт ─────────────────────────── */

  async function openExport() {
    if (!data.versions.length) {
      toast('Экспорт доступен после сборки промта', 'warn');
      return;
    }
    const dialog = openModal({
      title: 'Экспорт промта',
      body: h(
        'div',
        { class: 'stack gap-8' },
        h('p', { class: 'muted', style: { margin: '0', fontSize: '12.5px' } }, 'Экспорт содержит итоговый промт, разделы с оценками, источники и историю версий.'),
        h(
          'div',
          { class: 'row gap-8 wrap mt-8' },
          h('button', { class: 'btn btn-primary', type: 'button', onclick: () => downloadExport('md') }, 'Markdown (.md)'),
          h('button', { class: 'btn', type: 'button', onclick: () => downloadExport('txt') }, 'Текст (.txt)'),
          h('button', { class: 'btn', type: 'button', onclick: () => downloadExport('json') }, 'JSON (.json)'),
        ),
      ),
      footer: h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: () => dialog.close() }, 'Закрыть')),
    });
  }

  /** Скачивание через blob: сервер отдаёт attachment, но токен идёт заголовком. */
  async function downloadExport(format) {
    try {
      const response = await fetch(`/api/projects/${projectId}/export?format=${format}`, {
        headers: localStorage.getItem('apa.token') ? { 'x-app-token': localStorage.getItem('apa.token') } : {},
      });
      if (!response.ok) {
        const text = await response.text();
        let message = `Ошибка ${response.status}`;
        try {
          message = JSON.parse(text)?.error?.message ?? message;
        } catch {
          /* ignore */
        }
        throw new Error(message);
      }
      const blob = await response.blob();
      const disposition = response.headers.get('content-disposition') ?? '';
      const match = /filename="([^"]+)"/.exec(disposition);
      const name = match?.[1] ?? `prompt.${format}`;
      const url = URL.createObjectURL(blob);
      const link = h('a', { href: url, download: name });
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      toast('Файл сохранён', 'ok');
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  /* ─────────────────────────── Настройки проекта ─────────────────────────── */

  function openProjectSettings() {
    const titleInput = h('input', { type: 'text', value: data.project.title, maxlength: 160 });
    const audienceInput = h('input', { type: 'text', value: data.project.audience ?? '', maxlength: 400 });
    const modelInput = h('input', { type: 'text', value: data.project.targetModel ?? '', maxlength: 200 });
    const modeSelect = select(
      [
        { value: 'quick', label: 'Quick — быстро, без исследования' },
        { value: 'professional', label: 'Professional — исследование и контроль качества' },
        { value: 'expert', label: 'Expert — глубоко, с тестированием' },
      ],
      data.project.mode,
    );

    const saveBtn = h('button', { class: 'btn btn-primary', type: 'button' }, 'Сохранить');
    const dialog = openModal({
      title: 'Настройки проекта',
      body: h(
        'div',
        { class: 'stack gap-12' },
        field('Название', titleInput),
        field('Аудитория', audienceInput, 'Кому адресован результат.'),
        field('Целевая модель', modelInput, 'Используется для тестирования промта.'),
        field('Режим', modeSelect, 'Меняет глубину исследования и требования к разделам.'),
        h('div', { class: 'banner' }, h('div', {}, `Идея проекта: ${data.project.idea}`)),
      ),
      footer: h(
        'div',
        { class: 'row gap-8' },
        h('button', { class: 'btn', type: 'button', onclick: () => dialog.close() }, 'Отмена'),
        saveBtn,
      ),
    });

    saveBtn.addEventListener('click', async () => {
      const busy = busyState(saveBtn);
      busy.start('Сохранение…');
      try {
        await api.updateProject(projectId, {
          title: titleInput.value.trim(),
          audience: audienceInput.value.trim(),
          targetModel: modelInput.value.trim(),
          mode: modeSelect.value,
        });
        dialog.close();
        await reload();
        toast('Настройки обновлены', 'ok');
      } catch (error) {
        toast(errorMessage(error), 'error');
        busy.stop();
      }
    });
  }

  /* ─────────────────────────── Старт ─────────────────────────── */

  renderHeader();
  renderSections();
  renderChat();
  renderInspector();

  if (!data.sections.length && data.project.stage === 'intake') {
    // Проект создан, но план не составлен — предлагаем запустить.
    chatScroll?.append();
  }

  return () => {
    if (pipelineHandle) pipelineHandle.cancel();
  };
}

async function copyText(text) {
  if (!text) {
    toast('Нечего копировать', 'warn');
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    toast('Скопировано', 'ok');
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    document.body.append(area);
    area.select();
    try {
      document.execCommand('copy');
      toast('Скопировано', 'ok');
    } catch {
      toast('Не удалось скопировать', 'error');
    }
    area.remove();
  }
}

export { CONNECTION_TEXT, banner };
