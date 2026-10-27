---
name: custom-emoji
description: Add a new custom emoji to the Slack workspace (fetched, generated, or animated) by driving the requesting person's own browser. Plain reactions with existing emoji don't need this skill.
---

# Custom emoji

Adding an emoji is a visible change to the whole workspace: one per request, never a duplicate.

1. **Reuse.** If an existing workspace emoji fits, react with it (`[[react: name]]`) and stop.
2. **Get an image.** Fetch a known one from https://slackmojis.com (`curl` the page, grep the
   image URL, download it) and run `emoji.py process <in> <out.png>` on it. Otherwise generate
   with `scripts/emoji.py` in this skill's directory (`pip install -q pillow` first; select the
   org `openai` credential on the command):

   ```bash
   python3 <skill dir>/scripts/emoji.py make "<your prompt>" --name <name> --out /tmp/emoji [--motion bounce]
   ```

   The prompt goes to `gpt-image-1.5` verbatim, so describe the look you want in your own
   words: subject, art direction, mood, colours. It makes 4 candidates (`--n`), strips the
   background, crops tight and writes each as its own 128px transparent PNG, with a
   `<name>-<X>.src.png` at 512px kept for animating or deriving. Look at them: post each
   candidate to the person as its own file, never a sheet, and iterate on what they say. The
   output lists warnings per candidate (subject touching the canvas edge, see-through holes,
   over 128KB); they are things to look at, not verdicts. White areas often come back
   transparent; say "cream" or use `--opaque <hex>` for a solid background.

   For a recurring character in many poses, `pack <base>.src.png "<your prompt>" --name <name>`
   redraws a finished candidate with your prompt, sending it as the reference image so the
   design carries over; describe only what changes.

3. **Animate (optional).** `--motion`, or `emoji.py animate <src.png> <out.gif> --motion …`,
   builds a 128px GIF of 8–12 frames in a 0.3–0.9s loop. Presets: `bounce`, `nod`, `shake`,
   `rumble`, `wobble`, `pulse`, `spin`, `hover`. GIFs have hard 1-bit edges, so the script
   blends the outermost pixel of the silhouette toward a mid-grey, which is what smooth-looking
   animated emoji do; `--matte` changes that colour (darker favours the dark theme) and
   `--matte flat` keeps a hard edge. `--opaque <hex>` drops transparency entirely. Watch the
   frames yourself. For custom motion use slack-gif-creator. Motion comes from code, never from
   one image call per frame.
4. **Check.** Slack caps emoji at 128×128 and 128KB. Pick a lowercase name (letters, digits,
   `_`, `-`). Slack re-encodes animated PNGs to a single frame; animation must be GIF.
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
