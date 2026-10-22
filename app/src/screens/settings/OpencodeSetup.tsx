// Settings › Add executor, step 2 for OpenCode: pick a detected provider, accept a model, optionally cap spend.
import { useState } from "preact/hooks";
import type { Candidate, Detection } from "../../../../src/endpoints/detect";
import type {
  ModelChoice,
  UsageClass,
} from "../../../../src/endpoints/recommend";
import { Button } from "../../ds/Button";
import { TextInput } from "../../ds/Controls";
import { ChoicePicker } from "../../ds/ChoicePicker";
import { ChoiceCard } from "../../ds/Patterns";
import { Pill } from "../../ds/Pill";
import { SectionHeading } from "../../ds/SectionHeading";
import {
  addParams,
  GROUP_TITLES,
  groupCandidates,
  modelFacts,
  searchCandidates,
  usagePill,
} from "../../model/opencode-setup";
import {
  Feedback,
  Field,
  ResourceState,
  useOperation,
  useResource,
} from "./shared";

const modelCount = (n: number) => `${n} ${n === 1 ? "model" : "models"}`;

interface ModelsResult {
  pick: ModelChoice | null;
  rest: ModelChoice[];
  usage: UsageClass;
  note?: string;
}

export interface OpencodeSetupProps {
  /** Called with the new account name once the account and its executor exist. */
  onCreated: (name: string) => void;
  onUseUrl: () => void;
  initialDetection?: Detection;
  initialChoice?: Candidate;
  initialModels?: ModelsResult;
}

export function OpencodeSetup({
  onCreated,
  onUseUrl,
  initialDetection,
  initialChoice,
  initialModels,
}: OpencodeSetupProps) {
  const detection = useResource<Detection>(
    "executor.setup.candidates",
    {},
    initialDetection,
  );
  const [choice, setChoice] = useState<Candidate | undefined>(initialChoice);
  const [query, setQuery] = useState("");
  const candidates = detection.data?.candidates ?? [];

  const card = (c: Candidate) => {
    const pill = usagePill(c.usage);
    return (
      <ChoiceCard
        className="u3-choice"
        key={`${c.group}:${c.provider}`}
        disabled={!!c.added}
        aria-pressed={
          choice?.provider === c.provider && choice.group === c.group
        }
        onClick={() => setChoice(c)}
      >
        <div>
          <strong>{c.name}</strong>
          {c.group === "local" && (
            <div className="u3-muted">
              {c.base_url} · {modelCount(c.models ?? 0)}
            </div>
          )}
          <div>
            <Pill tone={pill.tone}>{pill.label}</Pill>
          </div>
          {c.added && <div className="u3-muted">Added as {c.added}</div>}
        </div>
      </ChoiceCard>
    );
  };

  // Rendered inside the wizard's card, so this is a section, not a nested card.
  return (
    <div className="u3-section">
      <ResourceState resource={detection}>
        {(detection.data?.notes ?? []).map((note) => (
          <p className="u3-muted" key={note}>
            {note}
          </p>
        ))}
        {groupCandidates(candidates).map(([group, list]) => (
          <div className="u3-section" key={group}>
            <SectionHeading as="h3">{GROUP_TITLES[group]}</SectionHeading>
            {group === "catalog" && (
              <Field
                label="Search providers"
                help="OpenCode stores the key; pacer never sees it."
              >
                <TextInput
                  value={query}
                  placeholder="e.g. deepseek"
                  onInput={(e) => setQuery(e.currentTarget.value)}
                />
              </Field>
            )}
            {group === "catalog" ? (
              <CatalogResults list={list} query={query} card={card} />
            ) : (
              <div className="u3-choices">{list.map(card)}</div>
            )}
          </div>
        ))}
        {!candidates.length && (
          <p>No providers or local model servers found.</p>
        )}
      </ResourceState>
      {choice?.group === "catalog" && (
        <ConnectProvider
          key={choice.provider}
          provider={choice.provider}
          name={choice.name}
          onRefresh={() => {
            setChoice(undefined);
            detection.reload();
          }}
        />
      )}
      {choice && choice.group !== "catalog" && (
        <ModelStep
          key={`${choice.group}:${choice.provider}`}
          candidate={choice}
          initialModels={initialModels}
          onCreated={onCreated}
        />
      )}
      <p>
        <Button variant="quiet" size="sm" onClick={onUseUrl}>
          Use a URL instead
        </Button>
      </p>
    </div>
  );
}

function CatalogResults({
  list,
  query,
  card,
}: {
  list: Candidate[];
  query: string;
  card: (c: Candidate) => unknown;
}) {
  const shown = searchCandidates(list, query);
  const matches = query.trim()
    ? searchCandidates(list, query, list.length).length
    : list.length;
  return (
    <>
      {!shown.length && (
        <p className="u3-muted">No provider matches “{query.trim()}”.</p>
      )}
      <div className="u3-choices">{shown.map(card) as never}</div>
      {matches > shown.length && (
        <p className="u3-muted">
          Showing {shown.length} of {matches}; search to narrow.
        </p>
      )}
    </>
  );
}

