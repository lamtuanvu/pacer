import MarkdownIt from "markdown-it";

const markdown = new MarkdownIt({ html: false, linkify: false });
markdown.renderer.rules.image = (tokens, index) => markdown.utils.escapeHtml(tokens[index]?.content ?? "");
markdown.renderer.rules.link_open = (tokens, index, options, _environment, renderer) => {
  tokens[index]?.attrJoin("class", "pc-inline-link");
  return renderer.renderToken(tokens, index, options);
};

export function renderMarkdownPreview(source: string): string {
  return markdown.render(source);
}
export { htmlPreviewDocument } from "./preview-html";
