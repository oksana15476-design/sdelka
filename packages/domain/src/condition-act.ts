import type { Instant } from './instant';
import {
  type ReleaseConditionType,
  isReleaseConditionType,
  isUsableReleaseCondition,
} from './release-condition';

/**
 * Акт получателя об условии — CORE.md Ф13, порождающий акт всей конструкции.
 *
 * Статья 27(2) держится на том, что обстоятельство определяет **получатель**, а
 * не платформа: без записанного акта его воли у отложенного платежа нет
 * основания, есть только наше утверждение, что мы так решили. А условие,
 * зависящее от усмотрения платформы, делает сделку ничтожной (красная линия №6).
 *
 * Поэтому акт — не метаданные, а факт, без которого не принимаются деньги.
 * По каждой сделке из него восстанавливается: кто, когда и в какой редакции
 * определил условие.
 */
export interface ConditionAct {
  /** Кто из получателей совершил акт. Ключ стороны, не имя: имена не уникальны. */
  readonly recipientPartyId: string;
  readonly agreedAt: Instant;
  /**
   * Редакция текста условия, действовавшая **в момент акта** (FUNCTIONAL.md
   * инвариант 23). Здесь ключ версии, а не сам текст: текста для клиента в коде
   * нет, а неизменяемое хранение самой редакции — забота хранилища документов.
   */
  readonly conditionTextVersion: string;
  /** Тип условия из закрытого перечня STATE-MACHINES.md §8. */
  readonly conditionType: ReleaseConditionType;
}

export function conditionActsEqual(left: ConditionAct, right: ConditionAct): boolean {
  return (
    left.recipientPartyId === right.recipientPartyId &&
    left.agreedAt === right.agreedAt &&
    left.conditionTextVersion === right.conditionTextVersion &&
    left.conditionType === right.conditionType
  );
}

/**
 * Пригоден ли акт как основание для приёма средств.
 *
 * Отказ закрытый во всех сомнительных случаях. Проверки в рантайме, а не только
 * по типам: акт приходит из базы и из внешнего интерфейса, а типы границу
 * процесса не переживают.
 *
 * Тип условия проверяется дважды: что он вообще из перечня и что он не помечен
 * в §8 как **[открыто]**. `registration_preliminary` не подтверждён как
 * основание расчёта, поэтому акт с ним не принимается — иначе непроверенное
 * условие растворилось бы в конфигурации.
 *
 * Акт, датированный будущим, не принимается: он не может быть совершён позже
 * момента, в который на него ссылаются.
 */
export function isConditionActValid(act: ConditionAct | null, now: Instant): boolean {
  if (act === null) {
    return false;
  }
  if (act.recipientPartyId.length === 0 || act.conditionTextVersion.length === 0) {
    return false;
  }
  if (!isReleaseConditionType(act.conditionType)) {
    return false;
  }
  if (!isUsableReleaseCondition(act.conditionType)) {
    return false;
  }
  return act.agreedAt <= now;
}
