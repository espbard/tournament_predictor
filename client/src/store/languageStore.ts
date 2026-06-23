import { create } from 'zustand';

export type Language = 'no' | 'en' | 'de';

interface LanguageStore {
  language: Language;
  setLanguage: (lang: Language) => void;
}

const stored =
  typeof window !== 'undefined' ? (localStorage.getItem('language') as Language | null) : null;

export const useLanguageStore = create<LanguageStore>((set) => ({
  language: stored ?? 'no',
  setLanguage: (language) => {
    localStorage.setItem('language', language);
    set({ language });
  },
}));
