import { resolveUiLang, UI_FALLBACK_LANGUAGE } from './resolve-ui-lang';

describe('resolveUiLang', () => {
  it('returns ua for null and empty', () => {
    expect(resolveUiLang(null)).toBe(UI_FALLBACK_LANGUAGE);
    expect(resolveUiLang(undefined)).toBe(UI_FALLBACK_LANGUAGE);
    expect(resolveUiLang('')).toBe(UI_FALLBACK_LANGUAGE);
  });

  it('returns the given language id', () => {
    expect(resolveUiLang('en')).toBe('en');
    expect(resolveUiLang('pl')).toBe('pl');
  });
});
