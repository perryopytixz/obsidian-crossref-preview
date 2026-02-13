const { EditorSuggest, MarkdownRenderer, MarkdownView, Plugin } = require("obsidian");

let RangeSetBuilder = null;
let Decoration = null;
let ViewPlugin = null;

try {
  ({ RangeSetBuilder } = require("@codemirror/state"));
  ({ Decoration, ViewPlugin } = require("@codemirror/view"));
} catch (_error) {
  // Keep plugin functional even if editor extension modules cannot be loaded.
}

const PREFIX_FRAGMENT = "(?:eq|fig|thm|lem|cor|prp|cnj|def|exm|exr|sol|rem|alg)";
const THEOREM_PREFIX_FRAGMENT = "(?:thm|lem|cor|prp|cnj|def|exm|exr|sol|rem|alg)";
const LABEL_FRAGMENT = `${PREFIX_FRAGMENT}-[A-Za-z0-9_-]+`;
const DEBUG_NOTE_BASENAME = "test.md";
const DEBUG_LOG_RELATIVE_PATH = "plugins/obsidian-crossref-preview/debug.log";

const REF_PATTERN = new RegExp(`@(${LABEL_FRAGMENT})`, "g");
const LABEL_TOKEN_PATTERN = new RegExp(`\\{#(${LABEL_FRAGMENT})\\}`, "g");
const NATIVE_FLASH_SUPPRESS_CLASS = "crossref-suppress-native-flash";
const NATIVE_FLASH_SUPPRESS_DURATION_MS = 1600;
const THEOREM_START_PATTERN = new RegExp(
  `^:::\\s*\\{#(${THEOREM_PREFIX_FRAGMENT}-[A-Za-z0-9_-]+)\\}\\s*$`
);
const THEOREM_END_PATTERN = /^:::\s*$/;

const CM_REF_PATTERN = new RegExp(`@${LABEL_FRAGMENT}`, "g");
const CM_LABEL_PATTERN = new RegExp(`\\{#${LABEL_FRAGMENT}\\}`, "g");

const LABEL_PREFIX_ITEMS = [
  { prefix: "eq-", desc: "Equation label" },
  { prefix: "fig-", desc: "Figure label" },
  { prefix: "thm-", desc: "Theorem label" },
  { prefix: "lem-", desc: "Lemma label" },
  { prefix: "cor-", desc: "Corollary label" },
  { prefix: "prp-", desc: "Proposition label" },
  { prefix: "cnj-", desc: "Conjecture label" },
  { prefix: "def-", desc: "Definition label" },
  { prefix: "exm-", desc: "Example label" },
  { prefix: "exr-", desc: "Exercise label" },
  { prefix: "sol-", desc: "Solution label" },
  { prefix: "rem-", desc: "Remark label" },
  { prefix: "alg-", desc: "Algorithm label" }
];

const THEOREM_TITLES = {
  thm: "Theorem",
  lem: "Lemma",
  cor: "Corollary",
  prp: "Proposition",
  cnj: "Conjecture",
  def: "Definition",
  exm: "Example",
  exr: "Exercise",
  sol: "Solution",
  rem: "Remark",
  alg: "Algorithm"
};

function fastHash(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash +=
      (hash << 1) +
      (hash << 4) +
      (hash << 7) +
      (hash << 8) +
      (hash << 24);
  }
  return (hash >>> 0).toString(16);
}

function buildLineOffsets(source) {
  const offsets = [0];
  for (let i = 0; i < source.length; i += 1) {
    if (source.charCodeAt(i) === 10) {
      offsets.push(i + 1);
    }
  }
  return offsets;
}

