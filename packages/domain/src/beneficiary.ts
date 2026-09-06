import type { Instant } from './instant';
import {
  type ParticipationKey,
  isParticipationKeyValid,
  participationKeysEqual,
} from './participation';

/**
 * Статус реквизитов выплаты — форма факта, общая для домена и комплаенса.
 *
 * Перечень живёт **здесь**, а не в `packages/compliance`, хотя решение о статусе
 * принимает комплаенс: домен на этом статусе стоит guard'ом, и второй перечень
 * тех же четырёх значений — ровно тот класс расхождения, который однажды уже
 * стоил `g_owner_matches` (STATE-MACHINES.md §1.3). Направление зависимостей
 * уже такое: `compliance` импортирует форму факта отсюда именно затем, чтобы её
 * изменение ломало сборку, а не расходилось молча.
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
 * Из чего изготавливается подтверждение. Отдельный тип, а не четыре позиционных
 * параметра: `BeneficiaryState` комплаенса подходит сюда структурно, и
 * `toBeneficiaryConfirmation` там — простая передача состояния, а не сборка
 * нового значения из разложенных полей.
 */
export interface BeneficiaryConfirmationSource {
  /** Участие, для которого реквизиты подтверждены. Не лицо и не транш. */
  readonly participation: ParticipationKey;
  readonly status: BeneficiaryStatus;
  /** Блокировка наступает при финансировании сделки, а не по решению оператора. */
  readonly locked: boolean;
  readonly lastChangedAt: Instant | null;
}

/**
 * Подтверждение реквизитов выплаты **для одного участия** — факт, на котором
 * стоят два **разных** guard'а: `g_beneficiary_verified` (доказательство
 * владения есть) и `g_beneficiary_locked` (реквизиты заперты и не менялись в
 * запретном окне). Склеивать их в один нельзя: §1.3 требует, чтобы каждое
 * условие проверялось поимённо, а два условия под одним именем не тестируются
 * по отдельности.
 *
 * **Почему класс с приватным полем, а не интерфейс.** Прежний `BeneficiaryLock`
 * был обычной структурой `{ status, locked, lastChangedAt }` без ключа участия:
 * подтверждение, полученное по сделке А, ложилось фактом транша сделки Б одним
 * присваиванием. Ключа участия было мало бы: структура с полем `participation`
 * переклеивается спредом — `{ ...подтверждениеА, participation: ключБ }`
 * компилируется и молча делает ровно то, что И13.1 запрещает. Приватное поле
 * `#nominal` — единственная в TypeScript форма номинального типа, которую
 * спред воспроизвести не может: результат спреда не имеет приватного поля и не
 * является подтверждением. На это стоит тест с `@ts-expect-error`, то есть
 * запрет проверяется компилятором, а не договорённостью.
 *
 * Чего это **не** даёт и что названо честно: изготовитель подтверждения —
 * комплаенс, и он вправе выписать подтверждение на любое участие, потому что
 * участие приходит ему из состояния реквизитов. Барьер здесь в другом: взять
 * готовое подтверждение чужого участия и надеть его на своё нельзя, а чтобы
 * получить своё, надо провести процедуру подтверждения по своему участию
 * (`verifyBeneficiaryHolder` берёт участие первым аргументом).
 */
class BeneficiaryConfirmationValue {
  /** Номинальность типа: см. комментарий выше и `participation.ts`. */
  readonly #nominal = 'sdelka.beneficiary.confirmation';

  readonly participation: ParticipationKey;
  readonly status: BeneficiaryStatus;
  readonly locked: boolean;
  readonly lastChangedAt: Instant | null;

  constructor(source: BeneficiaryConfirmationSource) {
    this.participation = source.participation;
    this.status = source.status;
    this.locked = source.locked;
    this.lastChangedAt = source.lastChangedAt;
    Object.freeze(this);
  }

  /** Приватное поле обязано быть прочитано — см. `ParticipationKeyValue`. */
  toString(): string {
    return `${this.#nominal}:${this.status}`;
  }
}

export type BeneficiaryConfirmation = BeneficiaryConfirmationValue;

/**
 * Единственный способ получить подтверждение. Класс наружу не выпущен —
 * экспортируется только его тип, — поэтому `new` вне этого модуля невозможен.
 */
export function beneficiaryConfirmation(
  source: BeneficiaryConfirmationSource,
): BeneficiaryConfirmation {
  return new BeneficiaryConfirmationValue(source);
}

/**
 * Подтверждение **этого** участия или `null`.
 *
 * Разрешение, а не сверка «совпало ли»: guard спрашивает «есть ли у этого
 * участия подтверждение», и подтверждение чужого участия для него просто не
 * существует. Разница видна в отказе — он тот же, что при отсутствии
 * подтверждения вовсе, и это правильно: подтверждения по сделке Б у стороны
 * нет, сколько бы их ни было по сделке А.
 *
 * Ключ с пустой сделкой или пустой стороной не разрешает ничего, даже если
 * второй такой же (`isParticipationKeyValid`): «сверять не с чем» — это отказ,
 * а не совпадение двух пустот.
 */
export function beneficiaryForParticipation(
  confirmation: BeneficiaryConfirmation | null,
  key: ParticipationKey,
): BeneficiaryConfirmation | null {
  if (confirmation === null) return null;
  if (!isParticipationKeyValid(key) || !isParticipationKeyValid(confirmation.participation)) {
    return null;
  }
  return participationKeysEqual(confirmation.participation, key) ? confirmation : null;
}
