import { useEffect, useLayoutEffect, useState } from "preact/hooks";
import { markAgent } from "../../../../src/view-model/agents";
import { executorLabel } from "../../../../src/view-model/words";
import type { RouteQuery } from "../../router";
import { AgentMark } from "../../ds/AgentMark";
import { Button } from "../../ds/Button";
import { Field, TextArea, TextInput } from "../../ds/Controls";
import { Dialog } from "../../ds/Dialog";
import { Identicon } from "../../ds/Identicon";
import { Icon } from "../../ds/icons";
import { Card } from "../../ds/Patterns";
import { Pill } from "../../ds/Pill";
import { SectionHeading } from "../../ds/SectionHeading";
import { compareProfiles, joinNames, profileRowFacts, profileSide, type ProfileComparison, type ProfilePreview } from "../../model/dispatcher-hub";
import type { StrategyRow } from "../../model/strategy";
import { FrameSlot, useFrame } from "../../shell/slots";
import { ErrorMessage, useTaskContext } from "../task-shared";
import { DispatcherPreviewForm } from "./Dispatcher";
import { useDispatcherStyles } from "./dispatcher-styles";
import { Feedback, ResourceState, resourceRevision, useOperation, useResource } from "./shared";

const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
type Loaded = { key: string; comparison?: ProfileComparison; error?: unknown };

/**
 * Reads the active and the compared profile through strategy.preview (validates, writes nothing) and compares them.
 * Every "from" fact comes from the active profile's own preview. The key follows the profile list and every
 * invalidation the service publishes, so a change from any client recomputes it.
 */
function useComparison(active: string | undefined, target: string | undefined, signature: string): Loaded | undefined {
  const { api, state } = useTaskContext();
  const [loaded, setLoaded] = useState<Loaded>();
  const key = `${active}\n${target}\n${signature}\n${resourceRevision("strategy.preview", state.invalidations)}`;
  useEffect(() => {
    if (!active || !target || !state.features.ops.has("strategy.preview")) return;
    let live = true;
    const read = (name: string) => api.call<ProfilePreview>("strategy.preview", { draft: { from: name } });
    void Promise.all([read(active), read(target)]).then(([current, next]) => {
      if (!live) return;
      const from = profileSide(current), to = profileSide(next);
      if (!from) { setLoaded({ key, error: new Error(`The active profile, ${active}, could not be read${current.errors?.length ? `: ${current.errors.join(" ")}` : "."}`) }); return; }
      if (!to) { setLoaded({ key, error: new Error(`${target} could not be read${next.errors?.length ? `: ${next.errors.join(" ")}` : "."}`) }); return; }
      setLoaded({ key, comparison: compareProfiles({ active: from, target: to, label: id => executorLabel(id) }) });
    }, error => { if (live) setLoaded({ key, error }); });
    return () => { live = false; };
  }, [key, api]);
  return loaded?.key === key ? loaded : undefined;
}

/**
 * Dispatcher › Profiles: the saved profiles (switch with an explicit button), what switching to one changes
 * compared with the active profile (the shell's side panel, or in page when panels cannot show), creating one from
 * a brief and saving the current settings as a new one.
 */
