// Vendored markdown-it (esbuild bundle of markdown-it@14 + deps) served
// same-origin from /js/vendor so the service worker can cache it and the
// story page renders offline (TEMUAN-034). Rebuild with:
//   npx esbuild --bundle --format=esm --outfile=public/js/vendor/markdown-it.bundle.js \
//     --target=es2020 node_modules/markdown-it/index.mjs
import MarkdownIt from '../vendor/markdown-it.bundle.js';

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
  // env MUST be an object — linkify's link rule reads env.references, and
  // md.parse/renderer.render pass it through. An undefined env crashed the
  // inline tokenizer with "Cannot read properties of undefined (reading
  // 'references')" whenever a message contained a URL.
  const safeEnv = env ?? {};
  const tokens = md.parse(src ?? '', safeEnv);
  decorateDialogue(tokens);
  return md.renderer.render(tokens, md.options, safeEnv);
};

export function renderMarkdown(text) {
  if (!text) return '';
  return md.render(text);
}
