import { describe, expect, it } from 'vitest';
import {
  AuthError,
  AuthErrorCode,
  CODE_KEY_MIN_LENGTH,
  CODE_PURPOSE_KEYS,
  type CodeDeliveryPort,
  type CodeDeliveryRequest,
  accountId,
  challengeId,
  deliveryFor,
  developmentCodeDelivery,
  isDeliveryMode,
  issueChallenge,
  resolveCodeDelivery,
} from '../src/index';
import { hmacCodeDerivation } from '../src/code';
import { NOW } from './support';

const CHALLENGE = issueChallenge({
  challengeId: challengeId('ch-1'),
  accountId: accountId('acc-party-1'),
  issuedAt: NOW,
});

const CODE = hmacCodeDerivation('k'.repeat(CODE_KEY_MIN_LENGTH)).codeFor(CHALLENGE);

const REQUEST: CodeDeliveryRequest = deliveryFor(
  CHALLENGE,
  CODE,
  CODE_PURPOSE_KEYS.signIn,
  'ka-GE',
);

function recorder(): { readonly port: CodeDeliveryPort; readonly seen: CodeDeliveryRequest[] } {
  const seen: CodeDeliveryRequest[] = [];
  return {
    seen,
    port: {
      deliver(request: CodeDeliveryRequest): Promise<void> {
        seen.push(request);
        return Promise.resolve();
      },
    },
  };
}

describe('порт без адаптера отказывает на старте', () => {
  it('боевой режим без адаптера не поднимается', () => {
    // Ворота: пока боевого адаптера нет, приложение в боевом режиме не встаёт.
    // Тихий откат к печати кода в журнал — это дыра, которую не видно.
    try {
      resolveCodeDelivery({ mode: 'production', adapter: null, sink: () => {} });
      expect.unreachable('боевой режим без канала обязан отказать');
    } catch (error) {
      expect(error).toBeInstanceOf(AuthError);
      expect((error as AuthError).code).toBe(AuthErrorCode.codeDeliveryAdapterMissing);
    }
  });

  it('отладочный канал в боевом режиме не собирается вовсе', () => {
    expect(() => developmentCodeDelivery(() => {}, 'production')).toThrow(AuthError);
  });

  it('боевой режим с адаптером поднимается и зовёт адаптер', async () => {
    const { port, seen } = recorder();
    const resolved = resolveCodeDelivery({ mode: 'production', adapter: port, sink: () => {} });
    await resolved.deliver(REQUEST);
    expect(seen).toEqual([REQUEST]);
  });
});

describe('отладочный канал разработки', () => {
  it('код уходит в журнал процесса — и это годится только в разработке', async () => {
    const lines: string[] = [];
    const port = resolveCodeDelivery({
      mode: 'development',
      adapter: null,
      sink: (line) => lines.push(line),
    });
    await port.deliver(REQUEST);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(CODE);
    expect(lines[0]).toContain(CODE_PURPOSE_KEYS.signIn);
  });
});

describe('запрос доставки', () => {
  it('несёт ключ назначения, а не текст: три языка', () => {
    expect(REQUEST.purposeKey).toBe(CODE_PURPOSE_KEYS.signIn);
    expect(REQUEST.locale).toBe('ka-GE');
  });

  it('адреса получателя в запросе нет — его знает адаптер, а не решение', () => {
    expect(Object.keys(REQUEST).sort()).toEqual([
      'accountId',
      'challengeId',
      'code',
      'expiresAt',
      'locale',
      'purposeKey',
    ]);
  });

  it('режим — закрытый перечень, «как-нибудь» у канала входа не бывает', () => {
    expect(isDeliveryMode('production')).toBe(true);
    expect(isDeliveryMode('development')).toBe(true);
    expect(isDeliveryMode('prod')).toBe(false);
    expect(isDeliveryMode('')).toBe(false);
  });
});
