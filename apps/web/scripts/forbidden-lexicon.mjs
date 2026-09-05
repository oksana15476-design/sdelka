/**
 * Запрещённая лексика клиентских текстов — машинная проверка по трём словарям.
 *
 * ## Зачем отдельный файл
 *
 * `LEGAL-REVIEW.md` §9 п.7 и Ю-08: «Машинная проверка запрещённых подстрок по трём
 * языкам в CI. Ревью глазами эту защиту не даёт». Юрист прочитал словари один раз
 * и нашёл ноль вхождений — но микрокопи сокращают и переписывают дальше, а
 * английский и грузинский переводятся с русского, и слово `escrow` / `ესქრო` в
 * переводе короче и «естественнее» правильного варианта. Проверка живёт отдельно
 * от `verify-ui.mjs`, потому что `verify-ui.mjs` поднимает сервер и браузер, а эта
 * проверка обязана запускаться в тесте за миллисекунды и на данных в памяти.
 *
 * ## Что здесь есть
 *
 * `LEXICON` — правила, собранные **из документов**, каждое со ссылкой на источник.
 * `ALLOWANCES` — разрешённые исключения, каждое с причиной и ссылкой. Исключение
 * без причины не проходит собственную проверку `validateAllowances()`.
 * `scanDictionaries()` — чистая функция: словари на входе, находки на выходе.
 *
 * ## Два уровня строгости и почему их два
 *
 * - **`banned`** — документ запрещает слово, и запрет не зависит от контекста
 *   строки. Находка = падение проверки.
 * - **`open`** — документ запрещает слово **в одном значении и разрешает в
 *   другом** («депозит» о клиентских средствах против «внесены»; «заблокированы»
 *   о реквизитах выплаты против денег; «обычно один банковский день» о банке
 *   против «обычно несколько минут» о нашей собственной проверке). Отличить одно
 *   от другого может человек, а не подстрока, и решение это продуктовое и
 *   юридическое. Такие правила печатаются как «ждёт решения» и не роняют прогон:
 *   иначе выбор был бы между красной проверкой навсегда и молчаливым списком
 *   подавлений, который через месяц никто не читает.
 *
 * ## Чего проверка не умеет
 *
 * Она синтаксическая. «Мы не гарантируем» и «мы гарантируем, что не» для неё
 * одинаковы, поэтому отрицание **не** ищется эвристикой по строке: прежняя
 * редакция искала «не/not/არ» где угодно в значении, и такая проверка пропускает
 * ровно тот случай, ради которого заведена (Ю-08: «в английском и грузинском
 * соблазн заменить отрицание на положительный синоним максимальный»). Отрицание —
 * это исключение по ключу, записанное человеком в `ALLOWANCES` с причиной.
 *
 * ## Границы слов
 *
 * `\b` считается по ASCII и в кириллице с грузинским не работает. Граница —
 * отсутствие буквы по свойству Unicode: `(?<!\p{L})` и `(?!\p{L})`. Основы
 * («гаранти», «эскроу», «безопасн») намеренно **без** правой границы: они обязаны
 * ловить подстроку внутри слова — «Гарантируем», «гарантийный», «эскроу-агент».
 */

/** Порядок словарей фиксирован: русский — исходный, с него переводят. */
export const LOCALES = ['ru', 'en', 'ka'];

/** Основа: ловит подстроку внутри слова и любой регистр. */
function stem(body) {
  return new RegExp(body, 'iu');
}

/** Слово или оборот целиком: слева и справа не буква. */
function word(body) {
  return new RegExp(`(?<!\\p{L})(?:${body})(?!\\p{L})`, 'iu');
}

/** Оборот, у которого важна только левая граница (окончания меняются). */
function phrase(body) {
  return new RegExp(`(?<!\\p{L})(?:${body})`, 'iu');
}

/**
 * Статус покрытия языка у правила.
 *
 * `установлено` — написание взято из документа или наблюдается в отгруженном
 * словаре; `гипотеза` — собрано по правилу словообразования и требует проверки
 * переводчиком; `открыто` — эквивалента нет, и правило на этом языке не ловит
 * ничего. Список «открыто» печатается на каждом прогоне: дыра, о которой знают,
 * лучше дыры, о которой забыли.
 */
