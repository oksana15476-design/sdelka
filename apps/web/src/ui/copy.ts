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
 * ## Что осталось после приёмки публичных страниц
 *
 * Текст лендинга, страницы второй стороны и партнёрской прошёл связку целиком:
 * черновик написан копирайтером, вычитан и переписан главредом, сто семь ключей
 * `landing.*` и `risks.promise` из перечня сняты. Осталось пятнадцать строк, и
 * ни одна из них главреда не ждёт — они ждут юриста (список ниже) и, в одном
 * месте, владельца: `landing.recipient.faq.cost.a` называет вторую сторону
 * неплательщиком комиссии, а кто её несёт — открытая развилка
 * (`DECISIONS-REVIEW.md` J2 и Q2). Строка переписана так, чтобы развилку не
 * закрывать собой, но её **значение** остаётся за владельцем.
 *
 * ## Строки исхода поручения: подключены
 *
 * `withdraw.state.paying_out.unknown.*`, `withdraw.state.blocked.review.*`,
 * `withdraw.state.blocked.rejected.*` и `withdraw.repeat.blocked.unknown`
 * рендерятся. Прежде их на экране не было: `withdraw/page.tsx` собирал ключ
 * шаблоном `withdraw.state.${status}.*` по шести состояниям машины, и
 * «неизвестно» показывалось клиенту как «перевод отправлен» — расхождение с
 * красной линией №8.
 *
 * Чинилось это не словарём, а данными, и источник взят у машины, а не выдуман:
 * исход стоит у ребра перехода (`WithdrawalTransition.outcome`), перечень
 * возможных исходов считает `withdrawalArrivals`
 * (`packages/domain/src/client-account.ts`), до вида его доводит
 * `WithdrawView.arrival` (`fixtures/screens.ts`), а ключи выбирает
 * `view/withdraw-state.ts`.
 *
 * Общие `withdraw.state.blocked.*` при этом остались в деле и означают ровно
 * то, что говорят: заявка приостановлена, а **чем** она в приостановку пришла,
 * не записано. `WithdrawalState` хранит статус, срок и момент входа и не хранит
 * ребра, поэтому заявка, прочитанная из хранилища, об этом законно молчит.
 * Убрать это положение можно только правкой домена и базы — не словаря.
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
   * (`docs/product/LANDING.md`). Черновик копирайтера прошёл главреда целиком:
   * сто семь строк `landing.*` и `risks.promise` из перечня сняты.
   * `risks.promise` сюда попала по недосмотру — она принята ещё в §2.1 спеки, и
   * лендинг её **переиспользует**, а не переписывает.
   *
   * Ниже остались только те строки, которые главред принимать не вправе: они
   * утверждают право, цену или обязательное раскрытие. Их принимает
   * `legal-compliance-ru`, а держатся они здесь потому, что публикуются
   * черновиком, — те же ключи перечислены отдельным списком ниже.
   *
   * Что главред переписал и почему — по одной причине на строку:
   *
   * · **`landing.recipient.faq.cost.a`** говорил второй стороне «Ничего.
   *   Комиссию платит сторона, которая вносит деньги; из суммы, которую вы
   *   получаете, мы ничего не удерживаем». Машина говорит обратное: комиссия
   *   удерживается из суммы транша, то есть её несёт получатель
   *   (`owner.tariff.payer.derived`, поля `feePayer` = recipient и
   *   `feePayerIsSetting` = false), и кабинет говорит это той же второй стороне
   *   дословно — `assurance.whereMoney.meaning`, «вам, за вычетом комиссии».
   *   После E16-4 плательщик стал закрытым перечнем `payer | recipient | split`
   *   без значения по умолчанию, то есть ответ решает владелец
   *   (`DECISIONS-REVIEW.md` J2 и Q2, **[открыто]**). Строка переписана так,
   *   чтобы за него не отвечать.
   * · **`landing.money.rate`** обещал фиксацию курса на срок и молчал о том,
   *   что котировка гасится движением рынка за допуск **внутри** срока
   *   (`FUNCTIONAL.md` §4.5; у машины это ребро есть —
   *   `topup.quote.voided_by_market_move`). Граница названа в самой строке, а
   *   ключ добавлен к юристу: раскрытие курса и наценки до операции — норма со
   *   санкцией (`FX.md` §8, приказ НБГ №1/04 ст. 7(1)(გ)), а не микрокопи.
   * · **`landing.recipient.assurance.body`** говорил «вы получаете
   *   подтверждение» — единственное утвердительное настоящее о неработающем
   *   сервисе среди строк `landing.*` (ПЛ9). Переписан страдательным залогом.
   *
   * Остальное — грамотность и одно слово на понятие: «остаются вашими и
   * отзывны» → «и отзывными», «срок держат реестр и банк» → «задают», «картой
   * закрыть суммы» → «оплатить», «в рабочее окно поддержки» → «в рабочие часы
   * поддержки», «приёмник заявок» → «приём заявок».
   *
   * Что осталось за пределами приёмки и почему: `trust.boundary` —
   * единственное утвердительное настоящее о сервисе, которое на публичных
   * страницах остаётся (`DECISIONS-REVIEW.md` Q1, **[открыто]**); строка
   * принята главредом раньше и лежит в `trust.*`, а не в `landing.*`.
   */
  'landing.decides.middleman.body',
  'landing.decides.reverse',
  'landing.facts.otherwise.body',
  'landing.faq.notary.a',
  'landing.money.currency',
  'landing.money.rate',
  'landing.notFor.1',
  'landing.partner.limit',
  'landing.recipient.assurance.note',
  'landing.recipient.boundary.body',
  'landing.recipient.faq.cost.a',
  'landing.recipient.need.2',
  'landing.recipient.when.late',
  'landing.step.4.body',
  'landing.youNeed.3',

  /*
   * Консоль оператора: карточка задачи «простой заявки на вывод» и её строка в
   * очереди. Двадцать три ключа, написанные дизайном, — черновик.
   *
   * ⚠ Это первые `ops.*` в перечне, и расхождение надо назвать вслух, а не
   * растворить. Остальная микрокопи консоли (семнадцать видов задач, «почему»,
   * «что дальше», исходы) в перечне **не значится** ни одной строкой: правило
   * проекта говорит о тексте, который видит клиент, а оператор — не клиент.
   * Здесь строки заведены черновиком по прямому указанию: цена ошибки в них
   * выше обычной консольной. Две из них утверждают запрет — «повтор поручения
   * запрещён до сверки», «здесь ничего не решается», — и если формулировка
   * окажется мягче запрета, оператор прочитает её как «пока нельзя, но можно
   * попросить». Это красная линия №8, а не микрокопи.
   *
   * Что важно знать тому, кто возьмёт строки в работу:
   *
   * · **Три отсутствия — три разные причины.** Сделки у вывода не бывает вовсе,
   *   лицо у заявки не хранится (известен ключ счёта), сумма не пересчитана,
   *   потому что курс — внешний факт. Свести их к одному «нет данных» нельзя:
   *   оператор по этим строкам понимает, чего не искать.
   * · **Возраст и срок — не синонимы.** `ops.task.subject.age.note` объясняет,
   *   почему заявка с непросроченным сроком стоит в очереди третьи сутки.
   *   Строка выглядит длинной, и она такая намеренно: короткая версия («срок
   *   двигается») не отвечает на вопрос, который у оператора возникает.
   * · **Бюджет длины.** `ops.task.type.withdrawalStalled` стоит и заголовком, и
   *   чипом фильтра — 32 знака на грузинском, не больше;
   *   `ops.task.stalled` — значок, тот же бюджет; `ops.outcomes.none.title` —
   *   заголовок карточки, 44.
   */
  'ops.fact.arrival',
  'ops.fact.deadlineRule',
  'ops.fact.enteredAt',
  'ops.fact.repeat',
  'ops.fact.stallAge',
  'ops.fact.value.deadlineMoves',
  'ops.fact.value.repeat.blocked',
  'ops.fact.withdrawalStatus',
  'ops.facts.note.stall',
  'ops.next.withdrawalStalled',
  'ops.outcomes.none.body',
  'ops.outcomes.none.title',
  'ops.task.rank.label',
  'ops.task.rank.none',
  'ops.task.stalled',
  'ops.task.subject.age.note',
  'ops.task.subject.deal.none',
  'ops.task.subject.party',
  'ops.task.subject.party.none',
  'ops.task.subject.withdrawal',
  'ops.task.subject.withdrawal.note',
  'ops.task.type.withdrawalStalled',
  'ops.why.withdrawalStalled',

  /*
   * Вход и выход. Двадцать строк, и **ни одна не прошла связку копирайтер →
   * главред**: экран входа появился раньше текста к нему, потому что форма без
   * подписей — это не «пока молчим», а неработающий экран (`SCREENS.md` §0.4 к
   * этому экрану ещё не написан).
   *
   * Что главреду придётся решать, а не вычитывать:
   *
   * · **`signIn.error.body`** обязан быть одинаков для «такой записи нет» и
   *   «код неверен» — разные формулировки здесь работают перечислителем
   *   учётных записей (`app/src/sign-in.ts`). Переписать можно как угодно, но
   *   различить два случая нельзя, и это ограничение текста, а не кода.
   * · **`signIn.sent.body`** говорит прямо, что мы не сообщаем о существовании
   *   записи. Молчание вместо этой фразы читается как «код точно ушёл», и
   *   человек ждёт сообщения, которого не будет.
   * · **`signIn.account.hint`** объясняет, что ключ учётной записи — не почта и
   *   не телефон. Форма ключа — следствие правила о персональных данных
   *   (`auth/src/ids.ts`), и без объяснения поле выглядит поломанным.
   * · **`signIn.code.ttl.*`** — счётная строка: срок подставляется числом из
   *   политики (`IDENTITY_CODE_POLICY`), а не вписан словом. Менять число в
   *   тексте нельзя — оно придёт из кода.
   */
  'signIn.title',
  'signIn.subtitle',
  'signIn.account.label',
  'signIn.account.hint',
  'signIn.account.cta',
  'signIn.sent.title',
  'signIn.sent.body',
  'signIn.code.ttl.one',
  'signIn.code.ttl.few',
  'signIn.code.ttl.many',
  'signIn.code.ttl.other',
  'signIn.code.label',
  'signIn.code.hint',
  'signIn.code.cta',
  'signIn.code.again',
  'signIn.error.title',
  'signIn.error.body',
  'signOut.title',
  'signOut.body',
  'signOut.cta',
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

  /*
   * Публичные страницы целиком. Русский написан копирайтером и принят
   * главредом (пятнадцать строк из них ждут юриста, см. список ниже),
   * английский и грузинский собраны той же терминологией, что и кабинет
   * (`ნომინალურ ანგარიშზე`, `nominee account`, `მეორე მხარე`), и проверены
   * только машиной: длиной на грузинском и запрещённой лексикой по трём языкам.
   *
   * Почему перечислено всё, а не правки этого захода: строка, вычитанная
   * носителем, снимается отсюда по одной, а перечень, в который попала половина
   * страницы, врёт в обе стороны — и о сделанном, и о несделанном. На публичной
   * странице цена ошибки языка выше, чем в кабинете: её читает человек, который
   * о нас ещё ничего не знает и уходит с первого неловкого оборота.
   *
   * Отдельно: `landing.partner.seek.body` и `landing.partner.form.who.hint` на
   * английском намеренно расходятся с русским — там, где по-русски стоит
   * «иностранные покупатели», по-английски стоит `clients from abroad`.
   * Английское название роли в единственном числе роняет обход (`verify-ui.mjs`,
   * «роль как состояние»), а множественное проходило там только по случайности
   * границы слова. Носителю: смысл сегмента сохранить, роль словом не называть.
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

  /*
   * Строка кабинета, переписанная ради публичных страниц: прежняя называла
   * место «вашим кабинетом», а на публичной странице её читает человек, у
   * которого кабинета нет и до заявки не будет. Правка задела en и ka, и до
   * вычитки носителем они значатся здесь.
   */
  'security.rule.onlyHere',

  /*
   * Те же двадцать три строки консоли: русский написан дизайном и ждёт связки,
   * английский и грузинский собраны терминологией, уже отгруженной в словарях
   * (`გატანის განაცხადი`, `ამონაწერთან შედარება`, `მდგომარეობა`, `withdrawal
   * request`, `reconciliation`), и проверены только машиной — длиной на
   * грузинском и запрещённой лексикой.
   *
   * Носителю отдельно: в грузинском `დავალება` сегодня означает и «задачу
   * оператора», и «поручение в банк» — так сложилось в уже принятых строках
   * (`ops.why.reviewBreak`). В этих строках оба значения встречаются рядом, и
   * где это грозило прочтением наоборот, стоит уточнение «ბანკში გაგზავნილი
   * დავალება». Развести термины совсем — работа по всему словарю, а не по этим
   * строкам, и она здесь не делалась.
   */
  'ops.fact.arrival',
  'ops.fact.deadlineRule',
  'ops.fact.enteredAt',
  'ops.fact.repeat',
  'ops.fact.stallAge',
  'ops.fact.value.deadlineMoves',
  'ops.fact.value.repeat.blocked',
  'ops.fact.withdrawalStatus',
  'ops.facts.note.stall',
  'ops.next.withdrawalStalled',
  'ops.outcomes.none.body',
  'ops.outcomes.none.title',
  'ops.task.rank.label',
  'ops.task.rank.none',
  'ops.task.stalled',
  'ops.task.subject.age.note',
  'ops.task.subject.deal.none',
  'ops.task.subject.party',
  'ops.task.subject.party.none',
  'ops.task.subject.withdrawal',
  'ops.task.subject.withdrawal.note',
  'ops.task.type.withdrawalStalled',
  'ops.why.withdrawalStalled',

  /*
   * Вход и выход. Русский — черновик (см. перечень выше), английский и
   * грузинский собраны по нему же и проверены только машиной. Носителю: слово
   * «გასაღები» здесь — ключ учётной записи, а не ключ шифрования, и в
   * грузинском у счётной строки одна форма, поэтому все четыре ключа
   * `signIn.code.ttl.*` совпадают намеренно.
   */
  'signIn.title',
  'signIn.subtitle',
  'signIn.account.label',
  'signIn.account.hint',
  'signIn.account.cta',
  'signIn.sent.title',
  'signIn.sent.body',
  'signIn.code.ttl.one',
  'signIn.code.ttl.few',
  'signIn.code.ttl.many',
  'signIn.code.ttl.other',
  'signIn.code.label',
  'signIn.code.hint',
  'signIn.code.cta',
  'signIn.code.again',
  'signIn.error.title',
  'signIn.error.body',
  'signOut.title',
  'signOut.body',
  'signOut.cta',
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
   *
   * Главред добавил сюда `landing.money.rate` и переписал `.faq.cost.a`: обе
   * строки говорят о деньгах клиента, а не об экране. Первая описывает
   * раскрытие курса и наценки до операции — это норма со санкцией (`FX.md` §8,
   * приказ НБГ №1/04 ст. 7(1)(გ), ст. 4), и то, какие именно три числа обязаны
   * быть названы, решает юрист, а не копирайтер. Вторая называет плательщика
   * комиссии, а он сегодня не назван нигде: у машины комиссия удерживается из
   * суммы транша, после E16-4 это закрытый перечень без умолчания, и решение —
   * владельца (`DECISIONS-REVIEW.md` J2 и Q2, **[открыто]**). До ответа строка
   * говорит только то, что верно при любом исходе.
   */
  'landing.decides.middleman.body',
  'landing.decides.reverse',
  'landing.facts.otherwise.body',
  'landing.faq.notary.a',
  'landing.money.currency',
  'landing.money.rate',
  'landing.notFor.1',
  'landing.partner.limit',
  'landing.recipient.assurance.note',
  'landing.recipient.boundary.body',
  'landing.recipient.faq.cost.a',
  'landing.recipient.need.2',
  /* Состояние по умолчанию при бездействии, названное второй стороне: деньги
     возвращаются вносящей стороне, а расчёт через сервис не исполняется. Это
     утверждение о последствии, а не описание экрана, и граница «что мы вправе
     говорить о чужой сделке» здесь за юристом (Ю-16). */
  'landing.recipient.when.late',
  'landing.step.4.body',
  'landing.youNeed.3',
]);
