import type { PartyRef } from '@sdelka/domain';
import { dealState } from '@sdelka/domain';
import { expect, it } from 'vitest';
import { APP_ROLE } from '../../src/roles.ts';
import type { DealSnapshot } from '../../src/store/port.ts';
import { loadDealsOfParty, saveDeal } from '../../src/store/state.ts';
import { dbSuite, withRollback } from './support/pg.ts';

/**
 * Сделки участника — на живой базе.
 *
 * **Зачем именно здесь.** Правило «отдаём только те сделки, где участник —
 * сторона» живёт целиком в `WHERE`, и проверить его по-настоящему можно только
 * тем, что в базе **лежит чужая сделка**, а выборка её не отдаёт. Офлайновый
 * набор (`test/store-deals-of-party.test.ts`) видит вопрос, который уходит в
 * базу; ответ на него даёт только Postgres.
 *
 * Второе, что проверяется только здесь, — **порядок**. Момент заведения
 * (`created_at`) в снимок не попадает, и вне базы его взять неоткуда; порядок же
 * — часть договора: список, приходящий дважды разным, заставляет кабинет
 * «прыгать» между переходами.
 */
const { run, title, pool } = await dbSuite('хранилище: сделки участника');

const VIEWER: PartyRef = { partyId: 'party-viewer-dop', accountKey: 'viewer.dop' };
const SELLER: PartyRef = { partyId: 'party-seller-dop', accountKey: 'seller.dop' };
const BUYER: PartyRef = { partyId: 'party-buyer-dop', accountKey: 'buyer.dop' };
const STRANGER_BUYER: PartyRef = { partyId: 'party-stranger-buyer-dop', accountKey: 'sb.dop' };
const STRANGER_SELLER: PartyRef = { partyId: 'party-stranger-seller-dop', accountKey: 'ss.dop' };

/** Участник — покупатель. */
const AS_BUYER: DealSnapshot = Object.freeze({
  dealId: 'deal-dop-a',
  state: dealState('funding'),
  buyer: VIEWER,
  seller: SELLER,
});

/** Тот же участник — продавец: он видит и то, что продаёт. */
const AS_SELLER: DealSnapshot = Object.freeze({
  dealId: 'deal-dop-b',
  state: dealState('draft'),
  buyer: BUYER,
  seller: VIEWER,
});

/** Сделка, к которой участник не имеет отношения вовсе. */
const OF_STRANGERS: DealSnapshot = Object.freeze({
  dealId: 'deal-dop-c',
  state: dealState('funding'),
  buyer: STRANGER_BUYER,
  seller: STRANGER_SELLER,
});

interface Client {
  query(text: string, values?: readonly unknown[]): Promise<unknown>;
}

/** Момент заведения назначается руками: `now()` внутри одной транзакции один на всех. */
async function foundedAt(client: Client, dealId: string, at: string): Promise<void> {
  await client.query(`UPDATE sdelka.deal SET created_at = $2 WHERE deal_id = $1`, [dealId, at]);
}

