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
 * ## Что именно ждёт кого
 *
 * · **Копирайтер и главред** — все ключи ниже: голос, единая терминология,
 *   грамотность, отсутствие ложных обещаний. Черновики написаны словарём,
 *   который уже принят на соседних экранах (`account.withdraw.*`,
 *   `ops.closing.rule.quorum.note`), — это снижает расхождение, но приёмки не
 *   заменяет.
 * · **Юрист** (`legal-compliance-ru`, не главред) — пять из них, потому что это
 *   утверждения о правах, а не микрокопи:
 *   `withdraw.review.note` — граница отзыва заявки («после утверждения отмены
 *   не бывает»); `withdraw.cancel.blocked.sent` — та же граница после отправки
 *   поручения в банк; `withdraw.form.error.source.holder` и
 *   `withdraw.form.error.source.unknown` — отказ в выводе на чужой счёт, то есть
 *   инвариант 20 словами для клиента; `withdraw.approvals.note` — раскрытие
 *   внутреннего контроля.
 *
 * ## Чего здесь нет
 *
 * Ключей, взятых с соседних экранов без изменений (`withdraw.source.body`,
 * `account.withdraw.cta`, `withdraw.state.*`, `account.free.title`): они уже
 * приняты, и повторная приёмка того же текста только размывает список.
 */
export const PENDING_COPY_KEYS: readonly string[] = Object.freeze([
  'withdraw.form.title',
  'withdraw.form.note',
  'withdraw.form.currency.label',
  'withdraw.form.amount.label',
  'withdraw.form.amount.hint',
  'withdraw.form.max',
  'withdraw.form.submit',
  'withdraw.form.errors.title',
  'withdraw.form.error.amount.required',
  'withdraw.form.error.amount.number',
  'withdraw.form.error.amount.fraction',
  'withdraw.form.error.amount.positive',
  'withdraw.form.error.amount.free',
  'withdraw.form.error.currency.free',
  'withdraw.form.error.source.unknown',
  'withdraw.form.error.source.holder',
  'withdraw.form.error.active',
  'withdraw.review.title',
  'withdraw.review.note',
  'withdraw.review.confirm',
  'withdraw.review.back',
  'withdraw.approvals.title',
  'withdraw.approvals.count',
  'withdraw.approvals.note',
  'withdraw.empty.title',
  'withdraw.empty.body',
  'withdraw.cancel.blocked.sent',
]);

/** Ключи из перечня, которые ждут юриста, а не главреда. */
export const PENDING_LEGAL_REVIEW_KEYS: readonly string[] = Object.freeze([
  'withdraw.review.note',
  'withdraw.form.error.source.unknown',
  'withdraw.form.error.source.holder',
  'withdraw.approvals.note',
  'withdraw.cancel.blocked.sent',
]);
