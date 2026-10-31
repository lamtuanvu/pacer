import type { ComponentChildren } from "preact";
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { Button, IconButton } from "./Button";

/**
 * Collapsible frame column. Closed panels keep only a strip with the control that reopens them. The open and closed
 * toggles are different elements, so focus follows to the new one when the old one had it or the panel took it away.
 * With `contentToggle`, the owner renders the toggle with id `${id}-toggle` inside unpadded content; the closed strip remains.
 * With `bar={false}` alone the owner shows the toggle elsewhere (the title bar), and a closed panel renders nothing.
 */
export function SidePanel({ side, label, open, onToggle, bar = true, wide = false, contentToggle = false, resize, children }: {
  side: "left" | "right"; label: string; open: boolean; onToggle: (open: boolean) => void; bar?: boolean; wide?: boolean; contentToggle?: boolean; children?: ComponentChildren; resize?: {key:string;initial:number;min:number;max:number};
}) {
  const id = `pc-side-panel-${side}`;
  const clamp = (value:number) => resize ? Math.max(resize.min,Math.min(resize.max,value)) : value;
  const [width,setWidth] = useState(() => {try { const saved=resize&&localStorage.getItem(resize.key);return saved?clamp(Number(saved)||resize!.initial):resize?.initial; } catch {return resize?.initial;} });
  const panelElement=useRef<HTMLElement>(null);
  useLayoutEffect(()=>{if(resize&&width&&panelElement.current){panelElement.current.style.setProperty("--pc-panel-width",String(width));}},[resize?.key,width,open]);
  const drag=useRef<{x:number;width:number}>();
  const saveWidth=(value:number)=>{const next=clamp(value);setWidth(next);try{if(resize)localStorage.setItem(resize.key,String(next));}catch{}};

  const button = useRef<HTMLButtonElement>(null), clicked = useRef(false), first = useRef(true);
  useLayoutEffect(() => {
    if (first.current) { first.current = false; return; }
    const lost = document.activeElement === document.body || document.activeElement === null;
    if (clicked.current || lost) {
      const target = button.current ?? document.getElementById(`${id}-toggle`) ?? document.querySelector<HTMLButtonElement>(`.pc-layout-toggles [aria-label="Toggle ${side} panel"]`);
      if (target) target.focus();
      // The frame portal mounts the owner's toggle after the panel's content ref updates.
      else if (contentToggle) requestAnimationFrame(() => {
        if (document.activeElement === document.body) document.getElementById(`${id}-toggle`)?.focus();
      });
    }
    clicked.current = false;
  }, [open]);
  const toggle = <IconButton ref={button} size="sm" variant="quiet" icon={`panel-${side}`} aria-label={`${open ? "Hide" : "Show"} ${label}`}
    title={`${open ? "Hide" : "Show"} ${label}`} aria-expanded={open} aria-controls={open ? id : undefined}
    onClick={() => { clicked.current = true; onToggle(!open); }} />;
  if (!bar && !contentToggle && !open) return null;
  return open
    ? <aside className={`pc-side-panel pc-side-panel--${side}${wide ? " pc-side-panel--wide" : ""}`} aria-label={label} ref={panelElement}>
      {resize&&<Button className={`pc-panel-resize pc-panel-resize--${side}`} variant="quiet" role="separator" aria-orientation="vertical" aria-label={`Resize ${label}`} title={`Resize ${label}; arrow keys adjust, double-click resets`} aria-valuemin={resize.min} aria-valuemax={resize.max} aria-valuenow={width}
        onDblClick={()=>saveWidth(resize.initial)} onKeyDown={event=>{const direction=side==='left'?1:-1;const next=event.key==='ArrowLeft'?width!-16*direction:event.key==='ArrowRight'?width!+16*direction:event.key==='Home'?resize.min:event.key==='End'?resize.max:null;if(next!==null){event.preventDefault();saveWidth(next);}}}
        onPointerDown={event=>{event.preventDefault();drag.current={x:event.clientX,width:width??resize.initial};event.currentTarget.setPointerCapture(event.pointerId);}}
        onPointerMove={event=>{if(drag.current&&event.currentTarget.hasPointerCapture(event.pointerId))saveWidth(drag.current.width+(event.clientX-drag.current.x)*(side==='left'?1:-1));}}
        onPointerUp={event=>{drag.current=undefined;if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);}}/>}
      {bar && <div className="pc-side-panel__bar">{toggle}</div>}
      <div id={id} className={`pc-side-panel__content${contentToggle ? " pc-side-panel__content--flush" : ""}`}>{children}</div>
    </aside>
    : <div className={`pc-side-panel pc-side-panel--${side} pc-side-panel--closed`}>{toggle}</div>;
}
