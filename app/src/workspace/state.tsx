import { createContext } from 'preact';
import { useContext, useLayoutEffect, useState } from 'preact/hooks';
import { workspaceKey, workspaceManager } from './manager';
export const WorkspaceIdentity = createContext('pending');
export const WorkspaceScope = createContext<string | null>(null);
export const ViewActive = createContext(true);
export const useViewActive = () => useContext(ViewActive);
export function useWorkspaceKey(task?: string, section?: string) { const identity = useContext(WorkspaceIdentity), scope = useContext(WorkspaceScope); return section ? workspaceKey(identity, task, section) : task ? workspaceKey(identity, task, scope ? JSON.parse(scope)[2] : 'workspace') : scope ?? workspaceKey(identity); }
export function useWorkspaceState<T>(key: string, field: string, initial: T) {
 const [, update] = useState(0);
 useLayoutEffect(() => workspaceManager.subscribe(key, field, () => update(n => n + 1)), [key, field]);
 const set = (value: T | ((previous: T) => T)) => workspaceManager.set(key, field, typeof value === 'function' ? (value as (previous: T) => T)(workspaceManager.get(key, field, initial)) : value);
 return [workspaceManager.get(key, field, initial), set] as const;
}
