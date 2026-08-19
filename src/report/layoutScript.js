/**
 * Скрипт раскладки отчёта: содержание слева, подсветка текущего раздела,
 * раскрытие блока по ссылке-якорю и подготовка к печати.
 *
 * Отчёт остаётся самодостаточным файлом — скрипт встраивается в него целиком,
 * сети не требует (см. `styles.js` о том же для стилей).
 *
 * Почему подпункты меню строятся здесь, а не при сборке разметки. Блоки внутри
 * раздела — это `<details class="collapsible">`, и появляются они двумя путями:
 * часть собирается явно, часть — разбором готовой разметки в
 * `collapsibleTables()`. Собрать по ним оглавление на этапе генерации значило
 * бы снова разбирать HTML регулярными выражениями — тем самым способом, что
 * уже ломал границы разделов (см. историю в `html.js`). В браузере есть
 * настоящий DOM: те же блоки находятся одним `querySelectorAll` и без риска.
 *
 * Верхний уровень меню при этом отрисован сервером: он должен работать и при
 * отключённых скриптах, и на печати.
 */

export const LAYOUT_SCRIPT = `
(function () {
  var nav = document.getElementById('reportNav');
  var sections = [].slice.call(document.querySelectorAll('section.section[id]'));

  if (nav && sections.length) {
    buildSubItems();
    trackCurrentSection();
  }
  openTargetOnNavigation();
  expandForPrinting();
  chainScrollOutOfCode();

  /**
   * Подпункты меню: по одному на каждый верхнеуровневый блок раздела —
   * сворачиваемый блок или обычный заголовок h3.
   */
  function buildSubItems() {
    sections.forEach(function (section) {
      var link = nav.querySelector('a[href="#' + section.id + '"]');
      if (!link || !link.parentNode) return;

      var body = section.querySelector('.sec__body') || section;
      var items = [];

      [].slice.call(body.children).forEach(function (child) {
        var title = null;
        if (child.tagName === 'DETAILS') {
          var summary = child.firstElementChild;
          if (summary && summary.tagName === 'SUMMARY') title = summaryTitle(summary);
        } else if (child.tagName === 'H3') {
          title = child.textContent.trim();
        }
        if (!title) return;
        if (!child.id) child.id = section.id + '-b' + (items.length + 1);
        items.push({ id: child.id, title: title });
      });

      if (items.length < 2) return; // один блок оглавления не заслуживает
      var list = document.createElement('ol');
      list.className = 'nav__sub';
      items.forEach(function (item) {
        var li = document.createElement('li');
        var a = document.createElement('a');
        a.href = '#' + item.id;
        a.textContent = item.title;
        a.title = item.title;
        li.appendChild(a);
        list.appendChild(li);
      });
      link.parentNode.appendChild(list);
    });
  }

  /** Текст заголовка блока без счётчика и значков — для строки меню. */
  function summaryTitle(summary) {
    var copy = summary.cloneNode(true);
    [].slice.call(copy.querySelectorAll('.collapsible__count, .badge')).forEach(function (n) {
      n.parentNode.removeChild(n);
    });
    return copy.textContent.replace(/\\s+/g, ' ').trim();
  }

  /**
   * Подсветка текущего раздела при прокрутке.
   *
   * Считается «последний раздел, начало которого уже выше линии отсчёта» —
   * это предсказуемее IntersectionObserver: у разделов очень разная высота,
   * и наблюдатель по видимости на длинном разделе переключался бы то на него,
   * то на следующий. Линия отсчёта чуть ниже верха окна, на высоте прилипшего
   * заголовка раздела.
   */
  function trackCurrentSection() {
    var links = sections.map(function (section) {
      return nav.querySelector('a[href="#' + section.id + '"]');
    });
    var timer = null;

    function update() {
      timer = null;
      var line = 96;
      var current = 0;
      for (var i = 0; i < sections.length; i += 1) {
        if (sections[i].getBoundingClientRect().top <= line) current = i;
      }
      // В самом низу страницы подсвечиваем последний раздел: иначе короткий
      // последний раздел никогда не становится текущим. Условие «мы вообще
      // прокрутили» обязательно: пока идёт первичная раскладка, высота
      // документа ещё равна высоте окна, и без него подсветка сразу
      // уезжала на последний раздел и там оставалась.
      var docHeight = document.documentElement.scrollHeight;
      if (window.scrollY > 0 && window.innerHeight + window.scrollY >= docHeight - 8) {
        current = sections.length - 1;
      }

      links.forEach(function (link, i) {
        if (!link) return;
        var active = i === current;
        link.classList.toggle('is-current', active);
        if (active) link.setAttribute('aria-current', 'true');
        else link.removeAttribute('aria-current');
      });
      markCurrentSubItem(links[current]);
    }

    function markCurrentSubItem(link) {
      [].slice.call(nav.querySelectorAll('.nav__sub a.is-current')).forEach(function (a) {
        a.classList.remove('is-current');
      });
      if (!link || !link.parentNode) return;
      var subs = [].slice.call(link.parentNode.querySelectorAll('.nav__sub a'));
      var found = null;
      subs.forEach(function (a) {
        var block = document.getElementById(a.getAttribute('href').slice(1));
        if (block && block.getBoundingClientRect().top <= 120) found = a;
      });
      if (found) found.classList.add('is-current');
    }

    /*
     * Троттлинг через setTimeout, а не requestAnimationFrame.
     *
     * rAF выглядит уместнее для прокрутки, но в скрытой вкладке браузер его
     * приостанавливает: с флагом «кадр уже запрошен» обработчик после первого
     * же переключения вкладки замолкал НАВСЕГДА — кадр не приходил, флаг
     * не снимался, и подсветка застывала на разделе, который был текущим
     * в тот момент. Поймано на этом же отчёте. setTimeout в скрытой вкладке
     * тоже придушен, но приходит, поэтому состояние само себя восстанавливает.
     * Для подсветки строки меню 60 мс задержки незаметны.
     */
    function schedule() {
      if (timer) return;
      timer = setTimeout(update, 60);
    }

    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    // Раскрытие и сворачивание разделов меняет их положение на странице.
    document.addEventListener('toggle', schedule, true);
    update();
  }

  /**
   * Переход по ссылке-якорю должен раскрыть всё, что над целью: и раздел,
   * и сворачиваемый блок внутри него. Иначе ссылка ведёт «в никуда» —
   * страница прокручивается к свёрнутому заголовку.
   */
  function openTargetOnNavigation() {
    window.addEventListener('hashchange', openTarget);
    document.addEventListener('click', function (event) {
      if (event.target.closest && event.target.closest('a[href^="#"]')) setTimeout(openTarget, 0);
    });
    if (location.hash) setTimeout(openTarget, 0);
  }

  function openTarget() {
    var target = document.getElementById(decodeURIComponent(location.hash.slice(1)));
    if (!target) return;
    var node = target;
    while (node) {
      if (node.tagName === 'DETAILS') node.open = true;
      node = node.parentElement;
    }
    // Раскрытие меняет высоту документа, поэтому доводим до цели сами.
    target.scrollIntoView({ block: 'start', behavior: 'auto' });
  }

  /**
   * Колесо мыши над блоком кода не запирается в нём.
   *
   * У блока кода своя прокрутка по обеим осям, и браузер отдаёт ему колесо
   * целиком: пока указатель в блоке, страница стоит. Хуже того, «прилипание»
   * работает и когда прокручивать в блоке нечего — длинная строка делает его
   * прокручиваемым по горизонтали, и этого достаточно.
   *
   * Поэтому колесо перехватывается: пока блоку есть куда прокручиваться
   * по вертикали, он прокручивается сам; дошёл до края (или прокручивать
   * нечего) — прокручивается страница. Требование пользователя.
   */
  function chainScrollOutOfCode() {
    // Обработчик вешается на САМ блок кода, а не на документ.
    //
    // Непассивный обработчик колеса на документе означает для браузера:
    // «любой щелчок колеса где угодно может быть отменён». Прокрутка тогда
    // перестаёт идти в потоке композитора и на каждый щелчок ждёт главный
    // поток — на длинном отчёте это видно как рывки. Поэтому документ слушает
    // только наведение указателя, и делает это пассивно, а тяжёлый обработчик
    // достаётся тем блокам кода, над которыми указатель действительно побывал.
    document.addEventListener('mouseover', function (event) {
      var box = event.target && event.target.closest ? event.target.closest('pre.snippet') : null;
      if (!box || box.hasAttribute('data-wheel-chained')) return;
      box.setAttribute('data-wheel-chained', '1');
      box.addEventListener('wheel', chainWheel, { passive: false });
    }, { passive: true });
  }

  function chainWheel(event) {
    if (event.ctrlKey || event.defaultPrevented) return; // масштабирование
    var box = event.currentTarget;
    if (!box) return;

    var delta = event.deltaY;
    if (event.deltaMode === 1) delta *= 16;                    // строки
    else if (event.deltaMode === 2) delta *= window.innerHeight; // страницы
    if (!delta) return;

    var room = box.scrollHeight - box.clientHeight;
    var atEdge = room <= 1
      || (delta > 0 ? box.scrollTop >= room - 1 : box.scrollTop <= 0);
    if (!atEdge) return;

    // Плавная прокрутка (html { scroll-behavior: smooth }) нужна переходам
    // по ссылкам, а колесо от неё уплывает: докрутка идёт анимацией и на
    // следующий щелчок колеса накладывается. Поэтому на время этого шага
    // плавность снимается своим же инлайновым стилем.
    var root = document.documentElement;
    var previous = root.style.scrollBehavior;
    root.style.scrollBehavior = 'auto';
    window.scrollBy(0, delta);
    root.style.scrollBehavior = previous;
    event.preventDefault();
  }

  /**
   * Печать в PDF: раскрываем всё перед печатью и возвращаем как было после.
   *
   * Одним CSS это не решается: содержимое закрытого сворачиваемого блока
   * браузер прячет не через display — снаружи его уже не показать, и в PDF
   * ушёл бы отчёт из одних заголовков.
   */
  function expandForPrinting() {
    var reopen = [];
    window.addEventListener('beforeprint', function () {
      reopen = [];
      [].slice.call(document.querySelectorAll('details')).forEach(function (d) {
        if (!d.open) { reopen.push(d); d.open = true; }
      });
    });
    window.addEventListener('afterprint', function () {
      reopen.forEach(function (d) { d.open = false; });
      reopen = [];
    });
  }
})();
`;
