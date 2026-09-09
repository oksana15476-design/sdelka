import { type Session, accountId, personId, sessionId } from '@sdelka/auth';
import { type Instant, instant } from '@sdelka/domain';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type DealApplicationDeps,
  type DealApplicationIntent,
  DEAL_APPLICATION_KEYS,
  applyDealApplicationEvent,
  mintDealApplicationKey,
  readDealApplicationQueue,
  readDealApplications,
  submitDealApplication,
} from '../src/index';
import {
  type ApplicationTables,
  applicationTables,
  chainIntact,
  chainOf,
  intakeStatus,
  memoryApplicationStore,
} from './support/application-store';

/**
 * Заявка на сделку как шаг приложения: кто подаёт, что записывается, что
 * возвращается на повтор и чего не отдаётся чужому.
 *
 * Сети здесь нет ни в одном виде, мока платёжного провайдера — тем более
 * (`CLAUDE.md`): хранилище заявок и признак остановки приёма — вторые реализации
 * объявленных портов, то есть карты и значения.
 */

const NOW: Instant = instant(Date.UTC(2026, 8, 9, 10, 0, 0));
const HOUR = 60 * 60 * 1000;
const CHAIN = 'sdelka-deal-application';

const CADASTRAL = '01.14.05.021.041';

const INTENT: DealApplicationIntent = Object.freeze({
  side: 'payer',
  objectCadastralCode: CADASTRAL,
  amount: { currency: 'GEL', decimal: '150000.00' },
  counterpartyContact: 'seller-contact-2',
  conditionType: 'registration_transfer',
});

function sessionFor(account: string, roleId: Session['roleId'], at: Instant = NOW): Session {
  return Object.freeze({
    sessionId: sessionId(`s-${account}`),
    accountId: accountId(account),
    personId: personId(`per-${account}`),
    roleId,
    onDuty: false,
    primary: { method: 'magic_link' as const, at, device: null, network: null },
    factors: [],
    issuedAt: at,
    expiresAt: instant(at + HOUR),
    lastSeenAt: at,
    revokedAt: null,
  });
}

const BUYER = sessionFor('acc-party-1', 'party');
const OTHER_BUYER = sessionFor('acc-party-2', 'party');
const OPERATOR = sessionFor('acc-operator-1', 'operator');

let data: ApplicationTables;
let clock: Instant;

function deps(overrides: Partial<DealApplicationDeps> = {}): DealApplicationDeps {
  return {
    store: memoryApplicationStore(data),
    intake: intakeStatus(true),
    chainId: CHAIN,
    now: (): Instant => clock,
    ...overrides,
  };
}

/** Значение как текст. `bigint` — в строку: суммы здесь целые, а не двоичные дроби. */
function shown(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'bigint' ? `${item}n` : item,
  );
}

/** Ожидаемый номер заявки — посчитанный чеканкой, а не переписанный из ответа. */
function expectedId(applicant: string, intent: DealApplicationIntent, minor: string): string {
  return mintDealApplicationKey([
    applicant,
    intent.side,
    intent.objectCadastralCode,
    intent.amount.currency,
    minor,
    intent.conditionType,
    intent.counterpartyContact,
  ]).value;
}

beforeEach(() => {
  data = applicationTables();
  clock = NOW;
});