export const LEXICON = [
  {
    id: 'escrow',
    tier: 'banned',
    scope: 'all',
    rule: 'эскроу и транслитерации',
    why: 'Эскроу-агентом по грузинскому праву может быть только банк или микробанк. Запрещено само слово, а не экономическая функция, — поэтому оно незаконно и в отрицании.',
    source: 'CLAUDE.md красная линия №10; SCREENS.md §0.4; CONTENT-KIT.md §4; LEGAL-REVIEW.md Ю-08',
    coverage: { ru: 'установлено', en: 'установлено', ka: 'установлено' },
    patterns: [
      stem('эскро[уов]'),
      stem('escrow'),
      stem('eskro[uw]'),
      stem('ესქრ'),
      stem('ესკრ'),
    ],
  },
  {
    id: 'bankProductAccount',
    tier: 'banned',
    scope: 'all',
    rule: 'счёт как банковский продукт',
    why: 'Синонимы, создающие впечатление, что клиент купил банковский продукт: депонирование, гарантийный и условный счёт, аккредитив, trust account, held in trust, safekeeping, deposit account.',
    source: 'LEGAL-REVIEW.md Ю-08; SCREENS.md §0.4',
    coverage: { ru: 'установлено', en: 'установлено', ka: 'гипотеза' },
    patterns: [
      stem('депонирован'),
      phrase('депозитн\\p{L}*\\s+сч[ёе]т'),
      phrase('гарантийн\\p{L}*\\s+сч[ёе]т'),
      phrase('условн\\p{L}*\\s+сч[ёе]т'),
      stem('аккредитив'),
      phrase('deposit\\s+account'),
      phrase('trust\\s+account'),
      phrase('held\\s+in\\s+trust'),
      stem('safekeeping'),
      phrase('letter\\s+of\\s+credit'),
      // Грузинский порядок слов не установлен, поэтому ловим оба: «დეპოზიტ…
      // ანგარიშ…» и обратный. Помечено «гипотеза» — подтверждает переводчик.
      stem('დეპოზიტ\\p{L}*\\s+ანგარიშ'),
      stem('ანგარიშ\\p{L}*\\s+დეპოზიტ'),
    ],
  },
  {
    id: 'guarantee',
    tier: 'banned',
    scope: 'client',
    rule: 'гарантия',
    why: 'Про что бы то ни было. Разрешено ровно одно употребление — в отрицании, там, где мы снимаем ожидание; оно записано исключением по ключу.',
    source: 'CONTENT-KIT.md §4; SCREENS.md §0.4; DRAFT-trust.md §7',
    coverage: { ru: 'установлено', en: 'установлено', ka: 'установлено' },
    patterns: [stem('гаранти'), stem('guarant'), stem('გარანტ')],
  },
  {
    id: 'absoluteSafety',
    tier: 'banned',
    scope: 'client',
    rule: 'полная защита и проценты',
    why: '«Полная защита», «100%», «абсолютно безопасно» — обещание, которое нечем закрыть.',
    source: 'CONTENT-KIT.md §4; DRAFT-trust.md §1',
    coverage: { ru: 'установлено', en: 'установлено', ka: 'открыто' },
    patterns: [
      phrase('абсолютно\\s+безопасн'),
      phrase('полн\\p{L}*\\s+защит'),
      phrase('100\\s*%\\s*(?:безопасн|защит|гаранти)'),
      phrase('100\\s*%\\s*(?:safe|protect|guarant)'),
      phrase('full\\s+protection'),
      phrase('(?:completely|absolutely|totally)\\s+safe'),
    ],
  },
  {
    id: 'ourMoney',
    tier: 'banned',
    scope: 'client',
    rule: 'деньги как наши',
    why: 'Клиентские деньги лежат на счёте номинального держания обособленно. «Ваши деньги у нас», «на нашем счёте», «на нашем балансе» описывают чужой баланс как свой.',
    source: 'SCREENS.md §0.4; CONTENT-KIT.md §4; DRAFT-money.md §2 (таблица терминов)',
    coverage: { ru: 'установлено', en: 'установлено', ka: 'открыто' },
    patterns: [
      phrase('ваши\\s+деньги\\s+у\\s+нас'),
      phrase('на\\s+наш(?:ем|ём)\\s+сч[ёе]т'),
      phrase('наш\\s+сч[ёе]т'),
      phrase('на\\s+наш(?:ем|ём)\\s+балансе'),
      phrase('our\\s+account'),
      phrase('our\\s+balance\\s+sheet'),
    ],
  },
  {
    id: 'weTransferToSeller',
    tier: 'banned',
    scope: 'client',
    rule: 'мы переводим продавцу',
    why: 'Клиент не даёт поручение банку, поручение даёт платформа; и наоборот — не мы «переводим продавцу». Обе конструкции описывают несуществующий маршрут денег.',
    source: 'SCREENS.md §0.4; CABINETS.md §0.1; DRAFT-money.md §2; DRAFT-trust.md §6 (trust.weDo.2)',
    coverage: { ru: 'установлено', en: 'установлено', ka: 'открыто' },
    patterns: [
      phrase('перевед[её]м\\s+(?:продавцу|получателю)'),
      phrase('переводим\\s+(?:их\\s+)?(?:продавцу|получателю)'),
      phrase('перевести\\s+(?:деньги\\s+)?продавцу'),
      phrase('отправить\\s+деньги\\s+(?:продавцу|получателю)'),
      phrase('вы\\s+перевели'),
      phrase('вы\\s+выплатили'),
      phrase('мы\\s+выплатили'),
      phrase('we\\s+(?:will\\s+)?(?:transfer|send)\\s+(?:the\\s+)?(?:money|funds)\\s+to'),
      phrase('you\\s+transferred'),
      phrase('you\\s+paid\\s+out'),
      phrase('we\\s+paid\\s+out'),
    ],
  },
  {
    id: 'discretion',
    tier: 'banned',
    scope: 'client',
    rule: 'расчёт по нашему усмотрению',
    why: 'Условие, наступление которого зависит только от воли стороны, делает сделку ничтожной (ГК ст. 92). Формулировка «когда платформа сочтёт условия выполненными» недопустима в любом виде.',
    source: 'SCREENS.md §0.4; DESCRIPTION.md §14; LEGAL-REVIEW.md §3, Ю-11',
    coverage: { ru: 'установлено', en: 'установлено', ka: 'открыто' },
    patterns: [
      stem('сочт[её]м'),
      phrase('по\\s+нашему\\s+усмотрению'),
      phrase('на\\s+наше\\s+усмотрение'),
      phrase('если\\s+мы\\s+признаем'),
      phrase('когда\\s+мы\\s+(?:решим|сочт)'),
      phrase('at\\s+our\\s+discretion'),
      phrase('if\\s+we\\s+deem'),
      phrase('when\\s+we\\s+see\\s+fit'),
    ],
  },
  {
    id: 'irrevocable',
    tier: 'banned',
    scope: 'client',
    rule: 'безотзывность',
    why: 'Средства до расчёта остаются собственностью вносящей стороны и отзывны. Безотзывное поручение ничтожно, а обещание безотзывности получателю — ложное обещание.',
    source: 'SCREENS.md §0.4; DRAFT-trust.md §1; LEGAL-REVIEW.md §1',
    coverage: { ru: 'установлено', en: 'установлено', ka: 'открыто' },
    patterns: [stem('безотзывн'), stem('irrevocab')],
  },
  {
    id: 'instantPromise',
    tier: 'banned',
    scope: 'client',
    rule: 'мгновенность',
    why: 'Срок расчёта зависит от реестра и банка, а не от нас. «Мгновенно», «за минуту», «в один клик» — обещание чужого срока как своего.',
    source: 'CONTENT-KIT.md §4',
    coverage: { ru: 'установлено', en: 'установлено', ka: 'открыто' },
    patterns: [
      stem('мгновен'),
      phrase('в\\s+один\\s+клик'),
      phrase('за\\s+(?:одну\\s+)?минуту'),
      word('instant(?:ly)?'),
      phrase('one\\s+click'),
      phrase('in\\s+a\\s+minute'),
    ],
  },
  {
    id: 'legalCheck',
    tier: 'banned',
    scope: 'client',
    rule: 'юридическая проверка объекта',
    why: 'Мы проверяем состояние реестра, а не чистоту объекта. «Пакет доказательств» — не «юридическая проверка».',
    source: 'CONTENT-KIT.md §4; DRAFT-trust.md §7 (глоссарий)',
    coverage: { ru: 'установлено', en: 'установлено', ka: 'открыто' },
    patterns: [
      phrase('юридическ\\p{L}*\\s+проверк'),
      phrase('проверено\\s+юридически'),
      phrase('чист\\p{L}*\\s+объект'),
      phrase('legal(?:ly)?\\s+(?:check|verified|clean)'),
      phrase('clean\\s+title'),
    ],
  },
  {
    id: 'accessRefusal',
    tier: 'banned',
    scope: 'all',
    rule: 'отказ без причины',
    why: 'Шаблон отказа в действии: что недоступно → причина фактом → когда станет доступно → путь дальше. «Недостаточно прав», «ошибка доступа», «обратитесь к администратору», «действие невозможно» не называют причину своим именем.',
    source: 'DRAFT-actions.md, «Шаблон отказа в действии»',
    coverage: { ru: 'установлено', en: 'установлено', ka: 'открыто' },
    patterns: [
      phrase('недостаточно\\s+прав'),
      phrase('ошибка\\s+доступа'),
      phrase('обратитесь\\s+к\\s+администратору'),
      phrase('действие\\s+невозможно'),
      phrase('insufficient\\s+(?:rights|permissions|privileges)'),
      phrase('access\\s+error'),
      phrase('contact\\s+(?:your\\s+)?(?:the\\s+)?administrator'),
    ],
  },
  {
    id: 'favour',
    tier: 'banned',
    scope: 'client',
    rule: 'право как одолжение',
    why: 'Право не подаётся как одолжение: «в порядке исключения», «мы можем пойти навстречу».',
    source: 'DRAFT-actions.md §kyc.liveness.alt; SCREENS.md §3.2',
    coverage: { ru: 'установлено', en: 'установлено', ka: 'открыто' },
    patterns: [
      phrase('в\\s+порядке\\s+исключения'),
      phrase('пойти\\s+навстречу'),
      phrase('as\\s+an\\s+exception'),
    ],
  },
  {
    id: 'tone',
    tier: 'banned',
    scope: 'client',
    rule: 'бодрость и сочувствие',
    why: 'Ни бодрости, ни сочувствия. Человек отдал шестизначную сумму; тёплый тон в этот момент читается как продажа, а не как поддержка.',
    source: 'DRAFT-money.md §2, правило 2',
    coverage: { ru: 'установлено', en: 'установлено', ka: 'открыто' },
    patterns: [
      phrase('к\\s+сожалению'),
      word('отлично'),
      phrase('не\\s+переживайте'),
      phrase('вс[её]\\s+под\\s+контролем'),
      stem('unfortunately'),
      phrase('do\\s?n[o’\']?t\\s+worry'),
      phrase('everything\\s+is\\s+under\\s+control'),
    ],
  },
  {
    id: 'metaphor',
    tier: 'banned',
    scope: 'client',
    rule: 'метафора вместо факта',
    why: 'Метафоры не переводятся и обещают больше, чем сказано: «под замком», «в сейфе», «под ключ», «деньги не пропадут», «висит».',
    source: 'DRAFT-money.md §2, правило 7; DRAFT-trust.md §1 («Переводимость»)',
    coverage: { ru: 'установлено', en: 'установлено', ka: 'открыто' },
    patterns: [
      phrase('под\\s+замком'),
      stem('сейф'),
      phrase('под\\s+ключ'),
      phrase('деньги\\s+не\\s+пропадут'),
      word('висит'),
      word('vault'),
      phrase('under\\s+lock'),
      phrase('in\\s+a\\s+safe(?!\\p{L})'),
    ],
  },

  /* ---------------------------------------------- ждёт решения человека */

  {
    id: 'safetyPromise',
    tier: 'open',
    scope: 'client',
    rule: 'обещание безопасности',
    why: '«Безопасная сделка» как обещание запрещена. Допустима только там, где страница честно объясняет, что в сделке бывает небезопасным и кто какой риск закрывает.',
    question: 'Это обещание безопасности или названная граница? Если граница — ключ вносится в ALLOWANCES с причиной; если обещание — текст переписывает главред.',
    source: 'CONTENT-KIT.md §4; DRAFT-trust.md §5; LEGAL-REVIEW.md «Запрещённое: не найдено»',
    coverage: { ru: 'установлено', en: 'установлено', ka: 'установлено' },
    patterns: [
      stem('безопасн'),
      word('safe(?:ly|r|st)?'),
      word('secure(?:ly)?'),
      word('security'),
      stem('უსაფრთხ'),
    ],
  },
  {
    id: 'foreignDeadline',
    tier: 'open',
    scope: 'client',
    rule: 'чужой срок за словом «обычно»',
    why: 'Чужие сроки называем чужими: банк и реестр — не наши обязательства, и текст говорит это прямо, а не прячет за «обычно». Срок нашего собственного действия называть можно.',
    question: 'Чей это срок — наш или банка, реестра, второй стороны? Наш — исключение с причиной; чужой — срок называется чужим прямо.',
    source: 'DRAFT-money.md §2, правило 5; SECURE-SETTLEMENT.md §7; CONTENT-KIT.md §4; LEGAL-REVIEW.md Ю-02',
    // Грузинское «ჩვეულებრივ» подтверждено отгруженным словарём: оно стоит
    // ровно в тех ключах, где в русском стоит «обычно».
    coverage: { ru: 'установлено', en: 'установлено', ka: 'установлено' },
    patterns: [word('обычно'), word('usually'), stem('ჩვეულებრივ')],
  },
  {
    id: 'clientDeposit',
    tier: 'open',
    scope: 'client',
    rule: 'депозит о клиентских средствах',
    why: 'Ю-08 запрещает «депозит» применительно к клиентским средствам — это слово банковского продукта. О внесении денег на счёт номинального держания говорим «внесены», «поступление».',
    question: 'Слово стоит о клиентских средствах (запрещено) или описывает действие внесения (допустимо)? Решение — за юристом, не за подстрокой.',
    source: 'LEGAL-REVIEW.md Ю-08',
    coverage: { ru: 'установлено', en: 'установлено', ka: 'установлено' },
    patterns: [stem('депозит'), phrase('deposit'), stem('დეპოზიტ')],
  },
  {
    id: 'blockedSubject',
    tier: 'open',
    scope: 'client',
    rule: 'блокировка — о чём именно',
    why: '«Заблокированы» разрешено только о реквизитах выплаты и никогда о деньгах и резерве: о деньгах — «зарезервированы под сделку», всегда.',
    question: 'Что заблокировано — реквизиты (разрешено, DRAFT-trust §7) или деньги и резерв (запрещено)?',
    source: 'SCREENS.md §0.4; DRAFT-trust.md §7 (разрешённые исключения)',
    coverage: { ru: 'установлено', en: 'установлено', ka: 'открыто' },
    patterns: [stem('заблокир'), stem('блокиров'), word('blocked'), word('locked')],
  },
  {
    id: 'frozenSubject',
    tier: 'open',
    scope: 'client',
    rule: 'заморозка',
    why: '«Заморозка» — санкционный термин с другим значением. О резерве — «зарезервированы под сделку до срока».',
    question: 'Слово о резерве (запрещено) или о санкционной мере и отрицании таковой (требует решения)?',
    source: 'SCREENS.md §0.4; DRAFT-money.md §2 (таблица терминов и правило 7)',
    coverage: { ru: 'установлено', en: 'установлено', ka: 'установлено' },
    patterns: [stem('заморо[жз]'), stem('разморо'), stem('froz(?:en|e)'), stem('freez'), stem('გაყინ')],
  },
  {
    id: 'lockedMoney',
    tier: 'open',
    scope: 'client',
    rule: '«заперто» — документы расходятся',
    why: 'DRAFT-actions закрепляет «заперто» как термин («средства привязаны к сделке», только о деньгах), DRAFT-money §2 и DRAFT-trust §1 перечисляют его как запрещённую метафору. Пока расхождение не снято, слово не запрещается и не разрешается машинно.',
    question: 'Какой из двух документов главный. Решение принимает владелец и фиксирует пометкой [решение].',
    source: 'DRAFT-actions.md (глоссарий, строка «заперто»); DRAFT-money.md §2 правило 7; DRAFT-trust.md §1',
    coverage: { ru: 'установлено', en: 'открыто', ka: 'открыто' },
    patterns: [stem('заперт')],
  },
  {
    id: 'othersDeal',
    tier: 'open',
    scope: 'client',
    rule: 'утверждение о чужой сделке',
    why: 'Ю-16: «сделка не состоялась» — утверждение о чужой сделке, которого мы не знаем. Не состоялся расчёт через сервис. Замена — «расчёт через сервис не исполнен».',
    question: 'Ю-16 против таблицы терминов DRAFT-money §2, где «сделка не состоялась» — предписанная формулировка. LEGAL-REVIEW.md в статусе «на приёмку владельцем»: до приёмки правило не становится запретом.',
    source: 'LEGAL-REVIEW.md Ю-16; DRAFT-money.md §2 (таблица терминов)',
    coverage: { ru: 'установлено', en: 'установлено', ka: 'открыто' },
    patterns: [
      phrase('сделка\\s+не\\s+состоялась'),
      phrase('the\\s+deal\\s+did\\s+not\\s+(?:take\\s+place|happen|go\\s+through)'),
    ],
  },
];

