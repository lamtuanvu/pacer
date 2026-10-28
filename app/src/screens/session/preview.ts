import MarkdownIt from "markdown-it";

const markdown = new MarkdownIt({ html: false, linkify: false });
// Images never load in the preview; a labelled placeholder keeps the alt text and the address (in title).
markdown.renderer.rules.image = (tokens, index) => {
  const token = tokens[index];
  const alt = token?.content ?? "", src = token?.attrGet("src") ?? "";
  const escape = markdown.utils.escapeHtml;
  return `<span class="pc-file-viewer__image" title="${escape(src)}">${escape(alt ? `Image not loaded: ${alt}` : "Image not loaded")}</span>`;
};
markdown.renderer.rules.link_open = (tokens, index, options, _environment, renderer) => {
  tokens[index]?.attrJoin("class", "pc-inline-link");
  return renderer.renderToken(tokens, index, options);
};

export function renderMarkdownPreview(source: string): string {
  return markdown.render(source);
}
export { htmlPreviewDocument } from "./preview-html";
