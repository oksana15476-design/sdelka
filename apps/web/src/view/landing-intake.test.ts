import { describe, expect, it } from 'vitest';
import { intakeState } from './landing-intake';

/**
 * Состояние приёма заявок — не оформление, а предохранитель: пока покрытие
 * клиентских средств нарушено, публичная форма обязана молчать, чем бы ни был
 * заполнен адрес (красная линия №3, `LANDING.md` §8 п. 6).
 */
describe('приём заявок на публичных страницах', () => {
  it('покрытие цело — форма открыта', () => {
    expect(intakeState(undefined, true)).toBe('open');
  });

  it('покрытие нарушено — форма закрыта, и адресом это не обходится', () => {
    expect(intakeState(undefined, false)).toBe('paused');
    expect(intakeState('sent', false)).toBe('paused');
  });

  it('состояния воспроизводятся ссылкой, как на остальных экранах', () => {
    expect(intakeState('sent', true)).toBe('sent');
    expect(intakeState('paused', true)).toBe('paused');
  });

  it('неизвестное значение в адресе не меняет положения', () => {
    expect(intakeState('whatever', true)).toBe('open');
  });
});
