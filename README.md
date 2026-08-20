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

## Notes

Paste accepts either a full header line or a bare `a=1; b=2` string. If the
request has no Cookie header it adds one. Duplicate Cookie headers are collapsed
into a single line, which matters on HTTP/2. Content-Length is left alone since
only headers change.

Copy reads the live editor text in Replay, so unsaved edits are what you get.

If copy fails, run **Copy Cookie Header: Diagnostics** from the command palette
with a request selected. It copies a short report to the clipboard.

## Repack after an edit

```bash
cd copy-cookie-header && zip -r ../copy-cookie-header.zip manifest.json frontend
```

## Layout

```
manifest.json
frontend/script.js
```
