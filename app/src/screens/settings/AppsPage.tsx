import { useEffect, useState } from "preact/hooks";
import type { AppAddResult, AppStatus } from "../../../../src/apps/types";
import { appsPageView, type AppsCardLocalState, type AppsCardView } from "../../../../src/view-model/apps";
import { Page, Skeleton } from "../../ds/Patterns";
import { DensityContext } from "../../ds/Density";
import { Pill } from "../../ds/Pill";
import { Button, ButtonLink } from "../../ds/Button";
import { Disclosure } from "../../ds/Controls";
import { Icon } from "../../ds/icons";
import { ActionMenu } from "../../ds/ActionMenu";
import { useDialogs } from "../../ds/useDialogs";
import { PageHead } from "../../shell/slots";
import { ErrorMessage } from "../task-shared";
import { useResource, Feedback, useOperation } from "./shared";
import cssText from "./apps-settings.css" with { type: "text" };

const styled = new WeakSet<Document>();
function useAppsStyles() {
  useEffect(() => {
    if (styled.has(document)) return;
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(cssText);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    styled.add(document);
  }, []);
}

function GrantIcon({ path }: { path: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d={path} />
    </svg>
  );
}

function AppsCard({
  card,
  busy,
  onAdd,
  onAllow,
  onCancel,
  onCheck,
  onOpen,
  onUpdate,
  onRemove,
}: {
  card: AppsCardView;
  busy: boolean;
  onAdd: () => void;
  onAllow: () => void;
  onCancel: () => void;
  onCheck: () => void;
  onOpen: () => void;
  onUpdate: () => void;
  onRemove: () => void;
}) {
  return (
    <article
      className={`pc-apps-card${card.cardTone === "warn" ? " pc-apps-card--warn" : ""}${card.cardTone === "bad" ? " pc-apps-card--bad" : ""}`}
      aria-label={card.name}
    >
      <span className="pc-apps-card__icon" aria-hidden="true">
        <Icon name="panel-right" />
      </span>
      <div className="pc-apps-card__copy">
        <div className="pc-apps-card__name">
          <b>{card.name}</b>
          {card.hostVersion && <span className="pc-settings-board__caption">{card.hostVersion}</span>}
          {card.pill && <Pill tone={card.pill.tone}>{card.pill.label}</Pill>}
        </div>
        <p className="pc-apps-card__description">{card.description}</p>
        <div className="pc-apps-tags">
          <span className="pc-settings-board__caption">Adds</span>
          {card.additions.map((text) => (
            <span key={text} className="pc-apps-tag">{text}</span>
          ))}
        </div>

        {card.phase === "not_found" && (
          <span className="pc-settings-board__caption">pacer can't find Orca on this Mac. Install it, open it once, then check again.</span>
        )}
        {card.phase === "missing_files" && card.error && (
          <span className="pc-settings-board__caption">{card.error}</span>
        )}
        {(card.phase === "added" || card.phase === "update") && card.whereToFind && (
          <span className="pc-settings-board__caption">{card.whereToFind}</span>
        )}

        {card.phase === "approving" && card.grants && (
          <div role="group" aria-labelledby={`apps-grants-${card.id}`} className="pc-apps-grants">
            <b id={`apps-grants-${card.id}`}>Orca will let pacer:</b>
            <ul className="pc-apps-grants__list">
              {card.grants.map((g) => (
                <li key={g.kind}>
                  <GrantIcon path={g.icon} />
                  <span className="pc-apps-grants__text">
                    <span>{g.what}</span>
                    <span className="pc-settings-board__caption">{g.why}</span>
                  </span>
                </li>
              ))}
            </ul>
            <span className="pc-settings-board__caption">You can remove it at any time, here or in Orca's settings.</span>
            <span className="pc-apps-grants__actions">
              <Button variant="primary" size="sm" disabled={busy} onClick={onAllow}>Allow and add</Button>
              <Button size="sm" disabled={busy} onClick={onCancel}>Cancel</Button>
            </span>
          </div>
        )}

        {card.phase === "failed" && (
          <>
            <p role="status" className="pc-apps-error">Orca didn't add pacer: {card.error}</p>
            {card.terminalCommands && (
              <Disclosure className="pc-apps-terminal" summary="Add it from a terminal instead">
                <ol className="pc-apps-terminal__steps">
                  <li>
                    <span>Run this. Orca prints what pacer may do and a fingerprint.</span>
                    <code>{card.terminalCommands.install}</code>
                  </li>
                  <li>
                    <span>If you agree, run it again with that fingerprint.</span>
                    <code>{card.terminalCommands.approve}</code>
                  </li>
                </ol>
              </Disclosure>
            )}
          </>
        )}

        {card.oldPlugin && (
          <div role="note" className="pc-apps-note">
            <span className="pc-apps-note__mark" aria-hidden="true">◐</span>
            <span className="pc-apps-note__body">
              <b>An older pacer plugin is still in Orca</b>
              <span className="pc-settings-board__caption">It came from the retired marketplace and no longer works. Remove "lamtuanvu.pacer" in Orca's Settings › Plugins so you see one pacer panel.</span>
            </span>
          </div>
        )}
      </div>

      <div className="pc-apps-card__actions">
        {card.phase === "not_found" && (
          <span className="pc-apps-card__actions-row">
            {card.getUrl && <ButtonLink size="sm" href={card.getUrl} target="_blank" rel="noreferrer">Get Orca</ButtonLink>}
            <Button size="sm" disabled={busy} onClick={onCheck}>Check again</Button>
          </span>
        )}
        {card.phase === "ready" && (
          <Button variant="primary" size="sm" disabled={busy} onClick={onAdd}>Add to Orca</Button>
        )}
        {card.phase === "failed" && (
          <Button size="sm" disabled={busy} onClick={onAdd}>Try again</Button>
        )}
        {(card.phase === "added" || card.phase === "update") && (
          <span className="pc-apps-card__actions-row">
            {card.phase === "update" && card.updateLabel && (
              <Button size="sm" disabled={busy} onClick={onUpdate}>{card.updateLabel}</Button>
            )}
            <Button variant="primary" size="sm" disabled={busy} onClick={onOpen}>Open in Orca</Button>
            <ActionMenu
              label={`More actions for ${card.name}`}
              items={[{ label: "Remove from Orca", onSelect: onRemove }]}
            />
          </span>
        )}
      </div>
    </article>
  );
}