function offsetToLine(lineOffsets, offset) {
  let left = 0;
  let right = lineOffsets.length - 1;

  while (left <= right) {
    const mid = (left + right) >> 1;
    if (lineOffsets[mid] <= offset) {
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }
  return Math.max(0, right);
}

function descriptorDisplay(descriptor) {
  if (!descriptor) {
    return "";
  }

  if (descriptor.kind === "equation") {
    return `(${descriptor.number})`;
  }

  if (descriptor.kind === "figure") {
    return `Figure ${descriptor.number}`;
  }

  const theoremName = THEOREM_TITLES[descriptor.prefix] || "Theorem";
  return `${theoremName} ${descriptor.number}`;
}

function normalizeText(element) {
  return (element.textContent || "").replace(/\u200b/g, "").trim();
}

function shortText(value, limit = 120) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}...`;
}

function countTheoremStartMarkers(source) {
  if (!source) {
    return 0;
  }
  const matches = source.match(
    /^\s*:::\s*\{#(?:thm|lem|cor|prp|cnj|def|exm|exr|sol|rem|alg)-[A-Za-z0-9_-]+\}\s*$/gm
  );
  return matches ? matches.length : 0;
}

function safeStringify(value) {
  const seen = new WeakSet();
  return JSON.stringify(value, (_key, current) => {
    if (typeof current === "object" && current !== null) {
      if (seen.has(current)) {
        return "[Circular]";
      }
      seen.add(current);
    }
    return current;
  });
}

function dedupeElements(elements) {
  const seen = new Set();
  const unique = [];

  for (const element of elements) {
    if (!(element instanceof HTMLElement)) {
      continue;
    }
    if (seen.has(element)) {
      continue;
    }
    seen.add(element);
    unique.push(element);
  }

  return unique;
}

function parseCrossrefIndex(source) {
  const lineOffsets = buildLineOffsets(source);
  const lines = source.split(/\r?\n/);
  const labels = new Map();
  let equationCounter = 0;
  let figureCounter = 0;
  const theoremCounters = Object.create(null);

  const addLabel = (label, kind, startOffset, endOffset, title = "") => {
    if (labels.has(label)) {
      return;
    }

    const prefix = label.split("-")[0];
    let number = 0;
    if (kind === "equation") {
      equationCounter += 1;
      number = equationCounter;
    } else if (kind === "figure") {
      figureCounter += 1;
      number = figureCounter;
    } else {
      theoremCounters[prefix] = (theoremCounters[prefix] || 0) + 1;
      number = theoremCounters[prefix];
    }

    const lineStart = offsetToLine(lineOffsets, startOffset);
    const lineEnd = offsetToLine(lineOffsets, Math.max(startOffset, endOffset - 1));

    labels.set(label, {
      label,
      kind,
      prefix,
      number,
      title,
      lineStart,
      lineEnd
    });
  };

  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() !== "$$") {
      continue;
    }

    let endLine = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j].trim() === "$$") {
        endLine = j;
        break;
      }
    }

    if (endLine < 0) {
      continue;
    }

    let labelLine = endLine + 1;
    while (labelLine < lines.length && lines[labelLine].trim() === "") {
      labelLine += 1;
    }

    if (labelLine < lines.length) {
      const labelMatch = lines[labelLine].trim().match(/^\{#(eq-[A-Za-z0-9_-]+)\}$/);
      if (labelMatch) {
        const blockStartOffset = lineOffsets[i] || 0;
        const nextLineIndex = labelLine + 1;
        const blockEndOffset =
          nextLineIndex < lineOffsets.length ? lineOffsets[nextLineIndex] : source.length;
        addLabel(labelMatch[1], "equation", blockStartOffset, blockEndOffset);
      }
    }

    i = endLine;
  }

  const figurePattern = /!\[[^\]]*]\([^)]+\)\s*\{#(fig-[A-Za-z0-9_-]+)\}/g;
  let match = figurePattern.exec(source);
  while (match) {
    addLabel(match[1], "figure", match.index, figurePattern.lastIndex);
    match = figurePattern.exec(source);
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const startMatch = line.trim().match(THEOREM_START_PATTERN);
    if (!startMatch) {
      continue;
    }

    const label = startMatch[1];
    const blockStartOffset = lineOffsets[i] || 0;

    let title = "";
    let cursor = i + 1;
    let blockEndLine = i;
    let implicitClosedByNextStart = false;

    for (; cursor < lines.length; cursor += 1) {
      const current = lines[cursor];
      const currentTrimmed = current.trim();
      if (!title) {
        const headingMatch = current.match(/^\s*#{1,6}\s+(.+)\s*$/);
        if (headingMatch) {
          title = headingMatch[1].trim();
        }
      }

      if (THEOREM_END_PATTERN.test(currentTrimmed)) {
        blockEndLine = cursor;
        break;
      }

      if (THEOREM_START_PATTERN.test(currentTrimmed)) {
        blockEndLine = Math.max(i, cursor - 1);
        cursor = cursor - 1;
        implicitClosedByNextStart = true;
        break;
      }

      blockEndLine = cursor;
    }

    const nextLineIndex = blockEndLine + 1;
    const blockEndOffset =
      nextLineIndex < lineOffsets.length ? lineOffsets[nextLineIndex] : source.length;

    addLabel(label, "theorem", blockStartOffset, blockEndOffset, title);
    if (implicitClosedByNextStart && !title) {
      const fallbackTitleLine = lines[i + 1] || "";
      const fallbackTitle = fallbackTitleLine.trim();
      if (fallbackTitle && !THEOREM_START_PATTERN.test(fallbackTitle) && !THEOREM_END_PATTERN.test(fallbackTitle)) {
        const descriptor = labels.get(label);
        if (descriptor && !descriptor.title) {
          descriptor.title = fallbackTitle.replace(/^#+\s*/, "").trim();
        }
      }
    }
    i = cursor;
  }

  return { labels };
}

function buildCrossrefEditorExtension() {
  if (!RangeSetBuilder || !Decoration || !ViewPlugin) {
    return [];
  }

  const refMark = Decoration.mark({ class: "cm-crossref-ref" });
  const labelMark = Decoration.mark({ class: "cm-crossref-label" });

  return [
    ViewPlugin.fromClass(
      class {
        constructor(view) {
          this.decorations = this.buildDecorations(view);
        }

        update(update) {
          if (update.docChanged || update.viewportChanged) {
            this.decorations = this.buildDecorations(update.view);
          }
        }

        buildDecorations(view) {
          const builder = new RangeSetBuilder();
          const ranges = [];

          for (const visible of view.visibleRanges) {
            const chunk = view.state.doc.sliceString(visible.from, visible.to);

            CM_REF_PATTERN.lastIndex = 0;
            let match = CM_REF_PATTERN.exec(chunk);
            while (match) {
              const from = visible.from + match.index;
              ranges.push({
                from,
                to: from + match[0].length,
                mark: refMark
              });
              match = CM_REF_PATTERN.exec(chunk);
            }

            CM_LABEL_PATTERN.lastIndex = 0;
            match = CM_LABEL_PATTERN.exec(chunk);
            while (match) {
              const from = visible.from + match.index;
              ranges.push({
                from,
                to: from + match[0].length,
                mark: labelMark
              });
              match = CM_LABEL_PATTERN.exec(chunk);
            }
          }

          ranges.sort((a, b) => {
            if (a.from !== b.from) {
              return a.from - b.from;
            }
            if (a.to !== b.to) {
              return a.to - b.to;
            }
            return 0;
          });

          for (const range of ranges) {
            builder.add(range.from, range.to, range.mark);
          }

          return builder.finish();
        }
      },
      {
        decorations: (value) => value.decorations
      }
    )
  ];
}

class CrossrefReferenceSuggest extends EditorSuggest {
  constructor(plugin) {
    super(plugin.app);
    this.plugin = plugin;
  }

  onTrigger(cursor, editor, file) {
    const line = editor.getLine(cursor.line);
    const before = line.slice(0, cursor.ch);
    const match = before.match(/(?:^|[\s([{"'`.,;:!?，。；：、])@([A-Za-z0-9_-]*)$/);
    if (!match) {
      return null;
    }

    const query = match[1] || "";
    return {
      start: {
        line: cursor.line,
        ch: cursor.ch - query.length - 1
      },
      end: cursor,
      query,
      file
    };
  }

  async getSuggestions(context) {
    const filePath = context.file && context.file.path ? context.file.path : this.plugin.getActiveFilePath();
    if (!filePath) {
      return [];
    }

    const descriptors = await this.plugin.getLabelDescriptors(filePath);
    const query = (context.query || "").toLowerCase();

    return descriptors
      .filter((descriptor) => descriptor.label.toLowerCase().includes(query))
      .slice(0, 40);
  }

  renderSuggestion(descriptor, el) {
    const row = el.createDiv({ cls: "crossref-suggest-row" });
    row.createSpan({ text: `@${descriptor.label}`, cls: "crossref-suggest-main" });
    row.createSpan({ text: descriptorDisplay(descriptor), cls: "crossref-suggest-meta" });
  }

  selectSuggestion(descriptor) {
    if (!this.context) {
      return;
    }

    this.context.editor.replaceRange(
      `@${descriptor.label}`,
      this.context.start,
      this.context.end
    );
  }
}

