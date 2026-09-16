/**
 * Copy Cookie Header - Caido frontend plugin
 *
 * Copy: right click a request, copy its whole "Cookie: ..." header line.
 * Paste: right click an editable request pane, replace its Cookie header
 *        with whatever is on the clipboard.
 *
 * Both also work from a keyboard shortcut or the command palette. Those
 * fire with BaseContext, which carries no request, so the target is worked
 * out from the current page's own selection instead.
 */

/**
 * The headers this plugin moves around.
 *
 * `join` is what to do when a request carries the header more than once:
 * a cookie list is routinely split across several headers on HTTP/2 and the
 * pieces belong together, while a second Authorization header is a mistake,
 * so the first one wins.
 *
 * The cookie command ids are the original ones. They are what any existing
 * keyboard shortcut is bound to, so they do not change.
 */
const Headers = {
  cookie: {
    name: "Cookie",
    join: "; ",
    copyId: "copy-cookie-header.copy",
    pasteId: "copy-cookie-header.paste",
    copyIcon: "fas fa-cookie-bite",
  },
  authorization: {
    name: "Authorization",
    join: null,
    copyId: "copy-cookie-header.copy-authorization",
    pasteId: "copy-cookie-header.paste-authorization",
    copyIcon: "fas fa-key",
  },
};

const DIAGNOSE_COMMAND = "copy-cookie-header.diagnose";

const REQUEST_LINE = /^[A-Za-z][A-Za-z0-9!#$%&'*+.^_`|~-]* \S+ HTTP\/\d/;

/** Last fetch failure, surfaced in toasts and diagnostics. */
let lastFetchError = "";

/* ------------------------------------------------------------------ */
/* Raw request parsing                                                 */
/* ------------------------------------------------------------------ */

/**
 * GraphQL returns `raw` as a Blob scalar, which is base64. A request pane
 * hands back plain text. Accept either.
 */
function normalizeRaw(raw) {
  if (typeof raw !== "string" || raw.length === 0) return "";
  if (REQUEST_LINE.test(raw)) return raw;

  try {
    const binary = atob(raw.replace(/\s+/g, ""));
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    const decoded = new TextDecoder("utf-8").decode(bytes);
    if (REQUEST_LINE.test(decoded)) return decoded;
  } catch {
    /* not base64 */
  }

  return raw;
}

/**
 * Split the header block into lines with absolute offsets into `text`.
 * Stops at the blank line so the body is never touched.
 */
function headerLines(text) {
  const separator = /\r?\n\r?\n/.exec(text);
  const head = separator ? text.slice(0, separator.index) : text;

  const lines = [];
  const breaks = /\r?\n/g;
  let start = 0;
  let match;

  while ((match = breaks.exec(head)) !== null) {
    lines.push({ from: start, to: match.index, text: head.slice(start, match.index) });
    start = match.index + match[0].length;
  }
  lines.push({ from: start, to: head.length, text: head.slice(start) });

  return lines;
}

/**
 * Indexes of the lines making up one header, including any obs-fold
 * continuation lines that belong to it. Header names are case insensitive,
 * which also covers the lowercase names HTTP/2 uses.
 */
function headerLineIndexes(lines, name) {
  const wanted = name.toLowerCase();
  const found = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].text;

    if (/^[ \t]/.test(line)) {
      if (found.length > 0 && found[found.length - 1] === i - 1) found.push(i);
      continue;
    }

    const colon = line.indexOf(":");
    if (colon === -1) continue;
    if (line.slice(0, colon).trim().toLowerCase() === wanted) found.push(i);
  }

  return found;
}

/** Build the full "Name: ..." line from a raw request, or "" if absent. */
function extractHeader(raw, spec) {
  const text = normalizeRaw(raw);
  const lines = headerLines(text);
  const indexes = headerLineIndexes(lines, spec.name);
  if (indexes.length === 0) return "";

  const values = [];
  let current = null;

  for (const i of indexes) {
    const line = lines[i].text;
    if (/^[ \t]/.test(line)) {
      if (current !== null) current += " " + line.trim();
      continue;
    }
    if (current !== null) values.push(current);
    current = line.slice(line.indexOf(":") + 1).trim();
  }
  if (current !== null) values.push(current);

  const present = values.filter(Boolean);
  const value = spec.join === null ? present[0] : present.join(spec.join);

  return value ? `${spec.name}: ${value}` : "";
}

/* ------------------------------------------------------------------ */
/* Paste planning                                                      */
/* ------------------------------------------------------------------ */

/**
 * Turn whatever is on the clipboard into one header line.
 *
 * Returns `{ header }`, or `{ mismatch }` when the clipboard holds one of
 * the other headers this plugin copies. Both commands share a single
 * clipboard, so that is a slip worth naming rather than pasting
 * "Authorization: Cookie: sid=1" into the request.
 */
