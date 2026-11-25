/**
 * Общие UI-примитивы: гипerscript, тосты, модальные окна, форматирование,
 * отображение статусов. Никаких сторонних библиотек — только DOM.
 */

/* ─────────────────────────── DOM ─────────────────────────── */

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
      else if (key === 'html') el.innerHTML = value;
      else if (key.startsWith('on') && typeof value === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (key in el && key !== 'list' && key !== 'form') {
        try {
          el[key] = value;
        } catch {
          el.setAttribute(key, String(value));
        }
      } else {
        el.setAttribute(key, value === true ? '' : String(value));
      }
    }
  }
  append(el, children);
  return el;
}

function append(parent, children) {
  for (const child of children) {
    if (child === undefined || child === null || child === false) continue;
    if (Array.isArray(child)) append(parent, child);
    else if (child instanceof Node) parent.append(child);
    else parent.append(document.createTextNode(String(child)));
  }
}

export function clear(node) {
  node.replaceChildren();
  return node;
}

/* ─────────────────────────── Экранирование и разметка ─────────────────────────── */

export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function inlineMarkup(escaped) {
  return escaped
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/(^|[\s(])_([^_]+)_(?=[\s).,:;!?]|$)/g, '$1<em>$2</em>');
}

/** Минимальный markdown: списки, жирный, курсив, код. Вход экранируется. */
export function md(text) {
  const wrap = h('div', { class: 'md' });
  const lines = String(text ?? '').split(/\r?\n/);
  let list = null;
  let listTag = '';
  for (const line of lines) {
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      const tag = bullet ? 'ul' : 'ol';
      if (!list || listTag !== tag) {
        list = h(tag, { style: { margin: '4px 0 8px', paddingLeft: '20px' } });
        listTag = tag;
        wrap.append(list);
      }
      list.append(h('li', { html: inlineMarkup(escapeHtml(bullet ? bullet[1] : numbered[1])) }));
      continue;
    }
    list = null;
    listTag = '';
    if (!line.trim()) continue;
    wrap.append(h('div', { html: inlineMarkup(escapeHtml(line)) }));
  }
  return wrap;
}

/* ─────────────────────────── Тосты и модальные окна ─────────────────────────── */

export function toast(message, tone = 'ok') {
  const root = document.getElementById('toast-root');
  if (!root) return;
  const node = h('div', { class: 'toast', dataset: { tone } }, message);
  root.append(node);
  setTimeout(() => {
    node.style.transition = 'opacity .2s';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 220);
  }, 4600);
}

export function errorMessage(error) {
  if (!error) return 'Неизвестная ошибка';
  if (typeof error === 'string') return error;
  return error.message || 'Неизвестная ошибка';
}

/**
 * Модальное окно. Возвращает { close, element }.
 * Закрытие по Esc, клику по фону и кнопке в шапке.
 */
export function openModal({ title, body, footer, width }) {
  const root = document.getElementById('modal-root');
  const closeBtn = h('button', { class: 'btn btn-ghost btn-icon', type: 'button', 'aria-label': 'Закрыть' }, '✕');
  const modal = h(
    'div',
    { class: 'modal', role: 'dialog', 'aria-modal': 'true', style: width ? { width: `min(${width}, 100%)` } : undefined },
    h('div', { class: 'modal-head' }, h('h2', {}, title), closeBtn),
    h('div', { class: 'modal-body' }, body),
    footer ? h('div', { class: 'modal-foot' }, footer) : null,
  );
  const backdrop = h('div', { class: 'modal-backdrop' }, modal);

  const onKey = (event) => {
    if (event.key === 'Escape') close();
  };
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
  };

  closeBtn.addEventListener('click', close);
  backdrop.addEventListener('mousedown', (event) => {
    if (event.target === backdrop) close();
  });
  document.addEventListener('keydown', onKey);

  clear(root).append(backdrop);
  const focusable = modal.querySelector('input, textarea, select, button');
  focusable?.focus?.();
  return { close, element: modal };
}

export function confirmDialog(message, { title = 'Подтверждение', confirmLabel = 'Удалить' } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
      dialog.close();
    };
    const body = h('p', { style: { margin: '0' } }, message);
    const dialog = openModal({
      title,
      body,
      footer: h(
        'div',
        { class: 'row gap-8' },
        h('button', { class: 'btn', type: 'button', onclick: () => finish(false) }, 'Отмена'),
        h('button', { class: 'btn btn-danger', type: 'button', onclick: () => finish(true) }, confirmLabel),
      ),
    });
    dialog.element.addEventListener('remove', () => resolve(false));
  });
}

/* ─────────────────────────── Кнопки ─────────────────────────── */

