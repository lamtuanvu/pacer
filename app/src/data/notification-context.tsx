import { createContext, type ComponentChildren } from 'preact';
import { useContext, useEffect, useState } from 'preact/hooks';
import { createNotifications, type Notifications } from '../model/notifications';
import { Toast } from '../ds/Toast';
const NotificationContext = createContext<Notifications | null>(null);
export const useNotifications = () => useContext(NotificationContext);
export function NotificationProvider({children}: {children: ComponentChildren}) {
  const [controller] = useState(createNotifications);
  const [items, setItems] = useState(controller.getSnapshot);
  useEffect(() => {
    const off = controller.subscribe(()=>setItems(controller.getSnapshot()));
    return () => {off(); controller.dispose();};
  },[controller]);
  return <NotificationContext.Provider value={controller}>{children}<aside className="pc-toasts" aria-label="App notifications">{items.map(n=><Toast key={n.id} tone={n.tone} title={n.title} message={n.message} onDismiss={()=>controller.dismiss(n.id)} onPause={()=>controller.pause(n.id)} onResume={()=>controller.resume(n.id)}/>)}</aside></NotificationContext.Provider>;
}
