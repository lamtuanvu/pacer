import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import { ActionPanel, Cluster, DisclosurePanel, Page, PageBody, PageColumns, PageHeader, Section, Stack } from "../app/src/ds/Page";

test("page variants and composition expose one canonical structure", () => {
 for(const width of ["standard","wide","full"] as const){
  const html=renderToString(<Page width={width} className="consumer"><PageBody>Body</PageBody></Page>);
  expect(html).toContain(`pc-page--${width}`);
  expect(html).toContain("consumer");
  expect(html.match(/pc-page--/g)).toHaveLength(1);
 }
 const html=renderToString(<Page width="wide"><PageHeader breadcrumbs={<a href="#/tasks">Tasks</a>} identity="Task" description="Description" metadata="Metadata" status="Done" actions={<button>Act</button>}>Title</PageHeader></Page>);
 expect(html).toContain('nav aria-label="Breadcrumb"');
 expect(html).toContain("pc-page-header__identity");
 expect(html).not.toContain("<h1");
});

test("columns preserve main-before-aside order and primitives forward attributes", () => {
 const html=renderToString(<PageColumns className="consumer-columns" data-kind="detail" main={<main>Main</main>} aside={<aside>Aside</aside>}/>);
 expect(html.indexOf("Main")).toBeLessThan(html.indexOf("Aside"));
 expect(html).toContain('data-kind="detail"');
 expect(html).toContain("consumer-columns");
 const composition=renderToString(<Stack space="section"><Cluster className="tools">Tools</Cluster><Section title="Section"><DisclosurePanel summary="More">Detail</DisclosurePanel></Section><ActionPanel>Action</ActionPanel></Stack>);
 for(const value of ["pc-stack--section","tools","pc-section","pc-disclosure-panel","pc-action-panel"])expect(composition).toContain(value);
});

test("page CSS centrally owns widths, gutters and responsive columns", async () => {
 const css=await Bun.file(new URL("../app/src/ds/components.css",import.meta.url)).text();
 expect(css).toMatch(/\.pc-page\{[^}]*width:100%[^}]*margin-inline:0[^}]*padding:/);
 expect(css).toMatch(/\.pc-page--standard\{[^}]*max-width:none/);
 expect(css).toMatch(/\.pc-page--wide\{[^}]*max-width:none/);
 expect(css).toMatch(/@media\(max-width:767px\)[^{]*\{[^}]*\.pc-page\{[^}]*padding:/);
 expect(css).toMatch(/@media\(max-width:900px\)[^{]*\{[^}]*\.pc-page-columns\{[^}]*grid-template-columns:minmax\(0,1fr\)/);
});
