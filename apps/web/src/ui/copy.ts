/**
 * Строки, которые ещё не прошли связку **копирайтер → главред**.
 *
 * ## Зачем перечень, если строки уже в словарях
 *
 * Правило проекта: любой текст, который видит клиент, пишет копирайтер и
 * принимает главред (`CLAUDE.md`, «Разделение работы»). Форма при этом не может
 * ждать: поле без подписи и кнопка без надписи — это не «пока молчим», это
 * неработающий экран. У ⚖-слотов выход есть — не рендерить блок целиком
 * (`PENDING_LEGAL_SLOTS` в `primitives.tsx`); у органа управления такого выхода
 * нет.
 *
 * Поэтому строки заведены **черновиком** и перечислены здесь. Перечень — не
 * оговорка в отчёте, а список работы: он печатается на каждом обходе числом и
 * поимённо, и снимается по одной строке — правкой в трёх словарях и
 * вычёркиванием ключа отсюда.
 *
 * ## Что осталось после приёмки формы вывода
 *
 * Микрокопи экрана вывода (`withdraw.*`) прошла связку целиком: черновик
 * написан копирайтером, вычитан и переписан главредом, ключи из перечня сняты.
 * Осталось три рода строк, и ни одна из них главреда больше не ждёт.
 *
 * · **Ждут юриста** — перечислены ниже отдельным списком: это утверждения о
 *   праве, а не микрокопи. Имя списка здесь не названо намеренно: перечни
 *   вычитываются из исходника по имени (`verify-ui.mjs`, `readNamedList`), и
 *   упоминание имени выше объявления уводит чтение на соседний список.
 * · **Ждёт решения владельца** — `withdraw.form.max` («Всё свободное»). Строка
 *   грамотна и в голосе, но её **значение** не определено, пока не отвечен
 *   `DECISIONS-REVIEW.md` M1: комиссия за вывод берётся сверх суммы или
 *   удерживается из неё. При первом ответе «всё свободное» перестаёт быть равно
 *   свободному остатку, и текст обязан это назвать. Принимать строку, смысл
 *   которой решает владелец, главред не вправе.
 *
 * ## Строки, которых экран пока не рендерит
 *
 * `withdraw.state.paying_out.unknown.*`, `withdraw.state.blocked.review.*`,
 * `withdraw.state.blocked.rejected.*` и `withdraw.repeat.blocked.unknown`
 * приняты и лежат в трёх словарях, но на экране их **нет**: `withdraw/page.tsx`
 * собирает ключ шаблоном `withdraw.state.${status}.*` по шести состояниям
 * машины (`WITHDRAWAL_STATUSES`), а различить «отправлено» и «отправлено, исход
 * неизвестен», «остановила наша проверка» и «банк не исполнил» по одному
 * статусу нельзя: причина остановки и исход выплаты живут в
 * `packages/domain/src/payout.ts`, и в слой экрана (`fixtures/screens.ts`,
 * `getWithdraw`) сегодня не приходят вовсе.
 *
 * Подключение этих строк — работа домена и экрана, а не словаря: сочинить
 * источник данных ради текста значило бы придумать поведение продукта. Пока
 * данных нет, «неизвестно» показывается клиенту как «перевод отправлен», и это
 * расхождение с красной линией №8 названо здесь, а не спрятано.
 */
