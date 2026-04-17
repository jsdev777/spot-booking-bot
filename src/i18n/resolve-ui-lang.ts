/** Default UI language; must match `I18nModule` `fallbackLanguage` and rules fallback in `resolveCommunityRulesText`. */
export const UI_FALLBACK_LANGUAGE = 'ua' as const;

export function resolveUiLang(languageId: string | null | undefined): string {
  if (languageId != null && languageId.length > 0) {
    return languageId;
  }
  return UI_FALLBACK_LANGUAGE;
}
