import { describe, expect, it } from 'vitest';
import type {
  DealSnapshot,
  PayoutSnapshot,
  TrancheSnapshot,
  WorldStore,
  WorldTransaction,
  WriteOutcome,
} from '@sdelka/app';
import type * as Db from '../../db/src/store/port';
import { DbErrorCode } from '../../db/src/errors';
import { STORE_ERROR } from './support/memory-store';

/**
 * Два объявления одного порта обязаны совпадать — и это проверяется, а не
 * обещается.
 *
 * **Почему объявлений два.** Порт хранилища живёт в `packages/db`
 * (`src/store/port.ts`): он появился там раньше, и там же объяснено, почему
 * ребро `@sdelka/db → @sdelka/app` перевернуло бы слои. Шагу мира понадобился
 * тип, который он примет аргументом, — и тот же файл этот момент предсказал,
 * пометив выход **[открыто]**: «вынести порт в отдельный пакет — решение
 * владельца, а не наше». Решение не принято, поэтому объявление повторено в
 * `@sdelka/app`, откуда `pg` не виден.
 *
 * **Почему это не расползётся.** Копия, за которой никто не следит, расходится
 * с оригиналом на первой правке, и «порт один» превращается в два разных порта
 * с одинаковыми именами. Здесь расхождение роняет `pnpm -r typecheck`:
 * присваивание идёт **в обе стороны**, поэтому не проходит ни отнятое поле, ни
 * добавленное, ни изменённая подпись метода.
 *
 * ⚠ Импорт — по относительному пути и **только типов**: `@sdelka/db` в
 * зависимостях сквозных сценариев нет намеренно (он тянет `pg` в набор,
 * которому база не нужна), а `import type` не оставляет ребра в рантайме.
 * Тот же приём уже применён в `vitest.config.ts` этого пакета, который
 * дотягивается до `packages/domain/src/guards.ts` по относительному пути.
 */

/**
 * Сверка — **тип, у которого единственное допустимое значение `true`**.
 *
 * Присваивание объявленных значений (`declare const … ; const x: A = b;`) для
 * этого не годится: `declare` не оставляет привязки в рантайме, и тест падал бы
 * `ReferenceError` на пустом месте. Здесь же в рантайме остаётся массив из
 * шести `true`, а вся работа сделана компилятором: если формы разошлись,
 * `Mutual` даёт `false`, и `true` в него не присваивается.
 *
 * Совместимость проверяется **в обе стороны**: одностороннее «db годится app»
 * пропустило бы поле, добавленное в `app`, — то есть ровно тот случай, ради
 * которого сверка и существует.
 */
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

const CONFORMS: readonly [
  Mutual<WorldStore, Db.WorldStore>,
  Mutual<WorldTransaction, Db.WorldTransaction>,
  Mutual<DealSnapshot, Db.DealSnapshot>,
  Mutual<TrancheSnapshot, Db.TrancheSnapshot>,
  Mutual<PayoutSnapshot, Db.PayoutSnapshot>,
  Mutual<WriteOutcome, Db.WriteOutcome>,
] = [true, true, true, true, true, true];

describe('порт хранилища: одно объявление на два пакета', () => {
  it('ключи отказов у хранилища в памяти — те же, что у базы', () => {
    // Второй ключ для того же нарушения — это два разных ответа на один вопрос
    // (`packages/db/src/errors.ts`). Сверка держит совпадение буква в букву.
    expect(STORE_ERROR.conflict).toBe(DbErrorCode.stepConflict);
    expect(STORE_ERROR.stateConflict).toBe(DbErrorCode.stepStateConflict);
  });

  it('совпадение объявлений проверяется типами, а не этим тестом', () => {
    // Утверждение символическое: настоящая проверка — шесть значений выше, и
    // падает она в `tsc`, а не в прогоне. Здесь только видно, что она есть.
    expect(CONFORMS).toEqual([true, true, true, true, true, true]);
  });
});
