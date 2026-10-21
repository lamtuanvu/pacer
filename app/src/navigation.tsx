import { createContext, type ComponentChildren, type JSX } from "preact";
import { useContext, useEffect, useMemo } from "preact/hooks";
import { ButtonLink, TextAction, type ButtonLinkProps } from "./ds/Button";
import { hrefFor, titleFor, type Route, type RouteQuery, type RouteTarget } from "./router";

export interface NavigationLocation { hash: string; replace(value: string): void }
export interface NavigationValue {
  current: Route;
  navigate(target: RouteTarget, options?: {replace?: boolean}): void;
}
const fallbackRoute:Route={name:"overview",query:{repo:null,scope:null}};
const NavigationContext=createContext<NavigationValue>({current:fallbackRoute,navigate:()=>{}});

export function NavigationProvider({route,children,location:provided}:{route:Route;children:ComponentChildren;location?:NavigationLocation}) {
  const location=provided??globalThis.location;
  const value=useMemo<NavigationValue>(()=>({current:route,navigate(target,options){
    const href=hrefFor(target,route.query);
    if(options?.replace)location.replace(href);else location.hash=href;
  }}),[route,location]);
  useEffect(()=>{
    if(typeof document==="undefined")return;
    document.title=`${titleFor(route)} · pacer`;
    document.getElementById("main-content")?.focus();
  },[route.name,"id" in route?route.id:undefined,"section" in route?route.section:undefined,"alias" in route?route.alias:undefined]);
  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>;
}
export function useNavigation():NavigationValue{return useContext(NavigationContext);}

type AppLinkProps=Omit<JSX.AnchorHTMLAttributes<HTMLAnchorElement>,"href">&{to:RouteTarget;query?:RouteQuery};
export function AppLink({to,query,...props}:AppLinkProps){const {current}=useNavigation();return <TextAction {...props} href={hrefFor(to,query??current.query)}/>;}
export function AppButtonLink({to,query,...props}:Omit<ButtonLinkProps,"href">&{to:RouteTarget;query?:RouteQuery}){const {current}=useNavigation();return <ButtonLink {...props} href={hrefFor(to,query??current.query)}/>;}
