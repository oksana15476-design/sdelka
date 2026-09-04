import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { isLocale } from '@/i18n/locales';
import { dictionaryOf, t } from '@/i18n/translate';
import { formatBasisPoints, formatRate, formatRemaining } from '@/i18n/format';
import { getTariff } from '@/fixtures/owner';
import { Amount, Badge, Banner, BlockedAction, Eyebrow, Row } from '@/ui/primitives';

/**
 * Тариф и наценка — **показ действующих значений и их следствий**. Изменение
 * сюда не заведено намеренно.
 *
 * ## Почему только показ
 *
 * Изменение тарифа — денежное решение, и оно требует версионирования в домене
 * (E16-11, `FUNCTIONAL.md` §4.2): на сделке хранится идентификатор версии
 * плана, применённой в момент заведения, и пересчёт задним числом обязан быть
 * **невозможен**, а не запрещён правилом. Сущности «редакция тарифного плана» в
 * домене сегодня нет: ставка живёт константой `PLATFORM_DEDUCTIONS`. Форма
 * ввода поверх константы дала бы владельцу кнопку, меняющую цену уже заведённых
 * сделок, — и это было бы хуже, чем отсутствие кнопки.
 *
 * ## Что здесь показано и откуда взято
 *
 * Ни одно значение не набрано руками: ставка и фикс — из `PLATFORM_DEDUCTIONS`,
 * потолок удержания — из `DEFAULT_FEE_CEILING_POLICY` домена, срок котировки и
 * порог дрейфа — из `PROPOSED_INTAKE_POLICY`, наценка и стоимость конвертации —
 * из курсов состоявшегося обмена, версия плана — из объявления начисления в
 * журнале. Экран не знает ни одной величины, которой нет в коде.
 */
