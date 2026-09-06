import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { isTerminalWithdrawalStatus } from '@sdelka/domain';
import { isPositive, toDecimalString } from '@sdelka/money';
import { isLocale } from '@/i18n/locales';
import { dictionaryOf, t } from '@/i18n/translate';
import { formatMoney, formatNumber } from '@/i18n/format';
import { getAccount } from '@/fixtures/store';
import {
  getWithdraw,
  withdrawCancelBlockedKey,
  withdrawFee,
  withdrawSource,
  withdrawSourceCaseOf,
  withdrawStatusOf,
} from '@/fixtures/screens';
import { Amount, Badge, BlockedAction, EmptyState, Eyebrow, Row, SecurityBlock } from '@/ui/primitives';
import { AmountField, ChoiceField, ErrorSummary, SubmitButton } from '@/ui/form';
import type { L10n } from '@/ui/l10n';
import { type WithdrawFieldError, buildWithdrawForm, errorOf, readWithdrawInput } from '@/view/withdraw-form';
import {
  withdrawArrivalOf,
  withdrawRepeatBlockedKey,
  withdrawStateKey,
  withdrawStateTone,
} from '@/view/withdraw-state';

/**
 * Экран вывода средств. Машина — `packages/domain/src/client-account.ts`:
 * `requested · approved · paying_out · paid_out · blocked · cancelled`.
 *
 * ## Что здесь появилось и почему это не украшение
 *
 * Экран показывал состояние заявки, которую **нечем было создать**: формы не
 * существовало, а счёт обещал «забрать можно в любой момент»
 * (`CABINETS-REDESIGN.md` §1.2, заход 1.6). Теперь на экране три шага —
 * заполнение, сверка и созданная заявка, — и все три собраны под ту же машину:
 *
 * · сумма проверяется guard'ом `g_free_balance_sufficient`, а не сравнением,
 *   написанным здесь заново;
 * · счёт-источник показан и **не редактируется**: красная линия №9 — возврат
 *   только на счёт-источник и только на имя плательщика, и «выбрать другой» —
 *   это не поле, которое мы забыли добавить, а поле, которого не бывает;
 * · утверждений два (`WITHDRAWAL_REQUIRED_APPROVALS`), и ноль набранных подписей
 *   показан числом: заявка живёт без единой подписи, и это её нормальное первое
 *   состояние, а не «почти утверждено».
 *
 * Отмена доступна только в `requested`: перехода `approved → cancelled` в
 * автомате нет, поэтому кнопки быть не должно — не «серой», а никакой. Причина
 * запрета повторной заявки (`g_no_active_withdrawal`) названа словами заранее,
 * а не отказом в момент нажатия.
 *
 * ## Статуса мало: исход поручения показывается отдельно
 *
 * Плашка собиралась шаблоном `withdraw.state.${status}.*` по шести состояниям
 * машины, и четыре разных положения читались одинаково: «поручение ушло, ответа
 * ждём», «ответа банка нет — исход неизвестен», «остановила наша проверка»,
 * «банк не исполнил». Клиенту в «неизвестно» показывалось «Перевод отправлен» —
 * расхождение с красной линией №8, а не недостача микрокопи.
 *
 * Теперь экран показывает **пару**: статус и исход, с которым заявка в него
 * пришла (`WithdrawView.arrival`, разбор и выбор ключей —
 * `view/withdraw-state.ts`). Исход берётся у машины: `outcome` стоит у ребра
 * перехода, перечень возможных исходов считает `withdrawalArrivals`.
 *
 * ## Форма без скрипта
 *
 * `method="get"`: шаг и введённые значения живут в адресе, проверка идёт на
 * сервере. Кнопка «всё свободное» — это тоже отправка формы, а не обработчик
 * нажатия: экран, где распоряжаются деньгами, обязан работать и без JavaScript.
 *
 * ## Приёмочные ключи адреса
 *
 * `?state=` — статус существующей заявки, `?outcome=none|unknown|rejected|settled`
 * — исход поручения, с которым в этот статус пришли, `?source=unknown|otherHolder`
 * — положение счёта-источника, `?free=none` — свободного остатка нет вовсе,
 * `?approvals=` — сколько подписей набрано. Это инструмент обхода, а не продукт:
 * в бою всё это приходит из данных.
 */