/**
 * Разрешённые исключения. Только явным списком и только с причиной.
 *
 * `key` — точный ключ либо префикс, оканчивающийся точкой. `locales` — языки, для
 * которых исключение действует; отсутствие поля означает все три.
 *
 * Исключение, которое ничего не разрешает (ключ исчез, слово переписано),
 * считается ошибкой и роняет проверку: разрешение, пережившее свой текст, не
 * ломает ничего сегодня и молча разрешает завтра.
 */
export const ALLOWANCES = [
  {
    rule: 'guarantee',
    key: 'assurance.ladder.note',
    why: 'Единственное разрешённое употребление — в отрицании: «Это не гарантия платежа». Слово снимает ожидание, а не создаёт его.',
    source: 'DRAFT-trust.md §7, «Два разрешённых исключения»',
  },
  {
    rule: 'ourMoney',
    key: 'assurance.whereMoney.body',
    locales: ['ru', 'en'],
    why: 'Оборот стоит в отрицании и несёт обязательное раскрытие: «Не на нашем балансе: клиентские деньги хранятся обособленно».',
    source: 'DRAFT-trust.md §3.3; DESCRIPTION.md §12',
  },
  {
    rule: 'ourMoney',
    key: 'deal.paying.where.reserved.body',
    locales: ['ru', 'en'],
    why: 'Тот же оборот в отрицании: «не у получателя и не на нашем балансе».',
    source: 'DRAFT-money.md §M-09',
  },
  {
    rule: 'instantPromise',
    key: 'requisites.subtitle',
    locales: ['ru', 'en'],
    why: 'Отрицание мгновенности и есть смысл строки: «здесь всё делается медленно… без единого мгновенного действия».',
    source: 'DRAFT-actions.md, защитный периметр реквизитов',
  },
  {
    rule: 'safetyPromise',
    key: 'trust.boundary',
    why: 'Строка проводит границу, а не обещает: «Мы делаем безопасным расчёт. Сделку целиком безопасной делают юрист, реестр и вы сами».',
    source: 'DRAFT-trust.md §6, trust.boundary',
  },
  {
    rule: 'safetyPromise',
    key: 'security.page.title',
    why: 'Название экрана B-07 «Безопасность и помощь», зафиксировано дословно.',
    source: 'DRAFT-trust.md §4.1',
  },
  {
    rule: 'safetyPromise',
    key: 'nav.security',
    why: 'Пункт навигации на экран B-07: та же строка, что и заголовок экрана.',
    source: 'DRAFT-trust.md §4.1',
  },
  {
    rule: 'safetyPromise',
    key: 'nav.help',
    why: 'Второй пункт навигации на тот же экран B-07.',
    source: 'DRAFT-trust.md §4.1',
  },
  {
    rule: 'legalCheck',
    key: 'trust.weDoNot.1',
    why: 'Строка блока «чего мы не делаем» и есть отрицание: «Не проверяем чистоту объекта. Мы смотрим состояние реестра на дату выписки — это не то же самое».',
    source: 'DRAFT-trust.md §6, trust.weDoNot.1',
  },
  {
    rule: 'blockedSubject',
    key: 'requisites.',
    why: '«Заблокированы» о реквизитах выплаты — разрешённое исключение: для получателя это защита, а не ограничение.',
    source: 'DRAFT-trust.md §7, «Два разрешённых исключения»',
  },
  {
    rule: 'blockedSubject',
    key: 'assurance.youReceive.payoutVerified',
    why: 'Тот же случай, названный в исключении дословно: «Реквизиты проверены и заблокированы до расчёта».',
    source: 'DRAFT-trust.md §7',
  },
];

