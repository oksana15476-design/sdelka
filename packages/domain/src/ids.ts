import { createHash } from 'node:crypto';
import { DomainError, RejectionCode } from './result';

/**
 * UUID версии 5 (RFC 4122): SHA-1 от пространства имён и имени. Реализован
 * здесь, а не взят зависимостью: алгоритм на двадцать строк, а лишняя
 * зависимость в денежном ядре — лишняя поверхность атаки.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function uuidToBytes(uuid: string): Uint8Array {
  if (!UUID_PATTERN.test(uuid)) {
    throw new DomainError(RejectionCode.invalidUuid, uuid);
  }
  const hex = uuid.replace(/-/gu, '');
  const bytes = new Uint8Array(16);
  for (let index = 0; index < 16; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function bytesToUuid(bytes: Uint8Array): string {
  const hex: string[] = [];
  for (const byte of bytes) {
    hex.push(byte.toString(16).padStart(2, '0'));
  }
  const joined = hex.join('');
  return [
    joined.slice(0, 8),
    joined.slice(8, 12),
    joined.slice(12, 16),
    joined.slice(16, 20),
    joined.slice(20, 32),
  ].join('-');
}

export function uuid5(namespace: string, name: string): string {
  const hash = createHash('sha1');
  hash.update(uuidToBytes(namespace));
  hash.update(new TextEncoder().encode(name));
  const digest = new Uint8Array(hash.digest()).slice(0, 16);
  const versionByte = digest[6];
  const variantByte = digest[8];
  if (versionByte === undefined || variantByte === undefined) {
    throw new DomainError(RejectionCode.invalidUuid);
  }
  digest[6] = (versionByte & 0x0f) | 0x50;
  digest[8] = (variantByte & 0x3f) | 0x80;
  return bytesToUuid(digest);
}

/** Пространства имён RFC 4122. */
export const UUID_NAMESPACE_DNS = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
export const UUID_NAMESPACE_URL = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';

/** Пространство имён выплат выводится детерминированно и не является магической константой. */
export const PAYOUT_NAMESPACE = uuid5(UUID_NAMESPACE_URL, 'https://sdelka.example/ns/payout');

/**
 * Ключ идемпотентности выплаты (FUNCTIONAL.md инвариант 13, STATE-MACHINES.md §1.5).
 * Аргумент ровно один: ни номера попытки, ни времени в ключе быть не может —
 * иначе повтор при потерянном ответе банка создаст вторую выплату.
 */
export function payoutIdempotencyKey(trancheId: string): string {
  return uuid5(PAYOUT_NAMESPACE, trancheId);
}

/**
 * Своё пространство имён у возврата покупателю. Возврат — **другой** перевод, а
 * не повтор расчёта: другой получатель (счёт-источник плательщика, красная
 * линия №9), другая сумма (брутто, без удержания) и другой момент.
 *
 * Общий ключ с расчётом был бы не экономией, а дырой: банк гасит по ключу, и
 * поручение на возврат, посланное после отклонённого расчёта, он вправе
 * посчитать повтором уже обработанного — то есть возврат тихо не уйдёт, а мы
 * будем считать, что ушёл. Обратный порядок ещё хуже.
 */
export const REFUND_NAMESPACE = uuid5(UUID_NAMESPACE_URL, 'https://sdelka.example/ns/refund');

/**
 * Ключ идемпотентности возврата покупателю.
 *
 * Аргумент ровно один — по той же причине, что у выплаты: номер попытки или
 * время в ключе означали бы, что повтор при потерянном ответе банка создаст
 * второй перевод (FUNCTIONAL.md инвариант 13, красная линия №8).
 */
export function refundIdempotencyKey(trancheId: string): string {
  return uuid5(REFUND_NAMESPACE, trancheId);
}

/** Своё пространство имён у вывода со счёта клиента: у него нет транша. */
export const WITHDRAWAL_NAMESPACE = uuid5(
  UUID_NAMESPACE_URL,
  'https://sdelka.example/ns/withdrawal',
);

/**
 * Ключ идемпотентности вывода со счёта клиента (ROADMAP.md И12.2).
 *
 * Ключ по траншу здесь не годится: у вывода транша нет вовсе. Аргумент, как и у
 * выплаты, ровно один — ни попытки, ни времени: иначе повтор при потерянном
 * ответе банка создаст второй вывод (FUNCTIONAL.md инвариант 13).
 */
export function withdrawalIdempotencyKey(withdrawalId: string): string {
  return uuid5(WITHDRAWAL_NAMESPACE, withdrawalId);
}

/**
 * Своё пространство имён у заявки на сделку.
 *
 * Заявка деньгами не двигает и сделкой ещё не является — но ключ ей нужен по
 * той же причине, что и поручению: повтор отправки формы (двойной клик,
 * перезагрузка, повторная доставка запроса) обязан попасть в **ту же** строку, а
 * не завести вторую заявку с теми же персональными данными второй стороны.
 *
 * Общее пространство имён с выплатой было бы дырой того же рода, что у возврата:
 * ключ заявки и ключ поручения по одному и тому же входу совпали бы, а гасит
 * банк по ключу.
 *
 * Здесь, а не в слое приложения, ровно по той причине, по которой здесь лежат
 * три соседних: значение зеркалится перечнем схем чеканки `@sdelka/audit`
 * (`MINT_SCHEMES`), и сверяются они друг с другом в `@sdelka/e2e` — пакет
 * аудита зависимостей не берёт и держит собственную копию.
 */
export const DEAL_APPLICATION_NAMESPACE = uuid5(
  UUID_NAMESPACE_URL,
  'https://sdelka.example/ns/deal-application',
);

/**
 * Ключ идемпотентности заявки на сделку.
 *
 * Аргумент ровно один и времени в нём нет — по тому же доводу, что у выплаты:
 * момент в ключе означал бы, что двойной клик даёт две заявки. Что именно
 * подаётся входом (канонический вид намерения вместе с подавшим), решает слой
 * сценариев — домену состав намерения не известен и известен быть не должен.
 */
export function dealApplicationIdempotencyKey(canonicalIntent: string): string {
  return uuid5(DEAL_APPLICATION_NAMESPACE, canonicalIntent);
}
