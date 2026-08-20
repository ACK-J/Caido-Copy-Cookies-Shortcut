/**
 * Copy Cookie Header - Caido frontend plugin
 *
 * Copy: right click a request, copy its whole "Cookie: ..." header line.
 * Paste: right click an editable request pane, replace its Cookie header
 *        with whatever is on the clipboard.
 *
 * Both also work from a keyboard shortcut or the command palette, which
 * fire with CommandContextBase and carry no request, so the target is
 * worked out from the current page selection instead.
 */

const Commands = {
  copy: "copy-cookie-header.copy",
  paste: "copy-cookie-header.paste",
  diagnose: "copy-cookie-header.diagnose",
};

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
 * Indexes of the lines making up the Cookie header, including any
 * obs-fold continuation lines that belong to it.
 */
function cookieLineIndexes(lines) {
  const found = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].text;

    if (/^[ \t]/.test(line)) {
      if (found.length > 0 && found[found.length - 1] === i - 1) found.push(i);
      continue;
    }

    const colon = line.indexOf(":");
    if (colon === -1) continue;
    if (line.slice(0, colon).trim().toLowerCase() === "cookie") found.push(i);
  }

  return found;
}

/** Build the full "Cookie: ..." line from a raw request, or "" if absent. */
function extractCookieHeader(raw) {
  const text = normalizeRaw(raw);
  const lines = headerLines(text);
  const indexes = cookieLineIndexes(lines);
  if (indexes.length === 0) return "";

  // An HTTP/2 cookie list is often split across several headers. Join the
  // values so the result pastes cleanly as one line.
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

  const joined = values.filter(Boolean).join("; ");
  return joined ? `Cookie: ${joined}` : "";
}

/* ------------------------------------------------------------------ */
/* Paste planning                                                      */
/* ------------------------------------------------------------------ */

function normalizeClipboard(clip) {
  const collapsed = String(clip ?? "").replace(/\s*\r?\n\s*/g, " ").trim();
  if (!collapsed) return "";

  const colon = collapsed.indexOf(":");
  if (colon !== -1 && collapsed.slice(0, colon).trim().toLowerCase() === "cookie") {
    const value = collapsed.slice(colon + 1).trim();
    return value ? `Cookie: ${value}` : "";
  }

  return `Cookie: ${collapsed}`;
}

function planCookiePaste(text, header) {
  const lines = headerLines(text);
  const indexes = cookieLineIndexes(lines);

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

function selectedId(selection) {
  return selection?.kind === "Selected" ? selection.main : undefined;
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
 * Find the request the user means.
 *
 * A right-click menu supplies it directly. A keyboard shortcut or the
 * command palette supplies CommandContextBase instead, so fall back to
 * the selection reported by the current page, then to the focused editor.
 */
async function resolveRaw(sdk, context) {
  lastFetchError = "";

  if (context?.type === "RequestContext" && context.request?.raw) {
    return context.request.raw;
  }

  if (context?.type === "RequestRowContext") {
    const id = context.requests?.[0]?.id;
    if (id !== undefined) {
      const raw = await fetchRawById(sdk, id);
      if (raw) return raw;
    }
  }

  if (context?.type === "ResponseContext") {
    const id = context.request?.id;
    if (id !== undefined) {
      const raw = await fetchRawById(sdk, id);
      if (raw) return raw;
    }
  }

  const page = currentPage(sdk);

  switch (page?.kind) {
    case "HTTPHistory": {
      const id = selectedId(page.selection);
      if (id !== undefined) {
        const raw = await fetchRawById(sdk, id);
        if (raw) return raw;
      }
      break;
    }

    case "Sitemap": {
      const id = selectedId(page.requestSelection);
      if (id !== undefined) {
        const raw = await fetchRawById(sdk, id);
        if (raw) return raw;
      }
      break;
    }

    // In Replay the editor holds unsaved edits, so it beats the stored
    // request. Fall back to the entry if focus is somewhere else.
    case "Replay": {
      const live = activeEditor(sdk);
      if (live) return live.text;

      try {
        const requestId = sdk.replay.getCurrentEntry()?.requestId;
        if (requestId !== undefined) {
          const raw = await fetchRawById(sdk, requestId);
          if (raw) return raw;
        }
      } catch {
        /* no current entry */
      }
      break;
    }

    default:
      break;
  }

  // Last resort: whatever request pane has focus. In HTTP History the
  // preview pane counts, so this rescues the case where the id lookup failed.
  return activeEditor(sdk)?.text ?? "";
}

/* ------------------------------------------------------------------ */
/* Commands                                                            */
/* ------------------------------------------------------------------ */

async function runCopy(sdk, context) {
  const raw = await resolveRaw(sdk, context);

  if (!raw) {
    sdk.window.showToast(
      lastFetchError
        ? `Copy Cookie Header: ${lastFetchError}`
        : "Copy Cookie Header: no request found. Select a row or focus a request pane.",
      { variant: "warning", duration: 6000 },
    );
    return;
  }

  const header = extractCookieHeader(raw);

  if (!header) {
    sdk.window.showToast("Copy Cookie Header: no Cookie header found.", {
      variant: "warning",
    });
    return;
  }

  const copied = await writeClipboard(header);

  sdk.window.showToast(
    copied ? "Cookie header copied." : "Copy Cookie Header: clipboard write failed.",
    { variant: copied ? "success" : "error", duration: 2000 },
  );
}

async function runPaste(sdk) {
  const target = activeEditor(sdk);

  if (!target) {
    sdk.window.showToast("Paste Cookie Header: focus a request editor first.", {
      variant: "warning",
    });
    return;
  }

  if (target.editor.isReadOnly()) {
    sdk.window.showToast(
      "Paste Cookie Header: this request is read only. Use a Replay tab.",
      { variant: "warning" },
    );
    return;
  }

  const clip = await readClipboard();

  if (clip === null) {
    sdk.window.showToast("Paste Cookie Header: could not read the clipboard.", {
      variant: "error",
    });
    return;
  }

  const header = normalizeClipboard(clip);

  if (!header) {
    sdk.window.showToast("Paste Cookie Header: clipboard is empty.", {
      variant: "warning",
    });
    return;
  }

  const changes = planCookiePaste(target.text, header);
  const replaced = changes[0].to > changes[0].from;

  target.editor.getEditorView().dispatch({ changes });
  target.editor.focus();

  sdk.window.showToast(
    replaced ? "Cookie header replaced." : "Cookie header added.",
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

  const id = selectedId(page?.selection) ?? selectedId(page?.requestSelection);
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
  sdk.commands.register(Commands.copy, {
    name: "Copy Cookie Header",
    run: (context) => runCopy(sdk, context),
  });

  sdk.commands.register(Commands.paste, {
    name: "Paste Cookie Header",
    run: () => runPaste(sdk),
  });

  sdk.commands.register(Commands.diagnose, {
    name: "Copy Cookie Header: Diagnostics",
    run: () => runDiagnose(sdk),
  });

  sdk.commandPalette.register(Commands.copy);
  sdk.commandPalette.register(Commands.paste);
  sdk.commandPalette.register(Commands.diagnose);

  sdk.menu.registerItem({
    type: "RequestRow",
    commandId: Commands.copy,
    leadingIcon: "fas fa-cookie-bite",
  });
  sdk.menu.registerItem({
    type: "Request",
    commandId: Commands.copy,
    leadingIcon: "fas fa-cookie-bite",
  });

  // Paste needs a writable editor, so it only goes on the request pane.
  sdk.menu.registerItem({
    type: "Request",
    commandId: Commands.paste,
    leadingIcon: "fas fa-paste",
  });
};
