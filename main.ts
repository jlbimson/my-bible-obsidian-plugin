import {
	App,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	FuzzySuggestModal,
	TFile,
	normalizePath,
	requestUrl,
	MarkdownRenderer,
	MarkdownPostProcessorContext,
	Editor,
	EditorSuggest,
	EditorSuggestContext,
	EditorSuggestTriggerInfo,
	EditorPosition,
} from 'obsidian'

import { E_CANCELED, Mutex } from 'async-mutex'
import { BBCodeTag, legacy, parse_mybible } from 'mybible_parser'
import { mb } from 'api'
import { buildVersePreviewExtension } from 'verse_preview'

const BUILD_END_TOAST = "Bible build finished!";
const SELECTED_TRANSLATION_OPTION = "<Selected reading translation, {0}>"
const SELECTED_TRANSLATION_OPTION_KEY = "default"
const REPORT_ISSUE_URL = "https://github.com/GsLogiMaker/my-bible-obsidian-plugin/issues/new/choose"

/// The type of the callout that a quoted verse's own text is pasted into
/// by {@link VerseLinkSuggest}. A callout is Obsidian's own foldable
/// section, so the quote keeps working — folding included — with this
/// plugin disabled, and exports (to PDF, say) as the plain text it is.
const VERSE_QUOTE_CALLOUT_TYPE = "bible"
enum BookNameStyle { Display, Abbreviated, Full }

class Version {
	major:number = 1
	minor:number = 0
	patch:number = 0

	constructor(ma:number, mi:number, pa:number) {
		this.major = ma
		this.minor = mi
		this.patch = pa
	}

	static fromString(version:string):Version {
		let parts = version.split(".")
		return new Version(
			Number(parts[0]),
			Number(parts[1]),
			Number(parts[2]),
		)
	}
}

class MyBibleSettings {
	translation: string
	reading_translation: string
	bible_folder: string

	store_locally: boolean

	padded_order: boolean
	book_folders_enabled: boolean
	book_name_format: string
	book_name_delimiter: string
	book_name_capitalization: string
	book_name_abbreviated: boolean

	padded_chapter: boolean
	book_ordering: string
	chapter_name_format: string
	chapter_body_format: string

	build_with_dynamic_verses: boolean
	verse_body_format: string

	verse_preview_enabled: boolean
	verse_preview_collapsed_by_default: boolean

	index_enabled: boolean
	index_name_format: string
	index_format: string
	index_link_format: string

	chapter_index_enabled: boolean
	chapter_index_name_format: string
	chapter_index_format: string
	chapter_index_link_format: string

	enable_javascript_execution:boolean

	_built_translation: string;
	_last_opened_version: Version|undefined
	/// Each translation's book names and chapter counts, remembered from
	/// the last time they were fetched, keyed by translation. Purely a
	/// cache of {@link BibleAPI.get_books_data}, kept so that naming a
	/// chapter's note doesn't need the network: the notes themselves are
	/// already in the vault, so features that only look one up (such as
	/// the `--` verse link suggester) keep working offline.
	_book_names: Record<string, Record<BookId, [name: string, chapter_count: number]>>
	_plugin:MyBible

	constructor() {}

	async set_translation(val: string) {
		if (val === SELECTED_TRANSLATION_OPTION_KEY) {
			this.translation = val
			return
		}

		let has_translation = false;
		let translations = (await this._plugin.bible_api.get_translations());
		if (!(val in translations)) {
			this.translation = await this._plugin.bible_api.get_default_translation();
		} else {
			this.translation = val;
		}
	}

	async setLastOpenedVersion(version:Version) {
		this._last_opened_version = version
		this._plugin.saveSettings()
	}
}

const DEFAULT_SETTINGS: MyBibleSettings = {
	translation: SELECTED_TRANSLATION_OPTION_KEY,
	reading_translation: "WEB",
	bible_folder: "/My Bible/",
	book_folders_enabled: true,
	book_name_format: "{order} {book}",
	book_name_delimiter: " ",
	chapter_name_format: "{book} {chapter}",
	book_name_capitalization: "name_case",
	book_name_abbreviated: false,
	padded_order: true,
	padded_chapter: false,
	book_ordering: "christian",
	build_with_dynamic_verses: true,
	verse_body_format: "###### {verse}\n"
		+ "{verse_text}"
	,
	chapter_body_format: "\n"
		+ "##### "
			+ "**[[{last_chapter_name}|⏪ {last_chapter_name}]] | [[{chapter_index}|Chapters]] | [[{next_chapter_name}|{next_chapter_name} ⏩]]**<br>"
			+ "**[[{first_chapter_name}|First ({first_chapter})]] | [[{final_chapter_name}|Last ({final_chapter})]]**<br><br>\n"
		+ "\n"
		+ "{verses}\n"
		+ "\n"
		+ "##### "
			+ "**[[{last_chapter_name}|⏪ {last_chapter_name}]] | [[{chapter_index}|Chapters]] | [[{next_chapter_name}|{next_chapter_name} ⏩]]**<br>"
			+ "**[[{first_chapter_name}|First ({first_chapter})]] | [[{final_chapter_name}|Last ({final_chapter})]]**\n"
	,
	verse_preview_enabled: true,
	verse_preview_collapsed_by_default: true,

	index_enabled: true,
	index_name_format: "-- Bible --",
	index_link_format: "- [[{chapter_index}|{book}]]",
	index_format: ""
		+ "### Old testament\n"
		+ "{old_testament}\n"
		+ "### New testament\n"
		+ "{new_testament}\n"
		+ "### Apocrypha\n"
		+ "{apocrypha}"
	,
	chapter_index_enabled: true,
	chapter_index_name_format: "-- {book} --",
	chapter_index_link_format: "- [[{chapter_name}|{chapter}]]",
	chapter_index_format: ""
		+ "##### *[[{index}|Books]]*\n"
		+ "\n"
		+ "### Chapters\n"
		+ "{chapters}\n"
	,
	store_locally: false,
	enable_javascript_execution: false,

	_built_translation: "",
	_last_opened_version: undefined,
	_book_names: {},
} as MyBibleSettings

export function getPlugin():MyBible {
	return MyBible.plugin
}

/// How long a request is given before it's called a lost cause. Generous
/// on purpose: some of the Bible API's endpoints (verse counts, say)
/// routinely take upwards of ten seconds to answer, and a build that gives
/// up on one of those fails outright, so waiting beats failing.
const HTTP_TIMEOUT_SECONDS = 60

export function httpGet(theUrl: string): Promise<string> {
	const request = requestUrl(theUrl).text;

	let timer: ReturnType<typeof setTimeout>
	const timeout = new Promise<never>((_, reject) =>
		timer = setTimeout(() => {
			const callSiteErr = new Error(
				`Request timed out after ${HTTP_TIMEOUT_SECONDS} seconds: ${theUrl}`
			);
			callSiteErr.name = "NetworkError";
			reject(callSiteErr)
		}, HTTP_TIMEOUT_SECONDS * 1000)
	);

	// Stop the timer once the request settles, so a finished request
	// doesn't leave one pending for the rest of the timeout
	return Promise.race([request, timeout])
		.finally(() => clearTimeout(timer))
}

export function is_alpha(string: string): boolean {
	for (let char_str of string) {
		let char = char_str.charCodeAt(0);
		if ((char > 64 && char < 91) || (char > 96 && char < 123) || (char > 39 && char < 42)) {
			// Character is a capital or lowercase letter, continue
			continue;
		}
		// Character is not a capital or lowercase letter, return false
		return false;
	}
	// All characters were uppercase or lowercase letters, return true
	return true;
}

export function is_alphanumeric(string: string): boolean {
	for (let char_str of string) {
		let char = char_str.charCodeAt(0);
		if ((char > 64 && char < 91) || (char > 96 && char < 123) || (char > 47 && char < 58)) {
			// Character is a capital or lowercase letter, continue
			continue;
		}
		// Character is not a capital or lowercase letter, return false
		return false;
	}
	// All characters were uppercase or lowercase letters, return true
	return true;
}

export function is_numeric(string: string): boolean {
	for (let char_str of string) {
		let char = char_str.charCodeAt(0);
		if (char > 47 && char < 58) {
			// Character is a number, continue
			continue;
		}
		// Character is not number, return false
		return false;
	}
	// All characters were numbers, return true
	return true;
}

export async function save_file(path: string, content: string) {
	let file_path = normalizePath(path);
	let file = this.app.vault.getAbstractFileByPath(file_path)
	if (file instanceof TFile) {
		await this.app.vault.modify(file, content)
	} else if (file === null) {
		await this.app.vault.create(
			file_path,
			content,
		)
	}
}

export function translation_to_display_name(translation:Translation):string {
	if (translation.language === "") {
		return translation.display_name
	}
	return "{0} - {1} - {2}"
		.format(translation.language, translation.abbreviated_name, translation.display_name)
	;
}

export function cyrb128(str:string): number {
    let h1 = 1779033703, h2 = 3144134277,
        h3 = 1013904242, h4 = 2773480762;
    for (let i = 0, k; i < str.length; i++) {
        k = str.charCodeAt(i);
        h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
        h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
        h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
        h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
    }
    h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
    h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
    h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
    h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
    h1 ^= (h2 ^ h3 ^ h4), h2 ^= h1, h3 ^= h1, h4 ^= h1;
    return h1 >>> 0
}

export function wait(seconds:number):Promise<void> {
    return new Promise(function(resolve) {
        setTimeout(resolve, seconds);
    });
}

export default class MyBible extends Plugin {
	bible_api: BibleAPI
	settings: MyBibleSettings
	progress_notice: Notice | null
	legacyParser: legacy.VerseParser
	depricationTimer: Promise<void>|undefined = undefined

	static plugin:MyBible

