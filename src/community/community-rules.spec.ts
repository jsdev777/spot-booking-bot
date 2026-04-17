import { resolveCommunityRulesText } from './community.service';

describe('resolveCommunityRulesText', () => {
  it('returns preferred language when present', () => {
    expect(
      resolveCommunityRulesText(
        [
          { languageId: 'ua', text: '  UA body  ' },
          { languageId: 'en', text: 'EN body' },
        ],
        'en',
      ),
    ).toBe('EN body');
  });

  it('falls back to Ukrainian when preferred is missing', () => {
    expect(
      resolveCommunityRulesText([{ languageId: 'ua', text: 'UA only' }], 'en'),
    ).toBe('UA only');
  });

  it('returns null when all texts are empty', () => {
    expect(
      resolveCommunityRulesText(
        [
          { languageId: 'ua', text: '   ' },
          { languageId: 'en', text: '' },
        ],
        'en',
      ),
    ).toBeNull();
  });

  it('uses first non-empty when Ukrainian is missing', () => {
    expect(
      resolveCommunityRulesText([{ languageId: 'en', text: 'Only EN' }], 'de'),
    ).toBe('Only EN');
  });
});