/** A catalog provider: OpenCode signs in from a terminal; the browser never takes the key. */
function ConnectProvider({
  provider,
  name,
  onRefresh,
}: {
  provider: string;
  name: string;
  onRefresh: () => void;
}) {
  const command = `opencode auth login ${provider}`;
  return (
    <div className="u3-section">
      <p>Run this in a terminal, then refresh:</p>
      <code>{command}</code>
      <p className="u3-muted">
        OpenCode asks for the key and stores it. Once it is signed in, {name}{" "}
        appears under “{GROUP_TITLES.signed_in}”.
      </p>
      <Button onClick={onRefresh}>Refresh</Button>
    </div>
  );
}

function ModelStep({
  candidate,
  initialModels,
  onCreated,
}: {
  candidate: Candidate;
  initialModels?: ModelsResult;
  onCreated: (name: string) => void;
}) {
  const models = useResource<ModelsResult>(
    "executor.setup.models",
    {
      provider: candidate.provider,
      group: candidate.group,
      ...(candidate.base_url ? { base_url: candidate.base_url } : {}),
    },
    initialModels,
  );
  const action = useOperation();
  const [modelId, setModelId] = useState("");
  const [usage, setUsage] = useState<UsageClass["usage"] | "">("");
  const [cap, setCap] = useState("");
  const [name, setName] = useState(
    candidate.provider.replace(/[^a-z0-9-]/g, "-"),
  );
  const [error, setError] = useState("");

  const list = models.data
    ? [...(models.data.pick ? [models.data.pick] : []), ...models.data.rest]
    : [];
  // With nothing to recommend, the user names the model (as the CLI asks for a model id); limits use the defaults.
  const manual = !!models.data && !list.length;
  const [manualId, setManualId] = useState("");
  const model = manual
    ? manualId.trim()
      ? {
          id: manualId.trim(),
          context: 128_000,
          output: 16_000,
          tools: true,
          costIn: null,
          costOut: null,
        }
      : undefined
    : (list.find((m) => m.id === modelId) ?? list[0]);
  const known = models.data?.usage.known ?? true;
  const kind =
    candidate.group === "local"
      ? "unmetered"
      : usage || (known ? (models.data?.usage.usage ?? "metered") : "metered");

  function submit(e: Event) {
    e.preventDefault();
    if (!model) {
      setError(manual ? "Enter a model id." : "Choose a model.");
      return;
    }
    const result = addParams({ candidate, model, usage: kind, cap, name });
    if ("error" in result) {
      setError(result.error);
      return;
    }
    setError("");
    void action.run("account.add", result.params, () => onCreated(name));
  }

  return (
    <form className="u3-section" onSubmit={submit}>
      <ResourceState resource={models}>
        {models.data?.note && <p className="u3-muted">{models.data.note}</p>}
        {manual && !models.data?.note && (
          <p className="u3-muted">
            None of {candidate.name}’s models can run an executor (embeddings,
            images or speech only), so there is nothing to recommend.
          </p>
        )}
        {manual && (
          <Field
            label="Model id"
            help="A model this provider serves that can call tools."
          >
            <TextInput
              required
              value={manualId}
              onInput={(e) => setManualId(e.currentTarget.value)}
            />
          </Field>
        )}
        {list.length > 0 && (
          <Field label="Model" help={model ? modelFacts(model) : undefined}>
            <ChoicePicker
              value={model?.id ?? ""}
              searchable
              options={list.map((m, i) => ({ value: m.id, label: `${m.id}${i === 0 && models.data?.pick ? " (recommended)" : ""}` }))}
              onValueChange={setModelId}
            />
          </Field>
        )}
        {candidate.group !== "local" && !known && (
          <Field label="Usage">
            <ChoicePicker
              value={kind}
              options={[{ value: "quota", label: "Quota — a plan with limits" }, { value: "metered", label: "Metered — pay per token" }, { value: "unmetered", label: "Unmetered — free or local" }]}
              onValueChange={(value) => setUsage(value as UsageClass["usage"])}
            />
          </Field>
        )}
        {kind === "metered" && (
          <Field
            label="Weekly spend cap in $"
            help="Leave blank for no cap; spend is always shown."
            error={error.startsWith("Enter a positive") ? error : undefined}
          >
            <TextInput
              inputMode="decimal"
              value={cap}
              onInput={(e) => setCap(e.currentTarget.value)}
            />
          </Field>
        )}
        <Field
          label="Name"
          help="The executor id becomes opencode#name."
          error={error.startsWith("Use lowercase") ? error : undefined}
        >
          <TextInput
            required
            value={name}
            pattern="[a-z0-9][a-z0-9-]*"
            onInput={(e) => setName(e.currentTarget.value)}
          />
        </Field>
        {error &&
          !error.startsWith("Enter a positive") &&
          !error.startsWith("Use lowercase") && <p role="alert">{error}</p>}
        <Button type="submit" variant="primary" disabled={action.busy}>
          Add executor
        </Button>
        <p className="u3-muted">
          Next, a short test task checks it before it is Ready.
        </p>
      </ResourceState>
      <Feedback action={action} />
    </form>
  );
}
