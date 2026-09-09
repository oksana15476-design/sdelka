import { SEED_PREFIX } from '@sdelka/app';
import type { PoolClient } from '../pool.ts';
import { SeedError, SeedErrorCode } from './errors.ts';

/**
 * Ворота засева: на базе с настоящими данными он не работает.
 *
 * **Признак «настоящих» — явный и проверяемый, а не «строк много».** Каждую
 * строку, которую засев кладёт, он именует со своего начала (`SEED_PREFIX`,
 * `@sdelka/app`): цепочка журнала аудита, а значит и записи журнала учёта (их
 * идентификатор несёт цепочку), сделка, транш, стороны. Настоящая строка этого
 * начала не имеет — значит вопрос «есть ли в базе не наше» решается запросом, а
 * не оценкой.
 *
 * Счёт строк для этого не годится ни в какую сторону: у живой базы в первый
 * день одна сделка, а у засеянной их десять, и «мало» с «много» местами
 * меняются. Флажок в отдельной таблице («эта база засеяна») не годится тоже: он
 * отвечает за всю базу разом и врёт с того момента, как рядом с засевом
 * появится хоть одна живая запись.
 *
 * **Два вида отношений, и правила у них разные.**
 *
 * 1. Те, куда засев пишет сам (`store/state.ts`, `journal.ts`, `audit.ts`): в
 *    них допускаются **только** строки с началом засева.
 * 2. Те, куда засев не пишет вовсе (реквизиты, наблюдения реестра, заявления,
 *    входящие платежи, исходящая очередь, сырые ответы, учётные записи и
 *    сессии): в них не допускается **ни одной** строки. Справочники, которые
 *    заполняет накат (валюты, виды счетов, роли, полномочия, политики сессий),
 *    сюда не входят — они часть схемы, а не данные.
 */

interface Namespaced {
  readonly relation: string;
  /** Условие «строка не наша». Параметр `$1` — начало идентификатора засева. */
  readonly foreign: string;
}

const NAMESPACED: readonly Namespaced[] = Object.freeze([
  { relation: 'party', foreign: 'party_id NOT LIKE $1' },
  { relation: 'deal', foreign: 'deal_id NOT LIKE $1' },
  { relation: 'condition_act', foreign: 'deal_id NOT LIKE $1' },
  { relation: 'tranche', foreign: 'deal_id NOT LIKE $1' },
  { relation: 'payout', foreign: 'deal_id NOT LIKE $1' },
  { relation: 'withdrawal', foreign: 'party_id NOT LIKE $1' },
  { relation: 'ledger_entry', foreign: 'entry_id NOT LIKE $1' },
  { relation: 'ledger_posting', foreign: 'entry_id NOT LIKE $1' },
  { relation: 'audit_record', foreign: 'chain_id NOT LIKE $1' },
]);

/**
 * Отношения, в которые засев не пишет ни строки. Любая строка здесь означает,
 * что базой уже пользовался кто-то настоящий: реквизиты выплаты, наблюдение
 * реестра, заявление, входящий платёж, поручение в очереди, сырой ответ
 * источника, учётная запись, сессия, грант, след доступа.
 */
const EMPTY: readonly string[] = Object.freeze([
  'beneficiary',
  'registry_observation',
  'registry_filing',
  'inbound_payment',
  'outbox',
  'raw_source',
  'auth_account',
  'auth_session',
  'auth_grant',
  'auth_event',
  'second_factor_binding',
]);

export interface ForeignRelation {
  readonly relation: string;
  readonly rows: number;
}

/**
 * Что в базе лежит не от засева. Пустой список — засев возможен.
 *
 * Возвращает **значение**, а не бросает: отказ формулирует вызывающий, а
 * команде и тесту нужен разный ответ на один и тот же вопрос.
 */
export async function foreignRelations(client: PoolClient): Promise<readonly ForeignRelation[]> {
  const found: ForeignRelation[] = [];
  for (const item of NAMESPACED) {
    const result = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM sdelka.${item.relation} WHERE ${item.foreign}`,
      [`${SEED_PREFIX}%`],
    );
    const rows = Number(result.rows[0]?.n ?? '0');
    if (rows > 0) found.push({ relation: item.relation, rows });
  }
  for (const relation of EMPTY) {
    const result = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM sdelka.${relation}`,
    );
    const rows = Number(result.rows[0]?.n ?? '0');
    if (rows > 0) found.push({ relation, rows });
  }
  return Object.freeze(found);
}

/**
 * Отказ работать на базе с настоящими данными.
 *
 * Отказ — до единой записи: засев, начавший писать и остановившийся на
 * половине, оставил бы базу в состоянии, которого никто не выбирал.
 */
export async function assertSeedable(client: PoolClient): Promise<void> {
  const foreign = await foreignRelations(client);
  if (foreign.length === 0) return;
  throw new SeedError(SeedErrorCode.foreignData, {
    relations: foreign.map((item) => `${item.relation}=${item.rows}`).join(','),
  });
}
