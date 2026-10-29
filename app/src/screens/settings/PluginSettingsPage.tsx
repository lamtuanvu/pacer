import { useContext, useEffect, useRef, useState } from "preact/hooks";
import type { SettingsField, SettingsSchema } from "../../../../src/plugins/ui-schema";
import type { PluginInfo, SurfaceInfo } from "../../../../src/plugins/registry";
import { Page, LoadingState, SegmentedControl } from "../../ds/Patterns";
import { PluginContext } from "../../plugins/catalog";
import { AppLink } from "../../navigation";
import { routes } from "../../router";
import { Alert } from "../../ds/Alert";
import { registerNavigationGuard } from "../../data/navigation-guard";
import { DensityContext } from "../../ds/Density";
import { Button } from "../../ds/Button";
import { Switch, TextInput } from "../../ds/Controls";
import { ChoicePicker } from "../../ds/ChoicePicker";
import { SearchPicker } from "../../ds/SearchPicker";
import { SettingRow } from "../../ds/SettingRow";
import { Icon } from "../../ds/icons";
import { useTaskContext, ErrorMessage } from "../task-shared";
import { useResource, Feedback } from "./shared";
import { usePluginToggle } from "./Plugins";
import { pluginIcon, capabilityWords, pluginPresentation } from "./plugin-presentation";
import { usePluginSettingsStyles } from "./plugin-styles";
export interface PluginSettingsData { id: string; title: string; schema: SettingsSchema; values: Record<string,unknown>; rev: number }
type FieldErrors = Record<string,string>;
const errorCode = (error: unknown) => (error as {code?:string})?.code;
export function fieldErrors(error: unknown): FieldErrors {
  const result: FieldErrors = {};
  for (const entry of (error as {data?:{errors?:{path:string;message:string}[]}})?.data?.errors ?? []) result[entry.path.replace(/^values\./, "")] = entry.message;
  return result;
}
export function settingsDefaults(data: PluginSettingsData) {
  return Object.fromEntries(Object.entries(data.schema.fields).map(([name,field]) => [name, data.values[name] ?? ("default" in field ? field.default : undefined) ?? (field.type === "boolean" ? false : field.type === "array" || field.type === "repos" ? [] : field.type === "integer" ? field.minimum : "")]));
}
export function settingsPayload(data: PluginSettingsData, baseline: Record<string,unknown>, values: Record<string,unknown>) {
  return Object.fromEntries(Object.entries(values).filter(([name,value]) =>
    (Object.hasOwn(data.values,name) || JSON.stringify(value) !== JSON.stringify(baseline[name])) &&
    !(value === "" && (data.schema.fields[name]?.type === "secretRef" || data.schema.fields[name]?.type === "string" && "enum" in data.schema.fields[name]!))));
}
export const sameValues = (a: Record<string,unknown>, b: Record<string,unknown>) => new Set([...Object.keys(a),...Object.keys(b)]).size === Object.keys(a).length && Object.keys(a).every(key => JSON.stringify(a[key]) === JSON.stringify(b[key]));
export const dirtyFields = (saved: Record<string,unknown>, values: Record<string,unknown>) => Object.keys(values).filter(name => JSON.stringify(values[name]) !== JSON.stringify(saved[name])).length;
const joinWords = (words: string[]) => words.length < 2 ? words[0] ?? "" : `${words.slice(0,-1).join(", ")} and ${words.at(-1)}`;
export function PluginSettingsPage({ section = "", plugin: pluginProp, initialData, initialPlugins, initialSurfaces }: { section?:string; plugin?:string; initialData?:PluginSettingsData; initialPlugins?:{plugins:PluginInfo[]}; initialSurfaces?:{surfaces:SurfaceInfo[]} }) {
  usePluginSettingsStyles();
  const plugin = pluginProp ?? section.slice(8), {api,state} = useTaskContext();
  const plugins = useResource("plugin.list", {}, initialPlugins), catalog = useContext(PluginContext), surfaces = catalog.surfaces.length ? catalog.surfaces : initialSurfaces?.surfaces ?? [];
  const info = plugins.data?.plugins.find(p => p.id === plugin);
  const [data,setData] = useState(initialData), [values,setValues] = useState<Record<string,unknown>>(() => initialData ? settingsDefaults(initialData) : {}), [baseline,setBaseline] = useState(values);
  const [error,setError] = useState<unknown>(), [errors,setErrors] = useState<FieldErrors>({}), [conflict,setConflict] = useState(false), [message,setMessage] = useState(""), [busy,setBusy] = useState(false);
  const pending = useRef(false), generation = useRef(0), active = useRef(true);
  const refresh = () => { plugins.reload(); catalog.reload(); };
  const toggle = usePluginToggle(refresh);
  async function load() {
    const ticket = ++generation.current; setError(undefined);
    try {
      const next = await api.call<PluginSettingsData>("plugin.settings.get",{plugin});
      if (!active.current || ticket !== generation.current) return;
      setData(next); const nextValues = settingsDefaults(next); setValues(nextValues); setBaseline(nextValues); setErrors({}); setConflict(false);
    } catch(error) { if(active.current && ticket === generation.current) setError(error); }
  }
  useEffect(() => { active.current = true; if (!initialData) void load(); return () => { active.current = false; generation.current++; }; }, [api,plugin]);
  useEffect(() => { if(!data?.title) return; const previous = document.title; document.title = data.title; return () => { if(document.title === data.title) document.title = previous; }; }, [data?.title]);
  const previousEnabled = useRef(info?.enabled);
  useEffect(() => { if (info?.enabled && previousEnabled.current === false) void load(); previousEnabled.current = info?.enabled; }, [info?.enabled]);
  const count = dirtyFields(baseline,values);
  const draftGuard = useRef({count, confirm:toggle.dialogs.confirm}); draftGuard.current = {count, confirm:toggle.dialogs.confirm};
  useEffect(() => {
    const unregister = registerNavigationGuard(() => draftGuard.current.count ? draftGuard.current.confirm("This plugin has unsaved settings. Discard your changes and leave?", "Unsaved plugin settings", "Discard changes") : Promise.resolve(true));
    const unload = (event:BeforeUnloadEvent) => { if(draftGuard.current.count) {event.preventDefault();event.returnValue="";} };
    window.addEventListener("beforeunload",unload);
    return () => {unregister();window.removeEventListener("beforeunload",unload);};
  }, []);
  function update(name: string, value: unknown) { setValues(old => ({...old,[name]:value})); setErrors(old => { const next={...old}; delete next[name]; return next; }); setMessage(""); }
  async function save() {
    if (pending.current || !data) return;
    const local: FieldErrors = {};
    for (const [name,field] of Object.entries(data.schema.fields)) if (field.type === "integer" && (!Number.isInteger(values[name]) || Number(values[name]) < field.minimum || Number(values[name]) > field.maximum)) local[name] = `Enter a whole number between ${field.minimum} and ${field.maximum}.`;
    setErrors(local); if(Object.keys(local).length) return;
    pending.current = true; setBusy(true); setMessage("");
    try {
      const payload = settingsPayload(data,baseline,values);
      const write = (rev:number) => api.call<{values:Record<string,unknown>;rev:number}>("plugin.settings.set",{plugin,values:payload,expect_rev:rev});
      let next;
      try { next = await write(data.rev); }
      catch(error) {
        if(errorCode(error) !== "conflict") throw error;
        const latest = await api.call<PluginSettingsData>("plugin.settings.get",{plugin});
        if(!active.current) return;
        if(!sameValues(latest.values,data.values)) throw error;
        setData(latest); next = await write(latest.rev);
      }
      if (!active.current) return;
      const saved = {...data,...next}; setData(saved); const defaults = settingsDefaults(saved); setValues(defaults); setBaseline(defaults); setConflict(false); setMessage("Saved.");
    } catch(error) {
      if (!active.current) return;
      if(errorCode(error) === "conflict") setConflict(true);
      else if(errorCode(error) === "invalid_input") { setErrors(fieldErrors(error)); setMessage("Some settings need attention. Check the fields below."); }
      else setError(error);
    } finally { pending.current = false; if(active.current) setBusy(false); }
  }
  async function visibility(surface: SurfaceInfo) {
    if (pending.current || !data) return;
    pending.current = true; setBusy(true);
    try {
      const result = await api.call<{rev:number}>("plugin.ui.visibility",{plugin,surface:surface.surface === "panelTabs" ? "panelTab" : surface.surface,id:surface.id,visible:!surface.visible,expect_rev:data.rev});
      if (!active.current) return;
      setData(old => old ? {...old,rev:result.rev} : old); catalog.reload(); setMessage(count ? "" : "Saved.");
    } catch(error) {
      if (!active.current) return;
      if (errorCode(error) === "conflict") {
        // Refresh the shared revision without discarding an unsaved field draft.
        try { const latest = await api.call<PluginSettingsData>("plugin.settings.get",{plugin}); if(active.current) { if (JSON.stringify(latest.values) !== JSON.stringify(data.values) && count) setConflict(true); else {setData(latest);if(!count) {const defaults=settingsDefaults(latest);setValues(defaults);setBaseline(defaults);}} catalog.reload(); setMessage("Changed elsewhere; showing the latest."); } } catch(error) { setError(error); }
      } else setError(error);
    } finally { pending.current = false; if(active.current) setBusy(false); }
  }
  async function turn() {
    if(!info || pending.current) return;
    if(info.enabled && count && !await toggle.dialogs.confirm(`Discard ${count} unsaved ${count === 1 ? "change" : "changes"} and turn off ${plugin}?`, "Unsaved plugin settings", "Discard and turn off")) return;
    if(info.enabled && count) { setValues(baseline); setErrors({}); setConflict(false); setMessage(""); }
    await toggle.toggle(info);
  }
  const other = surfaces.filter(s => s.plugin === plugin && s.surface !== "settings") ?? [];
  const unavailable = errorCode(error) === "plugin_unavailable", missing = ["unknown_plugin","not_found"].includes(errorCode(error) ?? "");
  const off = info?.state === "disabled";
  return <DensityContext.Provider value="settings"><Page width="full" className="u3-settings u3-settings-page"><div className="pc-settings-board pc-plugin-settings pc-plugin-settings--editor">
    <header className="pc-settings-board__header"><h1>{data?.title ?? surfaces.find(s => s.plugin === plugin && s.surface === "settings")?.title ?? "Plugin settings"}</h1></header>
    {info && <div className="pc-plugin-provenance"><span className="pc-plugin-provenance__icon" aria-hidden="true"><Icon name={pluginIcon(plugin,surfaces ?? [])}/></span><span className="pc-plugin-grow">Added by the plugin <b>{pluginPresentation(info).name} {info.version}</b> from {info.publisher}{info.capabilities.length > 0 && ` · may ${joinWords(capabilityWords(info).map(word => word[0]!.toLowerCase()+word.slice(1)))}`}</span><AppLink to={routes.settings("plugins")}>Manage plugin</AppLink>{info.state !== "refused" && <Button size="sm" aria-disabled={toggle.busy} onClick={() => void turn()}>{info.enabled ? "Turn off" : "Turn on"}</Button>}</div>}
    {off ? <p role="status">This plugin is off.</p> : missing ? <p>This plugin has no settings page.</p> : unavailable ? <p>This plugin is turned off or needs attention. <AppLink to={routes.settings("plugins")}>Open Plugins settings</AppLink></p> : <>
      {!data && !error && <LoadingState label="Loading plugin settings…"/>}
      {data && <section aria-label={`${data.title} settings`}>{Object.entries(data.schema.fields).map(([name,field]) => <SettingRow key={name} variant="board" headingLevel={3} label={field.title} description={field.description}><div className="pc-plugin-field"><SchemaField name={name} field={field} value={values[name]} onChange={value => update(name,value)} disabled={busy} error={errors[name]} repos={state.snapshot?.repos ?? []}/>{errors[name] && <span id={`plugin-field-${name}-error`} className="pc-plugin-field__error" role="alert">{errors[name]}</span>}</div></SettingRow>)}
        {other.length > 0 && <SettingRow variant="board" headingLevel={3} label="Where it shows" description={`This plugin offers ${other.length} ${other.length === 1 ? "view" : "views"}. These switches save at once.`}><div className="pc-plugin-field pc-plugin-field--visibility">{other.map(surface => <Switch key={`${surface.surface}:${surface.id}`} size="sm" label={surface.surface === "panelTabs" ? `${surface.title} tab in the right panel` : surface.surface === "activity" ? `${surface.title} in the activity bar` : `${surface.title} in the status bar`} checked={surface.visible} aria-disabled={busy} onChange={() => void visibility(surface)}/>)}</div></SettingRow>}
      </section>}
      {conflict && <Alert tone="warning" title="These settings changed elsewhere."><Button size="sm" onClick={() => void load()}>Load latest</Button></Alert>}
      {count > 0 && <div className="pc-plugin-save"><span className="pc-plugin-save__dot" aria-hidden="true"/><span className="pc-plugin-grow"><b>{count} unsaved {count === 1 ? "change" : "changes"}</b> <span className="pc-settings-board__caption">· saved to the plugin's own settings</span></span><Button variant="ghost" size="sm" onClick={() => {setValues(baseline);setErrors({});setMessage("");}}>Discard</Button><Button variant="primary" size="sm" aria-disabled={busy || conflict} onClick={() => {if(!busy && !conflict) void save();}}>Save</Button></div>}
    </>}
    {!unavailable && !missing && <ErrorMessage error={error}/>}{(busy || message && !(count && message === "Saved.")) && <p role="status">{busy ? "Saving…" : message}</p>}<Feedback action={toggle.action}/>{toggle.dialogs.dialog}
    <p className="pc-settings-board__caption">This page is drawn by pacer from the plugin's settings schema, so every plugin page uses the same layout.</p>
  </div></Page></DensityContext.Provider>;
}
function SchemaField({name,field,value,onChange,disabled,error,repos}: {name:string;field:SettingsField;value:unknown;onChange:(value:unknown)=>void;disabled:boolean;error?:string;repos:{key:string;label:string}[]}) {
  const [text,setText] = useState(""), drag = useRef<number>();
  // Rows are keyed by position, so keyboard focus follows the moved item to its new row (its same button, or the other one at an end).
  const ordered = useRef<HTMLOListElement>(null);
  function refocus(index: number, down: boolean) {
    requestAnimationFrame(() => {
      const buttons = Array.from(ordered.current?.children[index]?.querySelectorAll<HTMLElement>(".pc-plugin-move .pc-btn") ?? []);
      (buttons.find(button => button.getAttribute("aria-label")?.startsWith(down ? "Move down" : "Move up")) ?? buttons[0])?.focus();
    });
  }
  const inputId = `plugin-field-${name}`, props = {id:inputId,"aria-label":field.title,"aria-describedby":error ? `${inputId}-error` : undefined,"aria-invalid":!!error,"aria-disabled":disabled};
  if(field.type === "boolean") return <span className="pc-plugin-inline"><Switch {...props} size="sm" checked={!!value} onChange={event => {if(!disabled) onChange(event.currentTarget.checked);}}/><span>{value ? "On" : "Off"}</span></span>;
  if(field.type === "string" && field.enum) return field.enum.length <= 4 ? <SegmentedControl variant="board" label={field.title} value={String(value ?? "")} options={field.enum.map(value => ({value,label:value}))} onChange={value => {if(!disabled) onChange(value);}}/> : <ChoicePicker {...props} value={String(value ?? "")} options={field.enum.map(value => ({value,label:value}))} onValueChange={value => {if(!disabled) onChange(value);}}/>;
  if(field.type === "string" || field.type === "secretRef") return <><TextInput {...props} value={String(value ?? "")} maxLength={field.type === "string" ? field.maxLength : 64} onInput={event => {if(!disabled) onChange(event.currentTarget.value);}}/>{field.type === "secretRef" && <span className="pc-settings-board__caption">The name of a secret reference you manage in pacer, never the secret itself.</span>}</>;
  if(field.type === "integer") { const bad = !Number.isInteger(value) || Number(value) < field.minimum || Number(value) > field.maximum; return <><TextInput {...props} type="number" min={field.minimum} max={field.maximum} step={1} value={String(value ?? "")} aria-invalid={bad || !!error} aria-describedby={error ? `${inputId}-error` : bad ? `${inputId}-range` : undefined} onInput={event => {if(!disabled) onChange(event.currentTarget.value === "" ? "" : Number(event.currentTarget.value));}}/>{bad && !error && <span id={`${inputId}-range`} className="pc-plugin-field__error">Enter a whole number between {field.minimum} and {field.maximum}.</span>}</>; }
  const list = Array.isArray(value) ? value as string[] : [], max = field.maxItems ?? 100;
  function remove(at:number) {if(!disabled) onChange(list.filter((_,index) => index !== at));}
  function move(from:number,to:number,focus = false) {if(disabled || from === to || to < 0 || to >= list.length) return; const next = [...list]; next.splice(to,0,next.splice(from,1)[0]!); onChange(next); if (focus) refocus(to,to > from);}
  const reason = list.length >= max ? `Maximum ${max} ${field.type === "repos" ? max === 1 ? "repository" : "repositories" : max === 1 ? "item" : "items"}. Remove one to add another.` : undefined;
  if(field.type === "repos") {
    const options = repos.filter(repo => !list.includes(repo.key));
    return <><div className="pc-plugin-tags">{list.map((repo,index) => {const label = repos.find(r => r.key === repo)?.label ?? repo; return <span key={`${repo}-${index}`} className="pc-plugin-repo">{label}<Button variant="ghost" size="sm" className="pc-plugin-remove" aria-label={`Remove ${label}`} onClick={() => remove(index)}>×</Button></span>;})}{!reason && options.length > 0 ? <SearchPicker align="start" label="Add repository" searchLabel="Search repositories" placeholder="Search repositories…" emptyLabel="No matching repositories." value={null} options={options.map(repo => ({value:repo.key,label:repo.label,searchText:repo.key}))} onChange={value => {if(value && !disabled && list.length < max) onChange([...list,value]);}}/> : <Button size="sm" aria-disabled aria-describedby={`${inputId}-reason`}>Add repository</Button>}</div>{reason ? <span id={`${inputId}-reason`}>{reason}</span> : !options.length && <span id={`${inputId}-reason`} className="pc-settings-board__caption">{repos.length ? "All known repositories are already selected." : "No known repositories are available."}</span>}</>;
  }
  function add() {if(!disabled && text.trim() && list.length < max) {onChange([...list,text.trim()]);setText("");}}
  return <><ol ref={ordered} className="pc-plugin-ordered">{list.map((item,index) => <li key={index} draggable={!disabled} onDragStart={event => {drag.current=index;event.dataTransfer?.setData("text/plain",String(index));}} onDragOver={event => event.preventDefault()} onDrop={event => {event.preventDefault();if(drag.current !== undefined) move(drag.current,index);drag.current=undefined;}} onDragEnd={() => {drag.current=undefined;}}><svg className="pc-plugin-drag" viewBox="0 0 24 24" aria-hidden="true">{[6,12,18].flatMap(y => [9,15].map(x => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.5"/>))}</svg><span className="pc-plugin-ordered__text">{item}</span><span className="pc-plugin-move">{([-1,1] as const).map(direction => {const label = `Move ${direction < 0 ? "up" : "down"}: ${item}`, boundary = direction < 0 ? index === 0 : index === list.length-1; return boundary ? <span key={direction} className="pc-plugin-move__spacer" aria-hidden="true" /> : <Button key={direction} size="sm" variant="ghost" className="pc-plugin-remove" aria-label={label} title={label} aria-disabled={disabled} onClick={() => move(index,index+direction,true)}><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2"><path d={direction < 0 ? "m6 15 6-6 6 6" : "m6 9 6 6 6-6"}/></svg></Button>;})}</span><Button size="sm" variant="ghost" className="pc-plugin-remove" aria-label={`Remove ${item}`} onClick={() => remove(index)}>×</Button></li>)}</ol><div className="pc-plugin-inline"><TextInput aria-label={`${field.title}: new item`} placeholder="Add an item" value={text} maxLength={2000} onInput={event => setText(event.currentTarget.value)} onKeyDown={event => {if(event.key === "Enter") {event.preventDefault();add();}}}/><Button size="sm" aria-disabled={disabled || !!reason} aria-describedby={reason ? `${inputId}-reason` : undefined} onClick={add}>Add</Button></div>{reason && <span id={`${inputId}-reason`} className="pc-settings-board__caption">{reason}</span>}</>;
}
