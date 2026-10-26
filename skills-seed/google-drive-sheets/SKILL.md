---
name: google-drive-sheets
description: Find, read, export, edit, and manage the user's Google Drive, Docs, Sheets, and Slides through per-user OAuth.
requiredCapabilities:
  - egress:www.googleapis.com
  - egress:sheets.googleapis.com
  - egress:docs.googleapis.com
  - egress:slides.googleapis.com
---

# Google Drive / Docs / Sheets / Slides

Use this skill when the user asks about Drive files, Google Docs, Google Sheets, Google
Slides, sharing/access problems, or reading/editing any of that content.

This is an OAuth connector used by proxy: the user's token never enters your computer.
Select the connected-app credential for `www.googleapis.com` (Drive),
`sheets.googleapis.com` (Sheets), `docs.googleapis.com` (Docs), or `slides.googleapis.com`
(Slides) in `execute.credentials` (for example `connector:www.googleapis.com:default`);
that command gets `$AGENT_CREDENTIAL_TOKEN`. Call
`$AGENT_API_URL/v1/credentials/http/<host>/<path>` with `-H "x-agent-capability:
$AGENT_CREDENTIAL_TOKEN"`; the credential broker adds the user's token and forwards the
request to `https://<host>/<path>`. If you selected two accounts for the same host, put
the credential handle where the host goes. Select each host the command calls. Do not ask
the user for a token or use another principal's credential or a service fallback.

If a host's credential is not listed (an older connection made before that host was
added), ask the user to reconnect Google. If the API returns 401/403 or a file is
inaccessible, tell the user which Google account/principal needs access and whether they
should connect Google or share the file with that account.

## Find files

Search Drive by name, owner, MIME type, or recency:

```bash
curl -sS --get "$AGENT_API_URL/v1/credentials/http/www.googleapis.com/drive/v3/files" \
  -H "x-agent-capability: $AGENT_CREDENTIAL_TOKEN" \
  --data-urlencode "q=name contains 'deadline' and trashed=false" \
  --data-urlencode 'fields=nextPageToken,files(id,name,mimeType,webViewLink,owners(emailAddress,displayName),modifiedTime)' \
  --data-urlencode 'corpora=allDrives' \
  --data-urlencode 'includeItemsFromAllDrives=true' \
  --data-urlencode 'supportsAllDrives=true' \
  --data-urlencode 'pageSize=100'
```

The three `allDrives` params matter: without them the API searches only "My Drive",
and files living in shared drives — most team docs — are invisible, so you'd wrongly
report a file doesn't exist. If the response has a `nextPageToken`, keep fetching with
`pageToken=` before concluding anything is missing.

For a specific file, fetch metadata first:

```bash
curl -sS "$AGENT_API_URL/v1/credentials/http/www.googleapis.com/drive/v3/files/FILE_ID?supportsAllDrives=true&fields=id,name,mimeType,webViewLink,owners(emailAddress,displayName),capabilities" \
  -H "x-agent-capability: $AGENT_CREDENTIAL_TOKEN"
```

Add `supportsAllDrives=true` to every per-file call (get, download, PATCH, DELETE) —
without it, operations on shared-drive files 404.

## Read files

For uploaded files, download media:

```bash
curl -sS "$AGENT_API_URL/v1/credentials/http/www.googleapis.com/drive/v3/files/FILE_ID?alt=media" \
  -H "x-agent-capability: $AGENT_CREDENTIAL_TOKEN" \
  -o inbox/drive-file.bin
```

For Google Docs/Sheets/Slides, export to a useful format:

```bash
curl -sS --get "$AGENT_API_URL/v1/credentials/http/www.googleapis.com/drive/v3/files/FILE_ID/export" \
  -H "x-agent-capability: $AGENT_CREDENTIAL_TOKEN" \
  --data-urlencode 'mimeType=text/plain'
```

Keep source file ids and links in your answer so claims can be traced.

## Read Sheets

Read values from a named range:

```bash
curl -sS "$AGENT_API_URL/v1/credentials/http/sheets.googleapis.com/v4/spreadsheets/SPREADSHEET_ID/values/Sheet1!A1:Z100" \
  -H "x-agent-capability: $AGENT_CREDENTIAL_TOKEN"
```

For workbook structure:

```bash
curl -sS "$AGENT_API_URL/v1/credentials/http/sheets.googleapis.com/v4/spreadsheets/SPREADSHEET_ID?includeGridData=false" \
  -H "x-agent-capability: $AGENT_CREDENTIAL_TOKEN"
```

## Writes require approval

Creating, moving, sharing, or editing Drive/Sheets content is a write. Prepare the exact
change, summarize the target file/range, and ask for approval before running it.

After approval, update values:

```bash
curl -sS -X PUT "$AGENT_API_URL/v1/credentials/http/sheets.googleapis.com/v4/spreadsheets/SPREADSHEET_ID/values/Sheet1!A1:B2?valueInputOption=USER_ENTERED" \
  -H "x-agent-capability: $AGENT_CREDENTIAL_TOKEN" \
  -H 'content-type: application/json' \
  --data @values.json
```

Always report the file id/link and the modified range.

## Persist a file to Drive (upload)