export function DispatcherProfiles({ query: route, onActivated, initialData }: { query?: RouteQuery; onActivated?: () => void; initialData?: StrategyRow[] }) {
  useDispatcherStyles();
  const { state, api } = useTaskContext(), frame = useFrame();
  const query = useResource<StrategyRow[]>("strategy.list", {}, initialData), action = useOperation(query.reload);
  const rows = query.data ?? [];
  const active = rows.find(row => row.active);
  const [picked, setPicked] = useState<string>();
  const compared = rows.find(row => row.name === picked && !row.active) ?? rows.find(row => !row.active);
  const [building, setBuilding] = useState(false), [brief, setBrief] = useState("");
  const [saving, setSaving] = useState(false), [name, setName] = useState(""), [about, setAbout] = useState(""), [saveError, setSaveError] = useState<unknown>(), [savingBusy, setSavingBusy] = useState(false);
  const [trying, setTrying] = useState<string>();
  const comparison = useComparison(active?.name, compared?.name, JSON.stringify(rows));
  const canCompare = state.features.ops.has("strategy.preview");
  const canTry = state.features.ops.has("dispatch.explain") || state.features.ops.has("dispatch.preview");
  const side = !!frame?.right && !frame.inline;
  // The comparison belongs in the shell's side panel: open it once when the frame offers one.
  useLayoutEffect(() => { if (frame?.details && !frame.details.open && !frame.inline) frame.details.toggle(); }, [!!frame?.details]);
  const switchTo = (target: string) => void action.run("strategy.use", { name: target }, () => { setTrying(undefined); onActivated?.(); });
  const nameError = !name ? "" : !NAME.test(name) ? "Use lowercase letters, numbers and hyphens, starting with a letter or number."
    : name === "default" ? "default is protected; choose another name." : rows.some(row => row.name === name) ? "A profile with this name exists; choose another name." : "";
  const saveCurrent = async () => {
    if (!active || !name || nameError || savingBusy) return;
    setSavingBusy(true); setSaveError(undefined);
    try {
      await api.call("strategy.save", { name, draft: { from: active.name, ...(about.trim() ? { description: about.trim() } : {}) }, reason: about.trim() || "Saved the current settings as a profile" });
      setSaving(false); setName(""); setAbout(""); query.reload(); setPicked(name);
    } catch (failure) { setSaveError(failure); } finally { setSavingBusy(false); }
  };
  // An agent the snapshot knows by the summary's display name gets its mark.
  const markFor = (label: string) => state.snapshot?.executors?.find(row => executorLabel(row.id) === label);
  const about_ = (row: StrategyRow) => row.description && row.description !== row.summary ? row.description : undefined;
  const changes = comparison?.comparison?.changes ?? [];

  const panel = compared && <section className="pc-hub-compare pc-stack pc-stack--normal" aria-labelledby="profile-compare-h">
    <SectionHeading id="profile-compare-h">What switching to {compared.name} changes</SectionHeading>
    <Card tone="sunken" className="pc-hub-compare__card">
      {about_(compared) && <p className="pc-hub-compare__about">{about_(compared)}</p>}
      {!active ? <p role="status">No profile is active, so there is nothing to compare with. Switch to a profile first.</p>
        : !canCompare ? <p className="u3-muted">Update the service to compare profiles before switching.</p>
        : !comparison ? <p className="u3-muted" role="status">Reading {compared.name}…</p>
        : comparison.error ? <ErrorMessage error={comparison.error} />
        : <>
          {changes.length ? <dl className="pc-hub-diff">{changes.map(change => <div key={change.what} className="pc-hub-diff__row">
            <dt>{change.what}</dt>
            <dd><span className="pc-hub-diff__from">{change.from}</span><span className="pc-hub-diff__arrow" role="img" aria-label="becomes"><Icon name="chevron-right" /></span><span className="pc-hub-diff__to">{change.to}</span></dd>
          </div>)}</dl> : <p>Switching to {compared.name} changes nothing Pacer compares here.</p>}
          <p className="u3-muted">Unchanged: {joinNames(comparison.comparison!.unchanged)}.</p>
        </>}
      <div className="pc-hub-compare__actions">
        <Button size="sm" variant={changes.length ? "primary" : "secondary"} disabled={!!action.unavailable || action.busy} busy={action.busy} onClick={() => switchTo(compared.name)}>Switch to {compared.name}</Button>
        {canTry && <Button size="sm" variant="secondary" aria-expanded={trying === compared.name} aria-controls="dispatch-preview"
          onClick={() => setTrying(trying === compared.name ? undefined : compared.name)}>Try a task with it</Button>}
      </div>
    </Card>
    <p className="u3-muted">Running tasks keep their agent. New tasks use the profile from the moment you switch.</p>
  </section>;

  return <div className="pc-hub pc-stack pc-stack--section" id="saved-profiles">
    <div className="pc-hub-intro">
      <p>A profile stores the planner, pacing, the default and task-kind lists, the choice method, model sizes for each difficulty and each agent's models. Switching changes them together. Repository lists stay as they are.</p>
      <div className="pc-hub-intro__actions">
        <Button size="sm" variant="secondary" aria-expanded={building} onClick={() => setBuilding(value => !value)}>Create from a brief</Button>
        <Button size="sm" variant="secondary" disabled={!active} onClick={() => { setSaving(true); setSaveError(undefined); }}>Save current as a profile</Button>
      </div>
    </div>
    {building && <form className="pc-card pc-stack pc-stack--normal" onSubmit={event => { event.preventDefault(); void action.run("strategy.build", { brief }); }}>
      <Field label="What should this profile do?"><TextArea value={brief} maxLength={2000} required onInput={event => setBrief(event.currentTarget.value)} /></Field>
      <div><Button type="submit" disabled={!!action.unavailable || action.busy}>Build profile</Button></div>
      <p className="u3-muted">Opens a planning session that drafts a profile from your description, or returns a command to run. Nothing is switched until you review it here.</p>
    </form>}
    <section className="pc-stack pc-stack--normal" aria-labelledby="profiles-list-h">
      <SectionHeading id="profiles-list-h">Saved profiles{rows.length ? ` · ${rows.length}` : ""}</SectionHeading>
      <ResourceState resource={query} empty="No saved profiles yet.">
        <ul className="pc-hub-profiles">{rows.map(row => {
          const comparing = row.name === compared?.name, facts = profileRowFacts(row.summary), first = facts?.first ? markFor(facts.first) : undefined;
          return <li key={row.name} className={["pc-hub-profile", row.active && "pc-hub-profile--active", comparing && "pc-hub-profile--selected"].filter(Boolean).join(" ")}>
            <span className="pc-setup-icon"><Identicon seed={row.name} /></span>
            <span className="pc-hub-profile__text">
              <span className="pc-hub-profile__name"><code>{row.name}</code>{row.active && <Pill tone="good">Active</Pill>}{comparing && <Pill tone="info">Comparing</Pill>}</span>
              {about_(row) && <span>{about_(row)}</span>}
              {facts ? <span className="pc-hub-profile__facts">
                {facts.first && <span className="pc-hub-profile__first">First: {first && <AgentMark agent={markAgent(first.id, first.account)} size={16} labelled={false} />}{facts.first}</span>}
                <span>Planner keeps {facts.reserve}% back</span>
                <span>{facts.policy}</span>
              </span> : <span className="u3-muted">{row.summary}</span>}
            </span>
            {!row.active && <span className="pc-hub-profile__actions">
              {!comparing && canCompare && <Button size="sm" variant="quiet" aria-label={`Compare ${row.name}`} onClick={() => setPicked(row.name)}>Compare</Button>}
              {!comparing && <Button size="sm" variant="secondary" aria-label={`Switch to ${row.name}`} disabled={!!action.unavailable || action.busy} onClick={() => switchTo(row.name)}>Switch to it</Button>}
            </span>}
          </li>;
        })}</ul>
      </ResourceState>
      <Feedback action={action} />
    </section>
    <FrameSlot name="right">{side ? panel : null}</FrameSlot>
    {!side && panel}
    {trying && <DispatcherPreviewForm query={route ?? { repo: null, scope: null }} draft={{ from: trying }} focusOnMount draftNote={`Uses the ${trying} profile, not the active one.`} title={`Try a task with ${trying}`} />}
    {saving && <Dialog title="Save current as a profile" close={() => setSaving(false)}>
      <form className="pc-stack pc-stack--normal" onSubmit={event => { event.preventDefault(); void saveCurrent(); }}>
        <p className="u3-muted">Saves a copy of the active profile, {active?.name}, under a new name. The active profile stays as it is.</p>
        <Field label="Profile name" help="Lowercase letters, numbers and hyphens." error={nameError || undefined}><TextInput value={name} maxLength={40} autoFocus required disabled={savingBusy} onInput={event => setName(event.currentTarget.value)} /></Field>
        <Field label="What is it for?" help="Optional. Shown in the list."><TextInput value={about} maxLength={500} disabled={savingBusy} onInput={event => setAbout(event.currentTarget.value)} /></Field>
        <ErrorMessage error={saveError} />
        <div className="u3-actions">
          <Button variant="ghost" disabled={savingBusy} onClick={() => setSaving(false)}>Cancel</Button>
          <Button type="submit" variant="primary" busy={savingBusy} disabled={!name || !!nameError || savingBusy}>Save profile</Button>
        </div>
      </form>
    </Dialog>}
  </div>;
}
