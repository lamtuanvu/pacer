import { policyWords, policyDetail } from "../../../../src/view-model/words";
import { useContext, useState } from "preact/hooks";
import { Button, TextAction } from "../../ds/Button";
import { SetupContext } from "./context";
import { bannerKey, nextOptional, readDismissal, saveDismissal } from "./model";
export function SetupBanner({ showPolicy = true }: { showPolicy?: boolean } = {}) {
  const { checklist } = useContext(SetupContext);
  const [dismissed, setDismissed] = useState(readDismissal);
  const key = bannerKey(checklist), item = nextOptional(checklist);
  if (!key || !item || dismissed === key) return null;
  return <aside className="pc-notice pc-setup-banner" aria-label="Finish setup"><span>Finish setting up pacer: {item.title}{showPolicy && <> · <span title={policyDetail(checklist?.policy)}>{policyWords(checklist?.policy)}</span></>}</span>
    <TextAction className="pc-text-action" href="#/setup">Continue setup</TextAction><Button onClick={() => { saveDismissal(key); setDismissed(key); }}>Dismiss</Button></aside>;
}
