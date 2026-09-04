import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { isLocale } from '@/i18n/locales';
import { dictionaryOf, plural, t } from '@/i18n/translate';
import { listOwnerDeals } from '@/fixtures/owner';
import { moneyTone } from '@/view/owner-economics';
import { Amount, Badge, EmptyState, Eyebrow, ListRow } from '@/ui/primitives';

/**
 * Экономика сделок списком — вход в И16.1.
 *
 * Сортировка по марже **вверх**: первой стоит убыточная сделка. Это не
 * оформление, а смысл экрана: владелец приходит сюда за ответом «на чём мы
 * зарабатываем», и список, начинающийся с лучшей сделки, отвечает на другой
 * вопрос.
 *
 * Маржа в строке — по **первой валюте** экономики сделки, и рядом стоит её код.
 * Второй валюты в строке нет намеренно: сложить их нечем, а показать одну без
 * кода значит соврать. Полный разбор — на карточке сделки.
 */
export default async function OwnerDealsPage({
  params,
}: {
  readonly params: Promise<{ readonly locale: string }>;
}): Promise<ReactNode> {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const l = { dict: dictionaryOf(locale), locale };
  const deals = await listOwnerDeals();

  return (
    <>
      <div className="pagehead">
        <Eyebrow l={l} labelKey="owner.screen.deals" />
        <div className="pagehead__row">
          <h1>{t(l.dict, 'owner.deals.title')}</h1>
          <span className="faint">{plural(l.dict, locale, 'owner.deals.count', deals.length)}</span>
        </div>
        <p className="pagehead__note">{t(l.dict, 'owner.deals.subtitle')}</p>
      </div>

      {deals.length === 0 ? (
        <EmptyState l={l} titleKey="owner.deals.empty.title" bodyKey="owner.deals.empty.body" />
      ) : (
        <section className="card" aria-labelledby="owner-deals">
          <h2 className="card__title" id="owner-deals">
            {t(l.dict, 'owner.deals.list.title')}
          </h2>
          <div className="list">
            {deals.map((deal) => {
              const slice = deal.economics.byCurrency[0];
              return (
                <ListRow
                  key={deal.id}
                  label={
                    <>
                      <a href={`/${locale}/owner/deals/${deal.id}`}>
                        <span className="mono">{deal.ref}</span>
                      </a>
                      <span className="faint">{deal.address}</span>
                    </>
                  }
                  meta={
                    <>
                      <Badge
                        tone={deal.settled ? 'ok' : 'wait'}
                        label={t(l.dict, `owner.deal.kind.${deal.kind}`)}
                      />
                      <span className="faint">{deal.counterpartyName}</span>
                    </>
                  }
                  value={
                    <>
                      <Amount l={l} value={deal.amount} labelKey="owner.label.amount" />
                      {slice === undefined ? null : (
                        <Amount
                          l={l}
                          value={slice.margin}
                          signed
                          labelKey={
                            deal.settled ? 'owner.label.marginFact' : 'owner.label.marginSoFar'
                          }
                        />
                      )}
                      {slice === undefined ? null : (
                        <Badge
                          tone={moneyTone(slice.margin)}
                          label={t(l.dict, `owner.tone.${moneyTone(slice.margin)}`)}
                        />
                      )}
                    </>
                  }
                />
              );
            })}
          </div>
          <p className="faint">{t(l.dict, 'owner.deals.list.note')}</p>
        </section>
      )}
    </>
  );
}
