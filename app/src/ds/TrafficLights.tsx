import type { JSX } from "preact";

export interface TrafficLightsProps {
  /** Show the three controls (window running in Tauri). When false, renders no controls. */
  desktop: boolean;
  onClose?: () => void;
  onMinimize?: () => void;
  onMaximize?: () => void;
}

/**
 * macOS-style window controls for a custom (undecorated) titlebar.
 * Renders the three rounded "traffic light" buttons; when `desktop` is false it
 * renders no controls. The shell omits this component in a regular browser.
 */
export function TrafficLights({
  desktop,
  onClose,
  onMinimize,
  onMaximize,
}: TrafficLightsProps): JSX.Element {
  return (
    <div className="pc-traffic" aria-hidden={!desktop}>
      {desktop && (
        <>
          <button
            type="button"
            className="pc-traffic__btn pc-traffic__btn--close"
            onClick={onClose}
            aria-label="Close"
            title="Close"
          />
          <button
            type="button"
            className="pc-traffic__btn pc-traffic__btn--min"
            onClick={onMinimize}
            aria-label="Minimize"
            title="Minimize"
          />
          <button
            type="button"
            className="pc-traffic__btn pc-traffic__btn--zoom"
            onClick={onMaximize}
            aria-label="Zoom"
            title="Zoom"
          />
        </>
      )}
    </div>
  );
}