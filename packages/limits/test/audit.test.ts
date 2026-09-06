import {
  assertNoRawIdentifiers,
  appendRecord,
  auditActor,
  auditInstant,
  genesisChain,
  verifyChain,
} from '@sdelka/audit';
import { type RoleId, rolesWithoutAuditRole } from '@sdelka/auth';
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
import { T0, at, version } from './support/fixtures';

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

describe('изменение настройки владельцем записывается — блокер E16-12 снят', () => {
  it('успешная ветвь достижима: владелец записан собой, а не похожей ролью', () => {
    // До миграции `0023` этот путь был отказом, и не крайним случаем, а
    // единственным: `manage_settings` есть ровно у `principal`, а `principal` в
    // `AUDIT_ROLES` не переезжал никуда. Ни один тест эту ветвь не проходил,
    // потому что пройти её было нельзя.
    expect([...rolesWithoutAuditRole()]).toEqual([]);

    const result = settingChangedBody({
      version: FIRST,
      previous: null,
      render: renderDealCurrencies,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.change).toBe('introduced');
    expect(result.value.orderedBy).toEqual({
      actorId: 'acc-principal',
      roleId: 'principal',
      capability: 'manage_settings',
    });
    expect(result.value.setting).toBe('deal_currencies');
    expect(result.value.next).toEqual(['GEL']);
    expect(result.value.reasonKey).toBe('settings.reason.owner_decision');
  });

  it('смена версии несёт оба значения и прежнее, и новое', () => {
    const result = settingChangedBody({
      version: SECOND,
      previous: FIRST,
      render: renderDealCurrencies,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.change).toBe('updated');
    expect(result.value.previous).toEqual(['GEL']);
    expect(result.value.next).toEqual(['GEL', 'USD']);
    expect(result.value.policy).toBe('deal_currencies/2026-09-04.2');
  });

  it('запись доходит до цепочки: субъект, момент действия и актор сходятся', () => {
    // Проверка по существу, а не по форме тела: цепочка отвергает запись,
    // поданную под чужим субъектом, и настройку, введённую задним числом.
    const built = settingChangedBody({
      version: FIRST,
      previous: null,
      render: renderDealCurrencies,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const chain = genesisChain(
      'chain:settings',
      auditInstant(T0 - 60_000),
      auditActor('system', 'system', null),
    );
    const appended = appendRecord(chain, {
      recordId: 'chain:settings:1',
      recordedAt: auditInstant(T0),
      actor: built.value.orderedBy,
      subject: settingSubject(FIRST),
      body: built.value,
    });
    expect(appended.records[1]?.actor.roleId).toBe('principal');
    expect(verifyChain(appended).intact).toBe(true);
  });

  it('роль без метки журнала — по-прежнему отказ, а не похожая роль', () => {
    // Ролей без метки сегодня нет, поэтому проверяется значением, которого в
    // перечне нет вовсе: так роль приходит из хранилища, где типов нет. Отказ
    // обязан остаться отказом — подстановка «ближайшей по смыслу» роли
    // осталась бы в вечном журнале ложью о том, кто двигал деньги.
    // Собрано в обход `settingsVersion`: он бы такую версию не выпустил —
    // роли без `manage_settings` там отказ. Именно так версия и приезжает из
    // хранилища: значением, а не конструктором.
    const fromStorage = Object.freeze({
      ...FIRST,
      introducedByRole: 'notary' as RoleId,
    });
    const result = settingChangedBody({
      version: fromStorage,
      previous: null,
      render: renderDealCurrencies,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(LIMITS_REFUSAL_KEYS.auditRoleUnrepresentable);
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
