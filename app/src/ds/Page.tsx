import type { ComponentChildren, JSX } from "preact";
import { classNames as classes } from "./classNames";
import { Disclosure } from "./Controls";
import { SectionHeading } from "./SectionHeading";

type DivProps=JSX.HTMLAttributes<HTMLDivElement>;
export function Page({width,children,className,...props}:DivProps&{width:"standard"|"wide"|"full"}){return <div {...props} className={classes("pc-page",`pc-page--${width}`,className)}>{children}</div>;}
export function PageBody({children,className,...props}:DivProps){return <div {...props} className={classes("pc-page-body",className)}>{children}</div>;}
export function PageHeader({breadcrumbs,identity,description,metadata,status,actions,children,className,...props}:JSX.HTMLAttributes<HTMLElement>&{breadcrumbs?:ComponentChildren;identity?:ComponentChildren;description?:ComponentChildren;metadata?:ComponentChildren;status?:ComponentChildren;actions?:ComponentChildren}){
 return <header {...props} className={classes("pc-page-header",className)}>{breadcrumbs&&<nav aria-label="Breadcrumb" className="pc-page-header__breadcrumbs">{breadcrumbs}</nav>}<div className="pc-page-header__row"><div className="pc-page-header__content">{identity&&<div className="pc-page-header__identity">{identity}</div>}{children&&<SectionHeading>{children}</SectionHeading>}{description&&<div className="pc-page-header__description">{description}</div>}{metadata&&<div className="pc-page-header__metadata">{metadata}</div>}</div>{status&&<div className="pc-page-header__status">{status}</div>}{actions&&<div className="pc-page-header__actions">{actions}</div>}</div></header>;
}
export function PageColumns({main,aside,className,...props}:DivProps&{main:ComponentChildren;aside?:ComponentChildren}){return <div {...props} className={classes("pc-page-columns",className)}><div className="pc-page-columns__main">{main}</div>{aside&&<aside className="pc-page-columns__aside">{aside}</aside>}</div>;}
export function Stack({space="normal",children,className,...props}:DivProps&{space?:"compact"|"normal"|"section"}){return <div {...props} className={classes("pc-stack",`pc-stack--${space}`,className)}>{children}</div>;}
export function Cluster({children,className,...props}:DivProps){return <div {...props} className={classes("pc-cluster",className)}>{children}</div>;}
export function Section({title,description,actions,children,className,...props}:JSX.HTMLAttributes<HTMLElement>&{title:ComponentChildren;description?:ComponentChildren;actions?:ComponentChildren}){return <section {...props} className={classes("pc-composed-section",className)}><div className="pc-composed-section__header"><div><SectionHeading>{title}</SectionHeading>{description&&<div className="pc-composed-section__description">{description}</div>}</div>{actions&&<Cluster>{actions}</Cluster>}</div><div className="pc-composed-section__body">{children}</div></section>;}
export function DisclosurePanel({summary,children,className,...props}:JSX.HTMLAttributes<HTMLDetailsElement>&{summary:ComponentChildren;open?:boolean}){return <Disclosure {...props} className={classes("pc-disclosure-panel",className)} summary={summary}><div className="pc-disclosure-panel__body">{children}</div></Disclosure>;}
export function ActionPanel({children,className,...props}:JSX.HTMLAttributes<HTMLElement>){return <section {...props} className={classes("pc-action-panel",className)}>{children}</section>;}
