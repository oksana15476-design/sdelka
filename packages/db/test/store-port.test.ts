import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Порт обязан оставаться портом.
 *
 * Утверждение «приложение не знает про SQL, база не знает про домен» держится
 * не комментарием в заголовке, а этой проверкой. Модуль порта объявляет
 * интерфейс над общим словарём — `@sdelka/ledger`, `@sdelka/domain`,
 * `@sdelka/audit`, `@sdelka/money`, — и не имеет права знать ни драйвера, ни
 * пула, ни единой строки SQL. Иначе «порт» превращается в имя файла.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = join(HERE, '..', 'src', 'store', 'port.ts');
const SOURCE = readFileSync(PORT, 'utf8');

/** Строки импорта: `from '…'`. */
function importsOf(source: string): readonly string[] {
  return [...source.matchAll(/from '([^']+)'/gu)].map((item) => item[1] ?? '');
}

const ALLOWED = new Set(['@sdelka/audit', '@sdelka/domain', '@sdelka/ledger', '@sdelka/money']);

describe('порт хранилища', () => {
  it('не знает ничего, кроме общего словаря', () => {
    const unexpected = importsOf(SOURCE).filter((item) => !ALLOWED.has(item));
    expect(unexpected).toEqual([]);
  });

  it('не содержит ни SQL, ни драйвера, ни пула, ни слоя приложения', () => {
    // Смотрим на код, а не на объяснение к нему: в комментариях `@sdelka/app`
    // как раз назван — там объяснено, почему ребра на него нет. Ребро цикла бы
    // не дало (`app` на `db` не ссылается), но перевернуло бы слои: зависимости
    // `db` — строгое подмножество зависимостей `app`, и такое ребро затащило бы
    // `@sdelka/compliance` и `@sdelka/oracle` в граф сборки команды
    // `pnpm db:migrate`, которой они не нужны ни одной строкой.
    const code = SOURCE.replace(/\/\*[\s\S]*?\*\//gu, ' ').replace(/\/\/[^\n]*/gu, ' ');
    expect(code).not.toContain('@sdelka/app');
    for (const forbidden of ['pg', './pool', 'PoolClient', 'client.query']) {
      expect(code, forbidden).not.toContain(forbidden);
    }
    for (const keyword of ['SELECT ', 'INSERT ', 'UPDATE ', 'sdelka.']) {
      expect(code, keyword).not.toContain(keyword);
    }
  });

  it('обещает ровно два исхода записи: появилось и уже лежало', () => {
    // Третьего исхода нет намеренно: строка под тем же ключом с другим
    // содержимым — не повтор, а конфликт, и он поднимает ошибку.
    expect(SOURCE).toContain('readonly written: number;');
    expect(SOURCE).toContain('readonly repeated: number;');
  });
});
