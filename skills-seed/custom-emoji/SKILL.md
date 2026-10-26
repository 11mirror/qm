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
   python3 <skill dir>/scripts/emoji.py make "<subject>" --name <name> --out /tmp/emoji [--motion bounce]
   ```

   Give the subject a character and one big expression or gesture ("a grinning red rocket
   blasting off", not "a rocket"). Avoid white as a main colour: the image model tends to
   return white fills as transparent, which the hole check then rejects; say "cream" or
   "pale grey" instead, or pass `--opaque <hex>` to fill the whole canvas with a solid
   colour like many popular animated emoji do. The script asks `gpt-image-1.5` for 4
   transparent candidates in a flat blob-emoji style with no black outline, strips the
   background, defringes and crops them to 128px, and rejects any that are cut off at the
   edge or have see-through holes. A vision
   model then scores them blind alongside real Slack emoji from slackmojis.com, at 128px and
   22px on light and dark themes, and checks each one shows the subject. It writes `<name>.png`
   and exits 2 when nothing reaches the real emoji's median score; then reword the subject and
   run it again. Never ship a failing one.

3. **Animate (optional).** `--motion`, or `emoji.py animate <src.png> <out.gif> "<subject>" --motion …`,
   builds a 128px GIF of 8–12 frames in a 0.3–0.9s loop. Pick a motion that
   means something for the subject: `bounce` for happy, `nod` for yes, `shake` for no or
   annoyed, `rumble` for revving, `wobble` for silly or waving, `pulse` for emphasis, `spin`,
   `hover`. GIFs have hard 1-bit edges, so the script blends the outermost pixel of the
   silhouette toward a mid-grey, which is what smooth-looking animated emoji do; `--matte`
   changes that colour (darker favours the dark theme) and `--matte flat` keeps a hard edge.
   `--opaque <hex>` drops transparency entirely. The script plays
   the frames back to a vision model and reports whether the motion makes sense and stays in
   frame; act on what it says. For custom motion use slack-gif-creator. Motion comes from code,
   never from one image call per frame.
4. **Check.** Slack caps emoji at 128×128 and 128KB; the script warns when a file is over.
   Show people each emoji as its own file, never a sheet or frame strip. Pick a lowercase name
   (letters, digits, `_`, `-`). If a fal.ai key is ever available, its image-to-video and
   background-removal models are a possible upgrade; don't depend on it.
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
