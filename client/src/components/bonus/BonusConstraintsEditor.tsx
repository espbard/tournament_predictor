import { EUROPEAN_COUNTRIES } from '@tournament-predictor/shared';
import { useT } from '@/lib/useT';
import type { Team } from '@tournament-predictor/shared';
import type { PanelAnswerType } from '@/components/bonus/BonusQuestionsPanel';

// ── What an admin may narrow about a question ─────────────────────────────────
//
// A number question can carry a range and a leeway; a player, team or country question can
// carry the list of answers to choose from. Everything here is optional — a question with
// none of it behaves exactly as it did before these existed.
//
// The rules themselves live in shared/src/live/bonus.ts. This only edits them.

/** The draft an admin is editing. Numbers are strings because the inputs hold text. */
export interface BonusConstraintsDraft {
  minValue: string;
  maxValue: string;
  leeway: string;
  options: string[];
}

export const EMPTY_CONSTRAINTS: BonusConstraintsDraft = {
  minValue: '',
  maxValue: '',
  leeway: '',
  options: [],
};

/** What the draft becomes on the wire. Blank means "no constraint", which is null. */
export function constraintsToPayload(draft: BonusConstraintsDraft, answerType: PanelAnswerType) {
  const num = (value: string) => (value.trim() === '' ? null : Number(value));
  const isNumber = answerType === 'number';
  const takesOptions = answerType === 'player' || answerType === 'team' || answerType === 'country';
  return {
    minValue: isNumber ? num(draft.minValue) : null,
    maxValue: isNumber ? num(draft.maxValue) : null,
    leeway: isNumber ? num(draft.leeway) : null,
    options: takesOptions && draft.options.length > 0 ? draft.options : null,
  };
}

export function constraintsFromQuestion(question: {
  minValue?: number | null;
  maxValue?: number | null;
  leeway?: number | null;
  options?: string[] | null;
}): BonusConstraintsDraft {
  return {
    minValue: question.minValue != null ? String(question.minValue) : '',
    maxValue: question.maxValue != null ? String(question.maxValue) : '',
    leeway: question.leeway != null ? String(question.leeway) : '',
    options: question.options ?? [],
  };
}

interface Props {
  answerType: PanelAnswerType;
  value: BonusConstraintsDraft;
  onChange: (next: BonusConstraintsDraft) => void;
  /** Teams of the tournament, for picking the options of a team question. */
  teams: Team[];
}

export default function BonusConstraintsEditor({ answerType, value, onChange, teams }: Props) {
  const { t } = useT();

  const set = (patch: Partial<BonusConstraintsDraft>) => onChange({ ...value, ...patch });

  if (answerType === 'yes_no') return null;

  if (answerType === 'number') {
    return (
      <div className="grid gap-3 rounded-md border border-dashed p-3 sm:grid-cols-3">
        <label className="text-sm">
          <span className="mb-1 block text-xs font-medium text-muted-foreground">
            {t('bonusQuestions.constraints.min')}
          </span>
          <input
            type="number"
            value={value.minValue}
            onChange={e => set({ minValue: e.target.value })}
            placeholder={t('bonusQuestions.constraints.noLimit')}
            className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-xs font-medium text-muted-foreground">
            {t('bonusQuestions.constraints.max')}
          </span>
          <input
            type="number"
            value={value.maxValue}
            onChange={e => set({ maxValue: e.target.value })}
            placeholder={t('bonusQuestions.constraints.noLimit')}
            className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-xs font-medium text-muted-foreground">
            {t('bonusQuestions.constraints.leeway')}
          </span>
          <input
            type="number"
            min={0}
            value={value.leeway}
            onChange={e => set({ leeway: e.target.value })}
            placeholder={t('bonusQuestions.constraints.exact')}
            className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </label>
        <p className="text-xs text-muted-foreground sm:col-span-3">
          {t('bonusQuestions.constraints.numberHint')}
        </p>
      </div>
    );
  }

  // player / team / country — the list of answers to choose from.
  const source: string[] =
    answerType === 'country'
      ? [...EUROPEAN_COUNTRIES]
      : answerType === 'team'
        ? teams.map(team => team.name)
        : [];
  const remaining = source.filter(option => !value.options.includes(option));

  return (
    <div className="space-y-2 rounded-md border border-dashed p-3">
      <p className="text-xs font-medium text-muted-foreground">
        {t('bonusQuestions.constraints.options')}
      </p>

      {value.options.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {value.options.map(option => (
            <li
              key={option}
              className="flex items-center gap-1 rounded-full border bg-muted px-2.5 py-1 text-xs"
            >
              {option}
              <button
                type="button"
                onClick={() => set({ options: value.options.filter(o => o !== option) })}
                aria-label={t('bonusQuestions.constraints.removeOption', { option })}
                className="text-destructive hover:text-destructive/80"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">{t('bonusQuestions.constraints.allOptions')}</p>
      )}

      {source.length > 0 ? (
        <select
          value=""
          onChange={e => {
            if (e.target.value) set({ options: [...value.options, e.target.value] });
          }}
          className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="">{t('bonusQuestions.constraints.addOption')}</option>
          {remaining.map(option => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      ) : (
        // A player question has no roster to pick from, so the names are typed.
        <PlayerOptionInput
          onAdd={name => {
            if (!value.options.includes(name)) set({ options: [...value.options, name] });
          }}
        />
      )}

      {value.options.length > 0 && (
        <button
          type="button"
          onClick={() => set({ options: [] })}
          className="text-xs text-muted-foreground underline-offset-2 hover:underline"
        >
          {t('bonusQuestions.constraints.clearOptions')}
        </button>
      )}
    </div>
  );
}

function PlayerOptionInput({ onAdd }: { onAdd: (name: string) => void }) {
  const { t } = useT();
  return (
    <form
      onSubmit={e => {
        e.preventDefault();
        const input = e.currentTarget.elements.namedItem('option') as HTMLInputElement;
        const name = input.value.trim();
        if (name) {
          onAdd(name);
          input.value = '';
        }
      }}
      className="flex gap-2"
    >
      <input
        name="option"
        type="text"
        placeholder={t('bonusQuestions.constraints.addPlayerOption')}
        className="flex-1 rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
      />
      <button type="submit" className="rounded-md border px-3 py-2 text-sm hover:bg-muted">
        {t('common.add')}
      </button>
    </form>
  );
}
