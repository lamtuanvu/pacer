import { createContext, type ComponentChildren } from "preact";
import { useContext } from "preact/hooks";

export type Density = 'normal' | 'compact' | 'settings' | 'touch';
export const DensityContext = createContext<Density>('normal');
/** Responsive shell state is owned here so primitives never import their consumers. */
export const NarrowContext = createContext(false);
export function useDensity(): Density {
  const density = useContext(DensityContext);
  return useContext(NarrowContext) ? 'touch' : density;
}
export function DensityProvider({ value, children }: { value: Density; children: ComponentChildren }) {
  return <DensityContext.Provider value={value}><div className={`pc-density pc-density--${value}`}>{children}</div></DensityContext.Provider>;
}
