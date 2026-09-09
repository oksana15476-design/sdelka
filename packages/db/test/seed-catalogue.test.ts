import { describe, expect, it } from 'vitest';
import {
  type SeedStage,
  type SeededScenario,
  SEED_PREFIX,
  SEED_SCENARIOS,
  WITHOUT_STORE,
  seedChainId,
  seedDealId,
  seedTrancheId,
  seedWorlds,
} from '@sdelka/app';

/**
 * Каталог засева — **без базы**.
 *
 * Здесь проверяются два свойства, от которых зависит всё остальное, и ни одно
 * из них базы не требует.
 *
 * 1. *Сценарий доходит туда, куда объявлено.* Состояния считает автомат
 *    (`@sdelka/app`, боевые шаги), а не тест: если ступень «расчёт проведён»
 *    перестанет достигаться, это будет видно здесь, а не в живой базе.
 * 2. *Каждая строка засева именована его началом.* На этом стоят ворота
 *    (`seed/guard.ts`): признак «настоящих данных» — идентификатор без начала
 *    засева, и стоит одному виду записей его потерять, как ворота начнут
 *    пропускать живую базу, ничего при этом не сломав.
 */

const STAGE_STATES: Record<SeedStage, { readonly deal: string; readonly tranche: string }> = {
  instructed: { deal: 'ready', tranche: 'collecting' },
  collected: { deal: 'funding', tranche: 'collected' },
  reserved: { deal: 'funded', tranche: 'reserved' },
  settled: { deal: 'settled', tranche: 'paid_out' },
};

const seeded: Promise<readonly SeededScenario[]> = seedWorlds(WITHOUT_STORE).then(
  (result) => result.seeded,
);

describe('каталог засева', () => {
  it('каждый сценарий доходит до объявленной ступени', async () => {
    const result = await seeded;
    expect(result).toHaveLength(SEED_SCENARIOS.length);
    for (const item of result) {
      const expected = STAGE_STATES[item.stage];
      expect(`${item.id}:${item.dealStatus}/${item.trancheStatus}`).toBe(
        `${item.id}:${expected.deal}/${expected.tranche}`,
      );
    }
  });

  it('ни один сценарий не теряет части шага молча', async () => {
    const result = await seeded;
    // Непопавшее в базу — законное значение (`store.ts`, `UNMAPPED_REASONS`), но
    // причины у него закрытый перечень. Здесь проверяется, что засев не роняет
    // в него ни состояния сделки, ни транша, ни поручения: это означало бы, что
    // в базе лежит не то положение, до которого сценарий доведён.
    const lost = result.flatMap((item) =>
      item.unmapped.filter((part) => part.reasonKey.startsWith('payout.')),
    );
    expect(lost).toEqual([]);
  });

  it('все идентификаторы засева несут его начало', async () => {
    const result = await seeded;
    for (const item of result) {
      expect(item.dealId).toBe(seedDealId(item.id));
      expect(item.trancheId).toBe(seedTrancheId(item.id));
      expect(item.dealId.startsWith(SEED_PREFIX)).toBe(true);
      expect(item.trancheId.startsWith(SEED_PREFIX)).toBe(true);
      expect(seedChainId(item.id).startsWith(SEED_PREFIX)).toBe(true);
    }
  });

  it('идентификаторы сценариев различны', () => {
    const ids = SEED_SCENARIOS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

/**
 * Сверка с фикстурами интерфейса.
 *
 * ⚠ Каталогов два: этот и `apps/web/src/fixtures/scenarios.ts`. Второй живёт в
 * приложении и написан на своём словаре шагов, импортировать его пакетом нельзя
 * (`seed.ts`, `SEED_SCENARIOS`, и `DECISIONS-REVIEW.md` §Y1 **[открыто]**).
 * Значит расхождение обязано **ловиться**, а не обещаться: если сценарий
 * переименуют, сменят внешний номер или сумму, разойдутся экран и база — то
 * есть ровно то, ради чего засев и делался.
 *
 * Модуль фикстур подгружается путём, собранным из частей: у него другой корень
 * `tsconfig`, и статический импорт уронил бы проверку типов пакета. Читается он
 * **только на чтение** — граница `apps/web` этим тестом не пересекается ни в
 * какую другую сторону.
 */
interface FixtureScenario {
  readonly id: string;
  readonly ref: string;
  readonly requiredMinor: bigint;
}

async function fixtureCatalogue(): Promise<readonly FixtureScenario[]> {
  const path = ['..', '..', 'apps', 'web', 'src', 'fixtures', 'scenarios.ts'].join('/');
  const loaded = (await import(/* @vite-ignore */ path)) as {
    readonly SCENARIOS: readonly FixtureScenario[];
  };
  return loaded.SCENARIOS;
}

describe('засев и фикстуры интерфейса называют одни и те же сделки', () => {
  it('идентификатор, внешний номер и сумма совпадают', async () => {
    const fixtures = await fixtureCatalogue();
    const byId = new Map(fixtures.map((item) => [item.id, item]));
    for (const item of SEED_SCENARIOS) {
      const fixture = byId.get(item.id);
      expect(fixture, `сценария ${item.id} нет в фикстурах интерфейса`).toBeDefined();
      if (fixture === undefined) continue;
      expect(`${item.id}:${item.ref}`).toBe(`${fixture.id}:${fixture.ref}`);
      // Сумма сделки та же: у тарифа, несомого получателем, брутто равно
      // сумме сделки, и именно её фикстура называет «сколько перевести».
      expect(item.principalMinor).toBe(fixture.requiredMinor);
    }
  });
});
