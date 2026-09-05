import { assertNoRawIdentifiers } from '@sdelka/audit';
import { rolesWithoutAuditRole } from '@sdelka/auth';
import { HOUR } from '@sdelka/domain';
import { money } from '@sdelka/money';
import { describe, expect, it } from 'vitest';
import {
  LIMITS_REFUSAL_KEYS,
  amountTolerance,
  dealCurrencyList,
  materialityThreshold,
  queueAgeBands,
  renderAmountTolerance,
  renderDealCurrencies,
  renderMaterialityThreshold,
  renderQueueAgeBands,
  settingChangedBody,
  settingSubject,
} from '../src/index';
import { at, version } from './support/fixtures';

const DOC = 'docs/product/SETTINGS.md';

const FIRST = version({
  id: 'deal_currencies/2026-09-04.1',
  value: dealCurrencyList(['GEL']),
  recordedAt: at(0),
  effectiveFrom: at(0),
  supersedes: null,
});

const SECOND = version({
  id: 'deal_currencies/2026-09-04.2',
  value: dealCurrencyList(['GEL', 'USD']),
  recordedAt: at(10),
  effectiveFrom: at(10),
  supersedes: 'deal_currencies/2026-09-04.1',
});

describe('субъект записи — сама настройка', () => {
  it('область `setting`, идентификатор равен домену версии', () => {
    const subject = settingSubject(SECOND);
    expect(subject.scope).toBe('setting');
    expect(subject.id).toBe('deal_currencies');
  });
});

describe('запись собирается из версии, а не рядом с ней', () => {
  it('подана не та прежняя версия — отказ: запись утверждала бы не то, что журнал', () => {
    const result = settingChangedBody({
      version: SECOND,
      previous: version({
        id: 'deal_currencies/2026-09-03.1',
        value: dealCurrencyList(['GEL']),
        recordedAt: at(-24),
        effectiveFrom: at(-24),
        supersedes: null,
      }),
      render: renderDealCurrencies,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(LIMITS_REFUSAL_KEYS.auditPreviousVersionMismatch);
  });

  it('первая версия, поданная с прежней, — тот же отказ', () => {
    const result = settingChangedBody({
      version: FIRST,
      previous: SECOND,
      render: renderDealCurrencies,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(LIMITS_REFUSAL_KEYS.auditPreviousVersionMismatch);
  });

  it('сменяющая версия, поданная без прежней, — тот же отказ', () => {
    const result = settingChangedBody({
      version: SECOND,
      previous: null,
      render: renderDealCurrencies,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(LIMITS_REFUSAL_KEYS.auditPreviousVersionMismatch);
  });
});

describe('⚠ изменение настройки владельцем сегодня записать нечем', () => {
  it('роли `principal` нет соответствия в перечне ролей журнала', () => {
    // Не крайний случай, а обычный путь: `manage_settings` есть ровно у
    // `principal`, значит **любая** сегодняшняя версия настройки упирается сюда.
    // Пробел назван в `packages/auth/src/journal.ts` и в `ACTORS.md` §13;
    // закрывается он миграцией `sdelka.audit_role` вместе с `packages/audit`,
    // `packages/compliance` и `packages/db` — то есть не из этого пакета.
    expect(rolesWithoutAuditRole()).toContain('principal');

    const result = settingChangedBody({
      version: FIRST,
      previous: null,
      render: renderDealCurrencies,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(LIMITS_REFUSAL_KEYS.auditRoleUnrepresentable);
  });

  it('похожая роль не подставляется: отказ вместо лжи в вечном журнале', () => {
    const result = settingChangedBody({
      version: SECOND,
      previous: FIRST,
      render: renderDealCurrencies,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).not.toBe(LIMITS_REFUSAL_KEYS.auditPreviousVersionMismatch);
  });
});

describe('величины в журнале: целиком, канонично и без единой строки, которую туда нельзя', () => {
  it('перечень валют — массив кодов в каноничном порядке', () => {
    expect(renderDealCurrencies(dealCurrencyList(['USD', 'GEL']))).toEqual(['GEL', 'USD']);
  });

  it('допуск — доля целым, абсолют суммами в минорных единицах `bigint`', () => {
    const rendered = renderAmountTolerance(
      amountTolerance({
        absolute: [money('GEL', 5_000n)],
        shareBp: 50,
        rationaleDocRef: DOC,
      }),
    ) as { shareBp: number; absolute: readonly { currency: string; minor: bigint }[] };
    expect(rendered.shareBp).toBe(50);
    expect(rendered.absolute[0]?.currency).toBe('GEL');
    expect(rendered.absolute[0]?.minor).toBe(5_000n);
    expect(typeof rendered.absolute[0]?.minor).toBe('bigint');
  });

  it('границы очереди — миллисекунды целыми', () => {
    const rendered = renderQueueAgeBands(
      queueAgeBands({
        escalationAfterMs: [4 * HOUR, 24 * HOUR],
        rankCurrency: 'GEL',
        rationaleDocRef: DOC,
      }),
    ) as { escalationAfterMs: readonly number[]; rankCurrency: string };
    expect(rendered.escalationAfterMs).toEqual([4 * HOUR, 24 * HOUR]);
    expect(rendered.rankCurrency).toBe('GEL');
  });

  it('каждое значение проходит запрет сырых идентификаторов', () => {
    // Второй рубеж журнала: строка, не похожая на технический ключ, в тело
    // записи не входит вовсе. Ссылки на документ здесь нет намеренно —
    // якорь `SETTINGS.md#в8-допуск` не проходит по построению.
    const values = [
      renderDealCurrencies(dealCurrencyList(['GEL', 'USD'])),
      renderAmountTolerance(
        amountTolerance({ absolute: [money('GEL', 5_000n)], shareBp: 50, rationaleDocRef: DOC }),
      ),
      renderQueueAgeBands(
        queueAgeBands({
          escalationAfterMs: [4 * HOUR],
          rankCurrency: 'GEL',
          rationaleDocRef: DOC,
        }),
      ),
      renderMaterialityThreshold(
        materialityThreshold({
          monthlyTurnover: money('GEL', 900_000_000n),
          warnAtBp: 7_500,
          rationaleDocRef: DOC,
        }),
      ),
    ];
    for (const value of values) {
      expect(() => assertNoRawIdentifiers(value)).not.toThrow();
    }
  });
});