function one(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Ступени утверждения: две полосы и число словами.
 *
 * Пустая ступень показана так же явно, как набранная: «утверждений нет» — это
 * состояние, а не отсутствие данных. Число дублируется текстом, потому что
 * цветом и формой состояние не передаётся ни разу (`SCREENS.md` §1.7).
 */
function Approvals({
  l,
  done,
  required,
}: {
  readonly l: L10n;
  readonly done: number;
  readonly required: number;
}): ReactNode {
  const steps = Array.from({ length: required }, (item, index) => index);
  return (
    <div className="approvals">
      <Eyebrow l={l} labelKey="withdraw.approvals.title" />
      <div className="approvals__steps">
        {steps.map((index) => (
          <span
            aria-hidden="true"
            className={`approvals__step${index < done ? ' approvals__step--done' : ''}`}
            key={index}
          />
        ))}
        <span className="approvals__count">
          {t(l.dict, 'withdraw.approvals.count', {
            done: formatNumber(l.locale, done),
            required: formatNumber(l.locale, required),
          })}
        </span>
      </div>
      <p className="muted">{t(l.dict, 'withdraw.approvals.note')}</p>
    </div>
  );
}

export default async function WithdrawPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly locale: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const query = await searchParams;
  const l = { dict: dictionaryOf(locale), locale };
  const account = await getAccount();

  const status = withdrawStatusOf(one(query.state));
  const sourceCase = withdrawSourceCaseOf(one(query.source));
  const source = withdrawSource(sourceCase);
  const options =
    one(query.free) === 'none'
      ? []
      : account.balances
          .filter((balance) => isPositive(balance.free))
          .map((balance) => ({ currency: balance.currency, free: balance.free }));
  const input = readWithdrawInput(query);
  const form = buildWithdrawForm(input, { options, source, activeStatus: status });

  const submitted = form.step === 'submitted';
  const shownStatus = submitted ? 'requested' : status;
  const approvals = one(query.approvals);
  const view =
    shownStatus === null
      ? null
      : await getWithdraw(shownStatus, submitted && form.amount !== null ? form.amount : account.free, {
          source: sourceCase,
          approvals: approvals === undefined ? undefined : Number(approvals),
          // Исход поручения: пара к статусу, а не украшение. Разбирается
          // машиной — невозможная пара отбрасывается и не показывается вовсе.
          arrival: withdrawArrivalOf(shownStatus, one(query.outcome)),
        });
  // Приставка ключей плашки и её тон считаются один раз: заголовок, подпись и
  // тело обязаны говорить об одном положении, а не собираться каждый по своему
  // шаблону.
  const stateKey = view === null ? null : withdrawStateKey(view.status, view.arrival);
  const tone = view === null ? null : withdrawStateTone(view.status, view.arrival);

  // Счёт-источник неизвестен или не на имя плательщика: заявку заводить не из
  // чего. Форма на этом месте была бы тупиком с кнопкой — вместо неё названная
  // причина (`BlockedAction`), она же ведёт к работе человека (И12.2).
  const sourceError = errorOf(form.errors, 'source');
  const amountError = errorOf(form.errors, 'amount');
  const currencyError = errorOf(form.errors, 'currency');
  const showForm = form.formAvailable && sourceError === null && !submitted;
  const nothingToWithdraw = !form.formAvailable && form.activeStatus === null;
  // Ошибки показываются после обращения к форме, а не при первом открытии:
  // экран, встречающий человека красным «сумма не названа», сообщает не об
  // ошибке, а о том, что он ещё ничего не сделал.
  const attempted = input.step !== 'form' || input.amountText !== '' || input.fillMax;
  const summary: readonly WithdrawFieldError[] = attempted ? form.errors : [];

  /**
   * Подстановки в тексты ошибок собирает экран, а не разбор ввода: деньги
   * печатает `Intl` по локали, и «1016231.00» вместо «1 016 231,00 ₾» на экране
   * денег — это не мелочь оформления, а другое число на вид.
   *
   * Лишняя подстановка ключу не вредит: `t` подставляет то, что нашла, и
   * оставляет остальное. Поэтому свободный остаток кладётся ко всем ошибкам
   * поля суммы, а не выбирается условием по имени ключа.
   */
  const errorParams = (error: WithdrawFieldError | null): Record<string, string> => ({
    ...(error?.params ?? {}),
    free: form.free === null ? '' : formatMoney(locale, form.free),
  });

  return (
    <>
      <nav className="breadcrumb" aria-label={t(l.dict, 'nav.breadcrumb')}>
        <a className="chipbtn" href={`/${locale}/account`}>
          {t(l.dict, 'withdraw.back')}
        </a>
      </nav>

      <div className="pagehead">
        <h1>{t(l.dict, 'withdraw.title')}</h1>
        <p className="pagehead__note">{t(l.dict, 'withdraw.subtitle')}</p>
      </div>

      {view === null || stateKey === null || tone === null ? null : (
        <section className={`state-card state-card--${tone}`} aria-labelledby="withdraw-state">
          <div className="state-card__head">
            <div className="state-card__top">
              {/* Имени состояния машины (`paying_out`) на экране нет: клиент
                  читает плашку и заголовок, а не наш автомат (§1.7 разбора).
                  Приставка ключа при этом уже несёт исход поручения: «ответа
                  банка нет» и «банк не исполнил» — это не оттенки отправки. */}
              <Badge tone={tone} label={t(l.dict, `${stateKey}.badge`)} />
            </div>
            <h2 className="state-card__title" id="withdraw-state">
              {t(l.dict, `${stateKey}.title`)}
            </h2>
            <p className="state-card__body">{t(l.dict, `${stateKey}.body`)}</p>
          </div>
          <div className="state-card__inner">
            <div className="rows">
              <Row l={l} labelKey="withdraw.amount.title">
                <Amount l={l} value={view.amount} />
              </Row>
              <Row l={l} labelKey="withdraw.fee">
                <Amount l={l} value={view.fee} size="muted" />
              </Row>
            </div>
            <p className="faint">{t(l.dict, 'withdraw.lockedNote')}</p>
            {/* Отменённой заявке подписи не наберут никогда: ступени на ней —
                не история, а обещание, которого не будет. У выплаченной они
                история и остаются. */}
            {view.status === 'cancelled' ? null : (
              <Approvals done={view.approvals} l={l} required={view.approvalsRequired} />
            )}
            {view.cancellable ? (
              <p className="actions">
                <a className="btn btn--secondary" href={`/${locale}/withdraw?state=cancelled`}>
                  {t(l.dict, 'withdraw.cancel')}
                </a>
              </p>
            ) : isTerminalWithdrawalStatus(view.status) ? null : (
              /* «Отменить нельзя» на законченной заявке — сообщение о действии,
                 которого уже не требуется: у выплаченной и отменённой отмены
                 нет не по запрету, а потому что отменять нечего. */
              <BlockedAction
                l={l}
                labelKey="withdraw.cancel"
                reasonKey={withdrawCancelBlockedKey(view.status)}
              />
            )}
            {/* Красная линия №8, вторая половина: повтор из «неизвестно»
                запрещён без прохождения через сверку. Кнопки нет — и запрет
                назван словами, причём **своими** для «неизвестно»: общая
                строка «пока идёт этот вывод» описывает очередь, и человек
                прочитал бы её как «подождите», а ждать здесь нечего — открыть
                повтор может только сверка с выпиской. */}
            {view.repeatBlocked ? (
              <BlockedAction
                l={l}
                labelKey="withdraw.repeat"
                reasonKey={withdrawRepeatBlockedKey(view.status, view.arrival)}
              />
            ) : null}
          </div>
        </section>
      )}

      {nothingToWithdraw ? (
        <section className="card">
          <EmptyState l={l} titleKey="withdraw.empty.title" bodyKey="withdraw.empty.body" />
        </section>
      ) : null}

      {form.formAvailable && sourceError !== null ? (
        <section className="card" aria-labelledby="withdraw-form">
          <h2 className="card__title" id="withdraw-form">
            {t(l.dict, 'withdraw.form.title')}
          </h2>
          <BlockedAction l={l} labelKey="account.withdraw.cta" reasonKey={sourceError.messageKey} />
        </section>
      ) : null}

      {showForm && form.step === 'form' ? (
        <section className="card" aria-labelledby="withdraw-form">
          <h2 className="card__title" id="withdraw-form">
            {t(l.dict, 'withdraw.form.title')}
          </h2>
          <p className="muted">{t(l.dict, 'withdraw.form.note')}</p>
          <ErrorSummary
            l={l}
            problems={summary.map((item) => ({
              field: item.field,
              messageKey: item.messageKey,
              params: errorParams(item),
            }))}
            titleKey="withdraw.form.errors.title"
          />
          <form action={`/${locale}/withdraw`} className="form" method="get">
            {/* Приёмочные ключи переносятся через шаг: иначе снимок состояния
                «счёт-источник неизвестен» после первого же нажатия становится
                снимком обычной формы. В продукте этих полей нет. */}
            {one(query.source) === undefined ? null : (
              <input name="source" type="hidden" value={one(query.source)} />
            )}
            {one(query.free) === undefined ? null : (
              <input name="free" type="hidden" value={one(query.free)} />
            )}
            {form.options.length === 1 && form.currency !== null ? (
              <>
                <input name="currency" type="hidden" value={form.currency} />
                <div className="rows">
                  <Row l={l} labelKey="account.free.title">
                    {form.free === null ? null : <Amount l={l} value={form.free} />}
                  </Row>
                </div>
              </>
            ) : (
              <ChoiceField
                choices={form.options.map((option) => ({
                  value: option.currency,
                  label: option.currency,
                  meta: formatMoney(locale, option.free),
                }))}
                errorKey={currencyError?.messageKey ?? null}
                l={l}
                labelKey="withdraw.form.currency.label"
                name="currency"
                value={form.currency ?? ''}
              />
            )}
            <AmountField
              errorKey={amountError?.messageKey ?? null}
              errorParams={errorParams(amountError)}
              hintKey="withdraw.form.amount.hint"
              hintParams={{
                free: form.free === null ? '' : formatMoney(locale, form.free),
              }}
              l={l}
              labelKey="withdraw.form.amount.label"
              name="amount"
              unit={form.currency ?? ''}
              value={form.amountText}
            />
            <p className="actions">
              <SubmitButton l={l} labelKey="withdraw.form.submit" name="step" value="review" />
              <SubmitButton
                l={l}
                labelKey="withdraw.form.max"
                name="fill"
                tone="secondary"
                value="max"
              />
            </p>
            <p className="faint">{t(l.dict, 'withdraw.lockedNote')}</p>
          </form>
        </section>
      ) : null}

      {showForm && form.step === 'review' && form.amount !== null && form.currency !== null ? (
        <section className="card" aria-labelledby="withdraw-review">
          <h2 className="card__title" id="withdraw-review">
            {t(l.dict, 'withdraw.review.title')}
          </h2>
          <div className="rows">
            <Row l={l} labelKey="withdraw.amount.title">
              <Amount l={l} value={form.amount} size="lead" />
            </Row>
            {/* Комиссия стоит отдельной строкой и **не** вычитается из суммы:
                удерживается она из вывода или берётся сверх него — документом не
                названо, [открыто]. Показать «к зачислению» значило бы назвать
                число, которого мы не знаем, на экране, где клиент по нему сверяет
                выписку. */}
            <Row l={l} labelKey="withdraw.fee">
              <Amount l={l} value={withdrawFee(form.amount)} size="muted" />
            </Row>
            <Row l={l} labelKey="account.source.account">
              <span className="mono">{form.source === null ? '' : form.source.masked}</span>
            </Row>
            <Row l={l} labelKey="account.source.bank">
              <span>{form.source === null ? '' : form.source.bank}</span>
            </Row>
          </div>
          <p className="muted" style={{ marginBlockStart: 'var(--s-3)' }}>
            {t(l.dict, 'withdraw.review.note')}
          </p>
          <form action={`/${locale}/withdraw`} className="form" method="get">
            <input name="amount" type="hidden" value={toDecimalString(form.amount)} />
            <input name="currency" type="hidden" value={form.currency} />
            {one(query.source) === undefined ? null : (
              <input name="source" type="hidden" value={one(query.source)} />
            )}
            <p className="actions">
              <SubmitButton l={l} labelKey="withdraw.review.confirm" name="step" value="submitted" />
              <a
                className="btn btn--secondary"
                href={`/${locale}/withdraw?amount=${encodeURIComponent(toDecimalString(form.amount))}&currency=${form.currency}`}
              >
                {t(l.dict, 'withdraw.review.back')}
              </a>
            </p>
          </form>
        </section>
      ) : null}

      {/* Причина, уже сказанная вместо формы, здесь не повторяется: один и тот
          же отказ дважды на одном экране читается как два разных. */}
      {sourceError !== null && form.formAvailable ? null : (
        <section className="card card--quiet" id="source">
          <Eyebrow l={l} labelKey="withdraw.source.title" />
          <p className="muted" style={{ marginBlockStart: 'var(--s-2)' }}>
            {form.source === null
              ? t(l.dict, 'withdraw.form.error.source.unknown')
              : t(
                  l.dict,
                  form.source.holderIsPayer ? 'withdraw.source.body' : 'withdraw.form.error.source.holder',
                  { account: form.source.masked, bank: form.source.bank },
                )}
          </p>
        </section>
      )}

      <SecurityBlock l={l} />
    </>
  );
}
