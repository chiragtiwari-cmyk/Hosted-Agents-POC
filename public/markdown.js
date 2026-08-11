/**
 * A deliberately small Markdown renderer for assistant replies.
 *
 * Why hand-rolled rather than a library: this UI has no build step and no CDN
 * access (the container is offline and a deployed Foundry agent shouldn't fetch
 * scripts at runtime). The model only ever emits a narrow subset — bold, italic,
 * inline code, ordered and unordered lists, paragraphs — so that is all this
 * covers.
 *
 * SECURITY: model output is untrusted text. Everything here builds DOM nodes and
 * assigns via textContent; there is no innerHTML anywhere on this path, so a
 * reply containing `<img onerror=...>` renders as literal characters.
 *
 * Returns a DocumentFragment so callers can append it directly.
 */

/** Inline: **bold**, *italic*, `code`. Applied to already-escaped text nodes. */
function renderInline(text, target) {
  // One pass, longest-delimiter-first so ** wins over *.
  const pattern = /(\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_|`[^`]+`)/g;
  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      target.append(document.createTextNode(text.slice(lastIndex, match.index)));
    }
    const token = match[0];
    let el;
    if (token.startsWith("**") || token.startsWith("__")) {
      el = document.createElement("strong");
      el.textContent = token.slice(2, -2);
    } else if (token.startsWith("`")) {
      el = document.createElement("code");
      el.textContent = token.slice(1, -1);
    } else {
      el = document.createElement("em");
      el.textContent = token.slice(1, -1);
    }
    target.append(el);
    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) {
    target.append(document.createTextNode(text.slice(lastIndex)));
  }
}

const ORDERED = /^\s*(\d+)[.)]\s+(.*)$/;
const UNORDERED = /^\s*[-*+•]\s+(.*)$/;
const HEADING = /^\s*(#{1,4})\s+(.*)$/;

/**
 * Block-level parse. Groups consecutive list items into a single list, keeps
 * blank-line-separated text as paragraphs, and treats single newlines inside a
 * paragraph as line breaks (which is how the models here actually write).
 */
export function renderMarkdown(source) {
  const fragment = document.createDocumentFragment();
  const lines = String(source ?? "").split(/\r?\n/);

  let index = 0;
  while (index < lines.length) {
    const line = lines[index];

    // Blank lines separate blocks.
    if (!line.trim()) {
      index++;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      // Cap at h4-equivalent; these sit inside a chat bubble.
      const el = document.createElement("strong");
      el.className = "md-heading";
      renderInline(heading[2], el);
      fragment.append(el);
      index++;
      continue;
    }

    if (ORDERED.test(line) || UNORDERED.test(line)) {
      const ordered = ORDERED.test(line);
      const list = document.createElement(ordered ? "ol" : "ul");
      list.className = "md-list";

      while (index < lines.length) {
        const candidate = lines[index];
        const asOrdered = ORDERED.exec(candidate);
        const asUnordered = UNORDERED.exec(candidate);
        // A different list type ends this list rather than mixing.
        if (ordered && !asOrdered) break;
        if (!ordered && !asUnordered) break;

        const li = document.createElement("li");
        renderInline((asOrdered ? asOrdered[2] : asUnordered[1]).trim(), li);
        list.append(li);
        index++;
      }

      fragment.append(list);
      continue;
    }

    // Paragraph: consume until a blank line or the start of a list/heading.
    const paragraph = document.createElement("p");
    paragraph.className = "md-p";
    let first = true;
    while (index < lines.length) {
      const candidate = lines[index];
      if (!candidate.trim()) break;
      if (ORDERED.test(candidate) || UNORDERED.test(candidate) || HEADING.test(candidate)) break;
      if (!first) paragraph.append(document.createElement("br"));
      renderInline(candidate, paragraph);
      first = false;
      index++;
    }
    fragment.append(paragraph);
  }

  return fragment;
}

/** Replaces an element's content with rendered Markdown. */
export function setMarkdown(el, source) {
  el.textContent = "";
  el.append(renderMarkdown(source));
}