describe('подача заявки', () => {
  it('проходит, ложится в хранилище и читается тем же участником', async () => {
    const submitted = await submitDealApplication(deps(), { session: BUYER, intent: INTENT });
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;
    expect(submitted.value.applicationId).toBe(expectedId(BUYER.accountId, INTENT, '15000000'));
    expect(submitted.value.state).toBe('submitted');
    expect(submitted.value.repeated).toBe(false);
    expect(submitted.value.intakeHalted).toBe(false);

    const mine = await readDealApplications(deps(), { session: BUYER });
    expect(mine.ok).toBe(true);
    if (!mine.ok) return;
    expect(mine.value).toHaveLength(1);
    const stored = mine.value[0];
    expect(stored?.applicationId).toBe(submitted.value.applicationId);
    expect(stored?.applicant).toBe(BUYER.accountId);
    expect(stored?.objectCadastralCode).toBe(CADASTRAL);
    // Сумма — целые минорные единицы, `bigint`. Плавающей точки нет ни в одном поле.
    expect(stored?.amount).toEqual({ currency: 'GEL', minor: 15_000_000n });
    expect(stored?.counterpartyContact).toBe('seller-contact-2');
    expect(stored?.conditionType).toBe('registration_transfer');
    expect(stored?.submittedAt).toBe(NOW);
    expect(stored?.submittedDuringHalt).toBe(false);
  });

  it('повтор того же намерения не создаёт вторую заявку', async () => {
    const first = await submitDealApplication(deps(), { session: BUYER, intent: INTENT });
    // Второй вызов — двойной клик: другое хранилище над теми же таблицами, то
    // есть и другой процесс тоже.
    const second = await submitDealApplication(deps(), { session: BUYER, intent: INTENT });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.applicationId).toBe(first.value.applicationId);
    expect(first.value.repeated).toBe(false);
    expect(second.value.repeated).toBe(true);
    expect(data.applications.size).toBe(1);
    // И второй записи в вечном журнале тоже нет: подача была одна.
    expect(chainOf(data, CHAIN).records).toHaveLength(2);
  });

  it('намерение, отличающееся одним знаком, — другая заявка', async () => {
    await submitDealApplication(deps(), { session: BUYER, intent: INTENT });
    const other = await submitDealApplication(deps(), {
      session: BUYER,
      intent: { ...INTENT, amount: { currency: 'GEL', decimal: '150000.01' } },
    });
    expect(other.ok).toBe(true);
    expect(data.applications.size).toBe(2);
  });

  it('тот же ключ у другого участника — другая заявка', async () => {
    const mine = await submitDealApplication(deps(), { session: BUYER, intent: INTENT });
    const theirs = await submitDealApplication(deps(), { session: OTHER_BUYER, intent: INTENT });
    expect(mine.ok && theirs.ok).toBe(true);
    if (!mine.ok || !theirs.ok) return;
    // Подавший входит в чеканку: одинаковое намерение двух разных людей — это
    // две заявки, а не повтор одной.
    expect(theirs.value.applicationId).not.toBe(mine.value.applicationId);
    expect(data.applications.size).toBe(2);
  });
});

describe('чужое не отдаётся', () => {
  it('выборка по участнику не возвращает заявку другого', async () => {
    const mine = await submitDealApplication(deps(), { session: BUYER, intent: INTENT });
    expect(mine.ok).toBe(true);
    if (!mine.ok) return;

    const theirs = await readDealApplications(deps(), { session: OTHER_BUYER });
    expect(theirs.ok).toBe(true);
    if (!theirs.ok) return;
    // Пусто, а не отказ: чужая заявка не отличима от несуществующей ничем.
    expect(theirs.value).toEqual([]);
  });

  it('даже если хранилище забыло условие отбора', async () => {
    await submitDealApplication(deps(), { session: BUYER, intent: INTENT });
    const leaky = deps({
      store: memoryApplicationStore(data, { listingIgnoresApplicant: true }),
    });
    const theirs = await readDealApplications(leaky, { session: OTHER_BUYER });
    expect(theirs.ok).toBe(true);
    if (!theirs.ok) return;
    expect(theirs.value).toEqual([]);
  });
});

