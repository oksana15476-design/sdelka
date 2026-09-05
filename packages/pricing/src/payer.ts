import { PricingError, PricingErrorCode } from './errors';
import { RATE_SCALE_BP_NUMBER, assertBasisPoints } from './rate';

/**
 * Кто несёт комиссию платформы — **управляемая величина, а не следствие
 * конструкции расчёта** (E16-4, `SETTINGS.md` §В1).
 *
 * **Находка, которую это закрывает.** До сих пор плательщика комиссии не
 * существовало как величины вовсе: `settleTrancheToClientAccount` удерживает
 * комиссию из суммы транша, то есть её всегда нёс получатель, а экран владельца
 * показывал `feePayer: 'recipient', feePayerIsSetting: false`
 * (`apps/web/src/fixtures/owner.ts`) — то есть честно сообщал, что настройки
 * нет. Здесь она появляется.
 *
 * **Как это не трогает учёт.** Плательщик меняет не форму записи расчёта, а
 * **требуемую сумму транша**: комиссия одна и та же, а различаются брутто
 * (сколько обязан перевести покупатель) и нетто (сколько получит продавец) —
 * см. `quotation.ts`. Проводки при этом остаются ровно теми же, только с
 * другими суммами; ни одной новой строки, ни одного нового счёта.
 *
 * **Красная линия №2 держится по построению, а не проверкой.** Комиссия
 * покидает номинальный счёт в той же записи расчёта: `Дт transit:fee` на всю
 * её величину, `Кт bank:nominal` на брутто, `Дт bank:nominal` на нетто. Разница
 * брутто и нетто — это и есть комиссия, и без её дебета в транзит запись просто
 * не сойдётся повалютно (`@sdelka/ledger`, `assertBalanced`). Смена плательщика
 * двигает обе суммы **согласованно** — `брутто − нетто = комиссия` при любом из
 * трёх значений (свойство проверяется тестом `postings.test.ts`), поэтому пути,
 * на котором комиссия задержалась бы в файле транша на номинальном счёте, не
 * появляется: чтобы он появился, брутто должно перестать равняться сумме нетто
 * и комиссии, а тогда запись не соберётся вовсе.
 *
 * **Прилипает к созданию транша**, и по причине более жёсткой, чем у ставки:
 * плательщик меняет **требуемую сумму**, от которой зависят ступень утверждения,
 * база допуска и то, что показано покупателю до платежа. Менять его на живом
 * транше значит менять сумму, которую человек уже отправил (`SETTINGS.md` §В1
 * п.3, §8).
 *
 * ⚠ **[открыто] Правовая часть за нами не закреплена.** По `docs/research/TAX.md`
 * доля входного НДС подлежит вычету, только если плательщик комиссии —
 * покупатель-нерезидент; признаётся ли он «потребителем, учреждённым за
 * пределами Грузии», в документе помечено открытым. Здесь выражена только
 * механика; правовой вывод не наш (`DECISIONS-REVIEW.md` §J2).
 */
export const FEE_PAYERS = ['payer', 'recipient', 'split'] as const;

/**
 * `payer` — покупатель (тот, с чьей запертой части дебетуется брутто),
 * `recipient` — получатель, `split` — обе стороны в объявленных долях.
 *
 * Имена взяты у уже существующего перечня (`apps/web/src/fixtures/owner.ts`,
 * `FEE_PAYERS`) и у сторон расчёта в учёте (`TrancheSettlement.payer`,
 * `.recipient`), чтобы третьего словаря для одних и тех же двух людей не было.
 */
export type FeePayer = (typeof FEE_PAYERS)[number];

/**
 * Плательщик как величина. Размеченное объединение, а не строка с долями рядом:
 * доли существуют **только** у сплита, и «recipient с долей 40 %» не должно
 * собираться вовсе — иначе через полгода появится путь, на котором доли
 * прочитаны там, где их никто не заполнял.
 */
export type FeeBearing =
  | { readonly payer: 'payer' }
  | { readonly payer: 'recipient' }
  | {
      readonly payer: 'split';
      /** Доля покупателя в базисных пунктах. */
      readonly payerShareBp: number;
      /** Доля получателя в базисных пунктах. В сумме с долей покупателя — ровно 10 000. */
      readonly recipientShareBp: number;
    };

export function bornByRecipient(): FeeBearing {
  return Object.freeze({ payer: 'recipient' as const });
}

export function bornByPayer(): FeeBearing {
  return Object.freeze({ payer: 'payer' as const });
}

/**
 * Сплит: доли в сумме **ровно** 100 %.
 *
 * Не «примерно» и не «не больше»: недобор — это часть комиссии, которую не несёт
 * никто (молчаливая потеря выручки), перебор — часть, которую несут дважды
 * (молчаливый лишний рубль с клиентов). `SETTINGS.md` §9 п.8 требует ровного
 * равенства, и обе доли хранятся явно, а не «вторая = 10 000 − первая»: величина,
 * выведенная при чтении, теряется при первом же переносе через границу процесса.
 */
export function bornBySplit(payerShareBp: number, recipientShareBp: number): FeeBearing {
  assertBasisPoints(payerShareBp, 'payerShareBp');
  assertBasisPoints(recipientShareBp, 'recipientShareBp');
  if (payerShareBp + recipientShareBp !== RATE_SCALE_BP_NUMBER) {
    throw new PricingError(PricingErrorCode.splitSharesNotWhole, {
      payerShareBp: String(payerShareBp),
      recipientShareBp: String(recipientShareBp),
    });
  }
  return Object.freeze({ payer: 'split' as const, payerShareBp, recipientShareBp });
}

/**
 * Плательщик, пришедший из хранилища. Типы границу процесса не переживают, и
 * значение из колонки — это строка, а не член перечня.
 */
export function feeBearingFromStore(
  payer: string,
  shares: { readonly payerShareBp?: number; readonly recipientShareBp?: number } = {},
): FeeBearing {
  switch (payer) {
    case 'payer':
      return bornByPayer();
    case 'recipient':
      return bornByRecipient();
    case 'split': {
      const payerShareBp = shares.payerShareBp;
      const recipientShareBp = shares.recipientShareBp;
      if (payerShareBp === undefined || recipientShareBp === undefined) {
        // Сплит без долей — не «сплит пополам по умолчанию»: половина, взятая
        // молча, и есть та настройка, которой никто не выбирал.
        throw new PricingError(PricingErrorCode.splitSharesNotWhole, { payer });
      }
      return bornBySplit(payerShareBp, recipientShareBp);
    }
    default:
      throw new PricingError(PricingErrorCode.feePayerUnknown, { payer });
  }
}
