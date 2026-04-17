import { Test, TestingModule } from '@nestjs/testing';
import * as path from 'node:path';
import { HeaderResolver, I18nModule, I18nService } from 'nestjs-i18n';
import {
  createBotLabels,
  durationMinutesFromReplyLabel,
} from './bot-i18n.labels';

describe('createBotLabels', () => {
  let i18n: I18nService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        {
          ...I18nModule.forRoot({
            fallbackLanguage: 'ua',
            loaderOptions: {
              path: path.join(__dirname, '..', 'i18n'),
              watch: false,
            },
            resolvers: [{ use: HeaderResolver, options: ['x-test-lang'] }],
            disableMiddleware: true,
            logging: false,
          }),
          global: true,
        },
      ],
    }).compile();
    i18n = module.get(I18nService);
  });

  it('uses the same menu.book string for ua as the historical reply keyboard label', () => {
    const lbl = createBotLabels(i18n, 'ua');
    expect(lbl.menuBook).toBe('Забронювати');
  });

  it('exposes English menu labels for en', () => {
    const lbl = createBotLabels(i18n, 'en');
    expect(lbl.menuBook).toBe('Book');
    expect(lbl.menuMain).toBe('Main menu');
  });

  it('localizes change-language button per membership language', () => {
    expect(createBotLabels(i18n, 'ua').menuChangeLanguage).toBe('Змінити мову');
    expect(createBotLabels(i18n, 'en').menuChangeLanguage).toBe(
      'Change language',
    );
  });

  it('maps English duration reply labels to minutes like the booking handler', () => {
    const lbl = createBotLabels(i18n, 'en');
    expect(durationMinutesFromReplyLabel(lbl, lbl.duration1h)).toBe(60);
    expect(durationMinutesFromReplyLabel(lbl, lbl.duration90m)).toBe(90);
    expect(durationMinutesFromReplyLabel(lbl, lbl.duration2h)).toBe(120);
    expect(durationMinutesFromReplyLabel(lbl, '1 г')).toBeUndefined();
  });

  it('maps Ukrainian duration reply labels to minutes', () => {
    const lbl = createBotLabels(i18n, 'ua');
    expect(durationMinutesFromReplyLabel(lbl, lbl.duration1h)).toBe(60);
  });
});
