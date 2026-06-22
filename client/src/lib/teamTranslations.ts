import { useLanguageStore } from '@/store/languageStore';
import type { Language } from '@/store/languageStore';

const teamTranslations: Record<string, { en: string; de: string }> = {
  'Algerie':            { en: 'Algeria',               de: 'Algerien' },
  'Argentina':          { en: 'Argentina',              de: 'Argentinien' },
  'Australia':          { en: 'Australia',              de: 'Australien' },
  'Belgia':             { en: 'Belgium',                de: 'Belgien' },
  'Bosnia-Hercegovina': { en: 'Bosnia and Herzegovina', de: 'Bosnien-Herzegowina' },
  'Brasil':             { en: 'Brazil',                 de: 'Brasilien' },
  'Canada':             { en: 'Canada',                 de: 'Kanada' },
  'Colombia':           { en: 'Colombia',               de: 'Kolumbien' },
  'Curaçao':            { en: 'Curaçao',                de: 'Curaçao' },
  'DR Kongo':           { en: 'DR Congo',               de: 'DR Kongo' },
  'Ecuador':            { en: 'Ecuador',                de: 'Ecuador' },
  'Egypt':              { en: 'Egypt',                  de: 'Ägypten' },
  'Elfenbenskysten':    { en: 'Ivory Coast',            de: 'Elfenbeinküste' },
  'England':            { en: 'England',                de: 'England' },
  'Frankrike':          { en: 'France',                 de: 'Frankreich' },
  'Ghana':              { en: 'Ghana',                  de: 'Ghana' },
  'Haiti':              { en: 'Haiti',                  de: 'Haiti' },
  'Irak':               { en: 'Iraq',                   de: 'Irak' },
  'Iran':               { en: 'Iran',                   de: 'Iran' },
  'Japan':              { en: 'Japan',                  de: 'Japan' },
  'Jordan':             { en: 'Jordan',                 de: 'Jordanien' },
  'Kapp Verde':         { en: 'Cape Verde',             de: 'Kap Verde' },
  'Kroatia':            { en: 'Croatia',                de: 'Kroatien' },
  'Marokko':            { en: 'Morocco',                de: 'Marokko' },
  'Mexico':             { en: 'Mexico',                 de: 'Mexiko' },
  'Nederland':          { en: 'Netherlands',            de: 'Niederlande' },
  'New Zealand':        { en: 'New Zealand',            de: 'Neuseeland' },
  'Norge':              { en: 'Norway',                 de: 'Norwegen' },
  'Panama':             { en: 'Panama',                 de: 'Panama' },
  'Paraguay':           { en: 'Paraguay',               de: 'Paraguay' },
  'Portugal':           { en: 'Portugal',               de: 'Portugal' },
  'Qatar':              { en: 'Qatar',                  de: 'Katar' },
  'Saudi-Arabia':       { en: 'Saudi Arabia',           de: 'Saudi-Arabien' },
  'Senegal':            { en: 'Senegal',                de: 'Senegal' },
  'Skottland':          { en: 'Scotland',               de: 'Schottland' },
  'Spania':             { en: 'Spain',                  de: 'Spanien' },
  'Sveits':             { en: 'Switzerland',            de: 'Schweiz' },
  'Sverige':            { en: 'Sweden',                 de: 'Schweden' },
  'Sør-Afrika':         { en: 'South Africa',           de: 'Südafrika' },
  'Sør-Korea':          { en: 'South Korea',            de: 'Südkorea' },
  'Tsjekkia':           { en: 'Czech Republic',         de: 'Tschechien' },
  'Tunisia':            { en: 'Tunisia',                de: 'Tunesien' },
  'Tyskland':           { en: 'Germany',                de: 'Deutschland' },
  'Tyrkia':             { en: 'Turkey',                 de: 'Türkei' },
  'Uruguay':            { en: 'Uruguay',                de: 'Uruguay' },
  'USA':                { en: 'USA',                    de: 'Amerika' },
  'Usbekistan':         { en: 'Uzbekistan',             de: 'Usbekistan' },
  'Østerrike':          { en: 'Austria',                de: 'Österreich' },
};

export function translateTeam(name: string | null | undefined, language: Language | string): string {
  if (!name) return '';
  if (language === 'no') return name;
  const entry = teamTranslations[name];
  if (!entry) return name;
  return entry[language as 'en' | 'de'] ?? name;
}

export function useTeamName() {
  const { language } = useLanguageStore();
  return { tn: (name: string | null | undefined) => translateTeam(name, language) };
}
