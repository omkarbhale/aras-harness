import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

/**
 * Markdown renderer for streamed assistant output, backed by react-markdown +
 * remark-gfm (GitHub-Flavored Markdown: tables, task lists, strikethrough,
 * autolinks). The bubble re-renders on every streamed token; react-markdown
 * re-parses the full string each time and renders partial/unterminated syntax
 * gracefully, so formatting "snaps in" as the closing delimiter arrives.
 *
 * Safety: raw HTML in the model output is NOT rendered (no rehype-raw), and
 * react-markdown's default urlTransform already strips dangerous protocols.
 * We additionally restrict link hrefs to http(s)/mailto and open them in the
 * OS browser via the main-process setWindowOpenHandler.
 *
 * Note on identifiers: CommonMark does not treat intra-word underscores as
 * emphasis, so Aras names like `item_number` and `created_on` render verbatim.
 */

const SAFE_URL = /^(https?:|mailto:)/i

const components: Components = {
  a({ href, children }) {
    if (href && SAFE_URL.test(href)) {
      return (
        <a href={href} target="_blank" rel="noreferrer noopener">
          {children}
        </a>
      )
    }
    // Unsupported/unsafe protocol — render the link text inert.
    return <span>{children}</span>
  }
}

export function Markdown({ text }: { text: string }): JSX.Element {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {text}
    </ReactMarkdown>
  )
}
