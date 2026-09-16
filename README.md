# Copy Cookie Header

Caido plugin. Copy the `Cookie:` header off one request, paste it into another.

## Install

Caido > Plugins > Install Package > `copy-cookie-header.zip`

## Use

Right click a request row or a request pane:

- **Copy Cookie Header** copies the whole line, for example `Cookie: sid=abc123; theme=dark`
- **Paste Cookie Header** replaces the Cookie header in the focused request with the clipboard

Both are in the command palette and can be bound to hotkeys in Caido settings.
I use `CTRL + ALT + C` and `CTRL + ALT + V` respectively 

## Where copy looks

A right click names the request outright. A keyboard shortcut and the command
palette do not: Caido runs them with `BaseContext`, which carries no request, so
copy works through the sources below in order and takes the first one that
actually has a Cookie header. The toast says which one it used.

| Page | Sources, best first |
|---|---|
| HTTP History | selected rows, then the focused request pane |
| Sitemap | selected requests, then the focused request pane |
| Automate | selected requests, then the focused request pane |
| Replay | the editor (unsaved edits included), then the saved entry |
| Intercept, Search, elsewhere | the focused request pane |

Intercept selections are intercept entry ids rather than request ids, and the two
share one numeric space, so they are never looked up - the id would resolve to an
unrelated request.

## Notes

Paste accepts either a full header line or a bare `a=1; b=2` string. If the
request has no Cookie header it adds one. Duplicate Cookie headers are collapsed
into a single line, which matters on HTTP/2. Content-Length is left alone since
only headers change.

If copy fails, run **Copy Cookie Header: Diagnostics** from the command palette
with a request selected. It copies a report to the clipboard listing every
source it tried, what each one held, and the Cookie header it found in each.

## Repack after an edit

```bash
cd copy-cookie-header && zip -r ../copy-cookie-header.zip manifest.json frontend
```

## Layout

```
manifest.json
frontend/script.js
```
