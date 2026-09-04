import { AuthError, AuthErrorCode } from './errors';
import type { NonHumanActorId, RoleId } from './roles';
import { NON_HUMAN_ACTORS, ROLE_IDS } from './roles';

/**
 * Сопоставление прежних перечней ролей с этим.
 *
 * `ACTORS.md` §1 расхождение №1: перечней ролей в проекте четыре, **и ни один не
 * является надмножеством другого**; §1 расхождение №2 цитирует собственный
 * комментарий кода — «расхождение перечней молчаливое: сверить их тестом отсюда
 * нельзя, для этого нужен пакет, видящий оба» (`packages/audit/src/record.ts`).
 *
 * Этот пакет видит оба. Молчаливым расхождение с этого момента не является:
 * значение, появившееся в `compliance` или в `AUDIT_ROLES` и не названное здесь,
 * роняет тест `test/legacy.test.ts`.
 *
 * Что здесь **не** делается: переименования в чужих пакетах. `client → party`,
 * `approver → financial_controller`/`head_of_operations`, `oracle → oracle_source`
 * и миграция `sdelka.audit_role` — правки `packages/compliance`,
 * `packages/audit` и `packages/db`, и они не наши. Таблица ниже — карта, по
 * которой их делать, и одновременно контроль, что до тех пор ничто не разошлось
 * дальше.
 */
export type LegacyRoleId =
  | 'operator'
  | 'approver'
  | 'compliance_analyst'
  | 'support'
  | 'representative'
  | 'client'
  | 'system'
  | 'oracle';

/**
 * Куда переезжает каждое прежнее значение. Список, а не одно значение: `approver`
 * расщепляется на два уровня утверждения (`ACTORS.md` §5.2), и это и есть та
 * правка, ради которой расщепление вообще затевалось.
 */
const LEGACY_ROLE_TARGETS = {
  operator: ['operator'],
  /** Одна роль на оба уровня — расхождение №5. Порог по роли не был выражен. */
  approver: ['financial_controller', 'head_of_operations'],
  compliance_analyst: ['compliance_analyst'],
  support: ['support'],
  representative: ['representative'],
  /** Роль — свойство участия, а не человека: `client` → `party`. */
  client: ['party'],
  system: ['system'],
  /** Источник события, а не человек. Оператор оракула — третья сущность. */
  oracle: ['oracle_source'],
} as const satisfies Record<LegacyRoleId, readonly (RoleId | NonHumanActorId)[]>;

export const LEGACY_ROLE_MAP: Readonly<
  Record<LegacyRoleId, readonly (RoleId | NonHumanActorId)[]>
> = Object.freeze(LEGACY_ROLE_TARGETS);

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
export function unmappedLegacyRoles(external: readonly string[]): readonly string[] {
  if (external.length === 0) {
    throw new AuthError(AuthErrorCode.legacyRoleListEmpty);
  }
  const mapped = new Set<string>(Object.keys(LEGACY_ROLE_MAP));
  return Object.freeze(external.filter((value) => !mapped.has(value)));
}

/** Цели сопоставления, не существующие в этом перечне. Пусто всегда — иначе карта врёт. */
export function danglingLegacyTargets(): readonly string[] {
  const dangling: string[] = [];
  for (const [legacy, targets] of Object.entries(LEGACY_ROLE_MAP)) {
    for (const target of targets) {
      if (!KNOWN.has(target)) dangling.push(`${legacy}->${target}`);
    }
  }
  return Object.freeze(dangling);
}
