import type { Instant } from './instant';

/**
 * Статус реквизитов выплаты — форма факта, общая для домена и комплаенса.
 *
 * Перечень живёт **здесь**, а не в `packages/compliance`, хотя решение о статусе
 * принимает комплаенс: домен на этом статусе стоит guard'ом, и второй перечень
 * тех же четырёх значений — ровно тот класс расхождения, который однажды уже
 * стоил `g_owner_matches` (STATE-MACHINES.md §1.3). Направление зависимостей
 * уже такое: `compliance` импортирует `BeneficiaryLock` отсюда именно затем,
 * чтобы изменение формы факта ломало сборку, а не расходилось молча.
 *
 * `name_consistent` и `verified` — **разные** вещи, и это главное, ради чего
 * статус доезжает до домена (ROADMAP.md И13.1):
 *
 *  · `draft` — реквизиты введены, ничего не проверено;
 *  · `name_consistent` — имя владельца счёта согласуется с профилем стороны.
 *    Совпадение имени не является достаточным основанием ни для чего:
 *    латинизация грузинского необратима, и «Гиорги» ↔ «Giorgi» ↔ «Georgi»
 *    сходятся у разных людей;
 *  · `verified` — приложено доказательство владения счётом (код из тестового
 *    перевода или внешняя проверка владельца). Только этот статус открывает
 *    выплату;
 *  · `blocked` — расхождение имени или отсутствие латинской формы.
 */
export const BENEFICIARY_STATUSES = ['draft', 'name_consistent', 'verified', 'blocked'] as const;

export type BeneficiaryStatus = (typeof BENEFICIARY_STATUSES)[number];

export function isBeneficiaryStatus(value: string): value is BeneficiaryStatus {
  return (BENEFICIARY_STATUSES as readonly string[]).includes(value);
}

/**
 * Факт о реквизитах выплаты, на котором стоят два **разных** guard'а:
 * `g_beneficiary_verified` (доказательство владения есть) и
 * `g_beneficiary_locked` (реквизиты заперты и не менялись в запретном окне).
 * Склеивать их в один нельзя: §1.3 требует, чтобы каждое условие проверялось
 * поимённо, а два условия под одним именем не тестируются по отдельности.
 */
export interface BeneficiaryLock {
  readonly status: BeneficiaryStatus;
  readonly locked: boolean;
  readonly lastChangedAt: Instant | null;
}