describe('вечный журнал', () => {
  it('запись о подаче ушла фактически, и цепочка сходится', async () => {
    const submitted = await submitDealApplication(deps(), { session: BUYER, intent: INTENT });
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;

    const records = chainOf(data, CHAIN).records;
    expect(records.map((record) => record.body.kind)).toEqual([
      'chain_opened',
      'state_transition',
    ]);
    const record = records[1];
    expect(record?.subject).toEqual({
      kind: 'ref',
      scope: 'document',
      id: submitted.value.applicationId,
    });
    // Роль в журнале — метка журнала, а не роль доступа: `party` записывается
    // как `client` (`auth/src/journal.ts`, `AUDIT_ROLE_BY_ROLE`).
    expect(record?.actor).toEqual({
      actorId: BUYER.accountId,
      roleId: 'client',
      capability: null,
    });
    expect(record?.body).toEqual({
      kind: 'state_transition',
      machine: 'deal_application',
      from: 'absent',
      to: 'submitted',
      eventKey: 'deal_application.submitted',
      failedGuards: [],
    });
    // Сцепка проверяется настоящей проверкой пакета аудита, а не сравнением полей.
    expect(chainIntact(data, CHAIN)).toBe(true);
  });

  it('персональные данные заявки в журнал не попадают', async () => {
    await submitDealApplication(deps(), { session: BUYER, intent: INTENT });
    const written = JSON.stringify(chainOf(data, CHAIN));
    // Кадастровый код объекта и контакт второй стороны живут в строке заявки,
    // которую можно выдать и удалить. Журнал не редактируется — попавшее в него
    // остаётся навсегда.
    expect(written).not.toContain(CADASTRAL);
    expect(written).not.toContain('seller-contact-2');
  });

  it('заявка и журнал ложатся одной транзакцией: отказ журнала не оставляет заявку', async () => {
    const refusing = deps({ store: memoryApplicationStore(data, { journalRefuses: true }) });
    await expect(
      submitDealApplication(refusing, { session: BUYER, intent: INTENT }),
    ).rejects.toThrow();
    // Ни строки заявки, ни записи журнала: подача, записавшая одно и не
    // записавшая другое, невозможна.
    expect(data.applications.size).toBe(0);
    expect(chainOf(data, CHAIN).records).toHaveLength(0);
  });

  it('номер заявки с девятью цифрами подряд записи не ломает', async () => {
    /*
     * Ключ — UUID5, и примерно у каждого тридцать второго девять цифр идут
     * подряд; правило `digit_run` (`audit/src/values.ts`) считает такое значение
     * сырым идентификатором человека. Вход подобран перебором так, чтобы это
     * случилось наверняка: без доказательства чеканки запись бы не собралась, и
     * заявка была бы принята без единой строки в вечном журнале.
     */
    const intent: DealApplicationIntent = { ...INTENT, counterpartyContact: 'contact-run-12' };
    const key = expectedId(BUYER.accountId, intent, '15000000');
    expect(/\d{9,}/u.test(key)).toBe(true);

    const submitted = await submitDealApplication(deps(), { session: BUYER, intent });
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;
    expect(submitted.value.applicationId).toBe(key);
    expect(chainOf(data, CHAIN).records[1]?.subject.id).toBe(key);
  });
});

describe('кому отказано', () => {
  it('отказ один и тот же для случаев, различимых снаружи', async () => {
    // Консольная роль: сотрудник заявок не подаёт, он заводит сделку прямо.
    const staff = await submitDealApplication(deps(), { session: OPERATOR, intent: INTENT });
    // Клиентская роль с негодной сессией.
    const stale = await submitDealApplication(deps(), {
      session: sessionFor('acc-party-3', 'party', instant(NOW - 5 * HOUR)),
      intent: INTENT,
    });
    expect(staff.ok).toBe(false);
    expect(stale.ok).toBe(false);
    if (staff.ok || stale.ok) return;
    // Один ключ на оба случая: разные ответы перечисляли бы, чья учётная запись
    // клиентская, а чья консольная.
    expect(staff.error).toBe(DEAL_APPLICATION_KEYS.refused);
    expect(stale.error).toBe(staff.error);
    expect(data.applications.size).toBe(0);
  });

  it('разбор формы отвечает полем, а не единым отказом', async () => {
    const refusal = async (intent: DealApplicationIntent): Promise<string> => {
      const result = await submitDealApplication(deps(), { session: BUYER, intent });
      return result.ok ? 'принято' : result.error;
    };
    expect(await refusal({ ...INTENT, objectCadastralCode: 'дом у моря' })).toBe(
      DEAL_APPLICATION_KEYS.objectCodeMalformed,
    );
    expect(await refusal({ ...INTENT, amount: { currency: 'RUB', decimal: '10.00' } })).toBe(
      DEAL_APPLICATION_KEYS.currencyUnknown,
    );
    expect(await refusal({ ...INTENT, amount: { currency: 'GEL', decimal: '0.00' } })).toBe(
      DEAL_APPLICATION_KEYS.amountInvalid,
    );
    expect(await refusal({ ...INTENT, amount: { currency: 'GEL', decimal: '-1.00' } })).toBe(
      DEAL_APPLICATION_KEYS.amountInvalid,
    );
    // Лишние знаки не округляются: округление — решение правила, а не разбора.
    expect(await refusal({ ...INTENT, amount: { currency: 'GEL', decimal: '10.005' } })).toBe(
      DEAL_APPLICATION_KEYS.amountInvalid,
    );
    expect(await refusal({ ...INTENT, counterpartyContact: '   ' })).toBe(
      DEAL_APPLICATION_KEYS.counterpartyInvalid,
    );
    // Тип условия из перечня, но установить его сегодня нечем: наблюдения
    // нужного уровня не производит никто (`release-condition.ts`).
    expect(await refusal({ ...INTENT, conditionType: 'calendar_date' })).toBe(
      DEAL_APPLICATION_KEYS.conditionUnavailable,
    );
    expect(await refusal({ ...INTENT, conditionType: 'по договорённости' })).toBe(
      DEAL_APPLICATION_KEYS.conditionUnavailable,
    );
    expect(data.applications.size).toBe(0);
  });
});