run(title, () => {
  it('отдаёт обе стороны участника и не отдаёт чужую сделку', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await saveDeal(client, AS_BUYER);
      await saveDeal(client, AS_SELLER);
      await saveDeal(client, OF_STRANGERS);

      const mine = await loadDealsOfParty(client, VIEWER.partyId);
      const ids = mine.map((deal) => deal.dealId).sort();
      expect(ids).toEqual([AS_BUYER.dealId, AS_SELLER.dealId]);

      // Главная проверка этого файла: чужая сделка лежит в базе рядом и наружу
      // не выходит. Перечисление чужого — не «лишняя строка в списке», а утечка
      // (спека §3.2, правило 2).
      expect(ids).not.toContain(OF_STRANGERS.dealId);
      for (const deal of mine) {
        expect([deal.buyer.partyId, deal.seller.partyId]).toContain(VIEWER.partyId);
      }

      // Круг «мир → база → мир»: сделка возвращается той же, вместе с обеими
      // половинами обеих сторон.
      expect(mine.find((deal) => deal.dealId === AS_BUYER.dealId)).toEqual(AS_BUYER);
      expect(mine.find((deal) => deal.dealId === AS_SELLER.dealId)).toEqual(AS_SELLER);
    });
  });

  it('чужой участник видит только своё — проверка симметрична', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await saveDeal(client, AS_BUYER);
      await saveDeal(client, AS_SELLER);
      await saveDeal(client, OF_STRANGERS);

      // Зеркало предыдущего: выборка, отдающая всё подряд, прошла бы проверку
      // «мои сделки в списке есть» и провалилась бы здесь.
      const theirs = await loadDealsOfParty(client, STRANGER_SELLER.partyId);
      expect(theirs.map((deal) => deal.dealId)).toEqual([OF_STRANGERS.dealId]);
    });
  });

  it('порядок — от свежих к старым по моменту заведения', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await saveDeal(client, AS_BUYER);
      await saveDeal(client, AS_SELLER);
      await saveDeal(client, { ...AS_BUYER, dealId: 'deal-dop-d', seller: STRANGER_SELLER });

      // Моменты назначены так, что верный ответ не совпадает **ни** с порядком
      // вставки, **ни** с порядком идентификаторов: без `ORDER BY` строки
      // пришли бы в порядке вставки, с сортировкой по номеру — по алфавиту, и
      // оба ответа здесь неверны.
      await foundedAt(client, 'deal-dop-a', '2026-03-03T09:00:00Z');
      await foundedAt(client, 'deal-dop-b', '2026-03-01T09:00:00Z');
      await foundedAt(client, 'deal-dop-d', '2026-03-02T09:00:00Z');

      const mine = await loadDealsOfParty(client, VIEWER.partyId);
      expect(mine.map((deal) => deal.dealId)).toEqual(['deal-dop-a', 'deal-dop-d', 'deal-dop-b']);
    });
  });

  it('момент один на двоих — порядок всё равно один и тот же: по идентификатору', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      // Так и бывает на самом деле: `created_at` — момент транзакции, и две
      // сделки, заведённые одним шагом, получают его одинаковым. Вставка идёт в
      // обратном алфавитном порядке, поэтому без второго ключа сортировки
      // строки вернулись бы как лежат.
      await saveDeal(client, { ...AS_SELLER, dealId: 'deal-dop-z' });
      await saveDeal(client, { ...AS_BUYER, dealId: 'deal-dop-y' });
      await foundedAt(client, 'deal-dop-z', '2026-03-05T09:00:00Z');
      await foundedAt(client, 'deal-dop-y', '2026-03-05T09:00:00Z');

      const mine = await loadDealsOfParty(client, VIEWER.partyId);
      expect(mine.map((deal) => deal.dealId)).toEqual(['deal-dop-y', 'deal-dop-z']);
    });
  });

  it('шаг по сделке не переставляет её в списке', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await saveDeal(client, AS_BUYER);
      await saveDeal(client, AS_SELLER);
      await foundedAt(client, AS_BUYER.dealId, '2026-03-01T09:00:00Z');
      await foundedAt(client, AS_SELLER.dealId, '2026-03-02T09:00:00Z');
      const before = (await loadDealsOfParty(client, VIEWER.partyId)).map((deal) => deal.dealId);
      expect(before).toEqual([AS_SELLER.dealId, AS_BUYER.dealId]);

      // Смена статуса — шаг мира, а не заведение. Хранилище, обновляющее
      // `created_at` вместе со статусом, перекладывало бы кабинет на каждом
      // шаге по любой из сделок: список читался бы каждый раз в новом порядке,
      // и виноватым выглядел бы экран.
      await saveDeal(client, { ...AS_BUYER, state: dealState('settled') });
      const after = (await loadDealsOfParty(client, VIEWER.partyId)).map((deal) => deal.dealId);
      expect(after).toEqual(before);
    });
  });

  it('участника нет вовсе — пустой список, а не отказ', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      // «Пусто» — законное состояние экрана (спека §3.1). Отличать «участника
      // нет» от «сделок нет» снаружи нельзя, поэтому и здесь ответ один.
      expect(await loadDealsOfParty(client, 'party-nobody-dop')).toEqual([]);
    });
  });

  it('роль приложения имеет право это прочитать', async () => {
    if (pool === null) return;
    await withRollback(pool, async (client) => {
      await saveDeal(client, AS_BUYER);
      // Кабинет читает под ролью приложения, а не под логин-ролью набора: она
      // член `sdelka_owner` и потому проходит всюду. Недостающий `SELECT` на
      // `sdelka.deal` или `sdelka.party` иначе вскрылся бы только на стенде.
      await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
      try {
        const mine = await loadDealsOfParty(client, VIEWER.partyId);
        expect(mine.map((deal) => deal.dealId)).toEqual([AS_BUYER.dealId]);
      } finally {
        await client.query('RESET ROLE');
      }
    });
  });
});
