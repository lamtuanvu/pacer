import { useEffect, useRef, useState } from "preact/hooks";
import { Icon } from "../ds/icons";
import { Button, TextAction } from "../ds/Button"; // Button used in popup
import { Pill } from "../ds/Pill";
import { Tooltip } from "../ds/Tooltip";
import { useTaskContext } from "../screens/task-shared";
import { useResource, useOperation } from "../screens/settings/shared";
import type { StrategyRow } from "../model/strategy";
import type { ProjectStrategyView } from "../model/project-strategies";
import { routingContext, routingContextSummary } from "../model/strategy-quick-access";
import { routes, type Route, type RouteQuery } from "../router";
import { AppLink } from "../navigation";
import { SectionHeading } from "../ds/SectionHeading";

/**
 * Popup dialog for strategy quick access.
 * Similar to the tray's strategy switcher but context-aware.
 */
export function StrategyQuickAccessPopup({
  route,
  close,
}: {
  route: Route;
  close: () => void;
}) {
  const { state } = useTaskContext();

  // Fetch data we need
  const strategies = useResource<StrategyRow[]>("strategy.list", {});
  const projectOverrides = useResource<ProjectStrategyView[]>(
    "project.strategy.list",
    {}
  );
  const switchOp = useOperation();

  // Get context repo key (from query)
  const contextRepoKey = route.query.repo;

  // Determine effective routing context
  const knownRepos = (state.snapshot?.repos ?? []).map(r => ({
    key: r.key,
    label: r.label,
  }));

  // Find active strategy
  const activeStrategy =
    strategies.data?.find(s => s.active) ??
    strategies.data?.[0] ?? {
      name: "default",
      active: true,
      summary: "Global strategy",
    };

  const context = routingContext(
    contextRepoKey,
    knownRepos,
    projectOverrides.data ?? [],
    activeStrategy
  );

  const summary = routingContextSummary(context);

  // Close on escape
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [close]);

  // Focus first focusable element
  const firstFocusRef = useRef<HTMLAnchorElement | HTMLButtonElement>(null);
  useEffect(() => {
    firstFocusRef.current?.focus();
  }, []);

  // Handle click outside
  const onBackdropClick = (e: Event) => {
    if (e.target === e.currentTarget) close();
  };

  const switchStrategy = (name: string) => {
    switchOp.run("strategy.use", { name }, () => {
      strategies.reload();
    });
  };

  const allStrategies = strategies.data ?? [];

  return (
    <div
      className="pc-strategy-popup-backdrop"
      onClick={onBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-label="Routing & Strategy"
    >
      <div
        className="pc-strategy-popup"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="pc-strategy-popup__header">
          <SectionHeading>Routing & Strategy</SectionHeading>
          <Button variant="quiet" onClick={close} aria-label="Close">
            ✕
          </Button>
        </div>

        {/* Context summary */}
        <div className="pc-strategy-popup__summary">
          <div className="pc-strategy-popup__summary-row">
            <Icon name="layers" />
            <div className="pc-strategy-popup__summary-text">
              <strong>{summary.primary}</strong>
              <span className="u3-muted">{summary.secondary}</span>
            </div>
            {summary.badge && <Pill>{summary.badge}</Pill>}
          </div>

          {/* Show project override details when applicable */}
          {context.hasProjectOverride && context.projectPolicy && (
            <div className="pc-strategy-popup__project-order">
              <span className="u3-muted">Executor order for this repository:</span>
              <ol className="pc-strategy-popup__executors">
                {context.projectPolicy.executors.map((ref, i) => (
                  <li key={i} className="pc-strategy-popup__executor">
                    <span className="pc-strategy-popup__executor-order">
                      {i + 1}
                    </span>
                    <span className="mono">{ref}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>

        {/* Divider */}
        <div className="pc-strategy-popup__divider" />

        {/* Strategy switcher section */}
        <div className="pc-strategy-popup__section">
          <span className="u3-muted pc-strategy-popup__section-label">
            Global Strategy
          </span>
          <div className="pc-strategy-popup__strategies">
            {allStrategies.length > 0 ? (
              allStrategies.map(strategy => (
                <Button
                  key={strategy.name}
                  variant="ghost"
                  className={`pc-strategy-popup__strategy-item ${
                    strategy.active ? "pc-strategy-popup__strategy-item--active" : ""
                  }`}
                  disabled={switchOp.busy || strategy.active}
                  onClick={() => switchStrategy(strategy.name)}
                  ref={strategy.active ? undefined : ((el: HTMLButtonElement | null) => {
                    if (!firstFocusRef.current && el) firstFocusRef.current = el;
                  })}
                >
                  <span className="pc-strategy-popup__strategy-name">
                    {strategy.name}
                  </span>
                  <span className="u3-muted pc-strategy-popup__strategy-summary">
                    {strategy.summary}
                  </span>
                  {strategy.active && (
                    <span className="pc-strategy-popup__check" aria-hidden="true">
                      ✓
                    </span>
                  )}
                </Button>
              ))
            ) : (
              <span className="u3-muted">Loading strategies…</span>
            )}
          </div>
        </div>

        {/* Divider */}
        <div className="pc-strategy-popup__divider" />

        {/* Navigation links */}
        <div className="pc-strategy-popup__actions">
          <AppLink
            ref={el => {
              if (!firstFocusRef.current && el) firstFocusRef.current = el;
            }}
            to={routes.settings("routing")}
            query={route.query}
            onClick={close}
            className="pc-text-action"
          >
            <Icon name="routing" />
            Edit Routing Rules
          </AppLink>
          <AppLink
            to={routes.settings("strategies")}
            query={route.query}
            onClick={close}
            className="pc-text-action"
          >
            <Icon name="layers" />
            Manage Strategies
          </AppLink>
        </div>

        {/* Error/feedback */}
        {switchOp.error && (
          <div className="pc-strategy-popup__error" role="alert">
            {String(switchOp.error)}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Rail item for strategy/routing quick access.
 * Shows a tooltip with current status.
 * Click opens the popup.
 */
export function StrategyQuickAccess({
  route,
  query,
}: {
  route: Route;
  query: RouteQuery;
}) {
  const [popupOpen, setPopupOpen] = useState(false);

  // Check if we have repo context
  const hasRepoContext = query.repo !== null;

  // Tooltip text
  const tooltipText = hasRepoContext
    ? `Routing & Strategy · repo context: ${query.repo}`
    : "Routing & Strategy";

  return (
    <>
      <Tooltip text={tooltipText}>
        <button
          type="button"
          className="pc-rail__item"
          aria-label={tooltipText}
          aria-haspopup="dialog"
          aria-expanded={popupOpen}
          onClick={() => setPopupOpen(true)}
        >
          <Icon name="layers" />
          {hasRepoContext && (
            <span className="pc-rail__dot" aria-hidden="true" />
          )}
        </button>
      </Tooltip>

      {popupOpen && (
        <StrategyQuickAccessPopup
          route={route}
          close={() => setPopupOpen(false)}
        />
      )}
    </>
  );
}