export const PENDING_COPY_KEYS: readonly string[] = Object.freeze([
  'withdraw.form.max',
  'withdraw.form.error.source.unknown',
  'withdraw.form.error.source.holder',
  'withdraw.review.note',
  'withdraw.approvals.note',
  'withdraw.cancel.blocked.sent',
  'withdraw.state.paying_out.unknown.body',
  'withdraw.state.blocked.rejected.body',
  'withdraw.repeat.blocked.unknown',

  /*
   * Публичные страницы: лендинг, страница второй стороны, партнёрская
   * (`docs/product/LANDING.md`). Черновик здесь **весь текст целиком**, а не
   * отдельные строки, и это не оговорка: спека говорит, что должно быть
   * сказано, а не какими словами. Дизайн-агент оставил место правильной длины —
   * слова пишет копирайтер, принимает главред.
   *
   * Что важно знать тому, кто возьмёт эти строки в работу:
   *
   * · **Редакция Г1.** Продукт не запущен, и ни одна строка не говорит о сервисе
   *   в настоящем времени: механика описана страдательным залогом, а «мы»
   *   стоит только там, где речь о запуске («собираем первых участников»).
   *   Переписывать в настоящее время нельзя до первой живой сделки — это
   *   критерий приёмки ПЛ9, а не стилистика.
   * · **Запрещённое слово.** Красная линия №10 действует и в мета-описании, и в
   *   заголовке вкладки. Замена — не синоним, а порядок фактов: где деньги →
   *   что должно случиться → что если не случится.
   * · **`risks.promise` — общий ключ.** Обещание на сайте и на будущей карте
   *   рисков (E10-1) — одна строка, а не две. Правка здесь меняет обе
   *   поверхности; заводить второй ключ об одном обещании запрещено.
   * · **Грузинская версия проверяется первой.** Заголовки уложены в бюджет 44
   *   знака на `ka`, тела карточек — в 240. Строка, выросшая на русском, обычно
   *   ломает раскладку именно на грузинском.
   */
  'landing.decides.fact.body',
  'landing.decides.fact.title',
  'landing.decides.middleman.body',
  'landing.decides.middleman.title',
  'landing.decides.note',
  'landing.decides.other.body',
  'landing.decides.other.title',
  'landing.decides.ours',
  'landing.decides.reverse',
  'landing.decides.title',
  'landing.facts.otherwise.body',
  'landing.facts.otherwise.title',
  'landing.facts.title',
  'landing.facts.trigger.body',
  'landing.facts.trigger.title',
  'landing.facts.where.body',
  'landing.facts.where.title',
  'landing.faq.closed.q',
  'landing.faq.notary.a',
  'landing.faq.notary.q',
  'landing.faq.price.q',
  'landing.faq.speed.a',
  'landing.faq.speed.q',
  'landing.faq.title',
  'landing.faq.who.q',
  'landing.foot.note',
  'landing.foot.partner',
  'landing.form.amount.hint',
  'landing.form.amount.label',
  'landing.form.contact.hint',
  'landing.form.contact.label',
  'landing.form.country.hint',
  'landing.form.country.label',
  'landing.form.draftNote',
  'landing.form.note',
  'landing.form.submit',
  'landing.form.support',
  'landing.form.timing.hint',
  'landing.form.timing.label',
  'landing.form.title',
  'landing.hero.body',
  'landing.hero.cta',
  'landing.hero.eyebrow',
  'landing.hero.forward',
  'landing.hero.forward.note',
  'landing.hero.stage',
  'landing.hero.title',
  'landing.money.card',
  'landing.money.currency',
  'landing.money.rate',
  'landing.money.title',
  'landing.notFor.1',
  'landing.notFor.2',
  'landing.notFor.3',
  'landing.notFor.4',
  'landing.notFor.note',
  'landing.notFor.title',
  'landing.partner.eyebrow',
  'landing.partner.form.note',
  'landing.partner.form.submit',
  'landing.partner.form.title',
  'landing.partner.form.who.hint',
  'landing.partner.form.who.label',
  'landing.partner.limit',
  'landing.partner.noPromise.1',
  'landing.partner.noPromise.2',
  'landing.partner.noPromise.3',
  'landing.partner.noPromise.title',
  'landing.partner.seek.body',
  'landing.partner.seek.title',
  'landing.partner.title',
  'landing.partner.what.body',
  'landing.paused.body',
  'landing.paused.title',
  'landing.promise.title',
  'landing.recipient.assurance.body',
  'landing.recipient.assurance.note',
  'landing.recipient.assurance.title',
  'landing.recipient.boundary.body',
  'landing.recipient.boundary.title',
  'landing.recipient.contact.note',
  'landing.recipient.contact.title',
  'landing.recipient.eyebrow',
  'landing.recipient.faq.cost.a',
  'landing.recipient.faq.cost.q',
  'landing.recipient.faq.direct.a',
  'landing.recipient.faq.direct.q',
  'landing.recipient.faq.revoke.a',
  'landing.recipient.faq.revoke.q',
  'landing.recipient.faq.title',
  'landing.recipient.intro',
  'landing.recipient.need.1',
  'landing.recipient.need.2',
  'landing.recipient.need.3',
  'landing.recipient.need.title',
  'landing.recipient.title',
  'landing.recipient.what.body',
  'landing.recipient.what.title',
  'landing.recipient.when.body',
  'landing.recipient.when.late',
  'landing.recipient.when.title',
  'landing.rules.title',
  'landing.sent.body',
  'landing.sent.never',
  'landing.sent.title',
  'landing.step.1.body',
  'landing.step.1.title',
  'landing.step.2.body',
  'landing.step.2.title',
  'landing.step.3.body',
  'landing.step.3.title',
  'landing.step.4.body',
  'landing.step.4.title',
  'landing.step.5.body',
  'landing.step.5.title',
  'landing.steps.title',
  'landing.where.title',
  'landing.youNeed.1',
  'landing.youNeed.2',
  'landing.youNeed.3',
  'landing.youNeed.4',
  'landing.youNeed.title',
  'risks.promise',
]);

