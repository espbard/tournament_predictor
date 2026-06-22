import { useLanguageStore } from '@/store/languageStore';
import type { Language } from '@/store/languageStore';

const teamTranslations: Record<string, { en: string; de: string }> = {
  'Algerie':            { en: 'Algeria',               de: 'Sahara FC' },
  'Argentina':          { en: 'Argentina',              de: 'Hand-Gottes-FC' },
  'Australia':          { en: 'Australia',              de: 'Verkehrt herum' },
  'Belgia':             { en: 'Belgium',                de: 'Pommes-Erfinder' },
  'Bosnia-Hercegovina': { en: 'Bosnia and Herzegovina', de: 'Bindestrich-Nation' },
  'Brasil':             { en: 'Brazil',                 de: '1-7' },
  'Canada':             { en: 'Canada',                 de: 'Kaltes Amerika' },
  'Colombia':           { en: 'Colombia',               de: 'Kaffee-Republik' },
  'Curaçao':            { en: 'Curaçao',                de: 'Das ist ein Getränk' },
  'DR Kongo':           { en: 'DR Congo',               de: 'Das andere Kongo' },
  'Ecuador':            { en: 'Ecuador',                de: 'Wir sind der Äquator' },
  'Egypt':              { en: 'Egypt',                  de: 'Pharaonen FC' },
  'Elfenbenskysten':    { en: 'Ivory Coast',            de: 'Kein Elfenbein' },
  'England':            { en: 'England',                de: 'Elfmeterphobie' },
  'Frankrike':          { en: 'France',                 de: 'Froschesser' },
  'Ghana':              { en: 'Ghana',                  de: 'Freiwilligen-Land' },
  'Haiti':              { en: 'Haiti',                  de: 'Karibik-Traum' },
  'Irak':               { en: 'Iraq',                   de: 'Mesopotamien FC' },
  'Iran':               { en: 'Iran',                   de: 'Ehemals Persien' },
  'Japan':              { en: 'Japan',                  de: 'Trikot-Aufräumer' },
  'Jordan':             { en: 'Jordan',                 de: 'Petra FC' },
  'Kapp Verde':         { en: 'Cape Verde',             de: 'Welche Inseln?' },
  'Kroatia':            { en: 'Croatia',                de: 'Krawattenerfinder' },
  'Marokko':            { en: 'Morocco',                de: 'Maracas' },
  'Mexico':             { en: 'Mexico',                 de: 'Los Tacos' },
  'Nederland':          { en: 'Netherlands',            de: 'Wenn Deutschland netter wäre' },
  'New Zealand':        { en: 'New Zealand',            de: 'Hobbitland' },
  'Norge':              { en: 'Norway',                 de: 'Haalandia' },
  'Panama':             { en: 'Panama',                 de: 'Der Kanal' },
  'Paraguay':           { en: 'Paraguay',               de: 'Wo?' },
  'Portugal':           { en: 'Portugal',               de: 'Bacalhau' },
  'Qatar':              { en: 'Qatar',                  de: 'Klimaanlagen-WM' },
  'Saudi-Arabia':       { en: 'Saudi Arabia',           de: 'Petrodollar FC' },
  'Senegal':            { en: 'Senegal',                de: 'Mané-Schaft' },
  'Skottland':          { en: 'Scotland',               de: 'Dudelsack-Elf' },
  'Spania':             { en: 'Spain',                  de: 'Schläfrige Pässe' },
  'Sveits':             { en: 'Switzerland',            de: 'Neutral FC' },
  'Sverige':            { en: 'Sweden',                 de: 'Flaches Regal' },
  'Sør-Afrika':         { en: 'South Africa',           de: 'Vuvuzela-Republik' },
  'Sør-Korea':          { en: 'South Korea',            de: 'K-Pop FC' },
  'Tsjekkia':           { en: 'Czech Republic',         de: 'Besseres Bier' },
  'Tunisia':            { en: 'Tunisia',                de: 'Karthago FC' },
  'Tyskland':           { en: 'Germany',                de: 'Ostfrankreich' },
  'Tyrkia':             { en: 'Turkey',                 de: 'Nicht der Vogel' },
  'Uruguay':            { en: 'Uruguay',                de: 'Asado-Republik' },
  'USA':                { en: 'USA',                    de: 'Handegg-Weltmeister' },
  'Usbekistan':         { en: 'Uzbekistan',             de: 'Seidenstraße FC' },
  'Østerrike':          { en: 'Austria',                de: 'Nicht Deutschland' },
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