function normalizeClipboard(clip, spec) {
  const collapsed = String(clip ?? "").replace(/\s*\r?\n\s*/g, " ").trim();
  if (!collapsed) return {};

  // Accept a whole header line or a bare value. Only this header's own name
  // is stripped, so pasting "Bearer x" keeps every word of the value.
  const colon = collapsed.indexOf(":");
  const prefix = colon === -1 ? "" : collapsed.slice(0, colon).trim().toLowerCase();

  if (prefix === spec.name.toLowerCase()) {
    const value = collapsed.slice(colon + 1).trim();
    return value ? { header: `${spec.name}: ${value}` } : {};
  }

  const other = Object.values(Headers).find(
    (h) => h !== spec && h.name.toLowerCase() === prefix,
  );
  if (other) return { mismatch: other.name };

  return { header: `${spec.name}: ${collapsed}` };
}

function planHeaderPaste(text, spec, header) {
  const lines = headerLines(text);
  const indexes = headerLineIndexes(lines, spec.name);

  if (indexes.length === 0) {
    const lineBreak = text.includes("\r\n") ? "\r\n" : "\n";
    const last = lines[lines.length - 1];
    return [{ from: last.to, to: last.to, insert: lineBreak + header }];
  }

  const changes = [
    { from: lines[indexes[0]].from, to: lines[indexes[0]].to, insert: header },
  ];

  for (let k = 1; k < indexes.length; k++) {
    const i = indexes[k];
    changes.push({ from: lines[i - 1].to, to: lines[i].to, insert: "" });
  }

  return changes;
}

/* ------------------------------------------------------------------ */
/* Clipboard                                                           */
/* ------------------------------------------------------------------ */

async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.top = "-1000px";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(area);
      return ok;
    } catch {
      return false;
    }
  }
}

