// Settings › Add executor, step 2 for OpenCode: pick a detected provider, accept a model, optionally cap spend.
import { useState } from "preact/hooks";
import type { Candidate, Detection } from "../../../../src/endpoints/detect";
import type { ModelChoice, UsageClass } from "../../../../src/endpoints/recommend";
import { Button } from "../../ds/Button";
import { Select, TextInput } from "../../ds/Controls";
import { ChoiceCard } from "../../ds/Patterns";
import { Pill } from "../../ds/Pill";
import { SectionHeading } from "../../ds/SectionHeading";
import { addParams, GROUP_TITLES, groupCandidates, modelFacts, searchCandidates, usagePill } from "../../model/opencode-setup";
import { Feedback, Field, ResourceState, useOperation, useResource } from "./shared";

interface ModelsResult { pick: ModelChoice | null; rest: ModelChoice[]; usage: UsageClass; note?: string }

export interface OpencodeSetupProps {
  /** Called with the new account name once the account and its executor exist. */
  onCreated: (name: string) => void;
  onUseUrl: () => void;
  initialDetection?: Detection;
  initialChoice?: Candidate;
  initialModels?: ModelsResult;
}

export function OpencodeSetup({ onCreated, onUseUrl, initialDetection, initialChoice, initialModels }: OpencodeSetupProps) {
  const detection = useResource<Detection>("executor.setup.candidates", {}, initialDetection);
  const [choice, setChoice] = useState<Candidate | undefined>(initialChoice);
  const [query, setQuery] = useState("");
  const candidates = detection.data?.candidates ?? [];

  const card = (c: Candidate) => {
    const pill = usagePill(c.usage);
    return <ChoiceCard className="u3-choice" key={`${c.group}:${c.provider}`} disabled={!!c.added} aria-pressed={choice?.provider === c.provider && choice.group === c.group}
      onClick={() => setChoice(c)}>
      <div>
        <strong>{c.name}</strong>
        {c.group === "local" && <div className="u3-muted">{c.base_url} · {c.models ?? 0} models</div>}
        <Pill tone={pill.tone}>{pill.label}</Pill>
        {c.added && <div className="u3-muted">Added as {c.added}</div>}
      </div>
    </ChoiceCard>;
  };

  return <div className="pc-card">
    <ResourceState resource={detection}>
      {(detection.data?.notes ?? []).map(note => <p className="u3-muted" key={note}>{note}</p>)}
      {groupCandidates(candidates).map(([group, list]) => <div className="u3-section" key={group}>
        <SectionHeading as="h3">{GROUP_TITLES[group]}</SectionHeading>
        {group === "catalog" && <Field label="Search providers" help="OpenCode stores the key; pacer never sees it.">
          <TextInput value={query} placeholder="e.g. deepseek" onInput={e => setQuery(e.currentTarget.value)} />
        </Field>}
        <div className="u3-choices">{(group === "catalog" ? searchCandidates(list, query) : list).map(card)}</div>
      </div>)}
      {!candidates.length && <p>No providers or local model servers found.</p>}
    </ResourceState>
    {choice?.group === "catalog" && <ConnectProvider key={choice.provider} provider={choice.provider} onRefresh={() => { setChoice(undefined); detection.reload(); }} />}
    {choice && choice.group !== "catalog" && <ModelStep key={`${choice.group}:${choice.provider}`} candidate={choice} initialModels={initialModels} onCreated={onCreated} />}
    <p><Button variant="quiet" size="sm" onClick={onUseUrl}>Use a URL instead</Button></p>
  </div>;
}

/** A catalog provider: OpenCode signs in from a terminal; the browser never takes the key. */
function ConnectProvider({ provider, onRefresh }: { provider: string; onRefresh: () => void }) {
  const command = `opencode auth login ${provider}`;
  return <div className="u3-section">
    <p>Run this in a terminal, then refresh:</p>
    <code>{command}</code>
    <p className="u3-muted">OpenCode asks for the key and stores it. Once it is signed in, {provider} appears under “{GROUP_TITLES.signed_in}”.</p>
    <Button onClick={onRefresh}>Refresh</Button>
  </div>;
}

function ModelStep({ candidate, initialModels, onCreated }: { candidate: Candidate; initialModels?: ModelsResult; onCreated: (name: string) => void }) {
  const models = useResource<ModelsResult>("executor.setup.models",
    { provider: candidate.provider, group: candidate.group, ...(candidate.base_url ? { base_url: candidate.base_url } : {}) }, initialModels);
  const action = useOperation();
  const [modelId, setModelId] = useState("");
  const [usage, setUsage] = useState<UsageClass["usage"] | "">("");
  const [cap, setCap] = useState("");
  const [name, setName] = useState(candidate.provider.replace(/[^a-z0-9-]/g, "-"));
  const [error, setError] = useState("");

  const list = models.data ? [...(models.data.pick ? [models.data.pick] : []), ...models.data.rest] : [];
  const model = list.find(m => m.id === modelId) ?? list[0];
  const known = models.data?.usage.known ?? true;
  const kind = candidate.group === "local" ? "unmetered" : usage || (known ? models.data?.usage.usage ?? "metered" : "metered");

  function submit(e: Event) {
    e.preventDefault();
    if (!model) { setError("Choose a model."); return; }
    const result = addParams({ candidate, model, usage: kind, cap, name });
    if ("error" in result) { setError(result.error); return; }
    setError("");
    void action.run("account.add", result.params, () => onCreated(name));
  }

  return <form className="u3-section" onSubmit={submit}>
    <ResourceState resource={models} empty="No usable models found.">
      {models.data?.note && <p className="u3-muted">{models.data.note}</p>}
      {list.length > 0 && <Field label="Model" help={model ? modelFacts(model) : undefined}>
        <Select value={model?.id} onChange={e => setModelId(e.currentTarget.value)}>
          {list.map((m, i) => <option key={m.id} value={m.id}>{m.id}{i === 0 && models.data?.pick ? " (recommended)" : ""}</option>)}
        </Select>
      </Field>}
      {candidate.group !== "local" && !known && <Field label="Usage">
        <Select value={kind} onChange={e => setUsage(e.currentTarget.value as UsageClass["usage"])}>
          <option value="quota">Quota — a plan with limits</option>
          <option value="metered">Metered — pay per token</option>
          <option value="unmetered">Unmetered — free or local</option>
        </Select>
      </Field>}
      {kind === "metered" && <Field label="Weekly spend cap in $" help="Leave blank for no cap; spend is always shown." error={error.startsWith("Enter a positive") ? error : undefined}>
        <TextInput inputMode="decimal" value={cap} onInput={e => setCap(e.currentTarget.value)} />
      </Field>}
      <Field label="Name" help="The executor id becomes opencode#name." error={error.startsWith("Use lowercase") ? error : undefined}>
        <TextInput required value={name} pattern="[a-z0-9][a-z0-9-]*" onInput={e => setName(e.currentTarget.value)} />
      </Field>
      {error && !error.startsWith("Enter a positive") && !error.startsWith("Use lowercase") && <p role="alert">{error}</p>}
      <Button type="submit" disabled={action.busy || !model}>Add executor</Button>
      <p className="u3-muted">Next, a short test task checks it before it is Ready.</p>
    </ResourceState>
    <Feedback action={action} />
  </form>;
}