describe('остановленный приём', () => {
  it('заявка принимается и несёт признак', async () => {
    const halted = deps({ intake: intakeStatus(false) });
    const submitted = await submitDealApplication(halted, { session: BUYER, intent: INTENT });
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;
    expect(submitted.value.intakeHalted).toBe(true);
    expect(data.applications.get(submitted.value.applicationId)?.submittedDuringHalt).toBe(true);
    // Признак есть и в вечном журнале — ключом события, а не нарушенным guard'ом:
    // заявка принята, ни одна проверка не отказала.
    expect(chainOf(data, CHAIN).records[1]?.body).toMatchObject({
      eventKey: 'deal_application.submitted_during_halt',
      failedGuards: [],
    });
  });

  it('повтор при остановке отдаёт признак первой подачи, а не второй', async () => {
    const open = deps();
    const halted = deps({ intake: intakeStatus(false) });
    const first = await submitDealApplication(open, { session: BUYER, intent: INTENT });
    const second = await submitDealApplication(halted, { session: BUYER, intent: INTENT });
    expect(first.ok && second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.repeated).toBe(true);
    // Заявка подана до остановки — переписывать её задним числом нечем.
    expect(second.value.intakeHalted).toBe(false);
  });
});

describe('очередь оператора', () => {
  it('клиенту не отдаётся', async () => {
    await submitDealApplication(deps(), { session: BUYER, intent: INTENT });
    const queue = await readDealApplicationQueue(deps(), { session: BUYER, limit: 10 });
    expect(queue.ok).toBe(false);
    if (queue.ok) return;
    expect(queue.error).toBe(DEAL_APPLICATION_KEYS.queueRefused);
  });

  it('оператору отдаётся без контакта второй стороны', async () => {
    await submitDealApplication(deps(), { session: BUYER, intent: INTENT });
    const queue = await readDealApplicationQueue(deps(), { session: OPERATOR, limit: 10 });
    expect(queue.ok).toBe(true);
    if (!queue.ok) return;
    expect(queue.value).toHaveLength(1);
    // Просмотр персональных данных — отдельный шаг с записью в журнал; в очереди
    // их нет вовсе, поэтому и записывать нечего.
    expect(shown(queue.value)).not.toContain('seller-contact-2');
    expect(queue.value[0]?.objectCadastralCode).toBe(CADASTRAL);
  });
});

describe('автомат заявки', () => {
  it('подана → принята в работу → превращена в сделку', () => {
    const taken = applyDealApplicationEvent('submitted', { type: 'taken_into_review' });
    expect(taken).toEqual({ ok: true, value: 'in_review' });
    expect(applyDealApplicationEvent('in_review', { type: 'converted', dealId: 'deal-1' })).toEqual(
      { ok: true, value: 'converted' },
    );
  });

  it('отклонить можно и не беря в работу', () => {
    expect(
      applyDealApplicationEvent('submitted', { type: 'rejected', reasonKey: 'object.unclear' }),
    ).toEqual({ ok: true, value: 'rejected' });
  });

  it('сделка заводится только из разобранной заявки', () => {
    const straight = applyDealApplicationEvent('submitted', {
      type: 'converted',
      dealId: 'deal-1',
    });
    expect(straight.ok).toBe(false);
    if (straight.ok) return;
    expect(straight.error).toBe(DEAL_APPLICATION_KEYS.stateEventNotApplicable);
  });

  it('из терминального не ведёт ни одно событие', () => {
    for (const state of ['rejected', 'converted'] as const) {
      for (const event of [
        { type: 'taken_into_review' } as const,
        { type: 'rejected', reasonKey: 'again' } as const,
        { type: 'converted', dealId: 'deal-2' } as const,
      ]) {
        const moved = applyDealApplicationEvent(state, event);
        expect(moved.ok).toBe(false);
        if (moved.ok) continue;
        expect(moved.error).toBe(DEAL_APPLICATION_KEYS.stateTerminal);
      }
    }
  });
});
