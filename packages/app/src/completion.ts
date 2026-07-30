import type { CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete'
import { syntaxTree } from '@codemirror/language'
import { suggestValues, type ConfigModel } from '@attache/core'
import type { SyntaxNode, Tree } from '@lezer/common'

// Completing a value, from the syntax tree rather than from the model.
//
// The distinction is the whole reason this file works. The model is built by parsing the
// document, and while somebody is typing the document is usually not parseable: a key with
// no value yet, a list with one hyphen on it, a quote that has been opened. Ask the model
// where the caret is and the answer during editing is "nowhere" precisely when it is needed.
//
// Lezer keeps resolving through all of that. It is an error-tolerant incremental parser, so
// `resolveInner` gives a position inside a `Pair` whose value is half-written, which is the
// only moment a completion menu is any use.
//
// What is offered comes from `suggestValues` in the core, which answers with VALUES and
// never with field names — see that file for why the difference is not negotiable.

/** Strip YAML's quoting from a key. `"@type"` has to be quoted and is the common case. */
const unquote = (key: string) => key.trim().replace(/^(["'])(.*)\1$/, '$2')

/**
 * Where to ask the tree about, given where the caret is.
 *
 * Stepped back over trailing spaces and tabs, because `type: ` with the caret after the
 * space — which is the exact moment somebody presses Alt+Space — puts the caret PAST the end
 * of every node in the document. The pair ends at the colon, the space belongs to nothing,
 * and `resolveInner` answers `Stream`: no pair, no key, no menu, on the one keystroke this
 * feature exists for. Backing up to the last character that is part of the document asks
 * about the pair the caret is plainly sitting in.
 */
function probeFrom(read: (from: number, to: number) => string, pos: number): number {
  let probe = pos
  while (probe > 0 && /^[ \t]$/.test(read(probe - 1, probe))) probe--
  return probe
}

/**
 * The chain of keys enclosing a position, outermost first.
 *
 * Takes a reader rather than an `EditorState` so it can be tested against a bare parse. The
 * editor passes `state.sliceDoc`; the tests pass `String.prototype.slice`.
 */
export function keyContextAt(
  tree: Tree,
  read: (from: number, to: number) => string,
  pos: number,
): string[] {
  const out: string[] = []

  // Looking LEFT, and from the probe rather than the caret. The node starting AT the caret
  // is whatever comes next — often the following line's key, which would answer a question
  // about the wrong pair entirely.
  const at = probeFrom(read, pos)
  for (let node: SyntaxNode | null = tree.resolveInner(at, -1); node; node = node.parent) {
    if (node.name !== 'Pair') continue
    const key = node.getChild('Key')
    if (key) out.push(unquote(read(key.from, key.to)))
  }

  return out.reverse()
}

/**
 * Whether the caret is in the KEY half of a pair rather than the value half.
 *
 * Typing a field name puts the caret inside the `Key` node, and the enclosing pair is the
 * one being written — so without this, typing `clu` under a route would resolve the chain as
 * `[…, 'clu']`, which answers with nothing today but would quietly become field completion
 * the first time somebody added a fallback. Checked explicitly so that it cannot.
 */
export function inKeyPosition(
  tree: Tree,
  read: (from: number, to: number) => string,
  pos: number,
): boolean {
  const at = probeFrom(read, pos)
  for (let node: SyntaxNode | null = tree.resolveInner(at, -1); node; node = node.parent) {
    if (node.name === 'Key') return true
    if (node.name === 'Pair') return false
  }
  return false
}

/**
 * The completion source.
 *
 * The model arrives through a getter rather than as a value: this source is installed once,
 * when the editor is created, and the config it should be answering about is whatever is in
 * the store at the moment the menu opens.
 */
export function valueCompletions(currentModel: () => ConfigModel): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const tree = syntaxTree(context.state)
    const read = (from: number, to: number) => context.state.sliceDoc(from, to)
    if (inKeyPosition(tree, read, context.pos)) return null

    const chain = keyContextAt(tree, read, context.pos)
    const suggestions = suggestValues(chain, currentModel())
    if (suggestions.length === 0) return null

    // The characters a value can be made of, which for an `@type` is most of a URL. Anything
    // outside this set — a space, a brace, a comma — ends the token, so `{ cluster: api` in
    // flow style completes `api` and not `{ cluster: api`.
    const token = context.matchBefore(/[-\w./@:]*/)
    const from = token?.from ?? context.pos

    return {
      from,
      options: suggestions.map((suggestion) => ({
        label: suggestion.value,
        detail: suggestion.detail,
        type: 'value',
      })),
      // Everything offered here is a closed set from the config or from Envoy's own enums,
      // so the menu can be filtered down and reopened without re-consulting the tree until
      // the caret leaves the token.
      validFor: /^[-\w./@:]*$/,
    }
  }
}
