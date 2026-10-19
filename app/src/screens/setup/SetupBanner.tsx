import { useContext, useState } from 'preact/hooks';
import { Button } from '../../ds/Button';
import { SetupContext } from './context';
import { bannerKey, nextOptional, readDismissal, saveDismissal } from './model';
export function SetupBanner() {
  const { checklist } = useContext(SetupContext);
  const [dismissed, setDismissed] = useState(readDismissal);
  const key = bannerKey(checklist), item = nextOptional(checklist);
  if (!key || !item || dismissed === key) return null;
  return <aside className="pc-notice pc-setup-banner" aria-label="Finish setup"><span>Finish setting up pacer: {item.title}</span>
    <a className="pc-text-action" href="#/setup">Continue setup</a><Button onClick={() => { saveDismissal(key); setDismissed(key); }}>Dismiss</Button></aside>;
}