/** Ключи консоли операций: внутренний текст, а не текст для клиента. */
const OPS_PREFIX = 'ops.';

function allowanceMatches(allowance, ruleId, key, locale) {
  if (allowance.rule !== ruleId) return false;
  const byKey = allowance.key.endsWith('.')
    ? key.startsWith(allowance.key)
    : key === allowance.key;
  if (!byKey) return false;
  return allowance.locales === undefined || allowance.locales.includes(locale);
}

/**
 * Исключение обязано иметь причину и ссылку и указывать на существующее правило.
 * Проверяется до сканирования: список без причины — не список исключений.
 */
export function validateAllowances(rules = LEXICON, allowances = ALLOWANCES) {
  const ids = new Set(rules.map((rule) => rule.id));
  const problems = [];
  for (const allowance of allowances) {
    const where = `${allowance.rule}/${allowance.key}`;
    if (!ids.has(allowance.rule)) problems.push(`${where}: правила с таким id нет`);
    if (typeof allowance.why !== 'string' || allowance.why.trim().length < 20) {
      problems.push(`${where}: исключение без причины`);
    }
    if (typeof allowance.source !== 'string' || allowance.source.trim().length === 0) {
      problems.push(`${where}: исключение без ссылки на документ`);
    }
  }
  return problems;
}

