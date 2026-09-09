import { describe, expect, it } from 'vitest';
import type { PoolClient } from '../src/pool.ts';
import { loadDealsOfParty } from '../src/store/state.ts';

/**
 * Выборка «сделки участника» — без базы.
 *
 * **Что здесь вообще можно проверить и почему это стоит проверять.** Правило
 * «отдаём только те сделки, где участник — сторона» живёт целиком в `WHERE`, и
 * его настоящая проверка — на живом Postgres с чужой сделкой в нём
 * (`test/int/store-deals-of-party.int.test.ts`). Но у этой проверки есть цена:
 * она у того, у кого поднят кластер. Здесь проверяется то, что от кластера не
 * зависит, — **о чём выборка спрашивает базу**: чей это вопрос, обе ли стороны
 * в нём названы, задан ли порядок и сколько запросов уходит на один список.
 *
 * Смотреть на текст запроса — не «проверять, как написано». Текст запроса и
 * есть договор с базой: `OR` без скобок и потерянный `ORDER BY` ничем себя не
 * выдают на маленьких данных и выдают на настоящих.
 */

interface Ask {
  readonly text: string;
  readonly values: readonly unknown[];
}

interface DealRow {
  readonly deal_id: string;
  readonly status: string;
  readonly buyer_party_id: string;
  readonly buyer_account_key: string;
  readonly seller_party_id: string;
  readonly seller_account_key: string;
}

/**
 * Клиент, который ничего не решает: запоминает вопрос и отдаёт заданные строки.
 *
 * Это не мок в запрещённом смысле (`CLAUDE.md`: «если для теста нужен мок
 * платёжного провайдера — тест написан неверно»): фактов о деньгах он не
 * производит, поведения у него нет. Он нужен, чтобы увидеть **вопрос**, а не
 * чтобы подменить ответ базы.
 */
function clientOf(rows: readonly DealRow[], seen: Ask[]): PoolClient {
  return {
    query: async (text: string, values: readonly unknown[]) => {
      seen.push({ text, values });
      return { rows, rowCount: rows.length };
    },
  } as unknown as PoolClient;
}

const PARTY = 'party-viewer';

function row(dealId: string, buyer: string, seller: string): DealRow {
  return {
    deal_id: dealId,
    status: 'funding',
    buyer_party_id: buyer,
    buyer_account_key: `${buyer}.account`,
    seller_party_id: seller,
    seller_account_key: `${seller}.account`,
  };
}

describe('сделки участника: о чём спрашивается база', () => {
  it('участник уезжает параметром, а не подстановкой в текст запроса', async () => {
    const seen: Ask[] = [];
    await loadDealsOfParty(clientOf([], seen), PARTY);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.values).toEqual([PARTY]);
    // Идентификатор стороны приходит снаружи — из сессии. Склейка его в текст
    // запроса была бы внедрением SQL под тем самым ключом, по которому
    // разделяются чужие данные.
    expect(seen[0]?.text).not.toContain(PARTY);
  });

  it('спрашиваются обе стороны, и условие связано скобками', async () => {
    const seen: Ask[] = [];
    await loadDealsOfParty(clientOf([], seen), PARTY);
    const text = seen[0]?.text ?? '';
    // Продавец видит ту же сделку, что и покупатель: выборка только по
    // `buyer_party_id` спрятала бы от продавца всё, что он продаёт.
    expect(text).toMatch(/\(\s*d\.buyer_party_id = \$1\s+OR\s+d\.seller_party_id = \$1\s*\)/u);
    // Скобки — не оформление. Приписанное завтра `AND …` без них свяжется
    // только со вторым слагаемым, и наружу поедут чужие сделки.
    expect(text).not.toMatch(/[^(]\s*d\.buyer_party_id = \$1 OR/u);
  });

  it('порядок задан выборкой, а не планировщиком, и он полный', async () => {
    const seen: Ask[] = [];
    await loadDealsOfParty(clientOf([], seen), PARTY);
    const text = seen[0]?.text ?? '';
    // Без `ORDER BY` два одинаковых чтения приходят в разном порядке, и кабинет
    // «прыгает» между переходами.
    expect(text).toContain('ORDER BY');
    // Свежие сверху — кабинет читают сверху вниз.
    expect(text).toMatch(/ORDER BY\s+d\.created_at DESC/u);
    // Второй ключ обязателен: момент заведения — момент транзакции, и у двух
    // сделок одного шага он одинаков. Без него их взаимный порядок снова решает
    // планировщик.
    expect(text).toMatch(/ORDER BY\s+d\.created_at DESC,\s*d\.deal_id/u);
  });

  it('один список — один запрос: ни строки за строкой, ни подъёма мира', async () => {
    const seen: Ask[] = [];
    const rows = [
      row('deal-2', PARTY, 'party-seller'),
      row('deal-1', 'party-buyer', PARTY),
    ];
    await loadDealsOfParty(clientOf(rows, seen), PARTY);
    // Список кабинета читается на каждом переходе. «Номера списком, потом
    // `loadDeal` за каждым» стоило бы числа строк, а подъём мира — журнала и
    // цепочки на каждую строку (спека §3.2, правило 7).
    expect(seen).toHaveLength(1);
  });

  it('порядок базы сохраняется: код не пересортировывает прочитанное', async () => {
    const seen: Ask[] = [];
    const rows = [
      row('deal-late', PARTY, 'party-seller'),
      row('deal-early', 'party-buyer', PARTY),
    ];
    const deals = await loadDealsOfParty(clientOf(rows, seen), PARTY);
    // Порядок назначен `ORDER BY` и приходит уже готовым. Пересортировка в коде
    // была бы вторым ответом на тот же вопрос — и разошлась бы с первым в тот
    // день, когда у выборки появится окно с курсором.
    expect(deals.map((deal) => deal.dealId)).toEqual(['deal-late', 'deal-early']);
  });

  it('стороны не путаются местами: у каждой свой ключ счёта', async () => {
    const seen: Ask[] = [];
    const rows = [row('deal-1', PARTY, 'party-seller')];
    const deals = await loadDealsOfParty(clientOf(rows, seen), PARTY);
    // `PartyRef` несёт обе половины личности сразу: сделка, у которой ключ счёта
    // достался не той стороне, — это деньги одного лица под именем другого.
    expect(deals).toEqual([
      {
        dealId: 'deal-1',
        state: { status: 'funding' },
        buyer: { partyId: PARTY, accountKey: `${PARTY}.account` },
        seller: { partyId: 'party-seller', accountKey: 'party-seller.account' },
      },
    ]);
  });

  it('сделок нет — пустой список, а не отказ', async () => {
    const seen: Ask[] = [];
    // «Пусто» — законное состояние экрана (спека §3.1), а не ошибка. Отличать
    // «участника нет» от «сделок нет» здесь нечем и не нужно: снаружи оба ответа
    // обязаны быть одинаковыми (§3.2, правило 2).
    expect(await loadDealsOfParty(clientOf([], seen), 'party-nobody')).toEqual([]);
  });
});