class CrossrefLabelSuggest extends EditorSuggest {
  constructor(plugin) {
    super(plugin.app);
    this.plugin = plugin;
  }

  onTrigger(cursor, editor, file) {
    const line = editor.getLine(cursor.line);
    const before = line.slice(0, cursor.ch);
    const match = before.match(/\{#([A-Za-z0-9_-]*)$/);
    if (!match) {
      return null;
    }

    const query = match[1] || "";
    return {
      start: {
        line: cursor.line,
        ch: cursor.ch - query.length - 2
      },
      end: cursor,
      query,
      file
    };
  }

  getSuggestions(context) {
    const query = (context.query || "").toLowerCase();
    return LABEL_PREFIX_ITEMS.filter((item) => item.prefix.includes(query));
  }

  renderSuggestion(item, el) {
    const row = el.createDiv({ cls: "crossref-suggest-row" });
    row.createSpan({ text: `{#${item.prefix}}`, cls: "crossref-suggest-main" });
    row.createSpan({ text: item.desc, cls: "crossref-suggest-meta" });
  }

  selectSuggestion(item) {
    if (!this.context) {
      return;
    }

    const insertText = `{#${item.prefix}}`;
    const start = this.context.start;
    this.context.editor.replaceRange(insertText, start, this.context.end);
    this.context.editor.setCursor({
      line: start.line,
      ch: start.ch + insertText.length - 1
    });
  }
}

class CrossrefPreviewPlugin extends Plugin {
  async onload() {
    this.indexCache = new Map();
    this.debugLogPath = `${this.app.vault.configDir}/${DEBUG_LOG_RELATIVE_PATH}`;
    this.debugLogBuffer = [];
    this.debugLogFlushTimer = null;
    this.nativeFlashSuppressTimer = null;

    await this.resetDebugLogFile();

    this.registerMarkdownPostProcessor(async (element, context) => {
      await this.processSection(element, context);
    });

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file && file.path) {
          this.indexCache.delete(file.path);
          this.debugLog(file.path, "vault modify event");
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (oldPath) {
          this.indexCache.delete(oldPath);
        }
        if (file && file.path) {
          this.indexCache.delete(file.path);
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (file && file.path) {
          this.indexCache.delete(file.path);
        }
      })
    );

    this.registerEvent(
      this.app.workspace.on("editor-change", (_editor, view) => {
        const filePath = view && view.file ? view.file.path : null;
        if (filePath) {
          this.indexCache.delete(filePath);
        }
      })
    );

    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (!file || !file.path) {
          return;
        }
        this.indexCache.delete(file.path);
      })
    );

    this.referenceSuggest = new CrossrefReferenceSuggest(this);
    this.registerEditorSuggest(this.referenceSuggest);

    this.labelSuggest = new CrossrefLabelSuggest(this);
    this.registerEditorSuggest(this.labelSuggest);

    const editorExtension = buildCrossrefEditorExtension();
    if (editorExtension && editorExtension.length > 0) {
      this.registerEditorExtension(editorExtension);
    }

    this.registerDomEvent(document, "click", (event) => {
      this.handleReferenceClick(event);
    });
  }

  onunload() {
    this.flushDebugLogs();
    if (this.debugLogFlushTimer) {
      window.clearTimeout(this.debugLogFlushTimer);
      this.debugLogFlushTimer = null;
    }
    if (this.nativeFlashSuppressTimer) {
      window.clearTimeout(this.nativeFlashSuppressTimer);
      this.nativeFlashSuppressTimer = null;
    }
    if (document && document.body) {
      document.body.classList.remove(NATIVE_FLASH_SUPPRESS_CLASS);
    }
    this.indexCache.clear();
  }

  getActiveFilePath() {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    return activeView && activeView.file ? activeView.file.path : "";
  }

  isSourceRenderElement(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    if (element.closest(".cm-editor, .cm-contentContainer, .markdown-source-view")) {
      return true;
    }

    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (
      activeView &&
      typeof activeView.getMode === "function" &&
      activeView.getMode() !== "preview"
    ) {
      return true;
    }

    return false;
  }

  isDebugSource(sourcePath) {
    if (!sourcePath) {
      return false;
    }
    return sourcePath === DEBUG_NOTE_BASENAME || sourcePath.endsWith(`/${DEBUG_NOTE_BASENAME}`);
  }

  debugLog(sourcePath, message, payload) {
    if (!this.isDebugSource(sourcePath)) {
      return;
    }

    const timestamp = new Date().toISOString();
    let line = `[${timestamp}] ${sourcePath} ${message}`;
    if (typeof payload !== "undefined") {
      line += ` ${safeStringify(payload)}`;
    }
    this.enqueueDebugLogLine(`${line}\n`);

    if (typeof payload === "undefined") {
      console.log(`[CrossrefDebug] ${sourcePath} ${message}`);
      return;
    }
    console.log(`[CrossrefDebug] ${sourcePath} ${message}`, payload);
  }

  async resetDebugLogFile() {
    if (!DEBUG_NOTE_BASENAME || !this.debugLogPath) {
      return;
    }

    try {
      const header = `=== Crossref debug session ${new Date().toISOString()} ===\n`;
      await this.app.vault.adapter.write(this.debugLogPath, header);
    } catch (error) {
      console.error("Crossref Preview: failed to reset debug log file", error);
    }
  }

  enqueueDebugLogLine(line) {
    if (!this.debugLogPath) {
      return;
    }

    this.debugLogBuffer.push(line);
    if (this.debugLogFlushTimer) {
      return;
    }

    this.debugLogFlushTimer = window.setTimeout(() => {
      this.debugLogFlushTimer = null;
      this.flushDebugLogs();
    }, 80);
  }

  async flushDebugLogs() {
    if (!this.debugLogPath || this.debugLogBuffer.length === 0) {
      return;
    }

    const chunk = this.debugLogBuffer.join("");
    this.debugLogBuffer.length = 0;

    try {
      if (typeof this.app.vault.adapter.append === "function") {
        await this.app.vault.adapter.append(this.debugLogPath, chunk);
        return;
      }

      let existing = "";
      if (await this.app.vault.adapter.exists(this.debugLogPath)) {
        existing = await this.app.vault.adapter.read(this.debugLogPath);
      }
      await this.app.vault.adapter.write(this.debugLogPath, `${existing}${chunk}`);
    } catch (error) {
      console.error("Crossref Preview: failed to flush debug logs", error);
    }
  }

  async getLabelDescriptors(filePath) {
    if (!filePath) {
      return [];
    }

    const source = await this.readCurrentSource(filePath);
    if (!source) {
      return [];
    }

    const index = this.getCachedIndex(filePath, source);
    const descriptors = Array.from(index.labels.values());
    descriptors.sort((a, b) => a.lineStart - b.lineStart);
    return descriptors;
  }

  getTheoremDescriptors(index) {
    return Array.from(index.labels.values())
      .filter((descriptor) => descriptor.kind === "theorem")
      .sort((a, b) => a.lineStart - b.lineStart);
  }

  getSectionBounds(sectionInfo) {
    if (
      !sectionInfo ||
      !Number.isFinite(sectionInfo.lineStart) ||
      !Number.isFinite(sectionInfo.lineEnd)
    ) {
      return null;
    }

    return {
      start: Number(sectionInfo.lineStart),
      end: Number(sectionInfo.lineEnd)
    };
  }

  findTheoremMatchForSection(index, sectionInfo, directText) {
    const theoremDescriptors = this.getTheoremDescriptors(index);
    if (theoremDescriptors.length === 0) {
      return null;
    }

    const directStart = directText.match(THEOREM_START_PATTERN);
    if (directStart) {
      const descriptor = index.labels.get(directStart[1]);
      if (!descriptor || descriptor.kind !== "theorem") {
        return null;
      }
      return {
        descriptor,
        isStartSection: true,
        isFullyInside: true,
        sectionBounds: this.getSectionBounds(sectionInfo)
      };
    }

    if (THEOREM_END_PATTERN.test(directText)) {
      const sectionBounds = this.getSectionBounds(sectionInfo);
      if (!sectionBounds) {
        return null;
      }
      const descriptor = theoremDescriptors.find((item) => {
        return item.lineEnd >= sectionBounds.start && item.lineStart <= sectionBounds.end;
      });
      if (!descriptor) {
        return null;
      }
      return {
        descriptor,
        isStartSection: false,
        isFullyInside: true,
        sectionBounds
      };
    }

    const sectionBounds = this.getSectionBounds(sectionInfo);
    if (!sectionBounds) {
      return null;
    }

    const descriptor = theoremDescriptors.find((item) => {
      return item.lineEnd >= sectionBounds.start && item.lineStart <= sectionBounds.end;
    });
    if (!descriptor) {
      return null;
    }

    const isStartSection =
      sectionBounds.start <= descriptor.lineStart && sectionBounds.end >= descriptor.lineStart;
    const isFullyInside =
      sectionBounds.start >= descriptor.lineStart && sectionBounds.end <= descriptor.lineEnd;

    if (!isStartSection && !isFullyInside) {
      return null;
    }

    return {
      descriptor,
      isStartSection,
      isFullyInside,
      sectionBounds
    };
  }

  async renderTheoremSection(element, theoremMatch, sourcePath, source, index) {
    if (!(element instanceof HTMLElement) || !theoremMatch) {
      return;
    }

    const { descriptor, isStartSection, isFullyInside, sectionBounds } = theoremMatch;
    if (isStartSection) {
      const theoremNode = await this.createTheoremNodeFromSource(
        descriptor,
        sourcePath,
        source,
        index
      );
      element.replaceChildren(theoremNode);
      this.debugLog(sourcePath, "render theorem from section", {
        label: descriptor.label,
        lineStart: sectionBounds ? sectionBounds.start : null,
        lineEnd: sectionBounds ? sectionBounds.end : null
      });
      return;
    }

    if (isFullyInside) {
      if (element.childNodes.length > 0) {
        element.replaceChildren();
      }
      this.debugLog(sourcePath, "suppress overlapped theorem section", {
        label: descriptor.label,
        lineStart: sectionBounds ? sectionBounds.start : null,
        lineEnd: sectionBounds ? sectionBounds.end : null
      });
      return;
    }
  }

  async processSection(element, context) {
    if (!context || !context.sourcePath) {
      return;
    }

    if (this.isSourceRenderElement(element)) {
      return;
    }

    if (element instanceof HTMLElement && element.closest(".crossref-theorem")) {
      return;
    }

    const sourcePath = context.sourcePath;
    const source = await this.readCurrentSource(sourcePath);
    if (!source) {
      return;
    }

    const index = this.getCachedIndex(sourcePath, source);
    const sectionInfo = context.getSectionInfo ? context.getSectionInfo(element) : null;
    if (
      element instanceof HTMLElement &&
      sectionInfo &&
      Number.isFinite(sectionInfo.lineStart) &&
      Number.isFinite(sectionInfo.lineEnd)
    ) {
      element.dataset.crossrefLineStart = String(sectionInfo.lineStart);
      element.dataset.crossrefLineEnd = String(sectionInfo.lineEnd);
    }

    const directText = normalizeText(element);
    if (
      this.isDebugSource(sourcePath) &&
      (THEOREM_START_PATTERN.test(directText) ||
        THEOREM_END_PATTERN.test(directText) ||
        directText.startsWith("## "))
    ) {
      this.debugLog(sourcePath, "processSection candidate", {
        lineStart: sectionInfo && sectionInfo.lineStart,
        lineEnd: sectionInfo && sectionInfo.lineEnd,
        text: shortText(directText)
      });
    }

    const theoremMatch = this.findTheoremMatchForSection(index, sectionInfo, directText);
    if (theoremMatch) {
      await this.renderTheoremSection(element, theoremMatch, sourcePath, source, index);
      return;
    }

    const sectionTargets = this.selectTargetsForSection(index, sectionInfo);
    const equationLabels = sectionTargets
      .filter((descriptor) => descriptor.kind === "equation")
      .map((descriptor) => descriptor.label);
    const figureLabels = sectionTargets
      .filter((descriptor) => descriptor.kind === "figure")
      .map((descriptor) => descriptor.label);

    this.decorateEquationTargets(element, equationLabels, index);
    this.decorateFigureTargets(element, figureLabels, index);
    this.stripLabelTokens(element);
    this.decorateReferences(element, index, sourcePath);
    this.cleanupOrphanFenceMarkers(element);
    this.cleanupEmptyParagraphs(element);
  }

  selectTargetsForSection(index, sectionInfo) {
    const descriptors = Array.from(index.labels.values()).sort((a, b) => {
      if (a.lineStart !== b.lineStart) {
        return a.lineStart - b.lineStart;
      }
      return a.lineEnd - b.lineEnd;
    });

    if (!sectionInfo) {
      return [];
    }

    const sectionStart = Number.isFinite(sectionInfo.lineStart) ? sectionInfo.lineStart : 0;
    const sectionEnd = Number.isFinite(sectionInfo.lineEnd) ? sectionInfo.lineEnd : sectionStart;

    return descriptors.filter((descriptor) => {
      return descriptor.lineEnd >= sectionStart - 1 && descriptor.lineStart <= sectionEnd + 1;
    });
  }

  async readCurrentSource(sourcePath) {
    let editorSource = "";
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    const isPreviewMode =
      activeView &&
      typeof activeView.getMode === "function" &&
      activeView.getMode() === "preview";
    if (
      activeView &&
      activeView.file &&
      activeView.file.path === sourcePath &&
      activeView.editor &&
      !isPreviewMode
    ) {
      editorSource = activeView.editor.getValue();
    }

    const file = this.app.vault.getAbstractFileByPath(sourcePath);
    if (!file || typeof file.extension !== "string") {
      return editorSource || "";
    }

    try {
      const diskSource = await this.app.vault.cachedRead(file);
      if (!editorSource) {
        return diskSource;
      }

      const editorTheoremCount = countTheoremStartMarkers(editorSource);
      const diskTheoremCount = countTheoremStartMarkers(diskSource);

      if (diskTheoremCount > editorTheoremCount) {
        this.debugLog(sourcePath, "editor source fallback to disk snapshot", {
          editorTheoremCount,
          diskTheoremCount
        });
        return diskSource;
      }

      if (editorTheoremCount > diskTheoremCount) {
        return editorSource;
      }

      if (diskSource.length > editorSource.length + 20) {
        this.debugLog(sourcePath, "editor source fallback to longer disk snapshot", {
          editorLength: editorSource.length,
          diskLength: diskSource.length
        });
        return diskSource;
      }

      return editorSource;
    } catch (error) {
      console.error("Crossref Preview: failed to read source file", error);
      return editorSource || "";
    }
  }

  getCachedIndex(sourcePath, source) {
    const hash = fastHash(source);
    const cached = this.indexCache.get(sourcePath);
    if (cached && cached.hash === hash) {
      return cached.index;
    }

    const index = parseCrossrefIndex(source);
    if (this.isDebugSource(sourcePath)) {
      const theoremLabels = Array.from(index.labels.values())
        .filter((item) => item.kind === "theorem")
        .map((item) => item.label);
      this.debugLog(sourcePath, "index rebuilt", {
        labelCount: index.labels.size,
        theoremLabels
      });
    }
    this.indexCache.set(sourcePath, { hash, index });
    return index;
  }

  async createTheoremNodeFromSource(descriptor, sourcePath, source, index) {
    const lines = source.split(/\r?\n/);
    const bodyStart = Math.max(0, descriptor.lineStart + 1);
    const bodyEnd = Math.min(lines.length, Math.max(bodyStart, descriptor.lineEnd));
    const bodyLines = lines.slice(bodyStart, bodyEnd);

    let heading = descriptor.title || "";
    for (let i = 0; i < bodyLines.length; i += 1) {
      const headingMatch = bodyLines[i].match(/^\s*#{1,6}\s+(.+)\s*$/);
      if (!headingMatch) {
        continue;
      }
      heading = headingMatch[1].trim();
      bodyLines.splice(i, 1);
      break;
    }

    const theorem = document.createElement("div");
    theorem.className = `crossref-theorem crossref-theorem-${descriptor.prefix}`;
    this.applyTargetHost(theorem, descriptor.label, "theorem");

    const title = document.createElement("div");
    title.className = "crossref-theorem-title";
    const titlePrefix = descriptorDisplay(descriptor);
    title.textContent = heading ? `${titlePrefix}. ${heading}` : titlePrefix;
    theorem.appendChild(title);

    const body = document.createElement("div");
    body.className = "crossref-theorem-body";
    const bodyMarkdown = bodyLines.join("\n").trim();
    if (bodyMarkdown) {
      await MarkdownRenderer.renderMarkdown(bodyMarkdown, body, sourcePath, this);
    }
    theorem.appendChild(body);

    this.stripLabelTokens(theorem);
    this.decorateReferences(theorem, index, sourcePath);
    this.cleanupEmptyParagraphs(theorem);

    this.debugLog(sourcePath, "createTheoremNodeFromSource", {
      label: descriptor.label,
      heading: heading || "",
      bodyLineCount: bodyLines.length
    });

    return theorem;
  }

  decorateEquationTargets(root, labels, index) {
    if (!labels.length) {
      return;
    }

    const hosts = this.collectEquationHosts(root);
    const sourcePath = this.getActiveFilePath();
    if (this.isDebugSource(sourcePath)) {
      this.debugLog(sourcePath, "decorate equation targets", {
        labelCount: labels.length,
        hostCount: hosts.length
      });
    }
    const count = Math.min(labels.length, hosts.length);

    for (let i = 0; i < count; i += 1) {
      const label = labels[i];
      const host = hosts[i];
      if (!host) {
        continue;
      }

      const descriptor = index.labels.get(label) || this.createFallbackDescriptor(label);
      this.applyTargetHost(host, label, "equation");

      let badge = host.querySelector(".crossref-eq-number");
      if (!badge) {
        badge = document.createElement("span");
        badge.className = "crossref-eq-number";
        host.appendChild(badge);
      }
      badge.dataset.label = label;
      badge.textContent = descriptorDisplay(descriptor);

      if (this.isDebugSource(sourcePath)) {
        this.debugLog(sourcePath, "equation target attached", {
          label,
          hostTag: host.tagName
        });
      }
    }
  }

  decorateFigureTargets(root, labels, index) {
    if (!labels.length) {
      return;
    }

    const images = Array.from(root.querySelectorAll("img"));
    const count = Math.min(labels.length, images.length);

    for (let i = 0; i < count; i += 1) {
      const label = labels[i];
      const image = images[i];
      const host = image.closest("figure, p, div, li") || image.parentElement;
      if (!(host instanceof HTMLElement)) {
        continue;
      }

      const descriptor = index.labels.get(label) || this.createFallbackDescriptor(label);
      this.applyTargetHost(host, label, "figure");

      let caption = host.querySelector(".crossref-fig-number");
      if (!caption) {
        caption = document.createElement("div");
        caption.className = "crossref-fig-number";
        host.appendChild(caption);
      }
      caption.dataset.label = label;
      caption.textContent = descriptorDisplay(descriptor);
    }
  }

  collectEquationHosts(root) {
    const directMath = Array.from(root.querySelectorAll(".math.math-block, .math-block")).map(
      (node) => this.resolveEquationHost(node)
    );
    const mjxMath = Array.from(root.querySelectorAll("mjx-container[display='true']")).map(
      (node) => this.resolveEquationHost(node)
    );

    return dedupeElements(directMath.concat(mjxMath));
  }

  resolveEquationHost(node) {
    if (!(node instanceof HTMLElement)) {
      return null;
    }

    if (node.tagName.toLowerCase() === "mjx-container") {
      return (
        node.closest("figure, div, p, section, blockquote, li") ||
        node.parentElement ||
        node
      );
    }

    return node.closest("figure, div, p, section, blockquote, li") || node;
  }

  applyTargetHost(host, label, kind) {
    if (!(host instanceof HTMLElement)) {
      return;
    }

    host.classList.add("crossref-target");
    host.classList.add(`crossref-${kind}`);
    host.dataset.crossrefTarget = label;
    host.dataset.crossrefKind = kind;

    this.ensureAnchor(host, label);
  }

  ensureAnchor(host, label) {
    if (!(host instanceof HTMLElement)) {
      return;
    }

    const oldAnchors = Array.from(host.querySelectorAll(".crossref-anchor"));
    for (const oldAnchor of oldAnchors) {
      if (oldAnchor.dataset.label !== label) {
        oldAnchor.remove();
      }
    }

    let anchor = host.querySelector(`.crossref-anchor[data-label="${this.cssEscape(label)}"]`);
    if (!anchor) {
      anchor = document.createElement("span");
      anchor.className = "crossref-anchor";
      anchor.dataset.label = label;
      host.prepend(anchor);
    }
    anchor.id = label;
  }

  stripLabelTokens(root) {
    const textNodes = this.collectTextNodes(root, (node) => !this.shouldSkipTextNode(node));

    for (const textNode of textNodes) {
      const raw = textNode.nodeValue || "";
      if (!raw.includes("{#")) {
        continue;
      }

      if (THEOREM_START_PATTERN.test(raw.trim())) {
        continue;
      }

      const parent = textNode.parentElement;
      if (parent && THEOREM_START_PATTERN.test(normalizeText(parent))) {
        continue;
      }

      const replaced = raw.replace(LABEL_TOKEN_PATTERN, "");
      if (replaced !== raw) {
        textNode.nodeValue = replaced;
      }
    }
  }

  decorateReferences(root, index, sourcePath) {
    const textNodes = this.collectTextNodes(root, (node) => !this.shouldSkipTextNode(node));

    for (const textNode of textNodes) {
      const text = textNode.nodeValue || "";
      if (!text.includes("@")) {
        continue;
      }
      this.replaceReferencesInNode(textNode, index, sourcePath);
    }
  }

  replaceReferencesInNode(textNode, index, sourcePath) {
    const text = textNode.nodeValue || "";
    REF_PATTERN.lastIndex = 0;

    let cursor = 0;
    let replaced = false;
    const fragment = document.createDocumentFragment();
    let match = REF_PATTERN.exec(text);

    while (match) {
      const raw = match[0];
      const label = match[1];
      const atIndex = match.index;
      const previous = atIndex > 0 ? text.charAt(atIndex - 1) : "";

      if (atIndex > 0 && /[A-Za-z0-9_]/.test(previous)) {
        match = REF_PATTERN.exec(text);
        continue;
      }

      if (atIndex > cursor) {
        fragment.appendChild(document.createTextNode(text.slice(cursor, atIndex)));
      }

      const descriptor = index.labels.get(label);
      if (descriptor) {
        const link = document.createElement("a");
        link.className = `crossref-ref crossref-ref-${descriptor.kind}`;
        link.href = `#${label}`;
        link.dataset.href = `${sourcePath}#${label}`;
        link.dataset.crossrefLabel = label;
        link.textContent = descriptorDisplay(descriptor);
        fragment.appendChild(link);
      } else {
        const missing = document.createElement("span");
        missing.className = "crossref-ref crossref-ref-missing";
        missing.dataset.crossrefMissing = label;
        missing.textContent = raw;
        fragment.appendChild(missing);
      }

      cursor = atIndex + raw.length;
      replaced = true;
      match = REF_PATTERN.exec(text);
    }

    if (!replaced) {
      return;
    }

    if (cursor < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(cursor)));
    }

    if (textNode.parentNode) {
      textNode.parentNode.replaceChild(fragment, textNode);
    }
  }

  async handleReferenceClick(event) {
    if (!(event.target instanceof Element)) {
      return;
    }

    const link = event.target.closest("a.crossref-ref");
    if (!link) {
      return;
    }

    const rawLabel = link.dataset.crossrefLabel || (link.getAttribute("href") || "").replace(/^#/, "");
    const label = decodeURIComponent(rawLabel);
    if (!label) {
      return;
    }

    event.preventDefault();

    const target = this.findTargetElement(label, link);
    if (!target) {
      const navigated = await this.navigateToReferenceLabel(label, link);
      if (!navigated) {
        this.debugLog(this.getActiveFilePath(), "reference click target missing", { label });
      }
      return;
    }

    const focusHost = target.closest("[data-crossref-target]") || target;
    this.clearNativeFlashHighlights(link);
    this.debugLog(this.getActiveFilePath(), "reference click target resolved", {
      label,
      kind:
        (focusHost instanceof HTMLElement && focusHost.dataset
          ? focusHost.dataset.crossrefKind
          : "") || ""
    });
    focusHost.scrollIntoView({ behavior: "smooth", block: "center" });
    focusHost.classList.add("crossref-target-flash");
    window.setTimeout(() => {
      focusHost.classList.remove("crossref-target-flash");
    }, 1200);
  }

  async navigateToReferenceLabel(label, originLink) {
    const sourcePath = this.getActiveFilePath();
    if (!sourcePath) {
      return false;
    }

    const cached = this.indexCache.get(sourcePath);
    const index = cached ? cached.index : null;
    const descriptor = index && index.labels ? index.labels.get(label) : null;
    if (!descriptor) {
      return false;
    }

    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!activeView || !activeView.leaf) {
      return false;
    }

    try {
      this.startNativeFlashSuppression();

      await this.app.workspace.openLinkText(
        sourcePath,
        sourcePath,
        false,
        {
          active: true,
          eState: {
            line: descriptor.lineStart
          }
        }
      );

      await new Promise((resolve) => {
        window.setTimeout(resolve, 90);
      });

      this.clearNativeFlashHighlights(originLink);

      const target = this.findTargetElement(label, originLink);
      if (target) {
        const focusHost = target.closest("[data-crossref-target]") || target;
        focusHost.scrollIntoView({ behavior: "smooth", block: "center" });
        focusHost.classList.add("crossref-target-flash");
        window.setTimeout(() => {
          focusHost.classList.remove("crossref-target-flash");
        }, 1200);
        this.debugLog(sourcePath, "reference click target resolved", {
          label,
          kind:
            (focusHost instanceof HTMLElement && focusHost.dataset
              ? focusHost.dataset.crossrefKind
              : "") || "",
          via: "fallback-open-link-line"
        });
      } else {
        this.debugLog(sourcePath, "reference fallback navigation attempted", {
          label,
          line: descriptor.lineStart
        });
      }
      return true;
    } catch (_error) {
      return false;
    }
  }

  startNativeFlashSuppression() {
    if (!document || !document.body) {
      return;
    }

    document.body.classList.add(NATIVE_FLASH_SUPPRESS_CLASS);
    this.clearDocumentNativeFlashHighlights();
    if (this.nativeFlashSuppressTimer) {
      window.clearTimeout(this.nativeFlashSuppressTimer);
    }

    this.nativeFlashSuppressTimer = window.setTimeout(() => {
      this.nativeFlashSuppressTimer = null;
      if (document && document.body) {
        document.body.classList.remove(NATIVE_FLASH_SUPPRESS_CLASS);
      }
    }, NATIVE_FLASH_SUPPRESS_DURATION_MS);
  }

  clearDocumentNativeFlashHighlights() {
    if (!document || typeof document.querySelectorAll !== "function") {
      return;
    }

    const flashing = document.querySelectorAll(".is-flashing");
    for (const node of flashing) {
      if (!(node instanceof HTMLElement)) {
        continue;
      }
      node.classList.remove("is-flashing");
    }
  }

  clearNativeFlashHighlights(originLink) {
    const roots = this.collectReferenceSearchRoots(originLink);
    const visited = new Set();

    for (const root of roots) {
      if (!root || typeof root.querySelectorAll !== "function") {
        continue;
      }

      const flashing = root.querySelectorAll(".is-flashing");
      for (const node of flashing) {
        if (!(node instanceof HTMLElement) || visited.has(node)) {
          continue;
        }
        visited.add(node);
        node.classList.remove("is-flashing");
      }
    }
  }

  findTargetElement(label, originLink) {
    const roots = this.collectReferenceSearchRoots(originLink);

    for (const root of roots) {
      const direct = this.findDirectTargetInRoot(root, label);
      if (direct) {
        return direct;
      }
    }

    for (const root of roots) {
      const badgeTarget = this.findBadgeTargetInRoot(root, label);
      if (badgeTarget) {
        return badgeTarget;
      }
    }

    const sourcePath = this.getActiveFilePath();
    const cached = sourcePath ? this.indexCache.get(sourcePath) : null;
    const index = cached ? cached.index : null;
    const descriptor = index && index.labels ? index.labels.get(label) : null;
    if (!descriptor) {
      return null;
    }

    for (const root of roots) {
      const byRange = this.findTargetBySectionRange(root, descriptor);
      if (byRange) {
        return byRange;
      }
    }

    return null;
  }

  collectReferenceSearchRoots(originLink) {
    const roots = [];
    const seen = new Set();
    const add = (root) => {
      if (!root || seen.has(root)) {
        return;
      }
      seen.add(root);
      roots.push(root);
    };

    const leafContent = originLink.closest(".workspace-leaf-content");
    if (leafContent) {
      add(leafContent);
    }

    const previewRoot = originLink.closest(
      ".markdown-preview-sizer, .markdown-preview-view, .markdown-rendered"
    );
    if (previewRoot) {
      add(previewRoot);
    }

    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView && activeView.contentEl) {
      add(activeView.contentEl);
    }

    add(document);
    return roots;
  }

  findDirectTargetInRoot(root, label) {
    if (!root || typeof root.querySelectorAll !== "function") {
      return null;
    }

    const byId =
      root instanceof Document
        ? root.getElementById(label)
        : root.querySelector(`#${this.cssEscape(label)}`);
    if (byId) {
      return byId;
    }

    const targets = root.querySelectorAll("[data-crossref-target]");
    for (const target of targets) {
      if (target instanceof HTMLElement && target.dataset.crossrefTarget === label) {
        return target;
      }
    }

    return null;
  }

  findBadgeTargetInRoot(root, label) {
    if (!root || typeof root.querySelector !== "function") {
      return null;
    }

    const escaped = this.cssEscape(label);
    const equationBadge = root.querySelector(`.crossref-eq-number[data-label="${escaped}"]`);
    if (equationBadge instanceof HTMLElement) {
      return equationBadge.closest("[data-crossref-target]") || equationBadge.parentElement;
    }

    const figureBadge = root.querySelector(`.crossref-fig-number[data-label="${escaped}"]`);
    if (figureBadge instanceof HTMLElement) {
      return figureBadge.closest("[data-crossref-target]") || figureBadge.parentElement;
    }

    return null;
  }

  findTargetBySectionRange(root, descriptor) {
    if (
      !root ||
      typeof root.querySelectorAll !== "function" ||
      !descriptor ||
      !Number.isFinite(descriptor.lineStart) ||
      !Number.isFinite(descriptor.lineEnd)
    ) {
      return null;
    }

    const sections = root.querySelectorAll("[data-crossref-line-start][data-crossref-line-end]");
    for (const section of sections) {
      if (!(section instanceof HTMLElement)) {
        continue;
      }

      const start = Number(section.dataset.crossrefLineStart);
      const end = Number(section.dataset.crossrefLineEnd);
      if (!Number.isFinite(start) || !Number.isFinite(end)) {
        continue;
      }

      if (end < descriptor.lineStart || start > descriptor.lineEnd) {
        continue;
      }

      if (descriptor.kind === "equation") {
        const eqHost = section.querySelector(
          '[data-crossref-kind="equation"], .crossref-equation, .math.math-block, .math-block, mjx-container[display="true"]'
        );
        if (eqHost instanceof HTMLElement) {
          return eqHost.closest("[data-crossref-target]") || eqHost;
        }
      } else if (descriptor.kind === "figure") {
        const figHost = section.querySelector(
          '[data-crossref-kind="figure"], .crossref-figure, figure, img'
        );
        if (figHost instanceof HTMLElement) {
          return figHost.closest("[data-crossref-target]") || figHost;
        }
      } else {
        const theoremHost = section.querySelector(
          '[data-crossref-kind="theorem"], .crossref-theorem'
        );
        if (theoremHost instanceof HTMLElement) {
          return theoremHost.closest("[data-crossref-target]") || theoremHost;
        }
      }

      return section;
    }

    return null;
  }

  cleanupOrphanFenceMarkers(root) {
    const paragraphs = Array.from(root.querySelectorAll("p"));
    for (const paragraph of paragraphs) {
      if (paragraph.querySelector("img, .math, mjx-container, .crossref-theorem")) {
        continue;
      }

      const text = normalizeText(paragraph);
      if (!THEOREM_END_PATTERN.test(text)) {
        continue;
      }

      const prev = paragraph.previousElementSibling;
      if (prev && prev.classList.contains("crossref-theorem")) {
        paragraph.remove();
      }
    }
  }

  cleanupEmptyParagraphs(root) {
    const paragraphs = Array.from(root.querySelectorAll("p"));
    for (const paragraph of paragraphs) {
      if (paragraph.querySelector("img, .math, mjx-container")) {
        continue;
      }
      if ((paragraph.textContent || "").trim().length > 0) {
        continue;
      }
      paragraph.remove();
    }
  }

  collectTextNodes(root, predicate) {
    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let current = walker.nextNode();
    while (current) {
      if (predicate(current)) {
        nodes.push(current);
      }
      current = walker.nextNode();
    }
    return nodes;
  }

  shouldSkipTextNode(textNode) {
    const parent = textNode.parentElement;
    if (!parent) {
      return true;
    }

    return Boolean(
      parent.closest(
        "a, code, pre, .math, mjx-container, .cm-inline-code, .cm-formatting-code, .crossref-eq-number, .crossref-fig-number, .crossref-theorem-title"
      )
    );
  }

  createFallbackDescriptor(label) {
    const prefix = label.includes("-") ? label.split("-")[0] : "thm";
    let kind = "theorem";
    if (prefix === "eq") {
      kind = "equation";
    } else if (prefix === "fig") {
      kind = "figure";
    }

    return {
      label,
      prefix,
      kind,
      number: "?",
      title: "",
      lineStart: 0,
      lineEnd: 0
    };
  }

  cssEscape(value) {
    if (typeof CSS !== "undefined" && CSS && typeof CSS.escape === "function") {
      return CSS.escape(value);
    }
    return String(value).replace(/([^\w-])/g, "\\$1");
  }
}

module.exports = CrossrefPreviewPlugin;