export function AppsPage({ initialData }: { initialData?: { apps: AppStatus[] } }) {
  useAppsStyles();
  const resource = useResource<{ apps: AppStatus[] }>("apps.list", {}, initialData);
  const [local, setLocal] = useState<Record<string, AppsCardLocalState>>({});
  const action = useOperation(undefined, { notifySuccess: false });
  const dialogs = useDialogs();
  const page = appsPageView(resource.data?.apps ?? [], local);

  function clearLocal(id: string) {
    setLocal((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  function handleAddResult(id: string, data: AppAddResult) {
    if (data.status === "approval_required") {
      setLocal((prev) => ({ ...prev, [id]: { approval: { fingerprint: data.fingerprint, grants: data.grants } } }));
      return;
    }
    if (data.status === "error") {
      setLocal((prev) => ({ ...prev, [id]: { error: data.error } }));
      return;
    }
    clearLocal(id);
    resource.reload();
  }

  async function add(id: string, approve?: string) {
    await action.run("apps.add", { id, ...(approve ? { approve } : {}) }, (data: AppAddResult) => handleAddResult(id, data));
  }

  async function update(id: string) {
    await action.run("apps.update", { id }, (data: AppAddResult) => handleAddResult(id, data));
  }

  async function remove(id: string, name: string) {
    if (!(await dialogs.confirm(`Remove pacer from ${name}? You can add it again later.`, `Remove from ${name}`, "Remove"))) return;
    await action.run("apps.remove", { id }, () => {
      clearLocal(id);
      resource.reload();
    });
  }

  return (
    <DensityContext.Provider value="settings">
      <PageHead>
        <header className="pc-settings-board__header">
          <h1>Apps</h1>
          <p>Show pacer inside the apps you work in. Each app says what it lets pacer do before anything is added.</p>
        </header>
      </PageHead>
      <Page width="full" className="u3-settings u3-settings-page">
        <div className="pc-settings-board pc-apps-settings">
          <span id="apps-available-label" className="pc-settings-board__label">{resource.data ? page.availableLabel : "Available · …"}</span>
          <section aria-labelledby="apps-available-label" className="pc-apps-list">
            {!resource.data && !resource.error && <Skeleton layout="settings" label="Loading apps…" />}
            <ErrorMessage error={resource.error} />
            {page.cards.map((card) => (
              <AppsCard
                key={card.id}
                card={card}
                busy={!!action.busy}
                onAdd={() => void add(card.id)}
                onAllow={() => card.fingerprint && void add(card.id, card.fingerprint)}
                onCancel={() => clearLocal(card.id)}
                onCheck={() => { clearLocal(card.id); resource.reload(); }}
                onOpen={() => void action.run("apps.open", { id: card.id })}
                onUpdate={() => void update(card.id)}
                onRemove={() => void remove(card.id, card.name)}
              />
            ))}
          </section>
          <span className="pc-settings-board__caption">{page.trustCaption}</span>
          <Feedback action={action} />
          {dialogs.dialog}
        </div>
      </Page>
    </DensityContext.Provider>
  );
}
