import {displayPath} from './presentation';

/** Long file paths wrap at separators while file names remain intact. */
export function SettingsPath({path}: {path: string}) {
  return <code className="pc-settings-path">{displayPath(path).split(/(?<=\/)/).map((part,index)=><span key={index}>{part}<wbr/></span>)}</code>;
}
