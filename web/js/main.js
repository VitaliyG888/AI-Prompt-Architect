/**
 * Точка входа интерфейса: hash-роутер, шапка, статус окружения.
 * Каждый вид — модуль с функцией render(container, params).
 */
import { api, ApiError, setToken, hasToken } from './api.js';
import { h, clear, toast, errorMessage } from './ui.js';
import { renderHome } from './views/home.js';
import { renderNew } from './views/new.js';
import { renderWorkspace } from './views/workspace.js';
import { renderSettings } from './views/settings.js';

const routes = [
  { pattern: /^\/?$/, view: renderHome, nav: 'home', title: 'Проекты' },
  { pattern: /^\/new\/?$/, view: renderNew, nav: 'new', title: 'Новый промт' },
  { pattern: /^\/project\/([^/]+)\/?$/, view: renderWorkspace, nav: 'home', title: 'Проект', params: ['id'] },
  { pattern: /^\/settings(?:\/([^/]+))?\/?$/, view: renderSettings, nav: 'settings', title: 'Настройки', params: ['tab'] },
];

const main = document.getElementById('main');
let currentCleanup = null;

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  return raw.startsWith('/') ? raw : `/${raw}`;
}

function setActiveNav(key) {
  for (const item of document.querySelectorAll('[data-nav]')) {
    item.classList.toggle('active', item.dataset.nav === key);
  }
}

async function route() {
  const path = parseHash();
  let matched = null;
  let params = {};

  for (const candidate of routes) {
    const match = candidate.pattern.exec(path);
    if (!match) continue;
    matched = candidate;
    (candidate.params ?? []).forEach((name, index) => {
      params[name] = match[index + 1] ? decodeURIComponent(match[index + 1]) : undefined;
    });
    break;
  }

  if (currentCleanup) {
    try {
      currentCleanup();
    } catch {
      /* очистка не должна ломать навигацию */
    }
    currentCleanup = null;
  }

  setActiveNav(matched?.nav ?? '');
  document.title = matched ? `${matched.title} — AI Prompt Architect` : 'AI Prompt Architect';

  if (!matched) {
    clear(main).append(
      h('div', { class: 'empty' }, h('h3', {}, 'Страница не найдена'), h('p', {}, 'Проверьте адрес или вернитесь к проектам.'),
        h('a', { class: 'btn btn-primary', href: '#/' }, 'К проектам')),
    );
    return;
  }

  clear(main);
  main.append(h('div', { class: 'loading-skeleton' }, h('div', { class: 'skeleton', style: { height: '28px', width: '240px' } })));

  try {
    const cleanup = await matched.view(main, params);
    currentCleanup = typeof cleanup === 'function' ? cleanup : null;
  } catch (error) {
    clear(main);
    if (error instanceof ApiError && error.status === 401) {
      main.append(renderTokenGate());
      return;
    }
    main.append(
      h(
        'div',
        { class: 'empty' },
        h('h3', {}, 'Не удалось загрузить страницу'),
        h('p', {}, errorMessage(error)),
        h('button', { class: 'btn btn-primary', type: 'button', onclick: () => route() }, 'Повторить'),
      ),
    );
  }
}

/** Экран ввода токена: включается только при APP_TOKEN на сервере. */
function renderTokenGate() {
  const input = h('input', { type: 'password', placeholder: 'Токен доступа', autocomplete: 'off' });
  return h(
    'div',
    { class: 'card card-pad-lg', style: { maxWidth: '420px', margin: '48px auto' } },
    h('h2', { style: { marginBottom: '6px' } }, 'Требуется токен доступа'),
    h('p', { class: 'muted', style: { fontSize: '13px' } }, 'Сервер запущен с APP_TOKEN. Введите его, чтобы продолжить. Токен хранится только в этом браузере.'),
    h(
      'form',
      {
        class: 'stack gap-12 mt-16',
        onsubmit: (event) => {
          event.preventDefault();
          const value = input.value.trim();
          if (!value) return;
          setToken(value);
          toast('Токен сохранён', 'ok');
          route();
        },
      },
      input,
      h('button', { class: 'btn btn-primary', type: 'submit' }, 'Войти'),
    ),
  );
}

/* ─────────────────────────── Статус окружения ─────────────────────────── */

async function refreshStatus() {
  const target = document.getElementById('sidebar-status');
  if (!target) return;
  const dot = target.querySelector('.status-dot') ?? h('div', { class: 'status-dot' });
  const label = h('span', {}, 'Проверка окружения…');
  clear(target).append(dot, label);

  try {
    const health = await api.health();
    const providers = health.providers?.enabled ?? 0;
    const searchConfigured = Boolean(health.search?.configured);
    let status = 'ok';
    let text = `Провайдеров: ${providers}`;
    if (providers === 0) {
      status = 'warn';
      text = 'Провайдер не подключён';
    } else if (!searchConfigured) {
      status = 'warn';
      text = `Провайдеров: ${providers} · без поиска`;
    }
    dot.dataset.status = status;
    label.textContent = text;
    target.title = `Поиск: ${searchConfigured ? 'настроен' : 'не настроен'} · проектов: ${health.projects ?? 0}`;
  } catch (error) {
    dot.dataset.status = 'error';
    label.textContent = error instanceof ApiError && error.status === 401 ? 'Нужен токен доступа' : 'Сервер недоступен';
    target.title = errorMessage(error);
  }
}

/* ─────────────────────────── Запуск ─────────────────────────── */

window.addEventListener('hashchange', () => {
  void route();
});

// Тост при истечении токена, чтобы не уходить в бесконечный цикл перезагрузки.
window.addEventListener('unhandledrejection', (event) => {
  if (event.reason instanceof ApiError && event.reason.status === 401) {
    event.preventDefault();
  }
});

if (!location.hash) location.hash = '#/';
void route();
void refreshStatus();
setInterval(() => void refreshStatus(), 60_000);

export { route, hasToken };
