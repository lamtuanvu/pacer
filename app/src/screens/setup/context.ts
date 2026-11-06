import { createContext } from 'preact';
import type { SetupChecklist } from '../../../../src/setup/checklist';
import type { SetupHealthSummary } from './SetupHealthGate';
export const SetupContext = createContext<{
  checklist?: SetupChecklist; refresh: () => void;
  running?: { id: string; executor: string }; setRunning: (id: string, executor: string) => void;
  health?: SetupHealthSummary | null;
  reopenHealth?: () => void;
}>({ refresh: () => {}, setRunning: () => {} });
