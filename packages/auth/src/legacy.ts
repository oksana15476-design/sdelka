import { AuthError, AuthErrorCode } from './errors';
import type { NonHumanActorId, RoleId } from './roles';
import { NON_HUMAN_ACTORS, ROLE_IDS } from './roles';

/**
 * Метки перечня ролей журнала и роли доступа, которые за ними стоят.
 *
 * `ACTORS.md` §1 расхождение №1: перечней ролей в проекте четыре, **и ни один не
 * является надмножеством другого**; §1 расхождение №2 цитирует собственный
 * комментарий кода — «расхождение перечней молчаливое: сверить их тестом отсюда
 * нельзя, для этого нужен пакет, видящий оба» (`packages/audit/src/record.ts`).
 *
 * Этот пакет видит оба. Молчаливым расхождение не является: значение,
 * появившееся в `compliance` или в `AUDIT_ROLES` и не названное здесь, роняет
 * тест `test/legacy.test.ts`.
 *
 * ## Что изменилось миграцией `0023`
 *
 * Прежде здесь стояла карта в одну сторону — «куда переезжает каждое **прежнее**
 * значение», и переезд был не сделан: в журнале было восемь меток против
 * четырнадцати ролей доступа. Теперь метка есть у каждой роли, и карта
 * описывает **действующий** перечень журнала, а не только его прошлое. Прежние
 * метки из неё никуда не делись — они читаются в записях, сделанных до
 * миграции, и потому обязаны иметь строку здесь.
 *
 * Чего здесь по-прежнему **не** делается: переименований `client → party` и
 * `oracle → oracle_source`. Это не пробел, а другой класс правки: обе метки
 * соответствие имеют, речь только об имени, а переименование метки в перечне
 * переписывает прочтение уже сделанных записей (красная линия №11). Развилка
 * названа в `DECISIONS-REVIEW.md` §O1 и ждёт владельца.
 */
export type JournalRoleId =
  /* --- Прежние восемь: перечень до миграции `0023`. --- */
  | 'operator'
  | 'approver'
  | 'compliance_analyst'
  | 'support'
  | 'representative'
  | 'client'
  | 'system'
  | 'oracle'
  /* --- Дописанные `0023`, порядком `ROLE_IDS`. --- */
  | 'oracle_operator'
  | 'compliance_officer'
  | 'financial_controller'
  | 'head_of_operations'
  | 'principal'
  | 'auditor'
  | 'client_counsel';

/**
 * Метка журнала → роли доступа, которые ею записываются.
 *
 * Список, а не одно значение: `approver` покрывал **оба** уровня утверждения
 * (`ACTORS.md` §5.2 — **[решение]**: `financial_controller` даёт уровень 1,
 * `head_of_operations` — уровень 2, ни одна роль не даёт оба). Именно поэтому
 * он и выведен из употребления: запись «утвердил approver» не отвечает на
 * вопрос, кто утвердил.
 */
const JOURNAL_ROLE_TARGETS = {
  operator: ['operator'],
  /**
   * Прежняя метка обоих уровней. Строка сохранена, потому что записи с ней
   * существуют и обязаны читаться; новые под ней не пишутся
   * (`RETIRED_JOURNAL_ROLES`).
   */
  approver: ['financial_controller', 'head_of_operations'],
  compliance_analyst: ['compliance_analyst'],
  support: ['support'],
  representative: ['representative'],
  /** Роль — свойство участия, а не человека: `party` записывается как `client`. */
  client: ['party'],
  system: ['system'],
  /** Источник события, а не человек. Оператор оракула — третья сущность. */
  oracle: ['oracle_source'],
  oracle_operator: ['oracle_operator'],
  compliance_officer: ['compliance_officer'],
  financial_controller: ['financial_controller'],
  head_of_operations: ['head_of_operations'],
  principal: ['principal'],
  auditor: ['auditor'],
  client_counsel: ['client_counsel'],
} as const satisfies Record<JournalRoleId, readonly (RoleId | NonHumanActorId)[]>;

export const JOURNAL_ROLE_MAP: Readonly<
  Record<JournalRoleId, readonly (RoleId | NonHumanActorId)[]>
> = Object.freeze(JOURNAL_ROLE_TARGETS);

/**
 * Метки, под которыми **новые записи не пишутся**.
 *
 * Зеркало `RETIRED_AUDIT_ROLES` из `@sdelka/audit`; литералом, как и весь
 * перечень выше, — рабочий код этого пакета на журнал не ссылается. Сверку
 * ведёт `test/journal.test.ts`, он видит оба пакета.
 *
 * Роль, для которой не осталось ни одной действующей метки, соответствия не
 * имеет вовсе: `auditRoleFor` вернёт `null`, а `requireAuditRole` бросит.
 * Подстановка ближайшей по смыслу метки запрещена — это ложь в вечном журнале
 * (красная линия №11, `DECISIONS-REVIEW.md` §K5).
 */
export const RETIRED_JOURNAL_ROLES = ['approver'] as const;
export type RetiredJournalRoleId = (typeof RETIRED_JOURNAL_ROLES)[number];

export function isRetiredJournalRole(value: string): value is RetiredJournalRoleId {
  return (RETIRED_JOURNAL_ROLES as readonly string[]).includes(value);
}

/**
 * Метка, под которой пишут **новую** запись.
 *
 * Тип, а не соглашение: `requireAuditRole` возвращает именно его, и оттого
 * подать выведенную из употребления метку в `auditActor` (`@sdelka/audit`,
 * `WritableAuditRoleId`) не собирается. Совпадение двух перечней проверяет
 * `test/journal.test.ts` — он видит оба пакета.
 */
export type WritableJournalRoleId = Exclude<JournalRoleId, RetiredJournalRoleId>;

const KNOWN: ReadonlySet<string> = new Set<string>([...ROLE_IDS, ...NON_HUMAN_ACTORS]);

/**
 * Значения чужого перечня, которым здесь нет соответствия. Пусто — перечни не
 * разошлись; непусто — разошлись, и вот чем именно.
 *
 * Пустой перечень на входе — **ошибка, а не «всё сошлось»**. Это единственное
 * значение аргумента, при котором сверка отвечает «нарушений нет», ничего не
 * сверив: перечень, приехавший пустым из-за неудачного импорта или
 * переименованного экспорта, выглядел бы как зелёный тест.
 */
export function unmappedJournalRoles(external: readonly string[]): readonly string[] {
  if (external.length === 0) {
    throw new AuthError(AuthErrorCode.legacyRoleListEmpty);
  }
  const mapped = new Set<string>(Object.keys(JOURNAL_ROLE_MAP));
  return Object.freeze(external.filter((value) => !mapped.has(value)));
}

/** Цели сопоставления, не существующие в этом перечне. Пусто всегда — иначе карта врёт. */
export function danglingJournalTargets(): readonly string[] {
  const dangling: string[] = [];
  for (const [label, targets] of Object.entries(JOURNAL_ROLE_MAP)) {
    for (const target of targets) {
      if (!KNOWN.has(target)) dangling.push(`${label}->${target}`);
    }
  }
  return Object.freeze(dangling);
}
