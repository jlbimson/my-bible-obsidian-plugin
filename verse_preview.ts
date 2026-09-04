import {
	Decoration,
	DecorationSet,
	EditorView,
	WidgetType,
} from "@codemirror/view"
import { EditorState, RangeSetBuilder, StateField, Transaction } from "@codemirror/state"
import {
	editorInfoField,
	editorLivePreviewField,
	MarkdownRenderer,
	normalizePath,
	TFile,
} from "obsidian"

import MyBible from "main"

/// Matches a wikilink to a heading or block, e.g. `[[Genesis 1#1]]`,
/// `[[Genesis 1#1-3]]`, or `[[Genesis 1#^abc123|alias]]`.
const VERSE_LINK_REGEX = /\[\[([^\]|#]+)#(\^?[^\]|]+)(?:\|([^\]]*))?\]\]/g

/// Replaces a linked Bible verse (or verse range) with a collapsible
/// quote whose title, right next to the expand/collapse arrow, *is* the
/// link — so collapsed, the whole thing reads as a single line, matching
/// how {@link MyBible.render_verse_quotes} builds it for Reading View.
class VerseQuoteWidget extends WidgetType {
	constructor(
		private readonly plugin: MyBible,
		private readonly file: TFile,
		private readonly subpath: string,
		private readonly sourcePath: string,
		private readonly linkText: string,
		private readonly linkHref: string,
	) {
		super()
	}

	eq(other: VerseQuoteWidget): boolean {
		return other.file === this.file
			&& other.subpath === this.subpath
			&& other.sourcePath === this.sourcePath
			&& other.linkText === this.linkText
			&& other.plugin.settings.verse_preview_collapsed_by_default
				=== this.plugin.settings.verse_preview_collapsed_by_default
	}

	toDOM(view: EditorView): HTMLElement {
		let details = document.createElement("details")
		details.addClass("mb-verse-quote")
		details.addClass("mb-verse-quote-live-preview")
		details.open = !this.plugin.settings.verse_preview_collapsed_by_default

		let summary = details.createEl("summary", { cls: "mb-verse-quote-summary" })
		summary.createEl("a", {
			cls: "internal-link",
			text: this.linkText,
			attr: {
				href: this.linkHref,
				"data-href": this.linkHref,
				target: "_blank",
				rel: "noopener nofollow",
			},
		})

		let body = details.createDiv({ cls: "mb-verse-quote-body" })

		// A block widget's height changing without telling CodeMirror can
		// leave its internal layout measurements stale (e.g. the cursor
		// landing in the wrong visual spot); toggling open/closed changes
		// this widget between inline and block display, so ask for a
		// remeasure whenever that happens.
		details.addEventListener("toggle", () => view.requestMeasure())

		this.plugin.get_linked_section_markdown(this.file, this.subpath)
			.then(async text => {
				if (text === null || text.length === 0) {
					return
				}
				await MarkdownRenderer.render(this.plugin.app, text, body, this.sourcePath, this.plugin)
			})
			.catch(() => {})

		return details
	}

	ignoreEvent(): boolean {
		// Let clicks (toggling the <details>, following the link, etc)
		// reach the DOM instead of being treated as editor interactions.
		return true
	}
}

function is_bible_file(plugin: MyBible, file: TFile): boolean {
	let bible_path = normalizePath(plugin.settings.bible_folder)
	return file.path === bible_path || file.path.startsWith(bible_path + "/")
}

/// Whether any selection range (there can be more than one, with multiple
/// cursors) overlaps `[from, to)`. Used to leave a verse link as plain,
/// editable text while the cursor is on or inside it, matching how
/// Obsidian's own link rendering behaves in Live Preview.
function range_overlaps_selection(state: EditorState, from: number, to: number): boolean {
	for (const range of state.selection.ranges) {
		if (range.from <= to && range.to >= from) {
			return true
		}
	}
	return false
}

/// Scans the whole document for verse links. Deliberately not limited to
/// `view.visibleRanges`: CodeMirror only allows decorations that cover a
/// line break, or block-level widgets, to be added by extensions that
/// provide their decorations *directly* (a state field), not by ones that
/// provide a function of the view — and the latter is the only place
/// `visibleRanges` is available, since it's computed from the
/// already-finalized viewport. (This decoration is inline and single-line,
/// so that restriction wouldn't apply here, but the whole-document scan is
/// kept for consistency with `has_linked_section`/cursor-awareness below,
/// which need it regardless.)
function build_decorations(state: EditorState, plugin: MyBible): DecorationSet {
	let builder = new RangeSetBuilder<Decoration>()

	if (!plugin.settings.verse_preview_enabled) {
		return builder.finish()
	}
	if (state.field(editorLivePreviewField, false) !== true) {
		// Only show previews in Live Preview, not in raw source mode
		return builder.finish()
	}

	let source_path = state.field(editorInfoField, false)?.file?.path ?? ""

	let text = state.doc.toString()
	VERSE_LINK_REGEX.lastIndex = 0

	let match: RegExpExecArray | null
	while ((match = VERSE_LINK_REGEX.exec(text)) !== null) {
		let linkpath = match[1].trim()
		let subpath = match[2].trim()
		let alias = match[3]

		let match_start = match.index
		let match_end = match_start + match[0].length

		if (range_overlaps_selection(state, match_start, match_end)) {
			// Leave the raw `[[...]]` text editable while the cursor is on it
			continue
		}

		let file = plugin.app.metadataCache.getFirstLinkpathDest(linkpath, source_path)
		if (file === null || !is_bible_file(plugin, file)) {
			continue
		}
		if (!plugin.has_linked_section(file, subpath)) {
			// No such heading/block (e.g. a broken or out-of-range verse link)
			continue
		}

		let href = "{0}#{1}".format(linkpath, subpath)
		let link_text = (alias !== undefined && alias.length > 0)
			? alias
			: "{0}:{1}".format(linkpath, subpath)

		builder.add(
			match_start,
			match_end,
			Decoration.replace({
				widget: new VerseQuoteWidget(plugin, file, subpath, source_path, link_text, href),
			}),
		)
	}

	return builder.finish()
}

export function buildVersePreviewExtension(plugin: MyBible) {
	let field = StateField.define<DecorationSet>({
		create(state) {
			return build_decorations(state, plugin)
		},
		update(value, tr: Transaction) {
			if (
				!tr.docChanged
				&& tr.startState.selection.eq(tr.state.selection)
				&& tr.startState.field(editorLivePreviewField, false)
					=== tr.state.field(editorLivePreviewField, false)
			) {
				return value
			}
			return build_decorations(tr.state, plugin)
		},
		provide: f => EditorView.decorations.from(f),
	})
	return field
}