export default async function OwnerTariffPage({
  params,
}: {
  readonly params: Promise<{ readonly locale: string }>;
}): Promise<ReactNode> {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const l = { dict: dictionaryOf(locale), locale };
  const tariff = await getTariff();
  const conversion = tariff.sampleConversion;

  return (
    <>
      <div className="pagehead">
        <Eyebrow l={l} labelKey="owner.screen.tariff" />
        <div className="pagehead__row">
          <h1>{t(l.dict, 'owner.tariff.title')}</h1>
          {tariff.versionId === null ? null : <span className="mono">{tariff.versionId}</span>}
        </div>
        <p className="pagehead__note">{t(l.dict, 'owner.tariff.subtitle')}</p>
      </div>

      <Banner
        tone="info"
        titleKey="owner.tariff.readonly.title"
        bodyKey="owner.tariff.readonly.body"
        l={l}
      />

      <section className="card" aria-labelledby="tariff-fee">
        <h2 className="card__title" id="tariff-fee">
          {t(l.dict, 'owner.tariff.fee.title')}
        </h2>
        <div className="rows">
          <Row labelKey="owner.tariff.rate" l={l}>
            <span className="mono">{formatBasisPoints(locale, tariff.rateBp)}</span>
          </Row>
          <Row labelKey="owner.tariff.fixed" l={l}>
            <Amount l={l} value={tariff.fixed} />
          </Row>
          <Row labelKey="owner.tariff.ceiling" l={l}>
            <>
              <Badge tone="ok" label={t(l.dict, 'owner.tariff.ceiling.ok')} />{' '}
              <span className="mono">{formatBasisPoints(locale, tariff.ceilingBp)}</span>
            </>
          </Row>
          <Row labelKey="owner.tariff.sample" l={l}>
            <Amount l={l} value={tariff.sample} />
          </Row>
          <Row labelKey="owner.tariff.sampleFee" l={l} total>
            <Amount l={l} value={tariff.sampleFee} size="lead" />
          </Row>
        </div>
        <p className="muted">{t(l.dict, 'owner.tariff.ceiling.note')}</p>
      </section>

      <section className="card" aria-labelledby="tariff-payer">
        <h2 className="card__title" id="tariff-payer">
          {t(l.dict, 'owner.tariff.payer.title')}
        </h2>
        <div className="rows">
          <Row labelKey="owner.tariff.payer" l={l}>
            <span className="mono">{t(l.dict, `owner.tariff.payer.${tariff.feePayer}`)}</span>
          </Row>
        </div>
        <p className="muted">{t(l.dict, 'owner.tariff.payer.derived')}</p>
        <p className="muted">{t(l.dict, 'owner.tariff.payer.vat')}</p>
      </section>

      <section className="card" aria-labelledby="tariff-fx">
        <h2 className="card__title" id="tariff-fx">
          {t(l.dict, 'owner.tariff.fx.title')}
        </h2>
        <div className="rows">
          <Row labelKey="owner.tariff.markup" l={l}>
            <span className="mono">{formatBasisPoints(locale, tariff.markupBp)}</span>
          </Row>
          <Row labelKey="owner.tariff.fxCost" l={l}>
            <>
              <Badge tone="warn" label={t(l.dict, 'owner.tariff.fxCost.measured')} />{' '}
              <span className="mono">{formatBasisPoints(locale, tariff.conversionCostBp)}</span>
            </>
          </Row>
          <Row labelKey="owner.tariff.rate.official" l={l}>
            <span className="mono">{formatRate(locale, tariff.rateText.official, 'GEL')}</span>
          </Row>
          <Row labelKey="owner.tariff.rate.reference" l={l}>
            <span className="mono">{formatRate(locale, tariff.rateText.reference, 'GEL')}</span>
          </Row>
          <Row labelKey="owner.tariff.rate.client" l={l}>
            <span className="mono">{formatRate(locale, tariff.rateText.client, 'GEL')}</span>
          </Row>
        </div>
        <p className="muted">{t(l.dict, 'owner.tariff.fx.note')}</p>

        <Eyebrow l={l} labelKey="owner.tariff.fx.example" />
        <div className="rows">
          <Row labelKey="owner.conversion.source" l={l}>
            <Amount l={l} value={conversion.source} />
          </Row>
          <Row labelKey="owner.conversion.atOfficial" l={l}>
            <Amount l={l} value={conversion.atOfficial} />
          </Row>
          <Row labelKey="owner.conversion.cost" l={l}>
            <Amount l={l} value={conversion.cost} />
          </Row>
          <Row labelKey="owner.conversion.atReference" l={l}>
            <Amount l={l} value={conversion.atReference} />
          </Row>
          <Row labelKey="owner.conversion.markup" l={l} total>
            <Amount l={l} value={conversion.markup} size="lead" />
          </Row>
          <Row labelKey="owner.conversion.toClient" l={l}>
            <Amount l={l} value={conversion.toClient} />
          </Row>
        </div>
        <p className="muted">{t(l.dict, 'owner.tariff.fx.order')}</p>
      </section>

      <section className="card" aria-labelledby="tariff-quote">
        <h2 className="card__title" id="tariff-quote">
          {t(l.dict, 'owner.tariff.quote.title')}
        </h2>
        <div className="rows">
          <Row labelKey="owner.tariff.quote.drift" l={l}>
            <span className="mono">{formatBasisPoints(locale, tariff.quoteDriftBp)}</span>
          </Row>
          <Row labelKey="owner.tariff.quote.validity" l={l}>
            <span className="mono">{formatRemaining(locale, tariff.quoteValidityMs)}</span>
          </Row>
          <Row labelKey="owner.tariff.tolerance.share" l={l}>
            <span className="mono">{formatBasisPoints(locale, tariff.toleranceShareBp)}</span>
          </Row>
          {tariff.toleranceAbsolute.map((item) => (
            <Row
              key={item.currency}
              labelKey="owner.tariff.tolerance.absolute"
              l={l}
              params={{ currency: item.currency }}
            >
              <Amount l={l} value={item} />
            </Row>
          ))}
        </div>
        <p className="muted">{t(l.dict, 'owner.tariff.quote.note')}</p>
        <p className="faint">{t(l.dict, 'owner.tariff.tolerance.note')}</p>
      </section>

      <section className="card card--quiet" aria-labelledby="tariff-change">
        <h2 className="card__title" id="tariff-change">
          {t(l.dict, 'owner.tariff.change.title')}
        </h2>
        <BlockedAction
          l={l}
          labelKey="owner.tariff.change.action"
          reasonKey="owner.tariff.change.reason"
        />
        <p className="muted">{t(l.dict, 'owner.tariff.change.versioning')}</p>
        {/* Пересказ нормы, не прошедший юриста, в ⚖-слот не кладётся: слот
            обещает проверенную формулировку. Здесь это предупреждение о сроке,
            а не текст для клиента. */}
        <Eyebrow l={l} labelKey="owner.legal.label" />
        <p className="muted">{t(l.dict, 'owner.tariff.legal.notice')}</p>
      </section>
    </>
  );
}
