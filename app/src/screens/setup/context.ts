import { createContext } from 'preact';
import type { SetupChecklist } from '../../../../src/setup/checklist';
export const SetupContext = createContext<{
  checklist?: SetupChecklist; refresh: () => void;
  running?: { id: string; executor: string }; setRunning: (id: string, executor: string) => void;
}>({ refresh: () => {}, setRunning: () => {} });