You can save a file you produced (a report, an export, a generated artifact) into the
user's Drive. This is a write — summarize what you're uploading and where, and get
approval first.

After approval, multipart-upload the bytes. Send the metadata part then the file part:

```bash
curl -sS -X POST "$AGENT_API_URL/v1/credentials/http/www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink" \
  -H "x-agent-capability: $AGENT_CREDENTIAL_TOKEN" \
  -F "metadata={\"name\":\"report.pdf\"};type=application/json;charset=UTF-8" \
  -F "file=@report.pdf;type=application/pdf"
```

To place it in a specific folder, add `"parents":["FOLDER_ID"]` to the metadata. The
response returns the new file's `id` and `webViewLink` — report both so the user can open
it.

## Rename, move, or delete files

The connector has full Drive access, so you can rename, move, and delete any file the
connected user can reach — including pre-existing files in shared folders, not just ones
this connector created. These are destructive writes: name the exact file (id + name) and
the change, and get approval first. Deletes are especially irreversible — prefer trashing
(`trashed=true`) over permanent `DELETE` unless the user asks to purge.

Rename a file:

```bash
curl -sS -X PATCH "$AGENT_API_URL/v1/credentials/http/www.googleapis.com/drive/v3/files/FILE_ID?fields=id,name" \
  -H "x-agent-capability: $AGENT_CREDENTIAL_TOKEN" \
  -H 'content-type: application/json' \
  --data '{"name":"new-name.pdf"}'
```

Move a file (swap its parent folder):

```bash
curl -sS -X PATCH "$AGENT_API_URL/v1/credentials/http/www.googleapis.com/drive/v3/files/FILE_ID?addParents=DEST_FOLDER_ID&removeParents=OLD_FOLDER_ID&fields=id,parents" \
  -H "x-agent-capability: $AGENT_CREDENTIAL_TOKEN"
```

Trash a file (reversible) or permanently delete it:

```bash
curl -sS -X PATCH "$AGENT_API_URL/v1/credentials/http/www.googleapis.com/drive/v3/files/FILE_ID?fields=id,trashed" \
  -H "x-agent-capability: $AGENT_CREDENTIAL_TOKEN" \
  -H 'content-type: application/json' \
  --data '{"trashed":true}'

curl -sS -X DELETE "$AGENT_API_URL/v1/credentials/http/www.googleapis.com/drive/v3/files/FILE_ID" \
  -H "x-agent-capability: $AGENT_CREDENTIAL_TOKEN"
```

Report the file id/link and what changed.

## Edit a Google Doc

Editing a Doc's content uses the Docs API (`docs.googleapis.com`), not the Drive export
endpoint (export is read-only). First read the document to find the character indexes you
want to edit:

```bash
curl -sS "$AGENT_API_URL/v1/credentials/http/docs.googleapis.com/v1/documents/DOCUMENT_ID" \
  -H "x-agent-capability: $AGENT_CREDENTIAL_TOKEN"
```

The response's `body.content[]` carries each element's `startIndex`/`endIndex` — use those
to target an edit. All edits go through `:batchUpdate`. This is a write — summarize the
exact change and get approval first. Insert text at an index:

```bash
curl -sS -X POST "$AGENT_API_URL/v1/credentials/http/docs.googleapis.com/v1/documents/DOCUMENT_ID:batchUpdate" \
  -H "x-agent-capability: $AGENT_CREDENTIAL_TOKEN" \
  -H 'content-type: application/json' \
  --data '{"requests":[{"insertText":{"location":{"index":1},"text":"Hello\n"}}]}'
```

Other common requests in the same `requests[]` array: `deleteContentRange`
(`{"range":{"startIndex":N,"endIndex":M}}`), `replaceAllText`
(`{"containsText":{"text":"OLD","matchCase":true},"replaceText":"NEW"}`), and
`insertInlineImage`. Create a new doc with `POST https://docs.googleapis.com/v1/documents`
and a `{"title":"..."}` body. Report the document id/link and what changed.

## Edit a Google Slides presentation

Slides editing uses the Slides API (`slides.googleapis.com`). Read the deck to find slide
and element object ids:

```bash
curl -sS "$AGENT_API_URL/v1/credentials/http/slides.googleapis.com/v1/presentations/PRESENTATION_ID" \
  -H "x-agent-capability: $AGENT_CREDENTIAL_TOKEN"
```

Edits go through `:batchUpdate`. Get approval first, then e.g. replace text across the deck:

```bash
curl -sS -X POST "$AGENT_API_URL/v1/credentials/http/slides.googleapis.com/v1/presentations/PRESENTATION_ID:batchUpdate" \
  -H "x-agent-capability: $AGENT_CREDENTIAL_TOKEN" \
  -H 'content-type: application/json' \
  --data '{"requests":[{"replaceAllText":{"containsText":{"text":"{{TITLE}}","matchCase":true},"replaceText":"Q3 Review"}}]}'
```

Other common requests: `createSlide`, `insertText` (`{"objectId":"...","text":"...","insertionIndex":0}`),
and `createImage`. Create a new deck with `POST https://slides.googleapis.com/v1/presentations`
and a `{"title":"..."}` body. Report the presentation id/link and what changed.