/** Блокировка кнопки со спиннером на время операции. */
export function busyState(button) {
  let saved = null;
  return {
    start(label) {
      if (!button) return;
      if (saved === null) saved = button.innerHTML;
      button.disabled = true;
      button.replaceChildren(h('span', { class: 'spinner' }), document.createTextNode(label ? ` ${label}` : ''));
    },
    stop() {
      if (!button) return;
      button.disabled = false;
      if (saved !== null) {
        button.innerHTML = saved;
        saved = null;
      }
    },
  };
}

/* ─────────────────────────── Форматирование ─────────────────────────── */

export function fmtDate(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function fmtNumber(value) {
  return Number(value ?? 0).toLocaleString('ru-RU');
}

export const MODE_LABELS = {
  quick: 'Quick',
  professional: 'Professional',
  expert: 'Expert',
};

export const MODE_DESCRIPTIONS = {
  quick: 'Короткое интервью, без веб-исследования, быстрый результат.',
  professional: 'Адаптивное интервью, исследование каждого раздела, синтез и контроль качества.',
  expert: 'Глубокое исследование, несколько вариантов, расширенная проверка и тестирование на модели.',
};

const STATUS_TONE = {
  ready: 'ok',
  ready_for_synthesis: 'info',
  needs_revision: 'warn',
  awaiting_answer: 'info',
  needs_clarification: 'warn',
  researching: 'violet',
  analyzing: 'violet',
  not_started: '',
  draft: '',
  interviewing: 'info',
  assembling: 'violet',
  testing: 'violet',
  complete: 'ok',
  error: 'error',
  pending: '',
  running: 'violet',
  done: 'ok',
  skipped: '',
  unavailable: 'warn',
  pass: 'ok',
  revise: 'warn',
  not_run: 'warn',
};

export const STATUS_TEXT = {
  not_started: 'не начат',
  awaiting_answer: 'ожидает ответа',
  needs_clarification: 'требует уточнения',
  ready_for_synthesis: 'можно собирать',
  researching: 'исследуется',
  analyzing: 'анализируется',
  ready: 'готов',
  needs_revision: 'требует пересмотра',
  draft: 'черновик',
  interviewing: 'интервью',
  assembling: 'сборка',
  testing: 'тестирование',
  complete: 'готов',
  error: 'ошибка',
  pending: 'ожидает',
  running: 'выполняется',
  done: 'выполнено',
  skipped: 'пропущено',
  unavailable: 'недоступно',
  pass: 'пройдено',
  revise: 'нужна доработка',
  not_run: 'не запускалось',
};

export const CONNECTION_TEXT = {
  connected: 'Connected',
  authentication_failed: 'Authentication Failed',
  endpoint_unavailable: 'Endpoint Unavailable',
  model_not_found: 'Model Not Found',
  unsupported_protocol: 'Unsupported Protocol',
  request_timeout: 'Request Timeout',
  rate_limit: 'Rate Limit',
  unknown_error: 'Unknown Error',
};

export function chip(text, tone = '') {
  return h('span', { class: 'chip', dataset: tone ? { tone } : {} }, text);
}

export function statusChip(status) {
  return chip(STATUS_TEXT[status] ?? status ?? '—', STATUS_TONE[status] ?? '');
}

/* ─────────────────────────── Раскладка ─────────────────────────── */

export function pageHead(title, subtitle, actions) {
  return h(
    'div',
    { class: 'page-head' },
    h('div', {}, h('h1', {}, title), subtitle ? h('p', {}, subtitle) : null),
    actions ? h('div', { class: 'row gap-8 wrap' }, actions) : null,
  );
}

export function emptyState({ title, text, action }) {
  return h(
    'div',
    { class: 'empty' },
    h('h3', {}, title),
    text ? h('p', {}, text) : null,
    action ?? null,
  );
}

export function banner(content, tone = '') {
  return h('div', { class: 'banner', dataset: tone ? { tone } : {} }, h('div', {}, content));
}

export function field(label, control, hint) {
  return h(
    'div',
    { class: 'field' },
    h('label', {}, label),
    control,
    hint ? h('span', { class: 'hint' }, hint) : null,
  );
}

export function select(options, value, props = {}) {
  const el = h('select', props);
  for (const option of options) {
    el.append(
      h('option', { value: option.value, selected: String(option.value) === String(value) }, option.label),
    );
  }
  return el;
}

export function checkbox(label, checked, props = {}) {
  return h(
    'label',
    { class: 'checkbox' },
    h('input', { type: 'checkbox', checked, ...props }),
    label,
  );
}

export function progressBar(percent) {
  return h('div', { class: 'progress' }, h('span', { style: { width: `${Math.max(0, Math.min(100, percent))}%` } }));
}

export function scoreValue(total, verdict) {
  return h(
    'span',
    { class: 'score-value', dataset: { verdict: verdict === 'pass' ? 'pass' : verdict === 'revise' ? 'revise' : '' } },
    total === null || total === undefined ? '—' : String(Math.round(total)),
  );
}
