export interface UsageMeterProps { used: number; pace?: number | null; tone?: "good" | "warn" | "bad"; size?: "md" | "slim"; label?: string; className?: string }
const clamp = (n: number) => Math.max(0, Math.min(100, Number(n) || 0));
export function UsageMeter(props: UsageMeterProps) {
  const used = clamp(props.used), hasPace = props.pace !== undefined && props.pace !== null;
  const pace = hasPace ? clamp(props.pace!) : 0;
  const tone = props.tone || (used >= 97 ? "bad" : hasPace && used - pace > 10 ? "warn" : "good");
  const label = `${props.label || "Usage"} ${Math.round(used)} percent${hasPace ? `, pace ${Math.round(pace)} percent` : ""}`;
  return <div role="progressbar" aria-label={label} aria-valuenow={Math.round(used)} aria-valuemin={0} aria-valuemax={100} className={["pc-meter", props.size === "slim" && "pc-meter--slim", props.className].filter(Boolean).join(" ")}>
    <div className={`pc-meter__fill pc-meter__fill--${tone}`} style={{ width: `${used}%` }} />
    {hasPace && <div className="pc-meter__pace" style={{ left: `calc(${pace}% - 1px)` }} />}
  </div>;
}
