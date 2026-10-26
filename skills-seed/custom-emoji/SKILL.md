---
name: custom-emoji
description: Add a new custom emoji to the Slack workspace (fetched, generated, or animated) by driving the requesting person's own browser. Plain reactions with existing emoji don't need this skill.
---

# Custom emoji

Adding an emoji is a visible change to the whole workspace: one per request, never a duplicate.

1. **Reuse.** If an existing workspace emoji fits, react with it (`[[react: name]]`) and stop.
2. **Get an image.** Fetch a known one from https://slackmojis.com (`curl` the page, grep the
   image URL, download it) and run `emoji.py process <in> <out.png>` on it. Otherwise generate
   one with `scripts/emoji.py` in this skill's directory (`pip install -q pillow` first; select
   the org `openai` credential on the command):

   ```bash
   python3 <skill dir>/scripts/emoji.py make "<subject>" --name <name> --out /tmp/emoji [--motion fly]
   ```

   It asks `gpt-image-1.5` for 4 transparent candidates in a bold sticker style (one chunky
   silhouette filling the frame, thick outline, ≤7 flat colours, no text), strips the
   background, crops tight, caps at 32 colours and 128px, then has a vision model score each
   at 22px on light and dark Slack themes and keeps the best. It prints the scores and writes
   `<name>.png` plus a preview sheet. If the best scores under 7, change the subject wording
   and run it again rather than shipping a muddy emoji. Look at the sheet yourself too.

3. **Animate (optional).** `--motion` (bounce, wobble, pulse, shake, spin, hover, fly), or
   `emoji.py animate <name>-X.src.png <out.gif> --motion …`, builds a 128px GIF of 8–12 frames
   in a 0.3–0.9s loop with a clean transparent background. For custom motion use
   slack-gif-creator. Motion comes from code, never from one image call per frame.
4. **Check.** Slack caps emoji at 128×128 and 128KB; the script warns when a file is over.
   Pick a lowercase name (letters, digits, `_`, `-`). If a fal.ai key is ever available,
   its image-to-video and background-removal models are a possible upgrade; don't depend on it.
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