/**
 * Прогон по трём словарям. Проверяются **значения**, а не ключи: ключ пишет
 * разработчик и его видит ревью, значение приходит от переводчика и меняется
 * после ревью.
 *
 * @param {Record<string, Record<string, string>>} dicts словари по языкам
 * @returns {{findings: Array, unusedAllowances: Array, gaps: Array}}
 */
export function scanDictionaries(dicts, options = {}) {
  const rules = options.rules ?? LEXICON;
  const allowances = options.allowances ?? ALLOWANCES;
  const locales = options.locales ?? LOCALES;

  const findings = [];
  const used = new Set();

  for (const locale of locales) {
    const dict = dicts[locale];
    if (dict === undefined) continue;
    for (const [key, value] of Object.entries(dict)) {
      if (typeof value !== 'string') continue;
      for (const rule of rules) {
        if (rule.scope === 'client' && key.startsWith(OPS_PREFIX)) continue;
        const allowance = allowances.find((item) => allowanceMatches(item, rule.id, key, locale));
        for (const pattern of rule.patterns) {
          const found = value.match(pattern);
          if (found === null) continue;
          if (allowance !== undefined) {
            used.add(allowance);
            break;
          }
          findings.push({
            tier: rule.tier,
            ruleId: rule.id,
            rule: rule.rule,
            locale,
            key,
            word: found[0],
            source: rule.source,
            question: rule.question,
          });
          break;
        }
      }
    }
  }

  const unusedAllowances = allowances.filter((item) => !used.has(item));
  const gaps = [];
  for (const rule of rules) {
    for (const [locale, status] of Object.entries(rule.coverage ?? {})) {
      if (status !== 'установлено') gaps.push({ ruleId: rule.id, rule: rule.rule, locale, status });
    }
  }

  findings.sort((a, b) => a.key.localeCompare(b.key) || a.locale.localeCompare(b.locale));
  return { findings, unusedAllowances, gaps };
}

/** Сообщение об одной находке: язык, ключ, слово, правило. */
export function formatFinding(finding) {
  return `${finding.locale}: ${finding.key} — «${finding.word}» (${finding.rule})`;
}
