import { useLanguageStore } from '@/store/languageStore';
import type { Language } from '@/store/languageStore';

const teamTranslations: Record<string, { en: string; de: string }> = {
  'Algerie':            { en: 'Algeria',               de: 'Algerien (Sahara dort)' },
  'Argentina':          { en: 'Argentina',              de: 'Argentinien (Messi-Heimat)' },
  'Australia':          { en: 'Australia',              de: 'Australien (alles tötet dich dort)' },
  'Belgia':             { en: 'Belgium',                de: 'Belgien (Pommes-Frites-Erfinder!)' },
  'Bosnia-Hercegovina': { en: 'Bosnia and Herzegovina', de: 'Bosnien-Herzegowina (langer Name!)' },
  'Brasil':             { en: 'Brazil',                 de: 'Brasilien (Samba! Samba!)' },
  'Canada':             { en: 'Canada',                 de: 'Kanada (sehr kalt, viel Ahornsirup)' },
  'Colombia':           { en: 'Colombia',               de: 'Kolumbien (guter Kaffee)' },
  'Curaçao':            { en: 'Curaçao',                de: 'Curaçao (blaues Cocktailgetränk)' },
  'DR Kongo':           { en: 'DR Congo',               de: 'DR Kongo (sehr groß)' },
  'Ecuador':            { en: 'Ecuador',                de: 'Ecuador (am Äquator, logisch)' },
  'Egypt':              { en: 'Egypt',                  de: 'Ägypten (mit Pyramiden)' },
  'Elfenbenskysten':    { en: 'Ivory Coast',            de: 'Elfenbeinküste (Elefantenzähne?)' },
  'England':            { en: 'England',                de: 'England (erfanden Fußball und verlieren seitdem)' },
  'Frankrike':          { en: 'France',                 de: 'Frankreich (Baguette! Sacré bleu!)' },
  'Ghana':              { en: 'Ghana',                  de: 'Ghana' },
  'Haiti':              { en: 'Haiti',                  de: 'Haiti (Karibikinsel)' },
  'Irak':               { en: 'Iraq',                   de: 'Irak (früher Mesopotamien)' },
  'Iran':               { en: 'Iran',                   de: 'Iran (früher Persien)' },
  'Japan':              { en: 'Japan',                  de: 'Japan (Manga und Sushi)' },
  'Jordan':             { en: 'Jordan',                 de: 'Jordanien (nicht Michael Jordan)' },
  'Kapp Verde':         { en: 'Cape Verde',             de: 'Kap Verde (kleine Inseln)' },
  'Kroatia':            { en: 'Croatia',                de: 'Kroatien (Krawattenerfinder! Danke!)' },
  'Marokko':            { en: 'Morocco',                de: 'Marokko (sehr warm dort)' },
  'Nederland':          { en: 'Netherlands',            de: 'Niederlande (Tulpen! Käse! Fahrräder!)' },
  'New Zealand':        { en: 'New Zealand',            de: 'Neuseeland (Herr der Ringe-Land)' },
  'Norge':              { en: 'Norway',                 de: 'Norwegen (sehr kalt, viel Lachs)' },
  'Panama':             { en: 'Panama',                 de: 'Panama (der Hut!)' },
  'Paraguay':           { en: 'Paraguay',               de: 'Paraguay (wo ist das genau?)' },
  'Portugal':           { en: 'Portugal',               de: 'Portugal (Ronaldo kommt von hier)' },
  'Qatar':              { en: 'Qatar',                  de: 'Katar (heiß! sehr heiß!)' },
  'Saudi-Arabia':       { en: 'Saudi Arabia',           de: 'Saudi-Arabien (sehr viel Öl)' },
  'Senegal':            { en: 'Senegal',                de: 'Senegal' },
  'Skottland':          { en: 'Scotland',               de: 'Schottland (Männer in Röcken)' },
  'Spania':             { en: 'Spain',                  de: 'Spanien (Siesta und Fiesta!)' },
  'Sveits':             { en: 'Switzerland',            de: 'Schweiz (Käse-und-Schokolade-Land)' },
  'Sverige':            { en: 'Sweden',                 de: 'Schweden (IKEA-Fußballnation)' },
  'Tunisia':            { en: 'Tunisia',                de: 'Tunesien (in Afrika)' },
  'Tyskland':           { en: 'Germany',                de: 'Deutschland (wir sind das!! Hallo!!)' },
  'Tyrkia':             { en: 'Turkey',                 de: 'Türkei (nicht das Vogeltier!)' },
  'Uruguay':            { en: 'Uruguay',                de: 'Uruguay (auch wo bitte?)' },
  'USA':                { en: 'USA',                    de: 'Amerika (sehr laut und groß)' },
  'Usbekistan':         { en: 'Uzbekistan',             de: 'Usbekistan (sehr weit weg)' },
  'Østerrike':          { en: 'Austria',                de: 'Österreich (NICHT Deutschland! Bitte!)' },
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
