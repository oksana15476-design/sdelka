import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ENV_REGISTRY, envVariableNames } from '../src/registry.ts';
import { ENV_REFERENCE } from '../src/startup.ts';

/**
 * `.env.example` и перечень не расходятся.
 *
 * Пример окружения устаревает всегда: переменную заводят в коде и забывают
 * дописать, а разворачивающий читает файл и верит ему. Расхождение здесь —
 * не косметика: по неполному примеру разворачивают неполностью.
 */

const EXAMPLE_PATH = fileURLToPath(new URL(`../../../${ENV_REFERENCE}`, import.meta.url));
const EXAMPLE = readFileSync(EXAMPLE_PATH, 'utf8');

const ASSIGNMENTS = [...EXAMPLE.matchAll(/^([A-Z][A-Z0-9_]*)=(.*)$/gm)];
const HEADERS = new Map(
  [...EXAMPLE.matchAll(/^# ([A-Z][A-Z0-9_]*) (\[.+\])\s*$/gm)].map((match) => [
    match[1] as string,
    match[2] as string,
  ]),
);

describe('.env.example', () => {
  it('перечисляет ровно те переменные, что в перечне, и в том же порядке', () => {
    expect(ASSIGNMENTS.map((match) => match[1])).toEqual([...envVariableNames()]);
  });

  it('не содержит ни одного значения — красная линия №12', () => {
    for (const match of ASSIGNMENTS) expect(match[2], match[1]).toBe('');
  });

  it('у каждой переменной есть заголовок с пометкой обязательности', () => {
    for (const variable of ENV_REGISTRY) {
      const header = HEADERS.get(variable.name);
      expect(header, variable.name).toBeDefined();
      const expected = variable.necessity === 'required' ? '[обязательна]' : '[необязательна]';
      expect(header, variable.name).toContain(expected);
      // «обязательна» — подстрока «необязательна»: проверяем и обратное.
      if (variable.necessity === 'required') {
        expect(header, variable.name).not.toContain('[необязательна]');
      }
    }
  });

  it('секреты помечены секретами, несекреты — нет', () => {
    for (const variable of ENV_REGISTRY) {
      const header = HEADERS.get(variable.name) ?? '';
      expect(header.includes('[секрет]'), variable.name).toBe(variable.secret);
    }
  });

  it('у каждой переменной сказано, что будет, если не задана, и где взять значение', () => {
    const blocks = EXAMPLE.split(/^# (?=[A-Z][A-Z0-9_]* \[)/m).slice(1);
    expect(blocks.length).toBe(ENV_REGISTRY.length);
    for (const block of blocks) {
      const name = block.slice(0, block.indexOf(' '));
      expect(block, name).toContain('# Что это:');
      expect(block, name).toContain('# Если не задана:');
      expect(block, name).toContain('# Где взять:');
    }
  });
});
