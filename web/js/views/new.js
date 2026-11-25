/** Мастер создания проекта: идея, режим, аудитория, целевая модель. */
import { api } from '../api.js';
import {
  h,
  pageHead,
  field,
  toast,
  errorMessage,
  md,
  MODE_LABELS,
  MODE_DESCRIPTIONS,
  busyState,
} from '../ui.js';

const EXAMPLES = [
  {
    title: 'Ассистент технической поддержки',
    idea: 'Промт для AI-ассистента поддержки SaaS: принимает обращения пользователей, уточняет проблему, ищет решение в базе знаний и отвечает по шагам. Важно: не выдумывать факты, эскалировать сложные случаи человеку.',
    mode: 'professional',
  },
  {
    title: 'Аналитик конкурентов',
    idea: 'Промт для аналитика, который изучает публичные материалы конкурентов, сравнивает тарифы и позиционирование, готовит структурированный отчёт с таблицей сравнения и источниками.',
    mode: 'expert',
  },
  {
    title: 'Редактор лендингов',
    idea: 'Промт для редактора маркетинговых текстов: переписывает черновики лендингов, сохраняя факты и юридические формулировки, усиливает структуру и убирает воду.',
    mode: 'quick',
  },
];

export async function renderNew(container) {
  let defaults = { mode: 'professional', language: 'ru' };
  try {
    const settings = await api.settings();
    defaults = { ...defaults, ...settings.defaults };
  } catch {
    /* настройки недоступны — работаем со значениями по умолчанию */
  }

  let mode = defaults.mode ?? 'professional';

  const titleInput = h('input', { type: 'text', placeholder: 'Например: Ассистент технической поддержки', maxlength: 160 });
  const ideaInput = h('textarea', {
    placeholder:
      'Опишите идею как есть: для кого промт, какую задачу решает, что критично не потерять. Чем конкретнее — тем меньше уточняющих вопросов.',
    rows: 10,
    maxlength: 20000,
  });
  const audienceInput = h('input', {
    type: 'text',
    placeholder: 'Например: клиенты SaaS без технической подготовки',
    maxlength: 400,
  });
  const modelInput = h('input', {
    type: 'text',
    placeholder: 'Например: gpt-4.1-mini, claude-sonnet-4.5, glm-5',
    maxlength: 200,
  });

  const modeGrid = h('div', { class: 'mode-grid' });
  const modeNote = h('div', { class: 'banner', style: { marginTop: '10px' } });

  function renderModes() {
    modeGrid.replaceChildren();
    for (const key of ['quick', 'professional', 'expert']) {
      modeGrid.append(
        h(
          'button',
          {
            class: `mode-card${key === mode ? ' active' : ''}`,
            type: 'button',
            onclick: () => {
              mode = key;
              renderModes();
              modeNote.textContent = MODE_DESCRIPTIONS[key];
            },
          },
          h('strong', {}, MODE_LABELS[key]),
          h('span', {}, MODE_DESCRIPTIONS[key]),
        ),
      );
    }
    modeNote.textContent = MODE_DESCRIPTIONS[mode];
  }
  renderModes();

  const submitBtn = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Создать и начать интервью');
  const busy = busyState(submitBtn);
  const errorBox = h('div', { class: 'field-error hidden' });

  const form = h(
    'form',
    {
      class: 'stack gap-16',
      onsubmit: async (event) => {
        event.preventDefault();
        errorBox.classList.add('hidden');
        const idea = ideaInput.value.trim();
        if (idea.length < 10) {
          errorBox.textContent = 'Опишите идею подробнее — минимум 10 символов.';
          errorBox.classList.remove('hidden');
          ideaInput.focus();
          return;
        }

        busy.start('Создаём план…');
        try {
          const created = await api.createProject({
            idea,
            title: titleInput.value.trim() || undefined,
            mode,
            audience: audienceInput.value.trim() || undefined,
            targetModel: modelInput.value.trim() || undefined,
          });
          const projectId = created.project.id;

          try {
            await api.initialize(projectId);
            toast('План интервью готов', 'ok');
          } catch (error) {
            toast(`Проект создан, но план не составлен: ${errorMessage(error)}`, 'error');
          }

          location.hash = `#/project/${projectId}`;
        } catch (error) {
          errorBox.textContent = errorMessage(error);
          errorBox.classList.remove('hidden');
          busy.stop();
        }
      },
    },
    h(
      'div',
      { class: 'card card-pad-lg' },
      field('Идея промта', ideaInput, 'Обязательное поле. Всё остальное можно уточнить в интервью.'),
      h(
        'div',
        { class: 'row-between', style: { marginBottom: '6px' } },
        h('label', { style: { fontSize: '12px', fontWeight: '600', color: 'var(--text-dim)' } }, 'Режим работы'),
      ),
      modeGrid,
      modeNote,
      h('div', { class: 'example-row mt-12' }, h('span', { class: 'faint', style: { fontSize: '11.5px' } }, 'Примеры:'))
    ),
    h(
      'div',
      { class: 'card card-pad-lg' },
      h('div', { class: 'card-head' }, h('div', { class: 'card-title' }, 'Детали (необязательно)')),
      h(
        'div',
        { class: 'grid-2' },
        field('Название проекта', titleInput, 'Если пусто — возьмём первую строку идеи.'),
        field('Аудитория', audienceInput, 'Для кого предназначен результат.'),
      ),
      field('Целевая модель', modelInput, 'Модель, на которой промт будет работать и тестироваться.'),
      errorBox,
      h('div', { class: 'row gap-8 mt-8' }, submitBtn, h('a', { class: 'btn btn-ghost', href: '#/' }, 'Отмена')),
    ),
  );

  const exampleRow = form.querySelector('.example-row');
  for (const example of EXAMPLES) {
    exampleRow.append(
      h(
        'button',
        {
          class: 'chip',
          type: 'button',
          style: { cursor: 'pointer' },
          onclick: () => {
            ideaInput.value = example.idea;
            titleInput.value = example.title;
            mode = example.mode;
            renderModes();
            ideaInput.focus();
          },
        },
        example.title,
      ),
    );
  }

  container.append(
    pageHead(
      'Новый промт',
      'Опишите идею своими словами. Дальше приложение проведёт интервью по разделам, исследует практики и синтезирует промт — не по шаблону, а из ваших требований, найденных источников и профессионального варианта модели.',
    ),
    form,
  );
}

export { md };
