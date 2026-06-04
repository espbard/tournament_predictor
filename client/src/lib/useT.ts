import { useLanguageStore } from '@/store/languageStore';
import translations from '@/lib/translations';

export function useT() {
  const { language } = useLanguageStore();

  function t(key: string, vars?: Record<string, string | number>): string {
    const parts = key.split('.');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let val: any = (translations as any)[language];
    for (const p of parts) val = val?.[p];

    if (typeof val !== 'string') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let fallback: any = (translations as any).en;
      for (const p of parts) fallback = fallback?.[p];
      val = typeof fallback === 'string' ? fallback : key;
    }

    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        val = (val as string).replace(`{{${k}}}`, String(v));
      }
    }
    return val as string;
  }

  return { t, language };
}