	async onload() {
		MyBible.plugin = this

		// @ts-ignore
		globalThis["mb"] = mb

		this.legacyParser = new legacy.VerseParser()
		this.bible_api = new BollsLifeBibleAPI();
		this.bible_api.plugin = this;

		await this.loadSettings()
		this.settings._plugin = this

		this.settings.setLastOpenedVersion(
			Version.fromString(this.manifest.version)
		)

		await this.settings.set_translation(this.settings.translation)

		// This adds a simple command that can be triggered anywhere
		this.addCommand({
			id: 'create_bible_files',
			name: 'Build Bible',
			callback: async () => {
				new BuilderModal(this.app, this).open()
			}
		});

		this.addCommand({
			id: 'quick_change_translation',
			name: 'Change translation',
			callback: async () => {
				let modal = new QuickChangeTranslationeModal(this)
				modal.translations = await this.bible_api.get_translations()
				modal.onChose = async translation => {
					this.settings.reading_translation = translation.abbreviated_name
					await getPlugin().saveSettings()
				}
				modal.open()
			}
		});

		this.addCommand({
			id: 'clear_cache',
			name: 'Clear local files',
			callback: async () => {
				new ClearLocalFilesModal(this.app, this).open();
			}
		});

		this.addCommand({
			id: 'download_bible',
			name: 'Download translation',
			callback: async () => {
				let modal = new QuickChangeTranslationeModal(this)
				modal.translations = await this.bible_api.get_translations()
				modal.onChose = async translation => {
					await this.bible_api.user_download_translation(
						translation.abbreviated_name
					)
				}
				modal.open()
				
			}
		});

		this.registerMarkdownCodeBlockProcessor("verse", async (source, el, ctx) =>{
			const DEPRICATE_VERSE_BLOCK = false
			if (DEPRICATE_VERSE_BLOCK && this.depricationTimer === undefined) {
				MarkdownRenderer.render(
					this.app,
					"> [!WARNING] `verse` codeblocks are depricated\n"
						+ "> Rebuilding your Bible should resolve this issue. If you created this block yourself then use the `mybible` codeblock instead. For more information visit [the wiki]({0})."
						.format("https://gslogimaker.github.io/my-bible-obsidian-plugin/documents/Code_Blocks.html#md:verse-1"),
					el,
					"",
					this,
				)
				this.depricationTimer = (async () => {
					await wait(3)
					this.depricationTimer = undefined
					return
				})()
			}
			await this.legacyParser.parse(source, el)
		});

		this.registerMarkdownCodeBlockProcessor("mybible", async (source, el, ctx) => {
			let code_context = {
				file: this.app.vault.getAbstractFileByPath(ctx.sourcePath)
			}
			let parsed = parse_mybible(source)
			if (parsed instanceof Error) {
				MarkdownRenderer.render(
					this.app,
					"> [!ERROR] {0}\n> ```\n> {1}\n> ```".format(
						parsed.name,
						parsed.message
							.replace(/\n/g, "\n> ")
							.replace(/```/g, "")
					),
					el,
					"",
					this,
				)
				return
			}

			let text = ""
			for (const X of parsed) {
				if (X instanceof BBCodeTag) {
					text += await X.toText(code_context)
				} else {
					text += X
				}
			}
			MarkdownRenderer.render(this.app, text, el, "", this)
		});

		this.registerMarkdownPostProcessor((el, ctx) => {
			if (!this.settings.verse_preview_enabled) {
				return
			}
			return this.render_verse_quotes(el, ctx)
		});

		this.registerEditorExtension(buildVersePreviewExtension(this));

		this.registerEditorSuggest(new VerseLinkSuggest(this));

		this.addSettingTab(new SettingsTab(this.app, this));
	}

	onunload() {
	}

	async build_bible() {
		let bible_path = normalizePath(this.settings.bible_folder);

		let bible_folder = this.app.vault.getAbstractFileByPath(bible_path);
		if (bible_folder instanceof TFile) {
			// Can't handle if bible path is a file. Abort
			new ErrorModal(
				this.app,
				this,
				"Failed to build bible",
				"The bible folder defined in settings, \"{0}\", was expected to point to a folder, but it points to a file. Try changing the path to point to a folder, or change the file to a folder."
					.format(this.settings.bible_folder),
			).open();
			return;
		} else if (bible_folder === null) {
			// Bible path doesn't exist. Create it
			this.app.vault.adapter.mkdir(bible_path);
		} else {
			// Bible path is already a valid folder. No action needed
		}

		let folders_and_files = await this.app.vault.adapter.list(bible_path);
		if (folders_and_files.files.length + folders_and_files.folders.length != 0) {
			new ClearOldBibleFilesModal(this.app, this).open()
		} else {
			await this._build_bible(bible_path);
		}
	}

	async _build_bible(bible_path: string) {
		this.show_toast_progress(0, null)
		try {
			let translation = ""
			if (this.settings.translation == SELECTED_TRANSLATION_OPTION_KEY) {
				translation = this.settings.reading_translation
			} else {
				translation = this.settings.translation
			}
	
			// TODO: Build bibles according to translation in settings
			this.settings._built_translation = translation;
			await this.saveSettings();
	
			let ctx = new BuildContext
			ctx.plugin = this
			ctx.translation = translation
			ctx.set_books(await this.bible_api.get_books_data(ctx.translation))
			ctx.verse_counts = await this.bible_api.get_verse_count(ctx.translation)
	
			// Get translation texts
			ctx.translation_texts = await this.bible_api
				.get_translation(ctx.translation);

			// Remove empty chapters from books (HACK: This should be done in a better place, but this is where all the needed information is)
			if (ctx.translation_texts !== undefined) {
				for (const BOOK_ID of Object.keys(ctx.books) as unknown as number[]) {
					let book = ctx.books[BOOK_ID]
					let to_remove = []
					for (let i = 1; i != book.chapters.length+1; i++) {
						let chapter_texts = ctx.translation_texts.books[book.id]
						let verses = chapter_texts[i] || {}
						if (Object.keys(verses).length === 0) {
							to_remove.push(i)
						}
					}
					for (const i of to_remove.reverse()) {
						book.chapters.remove(i)
					}
				}
			}

			// Notify progress
			let built_chapter_count = 0
			let total_chapter_count = 0
			for (const i in ctx.books) {
				total_chapter_count += ctx.books[i].chapters.length
			}
			this.show_toast_progress(0, total_chapter_count)
	
			// Index
			if (this.settings.index_enabled) {
				await save_file(
					"{0}/{1}.md".format(bible_path, ctx.format_index_name()),
					ctx.format_index(),
				)
			}
	
			let file_promises: Array<Promise<any>> = [];
	
			for (const BOOK_ID of Object.keys(ctx.books) as unknown as number[]) {
				let book = ctx.books[BOOK_ID]
				ctx.set_book_and_chapter(book, book.chapters[0])
				let texts_of_book = ctx.translation_texts.books[book.id]
	
				// Book path
				let book_path = bible_path
				if (this.settings.book_folders_enabled) {
					book_path += "/" + ctx.format_book_name(ctx.book);
					this.app.vault.adapter.mkdir(normalizePath(book_path));
				}
	
				// Chapter index
				if (this.settings.chapter_index_enabled) {
					file_promises.push(save_file(
						"{0}/{1}.md".format(book_path, ctx.format_chapter_index_name(ctx.book)),
						ctx.format_chapter_index(ctx.book),
					))
				}
				
				for (const chapter of ctx.book.chapters) {
					file_promises.push(new Promise(async () => {
						ctx.set_chapter(chapter);
						let texts_of_chapter = texts_of_book[chapter]

						// Assemble verses
						ctx.verses_text = ""
						let added_verse_count = 0
						for (const verse_key of Object.keys(texts_of_chapter)) {
							const verse = Number(verse_key)
							while (added_verse_count < verse) {
								ctx.verse = added_verse_count + 1
								let text = ctx.format_verse_body()
								if (text.length === 0) {
									added_verse_count += 1
									continue
								}
								ctx.verses_text += text
								if (
									!(text.length === 0 && !this.settings.build_with_dynamic_verses)
									&& verse_key !== Object.keys(texts_of_chapter).last())
								{
									ctx.verses_text += "\n";
								}
								added_verse_count += 1
							}
						}
		
						// Chapter name
						let chapter_note_name = ctx.format_chapter_name();
		
						// Chapter body
						let note_body = ctx.format_chapter_body();
		
						// Save file
						let file_path = book_path + "/" + chapter_note_name + ".md"
		
						await save_file(file_path, note_body)
						built_chapter_count += 1
						this.show_toast_progress(
							built_chapter_count,
							total_chapter_count,
						)
					}))
				}
			}
	
			await Promise.all(file_promises);
		} catch (e) {
			new ErrorModal(
				this.app,
				this,
				"Failed to build bible",
				String(e),
			).open();
		}
	}

	/// Finds links to specific Bible verses within `el` and appends a
	/// collapsible quote of that verse's text, pulled directly from the
	/// built Bible note, right after the link.
	async render_verse_quotes(el: HTMLElement, ctx: MarkdownPostProcessorContext) {
		let bible_path = normalizePath(this.settings.bible_folder)
		let links = el.querySelectorAll<HTMLAnchorElement>("a.internal-link")

		for (const link of Array.from(links)) {
			if (link.closest(".mb-verse-quote, .callout, blockquote") !== null) {
				// Already inside a quote: one an earlier pass built, or a
				// callout holding the verse's text already (which is what
				// the `--` trigger inserts), or a blockquote the writer
				// meant as one. Quoting into a quote helps nobody.
				continue
			}

			let raw_href = link.getAttribute("data-href") ?? link.getAttribute("href") ?? ""
			let hash_i = raw_href.indexOf("#")
			if (hash_i === -1) {
				// Link doesn't point to a specific verse
				continue
			}

			let linkpath = raw_href.slice(0, hash_i)
			let subpath = raw_href.slice(hash_i + 1)
			if (subpath.length === 0) {
				continue
			}

			let file = this.app.metadataCache.getFirstLinkpathDest(linkpath, ctx.sourcePath)
			if (file === null) {
				continue
			}
			if (file.path !== bible_path && !file.path.startsWith(bible_path + "/")) {
				// Not a link into the built Bible, ignore it
				continue
			}
			if (!this.has_linked_section(file, subpath)) {
				// No such heading/block (e.g. a broken or out-of-range verse link)
				continue
			}

			let verse_text = await this.get_linked_section_markdown(file, subpath)
			if (verse_text === null || verse_text.length === 0) {
				continue
			}

			let details = document.createElement("details")
			details.addClass("mb-verse-quote")
			details.open = !this.settings.verse_preview_collapsed_by_default

			let summary = details.createEl("summary", { cls: "mb-verse-quote-summary" })

			// The link itself becomes the dropdown's title, instead of
			// sitting above a separately-labeled quote. If it's showing its
			// default un-aliased text, display that as "Genesis 1:1"
			// instead; a real custom alias matches neither form below and is
			// left alone. Reading View renders that default text with the
			// subpath separated by " > " ("Genesis 1 > 1") rather than the
			// raw "Genesis 1#1" the link was written as.
			let link_text = link.textContent ?? ""
			if (
				link_text === "{0}#{1}".format(linkpath, subpath)
				|| link_text === "{0} > {1}".format(linkpath, subpath)
			) {
				link.textContent = "{0}:{1}".format(linkpath, subpath)
			}
			link.replaceWith(details)
			summary.appendChild(link)

			let body = details.createDiv({ cls: "mb-verse-quote-body" })
			await this.render_verse_body(verse_text, body, ctx.sourcePath)
		}
	}

	/// Renders the text of a quoted verse (or range of them) into
	/// `container`, with each verse's number set inline at the start of its
	/// own text.
	///
	/// A chapter note numbers its verses with a heading apiece, which is
	/// how the numbers are told apart from the text here — but leaving them
	/// as headings and styling them into place doesn't survive Reading
	/// view, where every block gets wrapped in a div of its own and the
	/// numbers drift away from the verses they belong to. So each number is
	/// put inside its verse's first paragraph instead, where it stays
	/// regardless of how the text around it is laid out.
	async render_verse_body(markdown: string, container: HTMLElement, source_path: string) {
		for (const verse of parse_quoted_verses(markdown)) {
			let el = container.createDiv({ cls: "mb-verse" })
			await MarkdownRenderer.render(this.app, verse.text, el, source_path, this)
			if (verse.number === null) {
				continue
			}
			// The first paragraph, so the number reads as part of the verse
			// rather than as a line above it; the div itself is the
			// fallback for a verse that rendered to nothing paragraph-like
			let target = el.querySelector("p") ?? el
			target.insertBefore(
				createSpan({ cls: "mb-verse-num", text: verse.number }),
				target.firstChild,
			)
		}
	}

	/// Synchronously checks whether `subpath` names a real heading, block,
	/// or (for a `start-end` range) at least a real starting heading in
	/// `file`, using only the metadata cache (no file read). Used to decide
	/// whether a verse quote should be shown at all *before* constructing
	/// anything for it, so a broken/out-of-range verse link never gets an
	/// empty quote flashed onto the screen.
	has_linked_section(file: TFile, subpath: string): boolean {
		let cache = this.app.metadataCache.getFileCache(file)
		if (cache === null) {
			return false
		}
		if (subpath.startsWith("^")) {
			let block_id = subpath.slice(1).toLowerCase()
			return cache.blocks?.[block_id] !== undefined
		}
		let headings = cache.headings ?? []
		const range = parse_verse_range(subpath)
		if (range !== null) {
			return headings.some(h => h.heading.trim() === String(range[0]))
		}
		let target = subpath.toLowerCase()
		return headings.some(h => h.heading.toLowerCase() === target)
	}

	/// Returns the markdown found under the heading or block named
	/// `subpath` within `file`, or null if no such heading/block exists.
	/// `subpath` may also be a verse range like `"1-3"`, in which case the
	/// text spans every *consecutively numbered* verse heading found
	/// starting at the range's first verse, up to (and including) its last
	/// — stopping early if the chapter runs out of verses before the range
	/// does.
	async get_linked_section_markdown(file: TFile, subpath: string): Promise<string|null> {
		let cache = this.app.metadataCache.getFileCache(file)
		if (cache === null) {
			return null
		}

		let content = await this.app.vault.cachedRead(file)
		let lines = content.split("\n")

		if (subpath.startsWith("^")) {
			let block_id = subpath.slice(1).toLowerCase()
			let block = cache.blocks?.[block_id]
			if (block === undefined) {
				return null
			}
			return lines
				.slice(block.position.start.line, block.position.end.line + 1)
				.join("\n")
				.trim()
		}

		let headings = cache.headings ?? []
		const range = parse_verse_range(subpath)

		let start_index: number
		if (range !== null) {
			start_index = headings.findIndex(h => h.heading.trim() === String(range[0]))
		} else {
			let target = subpath.toLowerCase()
			start_index = headings.findIndex(h => h.heading.toLowerCase() === target)
		}
		if (start_index === -1) {
			return null
		}

		// For a range, extend through as many consecutive verse headings as
		// are available, up to (and including) the range's last verse.
		let end_index = start_index
		if (range !== null) {
			let [start, end] = range
			let expected = start + 1
			while (
				end_index + 1 < headings.length
				&& expected <= end
				&& headings[end_index + 1].heading.trim() === String(expected)
			) {
				end_index += 1
				expected += 1
			}
		}

		// When the quote spans more than one verse, include the starting
		// verse's own heading so every verse in the body is numbered (the
		// later verses' headings already fall inside the slice). A single
		// verse needs no number — the quote's title already names it.
		let start_line = end_index > start_index
			? headings[start_index].position.start.line
			: headings[start_index].position.end.line + 1
		let end_line = end_index + 1 < headings.length
			? headings[end_index + 1].position.start.line
			: lines.length

		let text = lines.slice(start_line, end_line).join("\n").trim()
		return text.length > 0 ? text : null
	}

	/// Finds the note in the built Bible that represents `chapter` of the
	/// book with `book_id`, or null if it hasn't been built.
	async resolve_chapter_file(book_id: BookId, chapter: number): Promise<TFile|null> {
		let translation = this.settings.translation === SELECTED_TRANSLATION_OPTION_KEY
			? this.settings.reading_translation
			: this.settings.translation

		let books = await this.get_books_data_offline(translation)
		let book = books[book_id]
		if (book === undefined || !book.has_chapter(chapter)) {
			return null
		}

		let ctx = new BuildContext
		ctx.plugin = this
		ctx.translation = translation
		ctx.set_books(books)
		ctx.set_book_and_chapter(book, chapter)

		let book_path = normalizePath(this.settings.bible_folder)
		if (this.settings.book_folders_enabled) {
			book_path += "/" + ctx.format_book_name(ctx.book)
		}
		let file_path = normalizePath("{0}/{1}.md".format(book_path, ctx.format_chapter_name()))

		let file = this.app.vault.getAbstractFileByPath(file_path)
		return file instanceof TFile ? file : null
	}

	/// Book names and chapter counts for `translation`, without requiring
	/// the network: fetching them normally hits the Bible API, which fails
	/// offline. Falls back to what was remembered the last time they were
	/// fetched (see {@link MyBibleSettings._book_names}), and past that to
	/// the default English names. Only for naming a chapter's note, never
	/// for building one — a name guessed from the fallback is checked
	/// against the vault anyway, so at worst nothing is found.
	async get_books_data_offline(translation: string): Promise<Record<BookId, BookData>> {
		let remembered = (this.settings._book_names ?? {})[translation]
		if (remembered === undefined) {
			// Never fetched on this device; the API is the only source
			try {
				return await this.bible_api.get_books_data(translation)
			} catch (e) {
				// Offline, or the API is unreachable; fall through
			}
		}

		// A remembered translation lists exactly the books it has, which may
		// not be the default 66 (e.g. one carrying the apocrypha)
		let book_ids = remembered !== undefined
			? Object.keys(remembered)
			: Object.keys(BOOK_ID_TO_NAME)

		let books: Record<BookId, BookData> = []
		for (const book_id_ of book_ids) {
			const book_id = Number(book_id_)
			let [name, chapter_count] = remembered?.[book_id]
				?? [BOOK_ID_TO_NAME[book_id], MAX_CHAPTER_COUNT]
			if (name === undefined) {
				continue
			}
			books[book_id] = new BookData(
				book_id,
				name,
				[...Array(chapter_count).keys()].map(x => x + 1),
			)
		}
		return books
	}

	/// Remembers `translation`'s book names and chapter counts so they're
	/// still available offline. See {@link MyBibleSettings._book_names}.
	async remember_books_data(translation: string, books: Record<BookId, BookData>) {
		// An object, not an array: saved as JSON, a sparse array would come
		// back with a null in every gap, book id 1 (Genesis) included
		let entry: Record<BookId, [name: string, chapter_count: number]> = {}
		for (const book_id_ of Object.keys(books)) {
			const book_id = Number(book_id_)
			entry[book_id] = [books[book_id].name, books[book_id].chapters.length]
		}

		let remembered = this.settings._book_names ?? {}
		if (JSON.stringify(remembered[translation]) === JSON.stringify(entry)) {
			return
		}
		// Replace the record rather than writing into it: when nothing has
		// been remembered yet it's still the object from DEFAULT_SETTINGS,
		// and saveSettings() drops any setting left identical to its default.
		this.settings._book_names = Object.assign({}, remembered, { [translation]: entry })
		await this.saveSettings()
	}

	show_toast_error(error:string) {
		if (this.progress_notice !== null) {
			this.progress_notice?.hide()
			this.progress_notice = null
		}
		new Notice("Error building bible: " + error, 0)
	}

	show_toast_progress(progress: number, finish: number|null) {
		if (progress === finish && finish != null) {
			this.progress_notice?.hide()
			this.progress_notice = null
			new Notice(BUILD_END_TOAST)
			return
		}

		if (this.progress_notice == null) {
			this.progress_notice = new Notice("", 0)
		}

		let msg = ""
		if (finish == null) {
			msg = "Building bible..."
		} else {
			msg = "Building bible... ({0}/{1})"
				.format(String(progress), String(finish))
		}
		this.progress_notice.setMessage(msg)
	}

	async loadSettings() {
		this.settings = Object.assign(
			new MyBibleSettings,
			DEFAULT_SETTINGS,
			await this.loadData(),
		)
	}

	async saveSettings() {
		let saving:Record<string, any> = {}
		Object.assign(saving, this.settings)
		for (const key in saving) {
			let value:any = (DEFAULT_SETTINGS as Record<string, any>)[key]
			if (saving[key] === value) {
				delete saving[key]
			}
		}
		delete saving["_plugin"]

		await this.saveData(saving)
	}
	
	async runJS(code:string, context?:any):Promise<any> {
		if (!this.settings.enable_javascript_execution) {
			throw new Error(
				"Can't execute javascript because `Enable Javascript excecution` is not enabled. Enable in MyBible settings."
			)
		}
		let call_result = await async function() {
			return eval("(async () => { {0} })()".format(code))
		}.call(context)
		return call_result
	}
}

class MBGeneralError extends Error {
	toString():string {
		let msg = "\n> [!ERROR] {0}\n".format(this.name)
		if (this.message.length !== 0) {
			msg += "> " + this.message + "\n"
		}
		return msg
	}
}

class MBTagError extends MBGeneralError {}

class MBValueParseError extends MBTagError {
	parsing_value:string
	constructor(parsing_value:string) {
		super("Parsing value: `{0}`".format(parsing_value))
		parsing_value = parsing_value
		this.name = "Failed to parse value"
	}
}

class MBArgValueParseError extends MBTagError {
	constructor(arg_name:string, err:MBValueParseError|undefined=undefined) {
		let msg = ""
		if (arg_name.length !== 0) {
			msg += "Parsing argument: `{0}`".format(arg_name)
		}
		if (err !== undefined) {
			msg += "\n> {0}".format(err.message)
		}
		super(msg)
		this.name = "Failed to parse value for argument"
	}
}

class FormatKeys {
	static translation = /{translation}/g
	static order = /{order}/g
	static book = /{book}/g
	static book_full = /{book_full}/g
	static book_short = /{book_short}/g
	static chapter = /{chapter}/g
	static chapter_name = /{chapter_name}/g
	static chapter_index = /{chapter_index}/g
	static last_chapter = /{last_chapter}/g
	static last_chapter_name = /{last_chapter_name}/g
	static last_chapter_book = /{last_chapter_book}/g
	static next_chapter = /{next_chapter}/g
	static next_chapter_name = /{next_chapter_name}/g
	static next_chapter_book = /{next_chapter_book}/g
	static first_chapter = /{first_chapter}/g
	static first_chapter_name = /{first_chapter_name}/g
	static final_chapter = /{final_chapter}/g
	static final_chapter_name = /{final_chapter_name}/g
	static verses = /{verses}/g
	static book_id = /{book_id}/g
	static verse_text = /{verse_text}/g
	static verse = /{verse}/g
	static index = /{index}/g
	static chapters = /{chapters}/g
	static old_testament = /{old_testament}/g
	static new_testament = /{new_testament}/g
	static apocrypha = /{apocrypha}/g
}

class BuildContext {
	translation: string = ""
	translation_texts: TranslationData
	books: Record<BookId, BookData> = {}
	/// List of book IDs sorted by their ordering as specified in the build settings
	sorted_book_ids: BookId[]
	/// Book of the current chapter
	book: BookData
	/// Book of previous chapter
	prev_book: BookData
	/// Book of next chapter
	next_book: BookData
	chapter: number = 1
	prev_chapter: number = 0
	next_chapter: number = 0
	chapters: ChapterData
	last_chapters: ChapterData
	next_chapters: ChapterData
	chapter_verse_count: number = 0
	verses_text: string = ""
	verse: number = 0
	verse_counts: VerseCounts
	plugin: MyBible

	/// Find index of book by ID
	find_book(book_id:BookId):number {
		return book_id
	}

	abbreviate_book_name(book:BookData, delimeter:string): string {
		if (book.id == DEFAULT_NAME_MAP["Judges"]) {
			return "Jdg"
		}
		if (book.id == DEFAULT_NAME_MAP["Philippians"]) {
			return "Php"
		}
		if (book.id == DEFAULT_NAME_MAP["Philemon"]) {
			return "Phm"
		}

		return book_id_to_name(book.id)
			.replace(delimeter, "")
			.slice(0,3);
	}

	format_book_name(
		book:BookData|undefined=undefined,
		style: BookNameStyle|undefined=BookNameStyle.Display,
	): string {
		if (book === undefined) {
			book = this.book
		}
		let delim = this.plugin.settings.book_name_delimiter
		let book_name = this.to_case(
			book.name,
			this.plugin.settings.book_name_capitalization,
			delim
		)

		if (
			(style === BookNameStyle.Abbreviated)
			|| (style === BookNameStyle.Display && this.plugin.settings.book_name_abbreviated)
		) {
			book_name = this.abbreviate_book_name(book, delim)
		}

		return this.plugin.settings.book_name_format
			.replace(FormatKeys.translation, String(this.translation))
			.replace(FormatKeys.book, book_name)
			.replace(
				FormatKeys.order,
				String(this.book_order(book))
					.padStart(2 * Number(this.plugin.settings.padded_order), "0")
			)
	}

	format_book_name_without_order(
		book:BookData|undefined=undefined,
		casing:string|undefined=undefined,
		style: BookNameStyle|undefined=BookNameStyle.Display,
	): string {
		if (book === undefined) {
			book = this.book
		}
		if (casing === undefined) {
			casing = this.plugin.settings.book_name_capitalization
		}
		let delim = this.plugin.settings.book_name_delimiter
		let book_name = this.to_case(
			book.name,
			casing,
			delim
		)

		if ( (style === BookNameStyle.Abbreviated) ||
		     (style === BookNameStyle.Display && this.plugin.settings.book_name_abbreviated) ) {
			book_name = this.abbreviate_book_name(book, delim)
			 }

		return book_name
	}
	
	format_chapter_body(): string {
		return this.plugin.settings.chapter_body_format
			.replace(FormatKeys.translation, String(this.translation))
			.replace(FormatKeys.book, this.format_book_name_without_order(this.book))
			.replace(FormatKeys.book_full, this.format_book_name_without_order(this.book, undefined, BookNameStyle.Full))
			.replace(FormatKeys.book_short, this.format_book_name_without_order(this.book, undefined, BookNameStyle.Abbreviated))
			.replace(
				FormatKeys.order,
				String(this.book_order(this.book))
					.padStart(2 * Number(this.plugin.settings.padded_order), "0")
			)
			.replace(FormatKeys.chapter, String(this.chapter))
			.replace(FormatKeys.chapter_name, this.format_chapter_name())
			.replace(FormatKeys.chapter_index, this.format_chapter_index_name(this.book))
			.replace(FormatKeys.last_chapter, String(this.prev_chapter))
			.replace(FormatKeys.last_chapter_name, this.format_chapter_name("last"))
			.replace(FormatKeys.last_chapter_book, this.format_book_name_without_order(this.prev_book))
			.replace(FormatKeys.next_chapter, String(this.next_chapter))
			.replace(FormatKeys.next_chapter_name, this.format_chapter_name("next"))
			.replace(FormatKeys.next_chapter_book, this.format_book_name_without_order(this.next_book))
			.replace(FormatKeys.first_chapter, String(this.book.chapters.first()))
			.replace(FormatKeys.first_chapter_name, this.format_chapter_name("first"))
			.replace(FormatKeys.final_chapter, String(this.book.chapters.last()))
			.replace(FormatKeys.final_chapter_name, this.format_chapter_name("final"))
			.replace(FormatKeys.verses, this.verses_text)
	}

	format_chapter_name(tense:string="current", custom_chapter:number|null = null): string {
		let format = this.plugin.settings.chapter_name_format;
		if (format.length == 0) {
			format = DEFAULT_SETTINGS.chapter_name_format;
		}

		let presentBook = this.book
		let book_name = "";
		let id = -1;
		let chapter = custom_chapter
		switch (tense) {
			case "current": {
				presentBook = this.book
				book_name = this.format_book_name_without_order(this.book);
				id = this.book.id
				chapter = this.chapter
				break;
			}
			case "last": {
				presentBook = this.prev_book
				book_name = this.format_book_name_without_order(this.prev_book);
				id = this.prev_book.id
				chapter = this.prev_chapter
				break;
			}
			case "next": {
				presentBook = this.next_book
				book_name = this.format_book_name_without_order(this.next_book);
				id = this.next_book.id
				chapter = this.next_chapter
				break;
			}
			case "first": {
				presentBook = this.book
				book_name = this.format_book_name_without_order(this.book);
				id = this.book.id
				chapter = this.book.chapters.first() || 1
				break;
			}
			case "final": {
				presentBook = this.book
				book_name = this.format_book_name_without_order(this.book);
				id = this.book.id
				chapter = this.book.chapters.last() || 1
				break;
			}
			case "custom": {
				book_name = this.format_book_name_without_order(this.book);
				id = this.book.id
				chapter = custom_chapter;
				break;
			}
			default: throw new Error("Unmatched switch case at tense '{0}'".format(tense));
		}

		if (chapter == null) {
			throw new Error("Chapter is null");
		}

		let chapter_pad_by = 1
		if (presentBook.chapters.length > 99) {
			chapter_pad_by = 3
		} else if (presentBook.chapters.length > 9) {
			chapter_pad_by = 2
		}

		return format
			.replace(FormatKeys.translation, String(this.translation))
			.replace(FormatKeys.book, book_name)
			.replace(
				FormatKeys.order,
				String(this.book_order(id))
					.padStart(2 * Number(this.plugin.settings.padded_order), "0")
			)
			.replace(
				FormatKeys.chapter,
				String(chapter)
					.padStart(chapter_pad_by * Number(this.plugin.settings.padded_chapter), "0"),
			)
	}

	format_verse_body(
		custom_text:string|undefined=undefined,
	): string {
		let book_name = this.format_book_name_without_order(
			this.book,
			"name_case",
		);

		let verse_text = ""
		if (custom_text !== undefined) {
			verse_text = custom_text
		} else if (this.plugin.settings.build_with_dynamic_verses) {
			verse_text = "``` verse\n"
				+ "{0} {1}:{2}\n".format(
					String(this.book.id),
					String(this.chapter),
					String(this.verse),
				)
				+ "```"
		} else {
			verse_text = this.plugin.bible_api.parse_html(
				this.translation_texts.books[this.book.id][this.chapter][this.verse] ?? ""
			)
			if (verse_text === undefined) {
				return ""
			}
		}

		if (verse_text === "") {
			return ""
		}

		return this.plugin.settings.verse_body_format
			.replace(FormatKeys.translation, String(this.translation))
			.replace(FormatKeys.book, book_name)
			.replace(FormatKeys.book_full, this.format_book_name_without_order(this.book, undefined, BookNameStyle.Full))
			.replace(FormatKeys.book_short, this.format_book_name_without_order(this.book, undefined, BookNameStyle.Abbreviated))
			.replace(FormatKeys.book_id, String(this.book.id))
			.replace(
				FormatKeys.order,
				String(this.book_order(this.book))
					.padStart(2 * Number(this.plugin.settings.padded_order), "0")
			)
			.replace(FormatKeys.chapter, String(this.chapter))
			.replace(FormatKeys.chapter_name, this.format_chapter_name())
			.replace(FormatKeys.verse_text, verse_text)
			.replace(FormatKeys.verse, String(this.verse))
	}

	format_chapter_index(book: BookData): string {
		let book_name = this.format_book_name_without_order(book)

		let chapter_links = ""

		// Format chapter links
		for (let i = 0; i != book.chapters.length; i++) {
			let chapter = book.get_chapter_number(i);
			let link = this.format_chapter_index_element(book, book_name, chapter)
			if (i != book.chapters.length-1) {
				link += "\n"
			}
			chapter_links += link
		}

		return this.plugin.settings.chapter_index_format
			.replace(FormatKeys.translation, String(this.translation))
			.replace(FormatKeys.book, book_name)
			.replace(FormatKeys.book_full, this.format_book_name_without_order(book, undefined, BookNameStyle.Full))
			.replace(FormatKeys.book_short, this.format_book_name_without_order(book, undefined, BookNameStyle.Abbreviated))
			.replace(FormatKeys.order, String(this.book_order(book)).padStart(2 * Number(this.plugin.settings.padded_order), "0"))
			.replace(FormatKeys.index, this.format_index_name())
			.replace(FormatKeys.chapters, chapter_links)
			.replace(FormatKeys.chapter_index, this.format_chapter_index_name(book))
		;
	}

	format_chapter_index_element(
		book:BookData|undefined=undefined,
		book_name: string|undefined=undefined,
		chapter: number|undefined=undefined,
	): string {
		if (book === undefined) {
			book = this.book
		}
		if (book_name === undefined) {
			book_name = this.format_book_name_without_order(book)
		}
		if (chapter === undefined) {
			chapter = this.chapter
		}
		return this.plugin.settings.chapter_index_link_format
			.replace(FormatKeys.translation, String(this.translation))
			.replace(FormatKeys.book, book_name)
			.replace(FormatKeys.book_full, this.format_book_name_without_order(book, undefined, BookNameStyle.Full))
			.replace(FormatKeys.book_short, this.format_book_name_without_order(book, undefined, BookNameStyle.Abbreviated))
			.replace(FormatKeys.order, String(this.book_order(book)).padStart(2 * Number(this.plugin.settings.padded_order), "0"))
			.replace(FormatKeys.chapter, String(chapter))
			.replace(FormatKeys.chapter_name, this.format_chapter_name("custom", chapter))
	}
	
	format_chapter_index_name(book: BookData|undefined=undefined): string {
		if (book === undefined) {
			book = this.book
		}
		let book_name = this.format_book_name_without_order(book)
		return this.plugin.settings.chapter_index_name_format
			.replace(FormatKeys.order, String(this.book_order(book)).padStart(2 * Number(this.plugin.settings.padded_order), "0"))
			.replace(FormatKeys.book, book_name)
			.replace(FormatKeys.book_full, this.format_book_name_without_order(book, undefined, BookNameStyle.Full))
			.replace(FormatKeys.book_short, this.format_book_name_without_order(book, undefined, BookNameStyle.Abbreviated))
			.replace(FormatKeys.translation, String(this.translation))
	}

	format_index_element(book:BookData|BookId|undefined=undefined) {
		let id = 0
		if (book === undefined) {
			id = this.book.id
		} else if (book instanceof BookData) {
			id = book.id
		} else {
			id = book
		}
		let book_name = this.format_book_name_without_order(this.books[id])

		let link = this.plugin.settings.index_link_format
			.replace(FormatKeys.translation, String(this.translation))
			.replace(FormatKeys.book, book_name)
			.replace(FormatKeys.order, String(this.book_order(Number(id))).padStart(2 * Number(this.plugin.settings.padded_order), "0"))
			.replace(FormatKeys.chapter_index, this.format_chapter_index_name(this.books[id]))
			+ '\n'
		return link
	}
	
	format_index_name(): string {
		return this.plugin.settings.index_name_format
			.replace(FormatKeys.translation, this.translation)
	}

	format_index(): string {
		let old_t_links = ""
		let new_t_links = ""
		let apocr_links = ""

		// Format all book links
		for (const ID_ in this.books) {
			const ID = Number(ID_)
			let link = this.format_index_element(ID)

			if (this.books[ID].id < 40) {
				old_t_links += link 
			} else if (this.books[ID].id < 67) {
				new_t_links += link 
			} else {
				apocr_links += link 
			}
		}

		old_t_links = old_t_links.slice(0, old_t_links.length-1)
		new_t_links = new_t_links.slice(0, new_t_links.length-1)
		apocr_links = apocr_links.slice(0, apocr_links.length-1)

		return this.plugin.settings.index_format
			.replace(FormatKeys.translation, this.translation)
			.replace(FormatKeys.old_testament, old_t_links)
			.replace(FormatKeys.new_testament, new_t_links)
			.replace(FormatKeys.apocrypha, apocr_links)
	}

	set_book(book:BookData) {
		this.book = book;

		let [next_book, next_chapter] = this.next_chapter_of(this.book, this.chapter)
		let [prev_book, prev_chapter] = this.prev_chapter_of(this.book, this.chapter)
		this.next_book = next_book
		this.next_chapter = next_chapter
		this.prev_book = prev_book
		this.prev_chapter = prev_chapter
	}

	set_book_and_chapter(book:BookData, chapter:number) {
		this.chapter = chapter
		this.set_book(book)
	}

	set_books(books:Record<BookId, BookData>) {
		this.books = books
		this.sorted_book_ids = (
			Object.keys(this.books)
		).map((x) => Number(x)).sort((a, b) => this.book_order(a)-this.book_order(b))
	}

	next_chapter_of(
		book: BookData,
		chapter:number,
	): [next_book:BookData, next_chapter:number] {
		let next_book:BookData = book
		if (chapter === book.chapters.last()) {
			// This is the final chapter. Next book is not the same
			// as the current book
			let current_book_index = 0
			for (const i of this.sorted_book_ids.keys()) {
				if (this.sorted_book_ids[i] === book.id) {
					current_book_index = i
					break;
				}
			}
			if (current_book_index == this.sorted_book_ids.length-1) {
				// `book` is last book. Next book is first book
				next_book = this.books[this.sorted_book_ids[0]]
			} else {
				// Set next_book to book after current
				next_book = this.books[this.sorted_book_ids[current_book_index+1]]
			}
		}

		let next_chapter = chapter+1
		if (next_book.id !== book.id) {
			// Get first chapter of next book
			next_chapter = next_book.chapters[0]
		}

		return [next_book, next_chapter]
	}

	prev_chapter_of(
		book: BookData,
		chapter:number,
	): [prev_book:BookData, prev_chapter:number] {
		let prev_book:BookData = book
		if (chapter === book.chapters.first()) {
			// This is the first chapter. Previous book is not the same
			// as the current book
			let current_book_index = 0
			for (const i of this.sorted_book_ids.keys()) {
				if (this.sorted_book_ids[i] === book.id) {
					current_book_index = i
					break;
				}
			}
			if (current_book_index == 0) {
				// `book` is first book. Previous book is last book
				prev_book = this.books[
					this.sorted_book_ids[this.sorted_book_ids.length-1]
				]
			} else {
				// Set prev_book to book before current
				prev_book = this.books[this.sorted_book_ids[current_book_index-1]]
			}
		}

		let prev_chapter = chapter-1
		if (prev_book.id !== book.id) {
			// Get last chapter of previous book
			prev_chapter = prev_book.chapters[prev_book.chapters.length-1]
		}

		return [prev_book, prev_chapter]
	}

	book_order(
		book: BookData|BookId|null = null,
	) {
		let book_obj:BookData
		if (book == null) {
			book_obj = this.book
		} else if (book instanceof BookData) {
			book_obj = book
		} else {
			book_obj = this.books[book]
		}

		if (this.plugin.settings.book_ordering === "hebraic") {
			return to_hebraic_order(book_obj.id)
		}
		return book_obj.id
	}

	set_chapter(chapter:number) {
		this.chapter = chapter
		this.set_book(this.book)
	}

	// Sets the capitalization of the given name depending on *name_case*.
	to_case(name:string, name_case:string, delimeter:string): string {
		name = name.replace(/ /g, delimeter)
		if (name_case == "lower_case") {
			name = name.toLowerCase()
		} else if (name_case == "upper_case") {
			name = name.toUpperCase()
		}
		return name;
	}

	get_verse_count():number {
		return this.verse_counts.get_count_for(this.book.id, this.chapter);
	}
}

class VerseCounts {
	books: Record<BookId, Record<number, number>>

	get_count_for(book:BookId, chapter:number): number {
		return this.books[book][chapter] || 0
	}
}

interface TranslationData {
	translation: string;
	books: Record<BookId, Record<number, ChapterData>>;
}
class BookData {
	/// The Book's numeric ID
	id: number;
	/// The chapters included in this book by their numeric order
	chapters: number[];
	/// The display name for the book
	name: string;

	constructor(id:number, name:string, chapters:number[]) {
		this.id = id
		this.name = name
		this.chapters = chapters
	}

	/// Returns the number of the chapter at index
	get_chapter_number(index:number): number {
		if (index >= this.chapters.length) {
			throw new Error("")
		}
		return this.chapters[index]
	}

	has_chapter(chapter:number): boolean {
		return this.chapters.find((value, _, __) => value === chapter) !== undefined
	}
}

type BookId = number;

/// A record of verses to texts
type ChapterData = Record<number, string>;

/// Ensures all coroutines wait for the same piece of code to finish
class SyncCache {
	syncs:Record<string, SyncCacheItem> = {}

	async sync(key:string, body:() => any): Promise<any> {
		if (!(key in this.syncs)) {
			this.syncs[key] = new SyncCacheItem()
		}
		let sync_item = this.syncs[key]

		sync_item.ref_count += 1


		try {
			await sync_item.mutex
				.acquire()
				.then(async () => {
					sync_item.data = await body()
	
					sync_item.mutex.cancel()
					sync_item.mutex.release()
				})
				.catch(e => {
					if (e === E_CANCELED) {
						/*pass*/
					} else {
						throw e
					}
				})
			;

		} finally {
			sync_item.ref_count -= 1
			if (sync_item.ref_count === 0) {
				delete this.syncs[key]
			}
		}
		
		
		return sync_item.data
	}
}
class SyncCacheItem {
	mutex: Mutex = new Mutex()
	data: any = null
	ref_count: number = 0
}

class BibleAPI {
	cache_clear_timer: Promise<null> | null = null
	cache_clear_timer_promise_err: (reason?: any) => void
	sync_cache: SyncCache = new SyncCache()
	plugin: MyBible

	async _get_book_data(translation: string, book_id:BookId): Promise<BookData> {
		throw new Error("unimplemented")
	}

	async _get_books_data(translation: string): Promise<Record<BookId, BookData>> {
		throw new Error("unimplemented")
	}

	async _get_chapter(
		translation: string,
		book_id: number,
		chapter: number,
	): Promise<ChapterData> {
		throw new Error("unimplemented")
	}

	async _get_translation(translation: string): Promise<TranslationData> {
		throw new Error("unimplemented")
	}

	async _get_translations(): Promise<Translations> {
		throw new Error("unimplemented")
	}

	async _get_default_translation(): Promise<string> {
		throw new Error("unimplemented")
	}

	async _get_verse(
		translation: string,
		book_id: number,
		chapter: number,
		verse: number,
	): Promise<string> {
		let chapter_data = await this.get_chapter(
			translation,
			book_id,
			chapter,
		);
		return chapter_data[verse] || "";
	}

	async _get_verse_count(translation:string): Promise<VerseCounts> {
		throw new Error("unimplemented")
	}

	/// Downloads a translation and saves it locally.
	async user_download_translation(translation:string) {
		let notify = new Notice(
			"Downloading {0} translation".format(translation),
			0,
		)

		let promises = []
		let translation_data = await this.get_translation(translation)
		for (const book_id_ in translation_data.books) {
			const book_id = Number(book_id_)
			const chapters = translation_data.books[book_id]
			for (const chapter_key of Object.keys(chapters)) {
				const chapter = Number(chapter_key)
				const chapter_data = chapters[chapter]
				promises.push(this.save_chapter_data(
					chapter_data,
					translation,
					book_id,
					chapter,
				))
			}
		}

		notify.hide()
		notify = new Notice("Saving {0} translation files".format(translation), 0)
		await Promise.all(promises)

		notify.hide()
		new Notice("Download complete")
	}

	// Get book ID from translation and book name
	async book_id(translation:string, book_name:string): Promise<number> {
		let books = await this.get_books_data(translation);
		for (const i of Object.keys(books) as unknown as BookId[]) {
			if (books[i].name === book_name) {
				return books[i].id;
			}
		}
		if (book_name in DEFAULT_NAME_MAP) {
			return DEFAULT_NAME_MAP[book_name];
		}

		throw new Error(
			"Translation '{0}' has no book named '{1}'"
				.format(translation, book_name)
		);
	}

	async get_book_data(translation: string, book_id:BookId): Promise<BookData> {
		let book_key = "{0}_{1}".format(translation, String(book_id));

		let data = await this.sync_cache.sync(
			"get_book_data_" + book_key,
			() => this._get_book_data(translation, book_id),
		)

		if (data == null) {
			throw new Error();
		}

		return data;
	}

	async get_books_data(translation: string): Promise<Record<BookId, BookData>> {
		let books = await this.sync_cache.sync(
			"get_books_data_" + translation,
			() => this._get_books_data(translation),
		)
		// Keep a copy for when the API can't be reached
		this.plugin.remember_books_data(translation, books).catch(() => {})
		return books
	}

	async cache_chapter(
		translation: string,
		book_id: number,
		chapter: number,
		chapter_data: ChapterData | null,
		save_locally: boolean,
	): Promise<void> {
		let key = this.make_chapter_key(translation, book_id, chapter);

		// Save chapter to local file sytem
		let cache_path = this.get_cache_path();
		this.plugin.app.vault.adapter.mkdir(cache_path);
		let cached_file_name = "{0} {1} {2}.txt"
			.format(translation, String(book_id), String(chapter));
		let cached_file_path = normalizePath(
			cache_path + "/" + cached_file_name,
		);
		if (
			chapter_data != null
			&& !await this.plugin.app.vault.adapter.exists(cached_file_path)
		) {
			await this.plugin.app.vault.adapter.write(
				cached_file_path,
				this.make_chapter_file(chapter_data),
			);
		}

		// Start/refresh cache clear timer
		if (this.cache_clear_timer !== null && this.cache_clear_timer_promise_err !== null) {
			// Clear out old promise
			this.cache_clear_timer_promise_err(null);
		}
		this.cache_clear_timer = new Promise((ok, err) => {
			this.cache_clear_timer_promise_err = err;
			setTimeout(ok, 60000 * 60) // Timeout after 1 hour
		});
		this.cache_clear_timer
			.then(() => this.clear_local_files())
			.catch(err => { });
	}

	async get_chapter(
		translation: string,
		book_id: number,
		chapter: number,
	): Promise<ChapterData> {
		let chapter_key = this.make_chapter_key(translation, book_id, chapter);

		let file_name = this.make_chapter_file_name(translation, book_id, chapter)

		let download_path = this.get_download_path()
		this.plugin.app.vault.adapter.mkdir(download_path)
		let download_file_path = normalizePath(
			download_path + "/" + file_name
		)

		let cache_path = this.get_cache_path()
		this.plugin.app.vault.adapter.mkdir(cache_path)
		let cached_file_path = normalizePath(
			cache_path + "/" + file_name
		)

		let data = await this.sync_cache.sync(
			"get_chapter_"+chapter_key,
			async () => {
				// Attempt to load chapter locally
				if ( await this.plugin.app.vault.adapter
					.exists(download_file_path)
				) {
					// Load from download
					return await this.load_chapter_file(download_path, file_name)
				} else if ( await this.plugin.app.vault.adapter
					.exists(cached_file_path)
				) {
					// Load from cache
					return await this.load_chapter_file(cache_path, file_name)
				}

				// Fetch chapter from the web
				let chapterData = await this._get_chapter(
					translation,
					book_id,
					chapter,
				)
				for (const KEY_ of Object.keys(chapterData)) {
					const KEY = Number(KEY_)
					chapterData[KEY] = chapterData[KEY]
				}
				return chapterData
			},
		)

		if (
			data === null
			|| Object.keys(data).length == 0
		) {
			// Failed to load or download chapter
			return [];
		}

		new Promise(async (ok, err) => {
			// Cache chapter if not downloaded
			try {
				if (
					!await this.plugin.app.vault.adapter
						.exists(download_file_path)
				) {
					this.cache_chapter(
						translation,
						book_id,
						chapter,
						data,
						this.plugin.settings.store_locally,
					);
				}
				ok(null)
			} catch (e) {
				err(e)
			}
		})

		return data;
	}

	get_cache_path(): string {
		return normalizePath(this.plugin.manifest.dir + "/.mybiblecache");
	}

	get_download_path(): string {
		return normalizePath(this.plugin.manifest.dir + "/.chapters");
	}

	async get_translation(translation: string): Promise<TranslationData> {
		return await this.sync_cache.sync(
			"get_translation_" + translation,
			() => this._get_translation(translation),
		)
	}

	async get_default_translation(): Promise<string> {
		return await this.sync_cache.sync(
			"get_default_translation",
			() => this._get_default_translation(),
		)
	}

	async get_translations(): Promise<Translations> {
		return await this.sync_cache.sync(
			"get_translations",
			() => this._get_translations(),
		)
	}

	async get_verse(
		translation: string,
		book_id: number,
		chapter: number,
		verse: number,
	): Promise<string> {
		let key = "get_verse_{0}_{1}_{2}_{3}".format(translation, String(book_id), String(chapter), String(verse))
		return await this.sync_cache.sync(
			key,
			() => this._get_verse(
				translation,
				book_id,
				chapter,
				verse,
			),
		)
	}

	async get_verse_count(translation:string): Promise<VerseCounts> {
		return await this.sync_cache.sync(
			"get_verse_count_"+translation,
			() => this._get_verse_count(translation),
		)
	}

	async clear_local_files() {
		this.cache_clear_timer = null;

		let cache_path = this.get_cache_path();
		if (await this.plugin.app.vault.adapter.exists(cache_path)) {
			if (!await this.plugin.app.vault.adapter.trashSystem(cache_path)) {
				await this.plugin.app.vault.adapter.trashLocal(cache_path);
			}
		}

		let download_path = this.get_download_path();
		if (await this.plugin.app.vault.adapter.exists(download_path)) {
			if (!await this.plugin.app.vault.adapter.trashSystem(download_path)) {
				await this.plugin.app.vault.adapter.trashLocal(download_path);
			}
		}
	}

	async load_chapter_file(folder:string, path: string): Promise<ChapterData> {
		this.plugin.app.vault.adapter.mkdir(folder)
		let raw = await this.plugin.app.vault.adapter
			.read(folder + "/" + path)
		;
		
		let verse_list = []
		if (raw.startsWith("[")) {
			verse_list = JSON.parse(raw)
		} else {
			verse_list = raw.split("\n")
		}
		
		let verses:ChapterData = {}
		for (let i = 0; i != verse_list.length; i++) {
			if (verse_list[i].length == 0) {
				continue
			}
			verses[i+1] = verse_list[i]
		}
		return verses
	}

	make_chapter_file(chapter_data:ChapterData): string {
		let added_verse_count = 0
		let body = "";
		for (let i = 1; added_verse_count !== Object.keys(chapter_data).length; i++) {
			if (i in chapter_data) {
				body += chapter_data[i]
				added_verse_count += 1
			}
			if (added_verse_count !== Object.keys(chapter_data).length) {
				body += "\n"
			}
		}
		
		return body
	}

	/// Makes the file name for downloaded chapters
	make_chapter_file_name(translation: string, book_id: number, chapter: Number): string {
		return "{0} {1} {2}.txt".format(translation, String(book_id), String(chapter));
		
	}

	make_chapter_key(translation: string, book_id: number, chapter: Number) {
		return "{0}_{1}_{2}".format(translation, String(book_id), String(chapter));
	}

	parse_html(html:string):string {
		html = html
			// Replace <i>x with *x
			.replace(/<\s*i\s*>(\s*)/g, (_, ws) => { return ws + "*" })
			// Replace x</i> with x*
			.replace(/(\s*)<\s*\/\s*i\s*>/g, (_, ws) => { return "*" + ws })
			// Replace <b>x with **x
			.replace(/<\s*b\s*>(\s*)/g, (_, ws) => { return ws + "**" })
			// Replace x</b> with x**
			.replace(/(\s*)<\s*\/\s*b\s*>/g, (_, ws) => { return "**" + ws })
			// Replace <S>x with <sup>*x
			.replace(/<\s*[S]\s*>(\s*)/g, (_, ws) => { return ws + "<sup>" })
			// Replace x</S> with x*</sup>
			.replace(/(\s*)<\s*\/\s*[S]\s*>/g, (_, ws) => { return "</sup>" + ws })
			// Breakline tag
			.replace(/<\s*br\s*\/?>/g, "\n")
		;
		return html
	}

	async pick_random_verse(seed:string|undefined=undefined): Promise<string> {
		return mb.randRef(seed).toString()
	}

	/// Saves chapter data to local disk
	async save_chapter_data(
		chapter_data:ChapterData,
		translation:string,
		book_id:number,
		chapter:number,
	) {
		// Save chapter to local file sytem
		let path = this.get_download_path();
		this.plugin.app.vault.adapter.mkdir(path);
		let file_name = this
			.make_chapter_file_name(translation, book_id, chapter);
		let file_path = normalizePath(
			path + "/" + file_name,
		);
		if (
			!await this.plugin.app.vault.adapter.exists(file_path)
		) {
			let body = "";
			for (const i_ in chapter_data) {
				const i = Number(i_)
				body += chapter_data[i];
				if (i !== Object.keys(chapter_data).length) {
					body += "\n"
				}
			}
			await this.plugin.app.vault.adapter.write(
				file_path,
				body,
			);
		}
	}
}

type Translations = Record<string, Translation>;
interface Translation {
	display_name: string,
	abbreviated_name: string,
	language: string,
}

class BollsLifeBibleAPI extends BibleAPI {
	plugin: MyBible
	translations: Translations = {}
	translation_maps: Record<string, Record<BookId, BookData>> = {}
	cache_clear_timer: Promise<null> | null = null
	sync_cache: SyncCache = new SyncCache()

	async _get_chapter(
		translation: string,
		book_id: number,
		chapter: number,
	): Promise<ChapterData> {
		// Fetch chapter from the web
		try {
			let verse_data_list = JSON.parse(await httpGet(
				"https://bolls.life/get-chapter/{0}/{1}/{2}/"
					.format(translation, String(book_id), String(chapter))
			));

			let texts:ChapterData = {}
			for (const data of verse_data_list) {
				let verse = data["verse"]
				texts[verse] = String(data["text"])
			}

			return texts
		} catch (e) {
			if (e instanceof Error && e.message.startsWith("No book exists by name")) {
				return [];
			}
			throw e;
		}
	}

	async _get_translation(translation: string): Promise<TranslationData> {
		let verses = JSON.parse(
			await httpGet(
				"https://bolls.life/static/translations/{0}.json".format(translation)
			)
		);

		let bible: TranslationData = {
			translation: translation,
			books: {},
		}

		await new Promise(async (ok, err) => {
			try {
				let i = 0;
				let curr_book_id = -1;
				let curr_chapter = -1;
				for (const data of verses) {
					let verse_text = String(data["text"])

					let verse = data["verse"]
	
					curr_book_id = data["book"]
					curr_chapter = data["chapter"]
	
					if (!(curr_book_id in bible.books)) {
						bible.books[curr_book_id] = []	
					}
					if (!(curr_chapter in bible.books[curr_book_id])) {
						bible.books[curr_book_id][curr_chapter] = {}
					}
	
					bible.books[curr_book_id][curr_chapter][verse] = verse_text
					i += 1;
				}
				ok(null);
			} catch (e) {
				err(e)
			}
		}).catch(e => {
			throw e
		})

		return bible;
	}

	async _get_book_data(translation: string, book_id:BookId): Promise<BookData> {
		let books = await this.get_books_data(translation);
		for (const BOOK_ID of Object.keys(books) as unknown as BookId[]) {
			let book = books[BOOK_ID]
			if (book.id == book_id) {
				return book;
			}
		}
		throw new Error();
	}

	async _get_books_data(translation: string): Promise<Record<BookId, BookData>> {
		let books = await this.get_translation_map(translation);
		return books;
	}

	async _get_default_translation(): Promise<string> {
		return "YLT";
	}

	async _get_translations(): Promise<Translations> {
		if (Object.keys(this.translations).length === 0) {
			let list = JSON.parse(await httpGet(
				"https://bolls.life/static/bolls/app/views/languages.json"
			));
			for (let language of list) {
				for (let item of language["translations"]) {
					if (item["short_name"] in this.translations) {
						throw new Error("Translation already added to map");
					}
					this.translations[item["short_name"]] = {
						abbreviated_name: item["short_name"],
						display_name: item["full_name"],
						language: language["language"],
					};
				}
			}
		}
		return this.translations;
	}

	async _get_verse_count(translation:string): Promise<VerseCounts> {
		let json = JSON.parse(await httpGet(
			"https://bolls.life/get-verse-counts/{0}/".format(translation)
		));
		let counts = new VerseCounts();
		counts.books = json;
		return counts
	}

	async book_to_id(translation: string, book: string): Promise<number> {
		let book_ = book.toLowerCase();
		let map = await this.get_translation_map(translation);
		for (let i in map) {
			let book_data = map[i];
			if (book_ == book_data["name"].toLowerCase()) {
				return Number(i) + 1;
			}
		}
		throw new Error('No book exists by name {0}.'.format(book));
	}

	chapter_key(translation: string, book_id: number, chapter: Number) {
		return "{0}.{1}.{2}".format(translation, String(book_id), String(chapter));
	}

	async generate_translation_map(translation: string) {
		let map: Array<Record<string, any>> = JSON.parse(await httpGet(
			"https://bolls.life/get-books/{0}/".format(translation)
		));
		let book_data: Record<BookId, BookData> = [];
		for (let item of map) {
			let chapter_list = [...Array(item["chapters"]).keys()].map(x => x+1)
			book_data[item["bookid"]] = new BookData(
				item["bookid"],
				item["name"],
				chapter_list,
			);
		}
		this.translation_maps[translation] = book_data;
	}

	async id_to_book(translation: string, book_id: number): Promise<string> {
		let map = await this.get_translation_map(translation);
		return map[book_id - 1]["name"];
	}

	async get_translation_map(translation: string): Promise<Record<BookId, BookData>> {
		if (!(translation in this.translation_maps)) {
			await this.generate_translation_map(translation);
		}
		return this.translation_maps[translation];
	}
}

const BOOK_ORDERING_LINK = "https://gslogimaker.github.io/my-bible-obsidian-plugin/documents/Book_Ordering"
const CHAPTER_NAME_FORMAT_LINK = "https://gslogimaker.github.io/my-bible-obsidian-plugin/documents/Format_Settings.html#md:chapters--name-format"
const CHAPTER_BODY_FORMAT_LINK = "https://gslogimaker.github.io/my-bible-obsidian-plugin/documents/Format_Settings.html#md:chapters--body-format"
const VERSES_FORMAT_LINK = "https://gslogimaker.github.io/my-bible-obsidian-plugin/documents/Format_Settings.html#md:verses--format"
const BOOK_NAME_FORMAT_LINK = "https://gslogimaker.github.io/my-bible-obsidian-plugin/documents/Format_Settings.html#md:books--name-format"
const BOOK_INDEX_NAME_FORMAT_LINK = "https://gslogimaker.github.io/my-bible-obsidian-plugin/documents/Format_Settings.html#md:book-index--name-format"
const BOOK_INDEX_ELEMENT_FORMAT_LINK = "https://gslogimaker.github.io/my-bible-obsidian-plugin/documents/Format_Settings.html#md:book-index--book-element-format"
const BOOK_INDEX_BODY_FORMAT_LINK = "https://gslogimaker.github.io/my-bible-obsidian-plugin/documents/Format_Settings.html#md:book-index--body-format"
const CHAPTER_INDEXS_NAME_FORMAT_LINK = "https://gslogimaker.github.io/my-bible-obsidian-plugin/documents/Format_Settings.html#md:chapter-indexes--name-format"
const CHAPTER_INDEXS_ELEMENT_FORMAT_LINK = "https://gslogimaker.github.io/my-bible-obsidian-plugin/documents/Format_Settings.html#md:chapter-indexes--book-element-format"
const CHAPTER_INDEXS_BODY_FORMAT_LINK = "https://gslogimaker.github.io/my-bible-obsidian-plugin/documents/Format_Settings.html#md:chapter-indexes--body-format"

class BuilderModal extends Modal {
	plugin: MyBible
	builder: BuildContext

	description_updators: Record<string, ()=>void>

	constructor(app: App, plugin: MyBible) {
		super(app);
		this.plugin = plugin;
		this.description_updators = {}

		this.builder = new BuildContext
		this.builder.plugin = plugin
		this.builder.translation = this.plugin.settings.translation
		this.builder.verse = 35
		this.builder.translation_texts = {
			"translation": this.builder.translation,
			"books": {
				1: {1: ["UNREACHABLE"]},
				22: {5: ["UNREACHABLE"]},
				43: {11: [
					"", "", "", "", "", "", "", "", "", "",
					"", "", "", "", "", "", "", "", "", "",
					"", "", "", "", "", "", "", "", "", "",
					"Jesus wept.",
				]}
			}
		}
		this.builder.chapter = 11
		this.builder.set_books({
			1: new BookData(1, "Genesis", [1, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
			22: new BookData(22, "Song of Solomon", [0, 0, 0, 0, 1]),
			43: new BookData(43, "John", [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 35]),
		})
		this.builder.set_book(this.builder.books[43])

		this.render();
	}

	render() {
		let containerEl = this.contentEl;

		new Setting(containerEl).nameEl.createEl("h1", { text: "Book builder" })

		// Top settings

		this.renderBibleFolder(new Setting(containerEl));

		new Setting(containerEl)
			.setName('Translation')
			.setDesc('Builds your Bible according to the layout of this tranlsation. If "Build with dynamic verses" is active, then the text from this version will be built into your Bible.')
			.addDropdown(async drop => {
				drop.addOption(
					SELECTED_TRANSLATION_OPTION_KEY,
					SELECTED_TRANSLATION_OPTION
						.format(this.plugin.settings.reading_translation)
				)

				let translations = await this.plugin.bible_api.get_translations()
				
				let translations_list = []
				for (const key in translations) {
					translations_list.push(key)
				}
				translations_list = translations_list.sort((a, b) => {
					if (translations[a].language < translations[b].language) {
						return -1
					}
					if (translations[a].language > translations[b].language) {
						return 1
					}

					if (a < b) {
						return -1
					}
					if (a > b) {
						return 1
					}

					return 0
				})

				for (const i in translations_list) {
					let key = translations_list[i];
					drop.addOption(
						key,
						translation_to_display_name(translations[key]),
					);
				}
				drop.onChange(async value => {
					await this.plugin.settings.set_translation(value)
					this.update_descriptions()
					await this.plugin.saveSettings()
				})
				drop.setValue(this.plugin.settings.translation)
			})
		;

		this.renderBuildButton(new Setting(containerEl));

		new Setting(containerEl).nameEl.createEl("h3", { text: "Advanced" })


		// Chapters

		new Setting(containerEl).nameEl.createEl("h4", { text: "Chapters" })
		
		this.renderChapterName(new Setting(containerEl));

		this.renderChapterFormat(new Setting(containerEl));
					
		let chapter_padding_setting = new Setting(containerEl)
			.setName('Pad numbers')
			.addToggle(toggle => toggle
				.setTooltip("Toggle alignment padding of chapter numbers")
				.setValue(this.plugin.settings.padded_chapter)
				.onChange(async (value) => {
					this.plugin.settings.padded_chapter = value
					this.update_descriptions()
					await this.plugin.saveSettings()
				}))
		this.description_updators["chapter_padding"] = () => {
			let desc = chapter_padding_setting.descEl
			this.builder.set_book_and_chapter(this.builder.books[1], 1)
			desc.empty()
			desc.appendText('When active, pads chapter numbers with extra zeros.')
			desc.appendText('For example, "Psalms 5" would become "Psalms 005".')
			desc.createEl("br")
			desc.appendText('Current syntax: ')
			desc.createEl("br")
			desc.createEl("b", {
				"text": this.builder.format_chapter_name(),
				"cls": "u-pop",
			})
		}

		// Verses

		new Setting(containerEl).nameEl.createEl("h4", { text: "Verses" })

		this.renderVerseFormat(new Setting(containerEl))

		new Setting(containerEl)
			.setName('Build with dynamic verses')
			.setDesc('When active, your Bible will be built with verse references that can be quickly changed when you switch translations. When inactive, the text of the translation is built directly into your Bible.')
			.addToggle(toggle => toggle
				.setTooltip("Toggle generating with dynamic verses")
				.setValue(this.plugin.settings.build_with_dynamic_verses)
				.onChange(async (value) => {
					this.plugin.settings.build_with_dynamic_verses = value;
					await this.plugin.saveSettings();
				}))

		// Books
		let books_header = new Setting(containerEl)
		books_header.nameEl.createEl("h4", { text: "Books" })
		books_header.addToggle(toggle => {toggle
			.setTooltip("Toggle if books should generate folders")
				.setValue(this.plugin.settings.book_folders_enabled)
				.onChange(async value => {
					this.plugin.settings.book_folders_enabled = value;
					await this.plugin.saveSettings();
				})
		})
		this.renderBookFormat(new Setting(containerEl));
		this.renderNameDelimeter(new Setting(containerEl));
		this.renderBookCapitalization(new Setting(containerEl));
		this.renderBookAbbreviation(new Setting(containerEl));
		this.renderPaddedOrderNums(new Setting(containerEl));
		this.renderBookOrdering(new Setting(containerEl));

		// Book index
		let index_header  = new Setting(containerEl)
		let index_name  = new Setting(containerEl)
		let index_links  = new Setting(containerEl)
		let index_body  = new Setting(containerEl)
		index_header
			.addToggle(toggle => {toggle
				.setTooltip("Toggle book index generation")
				.setValue(this.plugin.settings.index_enabled)
				.onChange(async value => {
					this.plugin.settings.index_enabled = value;
					await this.plugin.saveSettings();
				})
			})
			.nameEl.createEl("h4", { text: "Book index" })
		;

		this.renderIndexName(index_name)
		this.renderIndexBookLink(index_links)
		this.renderIndexBody(index_body)

		// Chapter index
		let chapter_index_header  = new Setting(containerEl)
		let chapter_index_name  = new Setting(containerEl)
		let chapter_index_links  = new Setting(containerEl)
		let chapter_index_body  = new Setting(containerEl)
		chapter_index_header
			.addToggle(toggle => {toggle
				.setTooltip("Toggle chapter index generation")
				.setValue(this.plugin.settings.chapter_index_enabled)
				.onChange(async value => {
					this.plugin.settings.chapter_index_enabled = value;
					await this.plugin.saveSettings();
				})
			})
			.nameEl.createEl("h4", { text: "Chapter indexes" })
		;
		this.renderChapterIndexName(chapter_index_name)
		this.renderChapterIndexLink(chapter_index_links)
		this.renderChapterIndexBody(chapter_index_body)

		// After

		this.renderBuildButton(new Setting(containerEl));

		this.update_descriptions()
	}

	// Top renderers

	renderBibleFolder(setting: Setting) {
		setting.clear()
		setting
			.setName('Folder')
			.setDesc('The path to the folder where your Bible will be placed. The folder should be empty for your Bible. If the path does not exist it will be created.')
			.addExtraButton(btn => btn
				.setIcon("rotate-ccw")
				.setTooltip("Reset value")
				.onClick(async () => {
					this.plugin.settings.bible_folder
						= DEFAULT_SETTINGS.bible_folder;
					this.renderBibleFolder(setting);
					await this.plugin.saveSettings();
				})
			)
			.addText(text => text
				.setPlaceholder("Example: " + DEFAULT_SETTINGS.bible_folder)
				.setValue(this.plugin.settings.bible_folder)
				.onChange(async (value) => {
					this.plugin.settings.bible_folder = value;
					await this.plugin.saveSettings();
				})
			)
		;
	}

	renderBuildButton(setting: Setting) {
		setting
			.addButton(btn => btn
				.setButtonText("Build")
				.setTooltip("Build your bible")
				.setCta()
				.onClick(async _ => {
					this.close()
					await this.plugin.build_bible()
				})
			)
		;
	}

	// Book renderers

	renderBookFormat(setting: Setting) {
		setting.clear()
		setting
			.setName('Name format')
			.setDesc('The format for the names of the folders of each book of the bible. For example, "{order} {name}" would become "2 Exodus". Leave blank to not have folders for each book.')
			.addExtraButton(btn => btn
				.setIcon("rotate-ccw")
				.setTooltip("Reset value")
				.onClick(async () => {
					this.plugin.settings.book_name_format
						= DEFAULT_SETTINGS.book_name_format
					this.renderBookFormat(setting)
					this.update_descriptions()
					await this.plugin.saveSettings()
				})
			)
			.addText(text => text
				.setPlaceholder("Example: " + DEFAULT_SETTINGS.book_name_format)
				.setValue(this.plugin.settings.book_name_format)
				.onChange(async (value) => {
					this.plugin.settings.book_name_format = value
					this.update_descriptions()
					await this.plugin.saveSettings()
				})
			)
		;
		this.description_updators["book_name"] = () => {
			let desc = setting.descEl
			this.builder.set_book_and_chapter(this.builder.books[43], 11)
			desc.empty()
			desc.appendText('The format for the names of the folders of each book of the bible. For example, "{order} {name}" would become "2 Exodus". Leave blank to not have folders for each book. ')
			desc.createEl("a", {
				"text":"More about formatting",
				"href":BOOK_NAME_FORMAT_LINK,
			})
			desc.appendText(". ")
			desc.createEl("br", "")
			desc.appendText("Current syntax: ")
			desc.createEl("br")
			desc.createEl("b", {
				"text": "{0}".format(this.builder.format_book_name()),
				"cls": "u-pop",
			})
		}
	}

	renderBookAbbreviation(setting: Setting) {
		setting.clear()
		setting
			.setName('Abbreviate names')
			.setDesc('When active, The names of books will be abbreviated to three letters. For example, "Genesis" becomes "Gen" and "1 Kings" becomes "1Ki". (May cause issues in some translations.)')
			.addToggle(toggle => toggle
				.setTooltip("Toggle book name abbreviation")
				.setValue(this.plugin.settings.book_name_abbreviated)
				.onChange(async (value) => {
					this.plugin.settings.book_name_abbreviated = value;
					this.update_descriptions()
					await this.plugin.saveSettings();
				})
			)
		;
	}

	renderBookCapitalization(setting: Setting) {
		setting.clear()
		setting
			.setName('Name capitalization')
			.setDesc('Dictates the capitalization of book names.')
			.addDropdown(drop => drop
				.addOption("lower_case", "Lower case")
				.addOption("name_case", "Name case")
				.addOption("upper_case", "Upper case")
				.setValue(this.plugin.settings.book_name_capitalization)
				.onChange(async (value) => {
					this.plugin.settings.book_name_capitalization = value
					this.update_descriptions()
					await this.plugin.saveSettings()
				})
			)
		;
	}

	renderNameDelimeter(setting: Setting) {
		setting.clear()
		setting
			.setName('Name delimiter')
			.addExtraButton(btn => btn
				.setIcon("rotate-ccw")
				.setTooltip("Reset value")
				.onClick(async () => {
					this.plugin.settings.book_name_delimiter
						= DEFAULT_SETTINGS.book_name_delimiter;
					this.renderNameDelimeter(setting);
					this.update_descriptions()
					await this.plugin.saveSettings();
				})
			)
			.addText(text => text
				.setPlaceholder('Example: "' + DEFAULT_SETTINGS.book_name_delimiter + '"')
				.setValue(this.plugin.settings.book_name_delimiter)
				.onChange(async (value) => {
					this.plugin.settings.book_name_delimiter = value;
					this.update_descriptions()
					await this.plugin.saveSettings();
				})
			)
		;
		this.description_updators["name_delimeter"] = () => {
			let desc = setting.descEl
			this.builder.set_book_and_chapter(this.builder.books[22], 5)
			desc.empty()
			desc.appendText('The characters separating words in book names, such as the spaces in "1 John" or "Song of Solomon".');
			desc.createEl("br")

			desc.appendText("Current syntax: ")
			desc.createEl("br")
			desc.createEl("b", {
				"text": "{0}".format(this.builder.format_book_name(
					new BookData(
						DEFAULT_NAME_MAP["Song of Solomon"],
						"Song of Solomon",
						[],
					),
					BookNameStyle.Full,
					))
					.slice(3),
				"cls": "u-pop",
			})
		}
	}

	renderPaddedOrderNums(setting: Setting) {
		setting.clear()
		setting
			.setName('Pad order numbers')
			.addToggle(toggle => toggle
				.setTooltip("Toggle alignment padding of book order numbers")
				.setValue(this.plugin.settings.padded_order)
				.onChange(async (value) => {
					this.plugin.settings.padded_order = value
					this.update_descriptions()
					await this.plugin.saveSettings()
				})
			)
		;
		this.description_updators["padded_order"] = () => {
			let desc = setting.descEl
			this.builder.set_book_and_chapter(this.builder.books[1], 1)
			desc.empty()
			desc.appendText('When Active, pads order numbers with extra zeros. ');
			desc.createEl("br")
			desc.appendText("Current syntax: ")
			desc.createEl("br")
			desc.createEl("b", {
				"text": "{0}".format(this.builder.format_book_name()),
				"cls": "u-pop",
			})
		}
	}

	renderBookOrdering(setting: Setting) {
		setting.clear()
		setting
			.setName('Book ordering')
			.addDropdown((x) => x
				.addOption("christian", "Christian")
				.addOption("hebraic", "Hebraic")
				.setValue(this.plugin.settings.book_ordering)
				.onChange(async (value) => {
					this.plugin.settings.book_ordering = value
					await this.plugin.saveSettings()
				})
			)
		;

		this.description_updators["book_ordering"] = () => {
			let desc = setting.descEl
			this.builder.set_book_and_chapter(this.builder.books[43], 11)
			desc.empty()
			desc.appendText("Choose how you want the books ordered in your Bible. ");
			desc.createEl("a", {
				"text": "More about book ordering",
				"href": BOOK_ORDERING_LINK,
			})
		}
	}

	// Chapter renderers

	renderChapterFormat(setting: Setting) {
		setting.clear()
		setting
			.setName('Body format')
			.addExtraButton(btn => btn
				.setIcon("rotate-ccw")
				.setTooltip("Reset value")
				.onClick(async () => {
					this.plugin.settings.chapter_body_format
						= DEFAULT_SETTINGS.chapter_body_format;
					this.renderChapterFormat(setting);
					await this.plugin.saveSettings();
				})
			)
			.addTextArea(text => text
				.setPlaceholder("Example: " + DEFAULT_SETTINGS.chapter_body_format)
				.setValue(this.plugin.settings.chapter_body_format)
				.onChange(async (value) => {
					this.plugin.settings.chapter_body_format = value;
					await this.plugin.saveSettings();
					}
				)
			)
		;
		this.description_updators["chapter_body"] = () => {
			let desc = setting.descEl
			desc.empty()
			desc.appendText("Formats the contents of chapters. ")
			desc.createEl("a", {
				"text": "More on formatting",
				"href": CHAPTER_BODY_FORMAT_LINK,
			})
			desc.appendText(".")
		}
		this.description_updators["chapter_body"]()
	}

	renderChapterName(setting: Setting) {
		setting.clear()
		setting
			.setName('Name format')
			.addExtraButton(btn => btn
				.setIcon("rotate-ccw")
				.setTooltip("Reset value")
				.onClick(async () => {
					this.plugin.settings.chapter_name_format
						= DEFAULT_SETTINGS.chapter_name_format;
					this.renderChapterName(setting);
					await this.plugin.saveSettings();
				})
			)
			.addText(text => text
				.setPlaceholder(this.plugin.settings.chapter_name_format)
				.setValue(this.plugin.settings.chapter_name_format)
				.onChange(async (value) => {
					this.plugin.settings.chapter_name_format = value
					this.update_descriptions()
					await this.plugin.saveSettings()
				})
			)
		;
		
		this.description_updators["chapter_name"] = () => {
			let desc = setting.descEl
			this.builder.set_book_and_chapter(this.builder.books[43], 11)
			desc.empty()
			desc.appendText("The format for the names of chapters. ")
			desc.createEl("a", {
				"text": "More about formatting",
				"href": CHAPTER_NAME_FORMAT_LINK,
			})
			desc.appendText(". ")
			desc.createEl("br")
			desc.appendText("Current syntax: ")
			desc.createEl("br")
			desc.createEl("b", {
				"text": "{0}".format(this.builder.format_chapter_name()),
				"cls": "u-pop",
			})
		}
		this.description_updators["chapter_name"]()
	}

	// Verse renders

	renderVerseFormat(setting: Setting) {
		setting.clear()
		setting
			.setName('Format')
			.setDesc('Formatting for individual verses.')
			.addExtraButton(btn => btn
				.setIcon("rotate-ccw")
				.setTooltip("Reset value")
				.onClick(async () => {
					this.plugin.settings.verse_body_format
						= DEFAULT_SETTINGS.verse_body_format;
					this.renderVerseFormat(setting);
					await this.plugin.saveSettings();
				})
			)
			.addTextArea(text => text
				.setPlaceholder("Example: " + DEFAULT_SETTINGS.verse_body_format)
				.setValue(this.plugin.settings.verse_body_format)
				.onChange(async (value) => {
					this.plugin.settings.verse_body_format = value;
					this.update_descriptions()
					await this.plugin.saveSettings();
				})
			)
		;
		this.description_updators["verse_body"] = () => {
			let desc = setting.descEl
			this.builder.set_book_and_chapter(this.builder.books[43], 11)
			desc.empty()
			desc.appendText("Formats individual verses. ")
			desc.createEl("a", {
				"text": "More about formatting",
				"href": VERSES_FORMAT_LINK,
			})
			desc.appendText(". ")
			desc.createEl("br")
			desc.appendText("Current syntax: ")
			for (const line of this.builder.format_verse_body("Jesus wept.").split("\n")) {
				desc.createEl("br")
				desc.createEl("b", {
					"text": line,
					"cls": "u-pop",
				})
			}
		}
		this.description_updators["verse_body"]()
	}

	// Book index

	renderIndexName(setting: Setting) {
		setting.clear()
		setting
			.setName('Name format')
			.setDesc('The format for the name of the book index.')
			.addExtraButton(btn => btn
				.setIcon("rotate-ccw")
				.setTooltip("Reset value")
				.onClick(async () => {
					this.plugin.settings.index_name_format
						= DEFAULT_SETTINGS.index_name_format;
					this.renderIndexName(setting)
					this.update_descriptions()
					await this.plugin.saveSettings();
				})
			)
			.addText(text => text
				.setPlaceholder(DEFAULT_SETTINGS.index_name_format)
				.setValue(this.plugin.settings.index_name_format)
				.onChange(async (value) => {
					this.plugin.settings.index_name_format = value
					this.update_descriptions()
					await this.plugin.saveSettings()
				})
			)
		;
		this.description_updators["index_name"] = () => {
			let desc = setting.descEl
			this.builder.set_book_and_chapter(this.builder.books[22], 5)
			desc.empty()
			desc.appendText('The format for the name of the book index. ')
			desc.createEl("a", {
				"text": "More about formatting",
				"href": BOOK_INDEX_NAME_FORMAT_LINK,
			})
			desc.appendText(". ")
			desc.createEl("br")

			desc.appendText("Current syntax: ")
			desc.createEl("br")
			desc.createEl("b", {
				"text": this.builder.format_index_name(),
				"cls": "u-pop",
			})
		}
		this.description_updators["index_name"]()
	}

	renderIndexBookLink(setting: Setting) {
		setting.clear()
		setting
			.setName('Book element format')
			.addExtraButton(btn => btn
				.setIcon("rotate-ccw")
				.setTooltip("Reset value")
				.onClick(async () => {
					this.plugin.settings.index_link_format
						= DEFAULT_SETTINGS.index_link_format
					this.renderIndexBookLink(setting)
					this.update_descriptions()
					await this.plugin.saveSettings()
				})
			)
			.addText(text => text
				.setPlaceholder(DEFAULT_SETTINGS.index_link_format)
				.setValue(this.plugin.settings.index_link_format)
				.onChange(async (value) => {
					this.plugin.settings.index_link_format = value;
					this.update_descriptions()
					await this.plugin.saveSettings();
				})
			)
		;
		setting.setDisabled(!this.plugin.settings.index_enabled)

		this.description_updators["index_element"] = () => {
			let desc = setting.descEl
			this.builder.set_book_and_chapter(this.builder.books[22], 5)
			desc.empty()
			desc.appendText('The format for each book element in this index list. ')
			desc.createEl("a", {
				"text": "More about formatting",
				"href": BOOK_INDEX_ELEMENT_FORMAT_LINK,
			})
			desc.appendText(". ")

			desc.createEl("br")
			desc.appendText("Current syntax: ")
			desc.createEl("br")
			desc.createEl("b", {
				"text": "{0}".format(this.builder.format_index_element()),
				"cls": "u-pop",
			})
		}
		this.description_updators["index_element"]()
	}

	renderIndexBody(setting: Setting) {
		setting.clear()
		setting
			.setName('Body format')
			.setDesc('The format for the content of the book index.')
			.addExtraButton(btn => btn
				.setIcon("rotate-ccw")
				.setTooltip("Reset value")
				.onClick(async () => {
					this.plugin.settings.index_format
						= DEFAULT_SETTINGS.index_format
					this.renderIndexBody(setting)
					this.update_descriptions()
					await this.plugin.saveSettings()
				})
			)
			.addTextArea(text => text
				.setPlaceholder(DEFAULT_SETTINGS.index_format)
				.setValue(this.plugin.settings.index_format)
				.onChange(async (value) => {
					this.plugin.settings.index_format = value
					this.update_descriptions()
					await this.plugin.saveSettings()
				})
			)
		;
		setting.setDisabled(!this.plugin.settings.index_enabled)

		this.description_updators["index_body"] = () => {
			let desc = setting.descEl
			this.builder.set_book_and_chapter(this.builder.books[22], 5)
			desc.empty()
			desc.appendText('The format for each book element in this index list. ')
			desc.createEl("a", {
				"text": "More about formatting",
				"href": BOOK_INDEX_BODY_FORMAT_LINK,
			})
			desc.appendText(". ")
		}
		this.description_updators["index_body"]()
	}

	// Chapter index

	renderChapterIndexName(setting: Setting) {
		setting.clear()
		setting
			.setName('Name format')
			.addExtraButton(btn => btn
				.setIcon("rotate-ccw")
				.setTooltip("Reset value")
				.onClick(async () => {
					this.plugin.settings.chapter_index_name_format
						= DEFAULT_SETTINGS.chapter_index_name_format
					this.renderChapterIndexName(setting)
					this.update_descriptions()
					await this.plugin.saveSettings()
				})
			)
			.addText(text => text
				.setPlaceholder(DEFAULT_SETTINGS.chapter_index_name_format)
				.setValue(this.plugin.settings.chapter_index_name_format)
				.onChange(async (value) => {
					this.plugin.settings.chapter_index_name_format = value
					this.update_descriptions()
					await this.plugin.saveSettings()
				})
			)
		;
		setting.setDisabled(!this.plugin.settings.index_enabled)

		this.description_updators["chapter_index_name"] = () => {
			let desc = setting.descEl
			this.builder.set_book_and_chapter(this.builder.books[43], 11)
			desc.empty()
			desc.appendText('The format for the name of the chapter index. ')
			desc.createEl("a", {
				"text": "More on formatting",
				"href": CHAPTER_INDEXS_NAME_FORMAT_LINK
			})
			desc.appendText(".")

			desc.createEl("br")
			desc.appendText("Current syntax: ")
			desc.createEl("br")
			desc.createEl("b", {
				"text": this.builder.format_chapter_index_name(),
				"cls": "u-pop",
			})
		}
		this.description_updators["chapter_index_name"]()
	}

	renderChapterIndexLink(setting: Setting) {
		setting.clear()
		setting
			.setName('Chapter element format')
			.addExtraButton(btn => btn
				.setIcon("rotate-ccw")
				.setTooltip("Reset value")
				.onClick(async () => {
					this.plugin.settings.chapter_index_link_format
						= DEFAULT_SETTINGS.chapter_index_link_format
					this.renderChapterIndexLink(setting)
					this.update_descriptions()
					await this.plugin.saveSettings()
				})
			)
			.addText(text => text
				.setPlaceholder(DEFAULT_SETTINGS.chapter_index_link_format)
				.setValue(this.plugin.settings.chapter_index_link_format)
				.onChange(async (value) => {
					this.plugin.settings.chapter_index_link_format = value
					this.update_descriptions()
					await this.plugin.saveSettings()
				})
			)
		;
		setting.setDisabled(!this.plugin.settings.index_enabled)

		this.description_updators["chapter_index_element"] = () => {
			let desc = setting.descEl
			this.builder.set_book_and_chapter(this.builder.books[43], 11)
			desc.empty()
			desc.appendText('The format for each chapter element in a list. ')
			desc.createEl("a", {
				"text": "More on formatting",
				"href": CHAPTER_INDEXS_ELEMENT_FORMAT_LINK,
			})
			desc.appendText(".")

			desc.createEl("br")
			desc.appendText("Current syntax: ")
			desc.createEl("br")
			desc.createEl("b", {
				"text": this.builder.format_chapter_index_element(),
				"cls": "u-pop",
			})
		}
		this.description_updators["chapter_index_element"]()
	}

	renderChapterIndexBody(setting: Setting) {
		setting.clear()
		setting
			.setName('Body format')
			.setDesc('The format for the content of the chapter index.')
			.addExtraButton(btn => btn
				.setIcon("rotate-ccw")
				.setTooltip("Reset value")
				.onClick(async () => {
					this.plugin.settings.chapter_index_format
						= DEFAULT_SETTINGS.chapter_index_format;
					this.renderChapterIndexBody(setting);
					await this.plugin.saveSettings();
				})
			)
			.addTextArea(text => text
				.setPlaceholder(DEFAULT_SETTINGS.chapter_index_format)
				.setValue(this.plugin.settings.chapter_index_format)
				.onChange(async (value) => {
					this.plugin.settings.chapter_index_format = value;
					await this.plugin.saveSettings();
				})
			)
		;
		setting.setDisabled(!this.plugin.settings.index_enabled)

		this.description_updators["chapter_index_body"] = () => {
			let desc = setting.descEl
			this.builder.set_book_and_chapter(this.builder.books[43], 11)
			desc.empty()
			desc.appendText('The format for the content of the chapter index. ')
			desc.createEl("a", {
				"text": "More on formatting",
				"href": CHAPTER_INDEXS_BODY_FORMAT_LINK,
			})
			desc.appendText(".")
		}
		this.description_updators["chapter_index_body"]()
	}

	
	refresh() {
		this.contentEl.empty()
		this.render()
	}

	update_descriptions() {
		for (const key of Object.keys(this.description_updators)) {
			this.description_updators[key]()
		}
	}
}

class ErrorModal extends Modal {
	plugin: MyBible
	title: string
	body: string

	constructor(app: App, plugin: MyBible, title:string, body:string) {
		super(app);
		this.plugin = plugin;
		this.title = title;
		this.body = body;
	}

	onOpen() {
		const { contentEl } = this;

		contentEl.createEl("h1", { text: this.title });
		contentEl.createEl("span", { text: this.body });

		contentEl.createEl("p", {});

		new Setting(contentEl)
			.addButton((btn) =>
				btn
					.setButtonText("Report an issue")
					.setCta()
					.onClick(() => {
						window.open(
							REPORT_ISSUE_URL,
							'_blank'
						);
					})
			)
			.addButton((btn) =>
				btn
					.setButtonText("Dismiss")
					.onClick(() => {
						this.close();
					})
			)
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

class ClearLocalFilesModal extends Modal {
	plugin: MyBible;

	constructor(app: App, plugin: MyBible) {
		super(app);
		this.plugin = plugin;
	}

	onOpen() {
		const { contentEl } = this;

		let bible_path = this.plugin.settings.bible_folder;

		contentEl.createEl("h1", { text: "Clear local files?" });
		contentEl.createEl("span", {
			text: "You are about to clear out all files added by My Bible from your file system. This includes temporay cached chapters and translations you manually downloaded."
				.format(bible_path)
		});
		contentEl.createEl("p", {
			text: "Do you want to clear these files?"
		});
		contentEl.createEl("p", {});

		new Setting(contentEl)
			.addButton((btn) =>
				btn
					.setButtonText("Cancel")
					.onClick(() => {
						this.close();
					})
			)
			.addButton((btn) =>
				btn
					.setButtonText("Clear files")
					.setCta()
					.onClick(async () => {
						this.close();
						await this.plugin.bible_api.clear_local_files();
						new Notice("Files cleared!");
					})
			);
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

class ClearOldBibleFilesModal extends Modal {
	plugin: MyBible

	constructor(app: App, plugin: MyBible) {
		super(app);
		this.plugin = plugin;
	}

	onOpen() {
		const { contentEl } = this;

		let bible_path = this.plugin.settings.bible_folder;

		contentEl.createEl("h1", { text: "Bible folder is not empty" });
		contentEl.createEl("span", {
			text: "The Bible folder in your settings is not empty. If you built a Bible in this folder before the new bible may be interlaced with the old one."
				.format(bible_path)
		});
		contentEl.createEl("p", {
			text: "Do you want to clear the folder before building your Bible?"
		});
		contentEl.createEl("p", {});

		new Setting(contentEl)
			.addButton((btn) =>
				btn
					.setButtonText("Cancel")
					.onClick(() => {
						this.close();
						
					})
			)
			.addButton((btn) =>
				btn
					.setButtonText("Build without clearing")
					.setCta()
					.onClick(async () => {
						this.close();
						await this.plugin._build_bible(bible_path);
					})
			)
			.addButton((btn) =>
				btn
					.setButtonText("Clear and build")
					.setCta()
					.onClick(async () => {
						this.close();
						let notice = new Notice("Clearing bible folder...", 0)

						let abstract = this.app.vault.getAbstractFileByPath(
							normalizePath(bible_path,)
						);
						if (abstract != null) {
							await this.app.vault.delete(abstract, true);
						}
						this.app.vault.adapter.mkdir(normalizePath(bible_path));

						notice.hide()
						await this.plugin._build_bible(bible_path);
					})
			);
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

class DownloadBibleModal extends Modal {
	plugin: MyBible;

	constructor(app: App, plugin: MyBible) {
		super(app);
		this.plugin = plugin;
	}

	onOpen() {
		const { contentEl } = this;

		let translation = this.plugin.settings.translation;

		contentEl.createEl("h1", { text: "Download bible?" });
		contentEl.createEl("span", {
			text: "You are about to download the entire {0} translation of the Bible, according to your settings."
				.format(translation)
		});
		contentEl.createEl("p", {
			text: "Do you want to continue?"
		});
		contentEl.createEl("p", {});

		new Setting(contentEl)
			.addButton((btn) =>
				btn
					.setButtonText("Cancel")
					.onClick(() => {
						this.close();
					})
			)
			.addButton((btn) =>
				btn
					.setButtonText("Download")
					.setCta()
					.onClick(() => {
						this.close();
						this.downloadBible(translation);
					})
			);
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}

	async downloadBible(translation: string) {
		new Notice(
			'Started download of the {0} translation!'
				.format(translation)
		);

		let bible = await this.plugin.bible_api.get_translation(translation);
		for (const book_id in bible.books) {
			for (const chapter_key of Object.keys(bible.books[book_id])) {
				const chapter = Number(chapter_key)
				await this.plugin.bible_api.cache_chapter(
					translation,
					Number(book_id),
					chapter + 1,
					bible.books[book_id][chapter],
					true,
				);
			}
		}

		new Notice(
			'Completed download of the {0} translation!'
				.format(translation)
		);
	}
}
  
export class QuickChangeTranslationeModal extends FuzzySuggestModal<Translation> {
	plugin: MyBible
	translations: Translations
	onChose: (chosen:Translation) => (void|Promise<void>) | null

	constructor(plugin: MyBible) {
		super(plugin.app);
		this.plugin = plugin;
	}

	// Returns all available suggestions.
	getItems(): Translation[] {
		let translations_list = Object.keys(this.translations).map(k => this.translations[k])
		return translations_list
	}

	getItemText(item:Translation):string {
		return translation_to_display_name(item)
	}

	// Perform action on the selected suggestion.
	onChooseItem(item: Translation, evt: MouseEvent | KeyboardEvent) {
		if (this.onChose !== null) {
			this.onChose(item)
		}
	}
}

interface VerseLinkSuggestion {
	label: string
	file: TFile
	/// The verse (`"1"`), verse range (`"1-3"`), or null to link to the
	/// whole chapter.
	subpath: string|null
	/// The text of the verse(s), read ahead of time so that choosing the
	/// suggestion can paste it in without waiting. Null when there's no
	/// text to quote (a whole-chapter reference, or a verse whose text
	/// couldn't be read), in which case a plain link is inserted instead.
	verse_text: string|null
}

/// Matches `--` followed by up to 60 characters that don't contain a
/// doubled dash (so a `---` rule, or a fresh `--` reference starting right
/// after, never gets swallowed into the query), but single dashes *are*
/// allowed through, since verse ranges use them (`1-3`).
const VERSE_TRIGGER_REGEX = /--((?:[^-\n]|-(?!-)){0,60})$/

/// Matches the reference part at the end of a query, e.g. the `1:1-3` in
/// `gen1:1-3` or `Genesis 1:1-3`. Searching from the right (rather than
/// requiring whitespace before it) is what lets both spaced ("Genesis
/// 1:1") and unspaced ("gen1:1") forms work, and what lets a book name
/// that itself starts with a digit (e.g. "1 John") be told apart from the
/// chapter number that follows it.
const VERSE_REFERENCE_REGEX = /(\d+)(?::(\d+)(?:-(\d+))?)?$/

/// One verse within a quote: its number, and its text. The number is null
/// for text that came before any verse heading — which is the whole of a
/// single verse quoted on its own, since the quote's title already names
/// it.
interface QuotedVerse {
	number: string|null
	text: string
}

/// Splits the markdown of a quoted passage into the verses it holds. A
/// chapter note gives every verse a heading of its own holding just the
/// verse's number, so a heading starts a new verse and everything up to
/// the next one is that verse's text.
function parse_quoted_verses(markdown: string): QuotedVerse[] {
	let verses: QuotedVerse[] = []
	let current: QuotedVerse = { number: null, text: "" }
	let push_current = () => {
		if (current.number !== null || current.text.trim().length > 0) {
			current.text = current.text.trim()
			verses.push(current)
		}
	}

	for (const line of markdown.replace(/\r/g, "").split("\n")) {
		let heading = line.match(/^#{1,6}\s+(.*\S)\s*$/)
		if (heading === null) {
			current.text += line + "\n"
			continue
		}
		push_current()
		current = { number: heading[1], text: "" }
	}
	push_current()

	return verses
}

/// Builds the markdown of a quoted verse: an Obsidian callout, folded
/// open or closed to start with, titled by the verse's link and holding
/// the verse text itself. A callout is Obsidian's own foldable section, so
/// nothing here depends on this plugin — the quote still folds, and still
/// reads as the verse it quotes, with the plugin turned off or the note
/// carried somewhere else entirely.
function build_verse_quote_callout(
	link: string,
	verse_text: string,
	collapsed: boolean,
): string {
	// Verse numbers are headings in a chapter note, where each verse is a
	// section of its own. Quoted into a callout they'd read as headings
	// rather than as verse numbers, so they're set in bold at the head of
	// their verse's own text instead.
	let lines: string[] = []
	for (const verse of parse_quoted_verses(verse_text)) {
		let verse_lines = verse.text.split("\n")
		if (verse.number !== null) {
			verse_lines[0] = "**{0}** {1}"
				.format(verse.number, verse_lines[0])
				.trim()
		}
		lines.push(...verse_lines)
	}

	return "> [!{0}]{1} {2}\n{3}".format(
		VERSE_QUOTE_CALLOUT_TYPE,
		collapsed ? "-" : "+",
		link,
		lines.map(line => ("> " + line).trimEnd()).join("\n"),
	)
}

/// Lets the user type `--Book Chapter:Verse` (e.g. `--Genesis 1:1`,
/// `--gen1:1-3`) to insert a link to that verse or verse range, mirroring
/// the trigger used by the "Obsidian Bible Reference" plugin. Book names
/// may be abbreviated (see {@link find_book_id_by_name}), and the space
/// between book and chapter is optional. A verse or verse range is
/// inserted as a foldable callout holding the verse's link and its text
/// (see {@link build_verse_quote_callout}); a whole chapter, having no
/// text to quote, is inserted as a plain link.
class VerseLinkSuggest extends EditorSuggest<VerseLinkSuggestion> {
	plugin: MyBible

	constructor(plugin: MyBible) {
		super(plugin.app)
		this.plugin = plugin
	}

	onTrigger(cursor: EditorPosition, editor: Editor, file: TFile | null): EditorSuggestTriggerInfo | null {
		let line = editor.getLine(cursor.line)
		let sub = line.slice(0, cursor.ch)
		let match = sub.match(VERSE_TRIGGER_REGEX)
		if (match === null) {
			return null
		}

		let start_ch = sub.length - match[0].length
		if (start_ch > 0 && sub[start_ch - 1] === "-") {
			// Don't trigger inside a longer run of dashes, e.g. a `---` rule
			return null
		}

		return {
			start: { line: cursor.line, ch: start_ch },
			end: cursor,
			query: match[1],
		}
	}

	async getSuggestions(context: EditorSuggestContext): Promise<VerseLinkSuggestion[]> {
		let ref_match = context.query.match(VERSE_REFERENCE_REGEX)
		if (ref_match === null) {
			return []
		}

		let book_part = context.query.slice(0, ref_match.index).trim()
		if (book_part.length === 0) {
			return []
		}

		let book_id = find_book_id_by_name(book_part)
		if (book_id === null) {
			return []
		}

		let chapter = Number(ref_match[1])
		let verse_start = ref_match[2] !== undefined ? Number(ref_match[2]) : undefined
		let verse_end = ref_match[3] !== undefined ? Number(ref_match[3]) : verse_start

		let file = await this.plugin.resolve_chapter_file(book_id, chapter)
		if (file === null) {
			return []
		}

		let book_name = book_id_to_name(book_id)

		if (verse_start === undefined) {
			return [{
				label: "{0} {1}".format(book_name, String(chapter)),
				file,
				subpath: null,
				verse_text: null,
			}]
		}
		if (!this.plugin.has_linked_section(file, String(verse_start))) {
			return []
		}

		let is_range = verse_end !== undefined && verse_end > verse_start
		let subpath = is_range
			? "{0}-{1}".format(String(verse_start), String(verse_end))
			: String(verse_start)
		let label = is_range
			? "{0} {1}:{2}-{3}".format(book_name, String(chapter), String(verse_start), String(verse_end))
			: "{0} {1}:{2}".format(book_name, String(chapter), String(verse_start))

		// Read now rather than when the suggestion is chosen, so that
		// inserting it stays a single, synchronous edit
		let verse_text = await this.plugin.get_linked_section_markdown(file, subpath)

		return [{
			label,
			file,
			subpath,
			verse_text: verse_text !== null && verse_text.length > 0
				? verse_text
				: null,
		}]
	}

	renderSuggestion(value: VerseLinkSuggestion, el: HTMLElement): void {
		el.addClass("mod-complex")
		let content = el.createDiv({ cls: "suggestion-content" })
		content.createDiv({ cls: "suggestion-title", text: value.label })
		if (value.verse_text !== null) {
			let text = value.verse_text
			content.createDiv({
				cls: "suggestion-note",
				text: text.length > 120 ? text.slice(0, 120) + "…" : text,
			})
		}
	}

	selectSuggestion(value: VerseLinkSuggestion, evt: MouseEvent | KeyboardEvent): void {
		if (this.context === null) {
			return
		}
		let link = this.plugin.app.fileManager.generateMarkdownLink(
			value.file,
			this.context.file.path,
			value.subpath !== null ? "#" + value.subpath : undefined,
			// Titled "Genesis 1:1" rather than the "Genesis 1 > 1" that
			// Obsidian shows a subpath link as: written into the note as an
			// alias, it reads that way with or without this plugin
			value.subpath !== null ? value.label : undefined,
		)

		// A quote pastes the verse's own text into the note, so that it's
		// still there wherever the note goes without the plugin (an
		// exported PDF, say). A whole chapter has no text to quote.
		let insert = value.verse_text === null
			? link
			: build_verse_quote_callout(
				link,
				value.verse_text,
				this.plugin.settings.verse_preview_collapsed_by_default,
			)

		let start = this.context.start
		if (value.verse_text !== null) {
			// A callout has to start a line of its own, and end one
			let before = this.context.editor.getLine(start.line).slice(0, start.ch)
			if (before.trim().length > 0) {
				insert = "\n" + insert
			}
			insert += "\n"
		}

		this.context.editor.replaceRange(insert, start, this.context.end)

		let inserted = insert.split("\n")
		this.context.editor.setCursor({
			line: start.line + inserted.length - 1,
			ch: inserted.length === 1
				? start.ch + insert.length
				: inserted[inserted.length - 1].length,
		})
	}
}

/// Common abbreviated/short forms of book names that aren't simply a
/// prefix of the full name (e.g. "Jas" for James, "Mt" for Matthew), keyed
/// by the abbreviation with spaces and periods removed, lowercased.
const BOOK_ABBREVIATIONS: Record<string, BookId> = {
	"gen": 1, "ge": 1, "gn": 1,
	"exo": 2, "ex": 2, "exod": 2,
	"lev": 3, "le": 3, "lv": 3,
	"num": 4, "nu": 4, "nm": 4, "numb": 4,
	"deut": 5, "deu": 5, "dt": 5,
	"josh": 6, "jos": 6, "jsh": 6,
	"judg": 7, "jdg": 7, "jg": 7, "jdgs": 7,
	"rut": 8, "ru": 8,
	"1sam": 9, "1sa": 9, "1s": 9,
	"2sam": 10, "2sa": 10, "2s": 10,
	"1kgs": 11, "1ki": 11, "1k": 11,
	"2kgs": 12, "2ki": 12, "2k": 12,
	"1chr": 13, "1ch": 13,
	"2chr": 14, "2ch": 14,
	"ezr": 15,
	"neh": 16,
	"esth": 17, "est": 17,
	"psa": 19, "ps": 19, "psm": 19, "pslm": 19,
	"prov": 20, "pro": 20, "prv": 20,
	"eccl": 21, "ecc": 21, "qoh": 21,
	"song": 22, "sos": 22, "sng": 22, "canticles": 22, "cant": 22,
	"isa": 23, "is": 23,
	"jer": 24, "je": 24,
	"ezek": 26, "eze": 26, "ezk": 26,
	"dan": 27, "dn": 27,
	"hos": 28,
	"joe": 29, "jl": 29,
	"amo": 30, "am": 30,
	"obad": 31, "oba": 31, "ob": 31,
	"jnh": 32, "jon": 32,
	"mic": 33, "mc": 33,
	"nah": 34, "na": 34,
	"hab": 35, "hb": 35,
	"zeph": 36, "zep": 36, "zp": 36,
	"hag": 37, "hg": 37,
	"zech": 38, "zec": 38, "zc": 38,
	"mal": 39, "ml": 39,
	"matt": 40, "mat": 40, "mt": 40,
	"mrk": 41, "mar": 41, "mk": 41, "mr": 41,
	"luk": 42, "lk": 42,
	"joh": 43, "jhn": 43, "jn": 43,
	"act": 44, "ac": 44,
	"rom": 45, "ro": 45, "rm": 45,
	"1cor": 46, "1co": 46,
	"2cor": 47, "2co": 47,
	"gal": 48, "ga": 48,
	"eph": 49,
	"phil": 50, "php": 50, "pp": 50,
	"col": 51,
	"1thess": 52, "1th": 52,
	"2thess": 53, "2th": 53,
	"1tim": 54, "1ti": 54,
	"2tim": 55, "2ti": 55,
	"tit": 56,
	"philem": 57, "phm": 57, "pm": 57,
	"heb": 58,
	"jas": 59, "jm": 59, "jam": 59,
	"1pet": 60, "1pe": 60, "1pt": 60,
	"2pet": 61, "2pe": 61, "2pt": 61,
	"1jn": 62, "1jo": 62,
	"2jn": 63, "2jo": 63,
	"3jn": 64, "3jo": 64,
	"jud": 65, "jde": 65,
	"rev": 66, "re": 66,
}

/// Strips spaces and periods and lowercases, so "1 Sam.", "1sam", and
/// "1 SAM" all compare equal.
function normalize_book_name(name: string): string {
	return name.toLowerCase().replace(/[.\s]/g, "")
}

/// Finds a book's ID by its full name or a common abbreviation,
/// case-insensitively and ignoring spaces/periods (e.g. "Genesis", "gen",
/// and "Gen." all resolve to the same book). Falls back to an unambiguous
/// prefix match against full book names for anything not covered by
/// {@link BOOK_ABBREVIATIONS}.
function find_book_id_by_name(name: string): BookId|null {
	let target = normalize_book_name(name)
	if (target.length === 0) {
		return null
	}

	for (const key of Object.keys(DEFAULT_NAME_MAP)) {
		if (normalize_book_name(key) === target) {
			return DEFAULT_NAME_MAP[key]
		}
	}

	if (target in BOOK_ABBREVIATIONS) {
		return BOOK_ABBREVIATIONS[target]
	}

	let matches = new Set(
		Object.keys(DEFAULT_NAME_MAP)
			.filter(key => normalize_book_name(key).startsWith(target))
			.map(key => DEFAULT_NAME_MAP[key])
	)
	if (matches.size === 1) {
		return matches.values().next().value ?? null
	}

	return null
}

/// Parses a verse or verse-range subpath like `"1"` or `"1-3"` into a
/// `[start, end]` pair (equal for a single verse), or returns null if
/// `subpath` isn't a plain numeric verse reference (e.g. a block reference
/// or a heading from a customized verse format) or the range is backwards.
function parse_verse_range(subpath: string): [number, number]|null {
	let match = subpath.match(/^(\d+)(?:-(\d+))?$/)
	if (match === null) {
		return null
	}
	let start = Number(match[1])
	let end = match[2] !== undefined ? Number(match[2]) : start
	if (end < start) {
		return null
	}
	return [start, end]
}

class SettingsTab extends PluginSettingTab {
	plugin: MyBible;

	constructor(app: App, plugin: MyBible) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName('Translation')
			.setDesc('The version of the Bible that will be displayed in dynamic verses.')
			.addDropdown(async drop => {
				let translations = await this.plugin.bible_api.get_translations();
				
				let translations_list = [];
				for (const key in translations) {
					translations_list.push(key);
				}
				translations_list = translations_list.sort((a, b) => {
					if (translations[a].language < translations[b].language) {
						return -1;
					}
					if (translations[a].language > translations[b].language) {
						return 1;
					}

					if (a < b) {
						return -1;
					}
					if (a > b) {
						return 1;
					}

					return 0;
				})

				for (const i in translations_list) {
					let key = translations_list[i]
					drop.addOption(
						key,
						"{0} - {1} - {2}".format(
							translations[key].language,
							key,
							translations[key].display_name,
						)
					);
				}
				drop.onChange(async value => {
					this.plugin.settings.reading_translation = value;
					await this.plugin.saveSettings()
				})
				drop.setValue(this.plugin.settings.reading_translation)
			})
		;

		new Setting(containerEl)
			.setName('Show verse text under Bible links')
			.setDesc('When enabled, links to a specific verse in your built Bible (e.g. [[Genesis 1#1]]) will show the verse text in a collapsible quote right after the link, in both Reading view and Live Preview. Type "--" followed by a reference, like "--Genesis 1:1", to insert a quote as you write. Those paste the verse text into the note itself, inside a foldable callout, so the quote keeps working with this plugin turned off and is still there when the note is exported to PDF.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.verse_preview_enabled)
				.onChange(async (value) => {
					this.plugin.settings.verse_preview_enabled = value
					await this.plugin.saveSettings()
					this.plugin.app.workspace.updateOptions()
				})
			)
		;

		new Setting(containerEl)
			.setName('Collapse verse previews by default')
			.setDesc('When enabled, verse previews start collapsed, and can be expanded by clicking on them.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.verse_preview_collapsed_by_default)
				.onChange(async (value) => {
					this.plugin.settings.verse_preview_collapsed_by_default = value
					await this.plugin.saveSettings()
					this.plugin.app.workspace.updateOptions()
				})
			)
		;

		let e_js_e = new Setting(containerEl)
			.setName('Enable Javascript execution')
			.setDesc('Enables the execution of Javascript code in `mybible` codeblocks.')
			.addToggle(x => x
				.setValue(this.plugin.settings.enable_javascript_execution)
				.setTooltip("Enable or disable Javascript execution")
				.onChange(async v => {
					this.plugin.settings.enable_javascript_execution = v
					await this.plugin.saveSettings()
				})
			)
		;
		e_js_e.descEl.appendText(" For more about using Javascript in MyBible see the ")
		e_js_e.descEl.createEl("a", {
			text: "Javascript API",
			href: "https://gslogimaker.github.io/my-bible-obsidian-plugin/modules/api.mb",
		})
		e_js_e.descEl.appendText(".")

		new Setting(containerEl)
			.setDesc('Looking for build settings? They have been moved to the `Book builder` menu. You can access the menu via the `My Bible: Build Bible` command.')
		;
	}
}

function book_id_to_name(id: BookId):string {
	for (const x of Object.keys(DEFAULT_NAME_MAP)) {
		if (DEFAULT_NAME_MAP[x] === id) {
			return x
		}
	}
	throw new Error("No book by ID {0} exists".format(String(id)))
}

function to_hebraic_order(id: BookId) {
	const BOOK_NAME = book_id_to_name(id)
	if (!(BOOK_NAME in HEBRAIC_ORDER))  {
		return id
	}
	return HEBRAIC_ORDER[BOOK_NAME]
}

export const DEFAULT_NAME_MAP: Record<string, BookId> = {
	"Genesis": 1,
	"Exodus": 2,
	"Leviticus": 3,
	"Numbers": 4,
	"Deuteronomy": 5,
	"Joshua": 6,
	"Judges": 7,
	"Ruth": 8,
	"1 Samuel": 9,
	"2 Samuel": 10,
	"1 Kings": 11,
	"2 Kings": 12,
	"1 Chronicles": 13,
	"2 Chronicles": 14,
	"Ezra": 15,
	"Nehemiah": 16,
	"Esther": 17,
	"Job": 18,
	"Psalms": 19,
	"Psalm": 19, // Alternate spelling
	"Proverbs": 20,
	"Ecclesiastes": 21,
	"Song of Solomon": 22,
	"Isaiah": 23,
	"Jeremiah": 24,
	"Lamentations": 25,
	"Ezekiel": 26,
	"Daniel": 27,
	"Hosea": 28,
	"Joel": 29,
	"Amos": 30,
	"Obadiah": 31,
	"Jonah": 32,
	"Micah": 33,
	"Nahum": 34,
	"Habakkuk": 35,
	"Zephaniah": 36,
	"Haggai": 37,
	"Zechariah": 38,
	"Malachi": 39,
	"Matthew": 40,
	"Mark": 41,
	"Luke": 42,
	"John": 43,
	"Acts": 44,
	"Romans": 45,
	"1 Corinthians": 46,
	"2 Corinthians": 47,
	"Galatians": 48,
	"Ephesians": 49,
	"Philippians": 50,
	"Colossians": 51,
	"1 Thessalonians": 52,
	"2 Thessalonians": 53,
	"1 Timothy": 54,
	"2 Timothy": 55,
	"Titus": 56,
	"Philemon": 57,
	"Hebrews": 58,
	"James": 59,
	"1 Peter": 60,
	"2 Peter": 61,
	"1 John": 62,
	"2 John": 63,
	"3 John": 64,
	"Jude": 65,
	"Revelation": 66,
	"1 Esdras": 67,
	"Tobit": 68,
	"Judith": 69,
	"Wisdom": 70,
	"Sirach": 71,
	"Epistle of Jeremiah": 72,
	"Baruch": 73,
	"1 Maccabees": 74,
	"2 Maccabees": 75,
	"3 Maccabees": 76,
	"2 Esdras": 77,
	"Susanna": 78,
	"Bel and Dragon": 79,
	"4 Maccabees": 80,
	"Greek Additions to Esther": 81,
	"3 Holy Children's Song": 82,
	"Prayer of Manasseh": 83,
	"Azariah": 88, // TODO: Fill in this jump in number
}

/// Chapters assumed per book when a translation's real chapter counts
/// aren't known (see {@link MyBible.get_books_data_offline}). It's the
/// longest book in the Bible, so no real chapter is ever excluded; the
/// ones over a given book's true length simply resolve to no note.
const MAX_CHAPTER_COUNT = 150

export const BOOK_ID_TO_NAME: Record<BookId, string> = {
	1: "Genesis",
	2: "Exodus",
	3: "Leviticus",
	4: "Numbers",
	5: "Deuteronomy",
	6: "Joshua",
	7: "Judges",
	8: "Ruth",
	9: "1 Samuel",
	10: "2 Samuel",
	11: "1 Kings",
	12: "2 Kings",
	13: "1 Chronicles",
	14: "2 Chronicles",
	15: "Ezra",
	16: "Nehemiah",
	17: "Esther",
	18: "Job",
	19: "Psalms",
	20: "Proverbs",
	21: "Ecclesiastes",
	22: "Song of Solomon",
	23: "Isaiah",
	24: "Jeremiah",
	25: "Lamentations",
	26: "Ezekiel",
	27: "Daniel",
	28: "Hosea",
	29: "Joel",
	30: "Amos",
	31: "Obadiah",
	32: "Jonah",
	33: "Micah",
	34: "Nahum",
	35: "Habakkuk",
	36: "Zephaniah",
	37: "Haggai",
	38: "Zechariah",
	39: "Malachi",
	40: "Matthew",
	41: "Mark",
	42: "Luke",
	43: "John",
	44: "Acts",
	45: "Romans",
	46: "1 Corinthians",
	47: "2 Corinthians",
	48: "Galatians",
	49: "Ephesians",
	50: "Philippians",
	51: "Colossians",
	52: "1 Thessalonians",
	53: "2 Thessalonians",
	54: "1 Timothy",
	55: "2 Timothy",
	56: "Titus",
	57: "Philemon",
	58: "Hebrews",
	59: "James",
	60: "1 Peter",
	61: "2 Peter",
	62: "1 John",
	63: "2 John",
	64: "3 John",
	65: "Jude",
	66: "Revelation",
	67: "1 Esdras",
	68: "Tobit",
	69: "Judith",
	70: "Wisdom",
	71: "Sirach",
	72: "Epistle of Jeremiah",
	73: "Baruch",
	74: "1 Maccabees",
	75: "2 Maccabees",
	76: "3 Maccabees",
	77: "2 Esdras",
	78: "Susanna",
	79: "Bel and Dragon",
	80: "4 Maccabees",
	81: "Greek Additions to Esther",
	82: "3 Holy Children's Song",
	83: "Prayer of Manasseh",
	88: "Azariah", // TODO: Fill in this jump in number
}

/// Maps book IDs to their hebraic ordering.
/// Absent books retain the order according to their IDs.
const HEBRAIC_ORDER: Record<string, BookId> = {
	"Genesis": 1,		// Torah
	"Exodus": 2,
	"Leviticus": 3,
	"Numbers": 4,
	"Deuteronomy": 5,
	"Joshua": 6,		// Nevi'im
	"Judges": 7,
	"1 Samuel": 8,
	"2 Samuel": 9,
	"1 Kings": 10,
	"2 Kings": 11,
	"Isaiah": 12,		// Ketuvim
	"Jeremiah": 13,
	"Ezekiel": 14,
	"Hosea": 15,
	"Joel": 16,
	"Amos": 17,
	"Obadiah": 18,
	"Jonah": 19,
	"Micah": 20,
	"Nahum": 21,
	"Habakkuk": 22,
	"Zephaniah": 23,
	"Haggai": 24,
	"Zechariah": 25,
	"Malachi": 26,
	"Psalms": 27,
	"Proverbs": 28,
	"Job": 29,
	"Song of Solomon": 30,
	"Ruth": 31,
	"Lamentations": 32,
	"Ecclesiastes": 33,
	"Esther": 34,
	"Daniel": 35,
	"Ezra": 36,
	"Nehemiah": 37,
	"1 Chronicles": 38,
	"2 Chronicles": 39,
}