async function readClipboard() {
  try {
    return await navigator.clipboard.readText();
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* GraphQL request lookup                                              */
/* ------------------------------------------------------------------ */

/**
 * Different SDK builds have returned the query result either bare or
 * wrapped in a `data` envelope. Accept both rather than assume.
 */
function unwrapRequest(result) {
  if (!result || typeof result !== "object") return undefined;
  return result.request ?? result.data?.request ?? undefined;
}

/**
 * Fetch a request's raw content by id. Tries the id as given and then as
 * a string, since GraphQL ID coercion is a common mismatch.
 */
async function fetchRawById(sdk, id) {
  const attempts = [id];
  if (typeof id !== "string") attempts.push(String(id));

  for (const candidate of attempts) {
    try {
      const result = await sdk.graphql.request({ id: candidate });
      const request = unwrapRequest(result);

      if (request?.raw) return request.raw;

      lastFetchError = request
        ? `request ${candidate} returned no raw content`
        : `request ${candidate} not found (keys: ${Object.keys(result ?? {}).join(",") || "none"})`;
    } catch (err) {
      lastFetchError = `graphql error for id ${candidate}: ${err?.message ?? err}`;
    }
  }

  sdk.log.error(`[copy-cookie-header] ${lastFetchError}`);
  return "";
}

/* ------------------------------------------------------------------ */
/* Target resolution                                                   */
/* ------------------------------------------------------------------ */

/** Every request id in a page selection, the focused one first. */
function selectedIds(selection) {
  if (selection?.kind !== "Selected") return [];
  return [selection.main, ...(selection.secondary ?? [])].filter((id) => id !== undefined);
}

function currentPage(sdk) {
  try {
    return sdk.window.getContext()?.page;
  } catch {
    return undefined;
  }
}

/** The focused editor, but only if it actually holds an HTTP request. */
function activeEditor(sdk) {
  try {
    const editor = sdk.window.getActiveEditor();
    if (!editor) return undefined;

    const text = editor.getEditorView().state.doc.toString();
    // Rejects response editors and any other focused text field.
    if (!REQUEST_LINE.test(text)) return undefined;

    return { editor, text };
  } catch {
    return undefined;
  }
}

/**
 * Every place the request could be, best first.
 *
 * A right-click menu names the request outright. A keyboard shortcut and
 * the command palette both run with BaseContext, which carries nothing, so
 * the page's own selection comes next and the focused editor last.
 *
 * Sources are lazy and are tried in turn, so a selection that resolves to
 * nothing, or to a request with no Cookie header, hands over to the next
 * one instead of ending the search.
 */
function candidateSources(sdk, context) {
  const sources = [];
  const fromId = (label, id) => sources.push({ label, get: () => fetchRawById(sdk, id) });

  let editorAdded = false;
  const fromEditor = (label) => {
    if (editorAdded) return;
    editorAdded = true;
    sources.push({ label, get: async () => activeEditor(sdk)?.text ?? "" });
  };

  switch (context?.type) {
    case "RequestContext":
      // A Replay draft carries its raw inline; a stored request may only
      // carry metadata, in which case the id is all there is to go on.
      if (context.request?.raw) {
        sources.push({ label: "the request pane", get: async () => context.request.raw });
      } else if (context.request?.id !== undefined) {
        fromId(`request #${context.request.id}`, context.request.id);
      }
      break;

    case "RequestRowContext":
      for (const request of context.requests ?? []) {
        if (request?.id !== undefined) fromId(`row #${request.id}`, request.id);
      }
      break;

    case "ResponseContext":
      if (context.request?.id !== undefined) {
        fromId(`request #${context.request.id}`, context.request.id);
      }
      break;

    default:
      break;
  }

  const page = currentPage(sdk);

  switch (page?.kind) {
    case "HTTPHistory":
      for (const id of selectedIds(page.selection)) fromId(`HTTP History #${id}`, id);
      break;

    case "Sitemap":
      for (const id of selectedIds(page.requestSelection)) fromId(`Sitemap #${id}`, id);
      break;

    case "Automate":
      for (const id of selectedIds(page.requestSelection)) fromId(`Automate #${id}`, id);
      break;

    // In Replay the editor holds unsaved edits, so it beats the stored entry.
    case "Replay": {
      fromEditor("the Replay editor");

      try {
        const requestId = sdk.replay.getCurrentEntry()?.requestId;
        if (requestId !== undefined) fromId(`Replay #${requestId}`, requestId);
      } catch {
        /* no current entry */
      }
      break;
    }

    // Intercept reports intercept entry ids, not request ids, and the two
    // share one numeric space, so looking one up would hand back an
    // unrelated request. The editor below is the only safe source there.
    default:
      break;
  }

  fromEditor("the focused request pane");

  return sources;
}

/* ------------------------------------------------------------------ */
/* Commands                                                            */
/* ------------------------------------------------------------------ */

async function runCopy(sdk, spec, context) {
  lastFetchError = "";

  // Sources that held a request but not this header, named in the toast so
  // a miss says which request was actually read.
  const searched = [];

  for (const source of candidateSources(sdk, context)) {
    const raw = await source.get();
    if (!raw) continue;

    searched.push(source.label);

    const header = extractHeader(raw, spec);
    if (!header) continue;

    const copied = await writeClipboard(header);

    sdk.window.showToast(
      copied
        ? `${spec.name} header copied from ${source.label}.`
        : `Copy ${spec.name} Header: clipboard write failed.`,
      { variant: copied ? "success" : "error", duration: 2000 },
    );
    return;
  }

  if (searched.length === 0) {
    sdk.window.showToast(
      lastFetchError
        ? `Copy ${spec.name} Header: ${lastFetchError}`
        : `Copy ${spec.name} Header: no request found. Select a row or focus a request pane.`,
      { variant: "warning", duration: 6000 },
    );
    return;
  }

  sdk.window.showToast(
    `Copy ${spec.name} Header: no ${spec.name} header in ${searched.join(", ")}.`,
    { variant: "warning", duration: 6000 },
  );
}

async function runPaste(sdk, spec) {
  const target = activeEditor(sdk);

  if (!target) {
    sdk.window.showToast(`Paste ${spec.name} Header: focus a request editor first.`, {
      variant: "warning",
    });
    return;
  }

  if (target.editor.isReadOnly()) {
    sdk.window.showToast(
      `Paste ${spec.name} Header: this request is read only. Use a Replay tab.`,
      { variant: "warning" },
    );
    return;
  }

  const clip = await readClipboard();

  if (clip === null) {
    sdk.window.showToast(`Paste ${spec.name} Header: could not read the clipboard.`, {
      variant: "error",
    });
    return;
  }

  const { header, mismatch } = normalizeClipboard(clip, spec);

  if (mismatch) {
    sdk.window.showToast(
      `Paste ${spec.name} Header: the clipboard holds ${/^[aeiou]/i.test(mismatch) ? "an" : "a"} ${mismatch} header. Copy ${spec.name} first.`,
      { variant: "warning", duration: 6000 },
    );
    return;
  }

  if (!header) {
    sdk.window.showToast(`Paste ${spec.name} Header: clipboard is empty.`, {
      variant: "warning",
    });
    return;
  }

  const changes = planHeaderPaste(target.text, spec, header);
  const replaced = changes[0].to > changes[0].from;

  target.editor.getEditorView().dispatch({ changes });
  target.editor.focus();

  sdk.window.showToast(
    replaced ? `${spec.name} header replaced.` : `${spec.name} header added.`,
    { variant: "success", duration: 2000 },
  );
}

/**
 * Dump everything needed to work out why a lookup failed, straight to the
 * clipboard. Palette only, no menu entry.
 */
async function runDiagnose(sdk) {
  const out = [];
  const show = (v) => {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  };

  const page = currentPage(sdk);
  out.push(`page kind: ${page?.kind ?? "undefined"}`);
  out.push(`page keys: ${page ? Object.keys(page).join(",") : "none"}`);
  out.push(`selection: ${show(page?.selection)}`);
  out.push(`requestSelection: ${show(page?.requestSelection)}`);

  const editor = (() => {
    try {
      return sdk.window.getActiveEditor();
    } catch (e) {
      return undefined;
    }
  })();
  out.push(`activeEditor: ${editor ? "present" : "undefined"}`);
  if (editor) {
    try {
      const text = editor.getEditorView().state.doc.toString();
      out.push(`  readOnly: ${editor.isReadOnly()}`);
      out.push(`  looksLikeRequest: ${REQUEST_LINE.test(text)}`);
      out.push(`  first line: ${show(text.split(/\r?\n/)[0]?.slice(0, 80))}`);
    } catch (e) {
      out.push(`  editor read failed: ${e?.message ?? e}`);
    }
  }

  const [id] = [...selectedIds(page?.selection), ...selectedIds(page?.requestSelection)];
  out.push(`resolved id: ${show(id)} (typeof ${typeof id})`);

  if (id !== undefined) {
    try {
      const result = await sdk.graphql.request({ id });
      out.push(`graphql ok. top-level keys: ${Object.keys(result ?? {}).join(",") || "none"}`);
      const request = unwrapRequest(result);
      out.push(`unwrapped request: ${request ? "present" : "null"}`);
      if (request) {
        out.push(`  request keys: ${Object.keys(request).join(",")}`);
        out.push(`  typeof raw: ${typeof request.raw}`);
        out.push(`  raw length: ${request.raw?.length ?? 0}`);
        out.push(`  raw head: ${show(String(request.raw ?? "").slice(0, 60))}`);
        out.push(`  decodes to: ${show(normalizeRaw(String(request.raw ?? "")).slice(0, 60))}`);
      }
    } catch (e) {
      out.push(`graphql threw: ${e?.name ?? ""} ${e?.message ?? e}`);
    }
  }

  // Walk the same sources a copy would, so the report shows where the
  // request came from and which sources came up short.
  lastFetchError = "";
  out.push("candidates, as a keyboard shortcut sees them:");

  for (const source of candidateSources(sdk, undefined)) {
    let raw = "";
    try {
      raw = await source.get();
    } catch (e) {
      out.push(`  ${source.label}: threw ${e?.message ?? e}`);
      continue;
    }

    if (!raw) {
      out.push(`  ${source.label}: empty`);
      continue;
    }

    const text = normalizeRaw(raw);
    out.push(`  ${source.label}: ${text.length} chars, ${show(text.split(/\r?\n/)[0]?.slice(0, 60))}`);
    for (const spec of Object.values(Headers)) {
      out.push(`    ${spec.name}: ${show(extractHeader(raw, spec).slice(0, 40))}`);
    }
  }

  out.push(`lastFetchError: ${lastFetchError || "none"}`);

  const report = out.join("\n");
  sdk.log.info(`[copy-cookie-header] diagnostics\n${report}`);
  const copied = await writeClipboard(report);

  sdk.window.showToast(
    copied ? "Diagnostics copied to clipboard." : "Diagnostics written to the Caido log.",
    { variant: "info", duration: 4000 },
  );
}

export const init = (sdk) => {
  for (const spec of Object.values(Headers)) {
    sdk.commands.register(spec.copyId, {
      name: `Copy ${spec.name} Header`,
      run: (context) => runCopy(sdk, spec, context),
    });

    sdk.commands.register(spec.pasteId, {
      name: `Paste ${spec.name} Header`,
      run: () => runPaste(sdk, spec),
    });

    sdk.commandPalette.register(spec.copyId);
    sdk.commandPalette.register(spec.pasteId);

    sdk.menu.registerItem({
      type: "RequestRow",
      commandId: spec.copyId,
      leadingIcon: spec.copyIcon,
    });
    sdk.menu.registerItem({
      type: "Request",
      commandId: spec.copyId,
      leadingIcon: spec.copyIcon,
    });

    // Paste needs a writable editor, so it only goes on the request pane.
    sdk.menu.registerItem({
      type: "Request",
      commandId: spec.pasteId,
      leadingIcon: "fas fa-paste",
    });
  }

  sdk.commands.register(DIAGNOSE_COMMAND, {
    name: "Copy Cookie Header: Diagnostics",
    run: () => runDiagnose(sdk),
  });

  sdk.commandPalette.register(DIAGNOSE_COMMAND);
};
