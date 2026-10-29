import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import { AppButtonLink, AppLink, NavigationProvider, useNavigation } from "../app/src/navigation";
import { resolveRoute, routes, type Route } from "../app/src/router";

const current = resolveRoute("#/tasks?repo=acme&scope=all") as Route;

test("typed links retain native anchor behavior and inherited scope", () => {
 const html = renderToString(<NavigationProvider route={current} location={{hash:"#/tasks?repo=acme&scope=all",replace(){}}}>
  <AppLink to={routes.task("a b")} target="_blank" rel="noopener" aria-current="page">Task</AppLink>
  <AppButtonLink to={routes.settings("planner")} variant="primary">Settings</AppButtonLink>
 </NavigationProvider>);
 expect(html).toContain('href="#/tasks/a%20b?repo=acme&amp;scope=all"');
 expect(html).toContain('target="_blank"');
 expect(html).toContain('rel="noopener"');
 expect(html).toContain('aria-current="page"');
 expect(html).toContain('href="#/settings/planner?repo=acme&amp;scope=all"');
 expect(html.match(/<a\b/g)).toHaveLength(2);
});

test("imperative navigation writes or replaces canonical destinations", () => {
 const writes:string[]=[];
 const location={hash:"#/tasks?repo=acme&scope=all",replace(value:string){writes.push(`replace:${value}`);}};
 let navigation:ReturnType<typeof useNavigation>|undefined;
 function Consumer(){navigation=useNavigation();return null;}
 renderToString(<NavigationProvider route={current} location={location}><Consumer/></NavigationProvider>);
 navigation!.navigate(routes.task("next one"));
 expect(location.hash).toBe("#/tasks/next%20one?repo=acme&scope=all");
 navigation!.navigate(routes.dispatch({repo:null}),{replace:true});
 expect(writes).toEqual(["replace:#/?scope=all"]);
});
