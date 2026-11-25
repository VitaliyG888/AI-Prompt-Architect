/** Главная: список проектов и быстрый старт. */
import { api } from '../api.js';
import {
  h,
  clear,
  pageHead,
  toast,
  errorMessage,
  fmtDate,
  progressBar,
  chip,
  MODE_LABELS,
  STATUS_TEXT,
  confirmDialog,
  emptyState,
  banner,
} from '../ui.js';

export async function renderHome(container) {
  const { projects } = await api.listProjects();

  const newButton = h('a', { class: 'btn btn-primary', href: '#/new' }, '+ Новый промт');

  const head = pageHead(
    'Проекты',
    'Каждый проект — это промт, собранный из интервью, исследования и синтеза по разделам.',
    newButton,
  );

  if (!projects.length) {
    container.append(
      head,
      emptyState({
        title: 'Пока нет ни одного проекта',
        text: 'Опишите идею — приложение проведёт интервью, соберёт требования, исследует практики и синтезирует готовый промт по двенадцати разделам.',
        action: h('a', { class: 'btn btn-primary', href: '#/new' }, 'Создать первый промт'),
      }),
      h(
        'div',
        { class: 'grid-3 mt-24' },
        shortCard('1. Интервью', 'Адаптивные вопросы по каждому разделу: роль, контекст, цель, ограничения.'),
        shortCard('2. Исследование', 'Поиск практик и источников по теме раздела через настроенные поисковые провайдеры.'),
        shortCard('3. Синтез и проверка', 'Сборка раздела, оценка качества, версии промта и тесты на целевой модели.'),
      ),
    );
    return;
  }

  const grid = h('div', { class: 'project-grid' });
  for (const project of projects) {
    grid.append(projectCard(project, container));
  }

  container.append(head, grid);
}

function shortCard(title, text) {
  return h('div', { class: 'card' }, h('div', { class: 'card-title' }, title), h('p', { class: 'muted', style: { fontSize: '12.5px', margin: '6px 0 0' } }, text));
}

function projectCard(project, container) {
  const total = project.sectionsTotal ?? 0;
  const ready = project.sectionsReady ?? 0;

  const deleteBtn = h(
    'button',
    {
      class: 'btn btn-ghost btn-sm btn-icon',
      type: 'button',
      title: 'Удалить проект',
      'aria-label': `Удалить проект «${project.title}»`,
      onclick: async (event) => {
        event.preventDefault();
        event.stopPropagation();
        const ok = await confirmDialog(
          `Проект «${project.title}» будет удалён вместе с разделами, сообщениями и версиями. Это необратимо.`,
          { title: 'Удалить проект' },
        );
        if (!ok) return;
        try {
          await api.deleteProject(project.id);
          toast('Проект удалён', 'ok');
          const card = deleteBtn.closest('.project-card');
          card?.remove();
          if (!container.querySelector('.project-card')) {
            location.hash = '#/';
            location.reload();
          }
        } catch (error) {
          toast(errorMessage(error), 'error');
        }
      },
    },
    '✕',
  );

  const meta = h(
    'div',
    { class: 'row gap-6 wrap', style: { fontSize: '11px' } },
    chip(MODE_LABELS[project.mode] ?? project.mode, 'info'),
    chip(STATUS_TEXT[project.status] ?? project.status, project.status === 'complete' ? 'ok' : ''),
    total ? chip(`${ready}/${total} разделов`) : chip('не инициализирован'),
  );

  return h(
    'a',
    { class: 'project-card', href: `#/project/${project.id}` },
    h(
      'div',
      { class: 'row-between', style: { alignItems: 'flex-start' } },
      h('h3', { class: 'grow' }, project.title),
      deleteBtn,
    ),
    h('div', { class: 'idea' }, project.idea),
    meta,
    total ? progressBar(project.progress ?? 0) : null,
    h('div', { class: 'faint', style: { fontSize: '10.5px' } }, `Обновлён ${fmtDate(project.updatedAt)}`),
  );
}

export { banner, clear };
