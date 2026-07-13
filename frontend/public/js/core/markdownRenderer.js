import MarkdownIt from 'https://cdn.jsdelivr.net/npm/markdown-it@14.1.0/+esm';

const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
  breaks: true,
});

function decorateDialogue(tokens) {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'inline' && t.content) {
      const trimmed = t.content.trimStart();
      if (trimmed.startsWith('"') || trimmed.startsWith('“')) {
        t.attrJoin('class', 'dialogue');
      }
    }
  }
}

// Decorate dialogue tokens (quote-prefixed inline) with a `dialogue` class by
// monkey-patching md.render. renderMarkdown calls the OVERRIDDEN md.render so
// the decoration actually runs — previously it called the pre-override bound
// originalRender and the dialogue styling was dead (TEMUAN-059).
md.render = function (src, env) {
  const tokens = md.parse(src ?? '', env);
  decorateDialogue(tokens);
  return md.renderer.render(tokens, md.options, env);
};

export function renderMarkdown(text) {
  if (!text) return '';
  return md.render(text);
}
