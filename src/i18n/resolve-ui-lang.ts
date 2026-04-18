/** Default UI language; must match `I18nModule` `fallbackLanguage` and rules fallback in `resolveCommunityRulesText`. */
export const UI_FALLBACK_LANGUAGE = 'ua' as const;

/**
 * Copy for the first-time language prompt when the user has no stored locale yet.
 * Keeps onboarding from defaulting to `UI_FALLBACK_LANGUAGE` before they choose.
 */
export const UI_LANGUAGE_PROMPT_NEUTRAL_LANG = 'en' as const;

export function resolveUiLang(languageId: string | null | undefined): string {
  if (languageId != null && languageId.length > 0) {
    return languageId;
  }
  return UI_FALLBACK_LANGUAGE;
}
