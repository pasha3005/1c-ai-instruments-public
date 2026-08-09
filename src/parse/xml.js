/**
 * Минимальный потоковый разбор XML без внешних зависимостей.
 *
 * Полноценный DOM для выгрузки конфигурации строить нельзя: у крупных типовых
 * решений (ERP, УТ) каталог выгрузки — это десятки тысяч файлов и сотни мегабайт.
 * Поэтому используются два режима:
 *
 *   parseXml(text)         — компактное дерево для небольших файлов (описания объектов);
 *   scanElements(text, cb) — обход без построения дерева для крупных файлов.
 *
 * Namespace-префиксы (v8:, xr:, app:) сохраняются в именах тегов «как есть»,
 * а для поиска используется сравнение по локальному имени.
 */

/**
 * @typedef {object} XmlNode
 * @property {string} name полное имя тега, включая префикс
 * @property {string} local локальное имя без префикса
 * @property {Record<string,string>} attrs
 * @property {XmlNode[]} children
 * @property {string} text текстовое содержимое (только прямые текстовые узлы)
 */

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
};

export function decodeEntities(text) {
  if (!text || text.indexOf('&') === -1) return text;
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, code) => {
    if (code[0] === '#') {
      const num = code[1] === 'x' || code[1] === 'X'
        ? parseInt(code.slice(2), 16)
        : parseInt(code.slice(1), 10);
      return Number.isFinite(num) ? String.fromCodePoint(num) : whole;
    }
    return ENTITIES[code] !== undefined ? ENTITIES[code] : whole;
  });
}

/**
 * Разбирает XML в дерево.
 * @param {string} text
 * @returns {XmlNode|null} корневой элемент
 */
export function parseXml(text) {
  const root = { name: '#root', local: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];

  scanElements(text, {
    onOpen(name, attrs) {
      const node = {
        name,
        local: localName(name),
        attrs,
        children: [],
        text: '',
      };
      stack[stack.length - 1].children.push(node);
      // Кладём на стек всегда, в том числе для самозакрывающихся тегов:
      // scanElements сразу же вызовет для них onClose, и стек останется сбалансирован.
      // Иначе onClose снял бы со стека РОДИТЕЛЯ, и всё поддерево «уехало» бы уровнем выше —
      // а в выгрузке 1С самозакрывающиеся теги (<Synonym/>, <Comment/>) встречаются повсеместно.
      stack.push(node);
    },
    onClose() {
      if (stack.length > 1) stack.pop();
    },
    onText(chunk) {
      stack[stack.length - 1].text += chunk;
    },
  });

  return root.children[0] || null;
}

/**
 * Потоковый обход XML. Не строит дерево — подходит для больших файлов.
 *
 * @param {string} text
 * @param {{onOpen?: Function, onClose?: Function, onText?: Function}} handlers
 */
export function scanElements(text, handlers) {
  const { onOpen, onClose, onText } = handlers;
  const len = text.length;
  let i = 0;

  while (i < len) {
    const lt = text.indexOf('<', i);
    if (lt === -1) {
      if (onText) emitText(text.slice(i), onText);
      break;
    }
    if (lt > i && onText) emitText(text.slice(i, lt), onText);

    // Комментарии, CDATA, декларации.
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      i = end === -1 ? len : end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9);
      const content = text.slice(lt + 9, end === -1 ? len : end);
      if (onText) onText(content);
      i = end === -1 ? len : end + 3;
      continue;
    }
    if (text.startsWith('<?', lt) || text.startsWith('<!', lt)) {
      const end = text.indexOf('>', lt);
      i = end === -1 ? len : end + 1;
      continue;
    }

    const gt = findTagEnd(text, lt);
    if (gt === -1) break;
    const inner = text.slice(lt + 1, gt);

    if (inner[0] === '/') {
      if (onClose) onClose(inner.slice(1).trim());
      i = gt + 1;
      continue;
    }

    const selfClosing = inner.endsWith('/');
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const { name, attrs } = parseTag(body);
    if (onOpen) onOpen(name, attrs, selfClosing);
    if (selfClosing && onClose) onClose(name);
    i = gt + 1;
  }
}

/** Ищет закрывающую '>' с учётом кавычек в значениях атрибутов. */
function findTagEnd(text, start) {
  let quote = null;
  for (let i = start + 1; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  return -1;
}

function parseTag(body) {
  const trimmed = body.trim();
  const spaceIdx = trimmed.search(/\s/);
  if (spaceIdx === -1) return { name: trimmed, attrs: {} };

  const name = trimmed.slice(0, spaceIdx);
  const attrs = {};
  const attrRe = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = attrRe.exec(trimmed)) !== null) {
    attrs[m[1]] = decodeEntities(m[3] !== undefined ? m[3] : m[4] || '');
  }
  return { name, attrs };
}

function emitText(chunk, onText) {
  if (/^\s*$/.test(chunk)) return;
  onText(decodeEntities(chunk));
}

export function localName(name) {
  const idx = name.indexOf(':');
  return idx === -1 ? name : name.slice(idx + 1);
}

// --- Навигация по дереву ----------------------------------------------------

/** Первый прямой потомок с указанным локальным именем. */
export function child(node, local) {
  if (!node) return null;
  return node.children.find((c) => c.local === local) || null;
}

/** Все прямые потомки с указанным локальным именем. */
export function children(node, local) {
  if (!node) return [];
  return node.children.filter((c) => c.local === local);
}

/** Текст прямого потомка. */
export function childText(node, local, fallback = '') {
  const c = child(node, local);
  if (!c) return fallback;
  return c.text.trim() || fallback;
}

/** Поиск первого потомка на любой глубине. */
export function find(node, local) {
  if (!node) return null;
  for (const c of node.children) {
    if (c.local === local) return c;
    const deep = find(c, local);
    if (deep) return deep;
  }
  return null;
}

/** Текст элемента вместе с текстом всех потомков. */
export function deepText(node) {
  if (!node) return '';
  let out = node.text;
  for (const c of node.children) out += deepText(c);
  return out;
}
