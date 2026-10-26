---
name: custom-emoji
description: Add a new custom emoji to the Slack workspace (fetched, generated, or animated) by driving the requesting person's own browser. Plain reactions with existing emoji don't need this skill.
---

# Custom emoji

Adding an emoji is a visible change to the whole workspace: one per request, never a duplicate.

1. **Reuse.** If an existing workspace emoji fits, react with it (`[[react: name]]`) and stop.
2. **Get an image.** Fetch a known one from https://slackmojis.com (`curl` the page, grep the
   image URL, download it), or generate one with `gpt-image-2` through the org `openai` shared
   credential (see use-shared-credential). Ask for a square, simple sticker on a plain or
   transparent background. Write the broker request body to a file and `curl -d @file`; the
   reply `body` holds `data[0].b64_json`.
3. **Animate (optional).** Feed the image to slack-gif-creator. Motion comes from code, never
   from one image call per frame.
4. **Shrink.** Slack caps emoji at 128×128 and 128KB: `Image.thumbnail((128, 128))` in Pillow
   for a still; slack-gif-creator already outputs 128px GIFs. Pick a lowercase name
   (letters, digits, `_`, `-`).
5. **Add it in the browser.** Use Browser Use (`BROWSER_USE_API_KEY`): follow the browse skill
   and its `providers/browser-use.md` to launch a browser on the requesting person's own
   Browser Use profile, then drive `https://<workspace>.slack.com/customize/emoji` with
   Playwright over the browser's CDP URL: click **Add Custom Emoji**, set the file input with
   a buffer payload (`set_input_files({"name": ..., "mimeType": ..., "buffer": ...})`), type
   the name, save. Reload, search the name, and confirm it is listed before you use it. If
   Slack shows a sign-in page, hand the person the live view to sign in with Google; never type
   credentials. Stop the browser afterwards so the profile keeps the session. If the CDP host
   doesn't resolve, the sandbox only reaches the internet through its proxy: relay CDP through
   a local `websockets` server whose client side connects with `proxy=True`.
6. **Use it.** `[[react: <name>]]` or `:<name>:`.