/**
 * Строки, чей **перевод** написан не носителем языка.
 *
 * Русский здесь исходный: его пишет копирайтер и принимает главред. Английский и
 * грузинский собраны терминологией, уже отгруженной в словарях (`დავალება`,
 * `ამონაწერთან შედარება`, `ნომინალურ ანგარიშზე`, `წყარო-ანგარიში`, `nominee
 * account`), и проверены двумя машинными проверками — длиной на грузинском и
 * запрещённой лексикой по трём языкам. Ни та, ни другая не проверяет **язык**:
 * падеж, порядок слов и то, звучит ли фраза по-грузински, видит носитель.
 *
 * Перечень — то же, что и остальные два: названная работа, а не оговорка.
 * Строка снимается отсюда после вычитки носителем, а не после следующей правки
 * русского.
 */
export const PENDING_NATIVE_REVIEW_KEYS: readonly string[] = Object.freeze([
  'withdraw.form.error.amount.positive',
  'withdraw.state.requested.body',
  'withdraw.state.approved.body',
  'withdraw.state.paying_out.body',
  'withdraw.state.paying_out.unknown.title',
  'withdraw.state.paying_out.unknown.body',
  'withdraw.state.blocked.badge',
  'withdraw.state.blocked.body',
  'withdraw.state.blocked.review.body',
  'withdraw.state.blocked.rejected.badge',
  'withdraw.state.blocked.rejected.body',
  'withdraw.repeat.blocked.unknown',
]);

/**
 * Ключи из перечня, которые ждут юриста, а не главреда.
 *
 * Общее у всех: строка утверждает **право**, а не описывает экран.
 *
 * · `withdraw.review.note` — граница отзыва заявки («после утверждения отмены не
 *   бывает»); `withdraw.cancel.blocked.sent` — та же граница после отправки
 *   поручения в банк;
 * · `withdraw.form.error.source.unknown` и `.holder` — отказ в выводе на чужой
 *   счёт, то есть инвариант 20 словами для клиента;
 * · `withdraw.approvals.note` — раскрытие внутреннего контроля;
 * · `withdraw.state.paying_out.unknown.body` и `withdraw.repeat.blocked.unknown`
 *   — запрет распоряжаться собственными отзывными средствами до сверки
 *   (красная линия №8, граница отзыва — `DECISIONS-REVIEW.md` B1, [открыто]);
 * · `withdraw.state.blocked.rejected.body` — заявкой клиента после остановки
 *   распоряжается оператор («либо утвердят снова, либо отменят»). Это описание
 *   переходов машины, но читается оно как право оператора отменить заявку, и
 *   границу тут проводит юрист.
 *
 * Снято отсюда главредом: `withdraw.state.approved.body`. Утверждение о праве
 * («отменить заявку уже нельзя») из строки убрано — тот же запрет с точной
 * причиной стоит на этом же экране ниже (`withdraw.cancel.blocked`, орган
 * `BlockedAction`), и повторённый в теле плашки он читался вторым, другим
 * отказом.
 */
export const PENDING_LEGAL_REVIEW_KEYS: readonly string[] = Object.freeze([
  'withdraw.review.note',
  'withdraw.form.error.source.unknown',
  'withdraw.form.error.source.holder',
  'withdraw.approvals.note',
  'withdraw.cancel.blocked.sent',
  'withdraw.state.paying_out.unknown.body',
  'withdraw.state.blocked.rejected.body',
  'withdraw.repeat.blocked.unknown',

  /*
   * Публичные страницы. Здесь не микрокопи, а утверждения о правах и о законе:
   * кто чем владеет до расчёта, что делает сделку ничтожной, чей платёж
   * останавливается на входе, кто платит комиссию и на каком основании
   * расторгается договор с партнёром. Такое утверждение принимает
   * `legal-compliance-ru`, а не главред, — и до его ответа строка публикуется
   * черновиком ровно потому, что альтернатива (умолчание в этих местах)
   * оставила бы читателя без ответа на вопрос, который он всё равно задаст.
   *
   * Строки, которые не публикуются вовсе, — не здесь, а в `PENDING_LEGAL_SLOTS`
   * (`ui/primitives.tsx`): статус сервиса, три правила Ю-25, цена, согласие.
   */
  'landing.decides.middleman.body',
  'landing.decides.reverse',
  'landing.facts.otherwise.body',
  'landing.faq.notary.a',
  'landing.money.currency',
  'landing.notFor.1',
  'landing.partner.limit',
  'landing.recipient.assurance.note',
  'landing.recipient.boundary.body',
  'landing.recipient.faq.cost.a',
  'landing.recipient.need.2',
  'landing.step.4.body',
  'landing.youNeed.3',
]);
