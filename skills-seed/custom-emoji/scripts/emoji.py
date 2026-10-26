import argparse, base64, io, json, math, os, random, statistics, sys, urllib.request
from concurrent.futures import ThreadPoolExecutor
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont, ImageSequence

LIGHT, DARK = (255, 255, 255), (26, 29, 33)
JUDGE = os.environ.get("EMOJI_JUDGE_MODEL", "gpt-5.5")
STYLE = (
    "A Slack custom emoji: {subject}. Draw it like the best-loved Slack emoji (Google blob emoji, party parrot): a cartoon "
    "character or object with real personality and one big, readable expression or gesture. Composition: one compact, chunky "
    "silhouette, centered, with a small even margin; nothing touches or crosses the edge of the canvas. Built from a handful of "
    "big simple shapes so it still reads at 22 pixels. Flat colour only: no gradients, no glossy highlights, no shading, no "
    "texture. Bright saturated colours with a clean dark outline of even weight. No text, no smoke, sparkles, motion lines, "
    "scenery or drop shadow. Transparent background."
)
REFS = [
    "1643514680/6827/blob_aww.png", "1643514688/6901/blob_rofl.png", "1643514693/6950/blob_wave.png",
    "1623519268/44552/rocket-pop.png", "1643514140/990/party_parrot.gif", "1622916972/43564/facepalm.png",
]


def broker(url, payload):
    body = json.dumps({"credential": "openai", "method": "POST", "url": url,
                       "headers": {"content-type": "application/json"}, "body": json.dumps(payload)}).encode()
    req = urllib.request.Request(os.environ["AGENT_API_URL"] + "/v1/credentials/broker", data=body,
                                 headers={"x-agent-capability": os.environ["AGENT_CREDENTIAL_TOKEN"],
                                          "content-type": "application/json"})
    reply = json.load(urllib.request.urlopen(req, timeout=300))
    if reply["status"] != 200:
        raise RuntimeError(f"openai {reply['status']}: {reply['body'][:500]}")
    return json.loads(reply["body"])


def ask(text, images, effort="medium"):
    content = [{"type": "input_text", "text": text}] + [{"type": "input_image", "image_url": data_url(i)} for i in images]
    data = broker("https://api.openai.com/v1/responses", {
        "model": JUDGE, "reasoning": {"effort": effort}, "text": {"format": {"type": "json_object"}},
        "input": [{"role": "user", "content": content}]})
    return json.loads(next(c["text"] for o in data["output"] if o["type"] == "message"
                           for c in o["content"] if c["type"] == "output_text"))


def data_url(im):
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def generate(subject, model, out):
    data = broker("https://api.openai.com/v1/images/generations", {
        "model": model, "prompt": STYLE.format(subject=subject), "size": "1024x1024",
        "background": "transparent", "output_format": "png", "quality": "high"})
    Image.open(io.BytesIO(base64.b64decode(data["data"][0]["b64_json"]))).convert("RGBA").save(out)
    return out


def strip_background(im):
    im = im.convert("RGBA")
    if im.getchannel("A").getextrema()[0] > 0:
        for xy in [(0, 0), (im.width - 1, 0), (0, im.height - 1), (im.width - 1, im.height - 1)]:
            if im.getpixel(xy)[3] > 0:
                ImageDraw.floodfill(im, xy, (0, 0, 0, 0), thresh=40)
    alpha = im.getchannel("A").point(lambda a: 0 if a < 32 else 255 if a > 224 else a)
    rgb = im.convert("RGB")
    rgb.paste(rgb.filter(ImageFilter.MinFilter(5)), mask=alpha.point(lambda a: 255 if 0 < a < 255 else 0))
    rgb.putalpha(alpha)
    return rgb


def square(im, size):
    box = im.getchannel("A").point(lambda a: 255 if a > 16 else 0).getbbox() or (0, 0, im.width, im.height)
    im = im.crop(box)
    side = max(im.size)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(im, ((side - im.width) // 2, (side - im.height) // 2))
    inner = size - round(size * 0.04) * 2
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(canvas.convert("RGBa").resize((inner, inner), Image.LANCZOS).convert("RGBA"), ((size - inner) // 2,) * 2)
    return out


def finish(im, colors=32):
    alpha = im.getchannel("A")
    out = im.convert("RGB").quantize(colors, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).convert("RGBA")
    out.putalpha(alpha)
    return out


def process(src, out):
    hi = square(strip_background(Image.open(src)), 512)
    hi.save(out.removesuffix(".png") + ".src.png")
    finish(square(hi, 128)).save(out, optimize=True)
    return out


def defects(raw):
    a = Image.open(raw).convert("RGBA").getchannel("A").point(lambda v: 255 if v > 32 else 0)
    w, h = a.size
    edge = any(a.getpixel((x, y)) for i in range(w) for x, y in ((i, 0), (i, h - 1), (0, i * h // w), (w - 1, i * h // w)))
    outside = a.copy()
    ImageDraw.floodfill(outside, (0, 0), 128)
    hist = outside.histogram()
    holes = hist[0] / max(1, hist[255])
    found = []
    if edge:
        found.append("cut off at the canvas edge")
    if holes > 0.03:
        found.append(f"see-through holes inside the subject ({round(holes * 100)}% of its area)")
    return found


def tile(im):
    im = im.convert("RGBA")
    im.thumbnail((128, 128))
    out = Image.new("RGB", (472, 128), (200, 200, 200))
    for i, bg in enumerate([LIGHT, DARK]):
        t = Image.new("RGBA", (128, 128), bg + (255,))
        t.alpha_composite(im, ((128 - im.width) // 2, (128 - im.height) // 2))
        out.paste(t.convert("RGB"), (i * 128, 0))
        out.paste(t.resize((22, 22), Image.LANCZOS).resize((88, 88), Image.NEAREST).convert("RGB"), (276 + i * 108, 20))
    return out


def numbered(im, n):
    t = tile(im)
    c = Image.new("RGB", (t.width, t.height + 22), (200, 200, 200))
    c.paste(t, (0, 22))
    ImageDraw.Draw(c).text((4, 2), f"#{n}", fill="black", font=ImageFont.load_default(16))
    return c


def references():
    cache = os.path.expanduser("~/.cache/custom-emoji-refs")
    os.makedirs(cache, exist_ok=True)
    refs = []
    for ref in REFS:
        path = os.path.join(cache, os.path.basename(ref))
        if not os.path.exists(path):
            try:
                urllib.request.urlretrieve("https://emojis.slackmojis.com/emojis/images/" + ref, path)
            except OSError:
                continue
        refs.append(Image.open(path).convert("RGBA"))
    return refs


def panel(cands, refs, seed):
    items = [("ref", r) for r in refs] + [(k, Image.open(p)) for k, p in cands.items()]
    random.Random(seed).shuffle(items)
    ask_text = (f"Here are {len(items)} Slack custom emoji, #1..#{len(items)}, each shown at 128px on light and dark Slack "
                "themes, then at 22px zoomed 4x. Rate each 1-10: would people love using it? Judge charm and personality, "
                "how instantly it reads at 22px on both themes, a clean silhouette and crop with nothing cut off, and craft. "
                "Use the full scale and be discriminating. Also say in under 8 words what each one depicts. "
                'Reply JSON: {"scores": {"1": n}, "depicts": {"1": "..."}}')
    out = ask(ask_text, [numbered(im, i + 1) for i, (_, im) in enumerate(items)])
    return [(k, out["scores"][str(i + 1)], out["depicts"][str(i + 1)]) for i, (k, _) in enumerate(items)]


def judge(cands, subject):
    refs = references()
    with ThreadPoolExecutor(2) as pool:
        rounds = list(pool.map(lambda s: panel(cands, refs, s), [1, 2]))
    bar = statistics.median(s for r in rounds for k, s, _ in r if k == "ref") if refs else 7
    depicts = {k: d for k, _, d in rounds[0] if k != "ref"}
    match = ask(f'Intended emoji: "{subject}". For each description below, does it clearly depict that subject? '
                'Reply JSON: {"match": {"<key>": true}}\n' + json.dumps(depicts), [], "low")["match"]
    result = {}
    for k in cands:
        score = statistics.mean(s for r in rounds for kk, s, _ in r if kk == k)
        result[k] = {"score": round(score, 1), "depicts": depicts[k], "on_subject": bool(match.get(k))}
    return result, bar


MOTIONS = {
    "bounce": lambda t: dict(dy=-0.14 * abs(math.sin(math.pi * t)), sx=1 + 0.08 * (1 - abs(math.sin(math.pi * t))) ** 4,
                             sy=1 - 0.08 * (1 - abs(math.sin(math.pi * t))) ** 4, scale=0.84, ground=True),
    "wobble": lambda t: dict(rot=10 * math.sin(2 * math.pi * t), scale=0.86),
    "pulse": lambda t: dict(scale=0.84 + 0.12 * (0.5 - 0.5 * math.cos(2 * math.pi * t))),
    "shake": lambda t: dict(dx=0.04 * math.sin(4 * math.pi * t), rot=4 * math.sin(4 * math.pi * t + 1), scale=0.88),
    "rumble": lambda t: dict(dx=0.025 * math.sin(6 * math.pi * t), dy=-0.02 * abs(math.sin(4 * math.pi * t)), scale=0.9),
    "spin": lambda t: dict(rot=-360 * t, scale=0.7),
    "hover": lambda t: dict(dy=0.05 * math.sin(2 * math.pi * t), rot=3 * math.sin(2 * math.pi * t + 1), scale=0.86),
}


def frame(src, t, motion, size=128, matte=None):
    m = {"dx": 0, "dy": 0, "rot": 0, "sx": 1, "sy": 1, "scale": 1, "ground": False, **MOTIONS[motion](t)}
    big = src.width
    layer = src.convert("RGBa").resize((int(big * m["scale"] * m["sx"]), int(big * m["scale"] * m["sy"])), Image.LANCZOS)
    if m["rot"]:
        layer = layer.rotate(m["rot"], resample=Image.BICUBIC, expand=True)
    canvas = Image.new("RGBa", (big, big))
    x = (big - layer.width) // 2 + round(m["dx"] * size) * (big // size)
    base = big - layer.height - int(big * 0.04) if m["ground"] else (big - layer.height) // 2
    canvas.paste(layer, (x, base + round(m["dy"] * size) * (big // size)))
    shot = canvas.resize((size, size), Image.LANCZOS).convert("RGBA")
    alpha = shot.getchannel("A")
    rgb = shot.convert("RGB")
    if matte:
        hard = alpha.point(lambda a: 255 if a >= 96 else 0)
        ring = ImageChops.subtract(hard, hard.filter(ImageFilter.MinFilter(3)))
        fill = rgb.filter(ImageFilter.MaxFilter(9))
        rgb.paste(Image.blend(fill, Image.new("RGB", rgb.size, matte), 0.5), mask=ring)
        rgb.putalpha(hard)
        return rgb
    rgb.paste(rgb.filter(ImageFilter.MinFilter(3)), mask=alpha.point(lambda a: 255 if 0 < a < 255 else 0))
    rgb.putalpha(alpha.point(lambda a: 255 if a >= 128 else 0))
    return rgb


def flat_palette(src, share=0.004, merge=40):
    rgb = src.convert("RGB")
    rgb.paste((255, 0, 255), mask=src.getchannel("A").point(lambda a: 255 if a < 255 else 0))
    buckets = {}
    for n, c in rgb.getcolors(1 << 16):
        if c != (255, 0, 255):
            b = buckets.setdefault(tuple(v >> 4 for v in c), [0, 0, 0, 0])
            b[0] += n
            for i in range(3):
                b[i + 1] += n * c[i]
    opaque = sum(b[0] for b in buckets.values())
    pal = []
    for n, r, g, b in sorted(buckets.values(), reverse=True):
        c = (r // n, g // n, b // n)
        if n < share * opaque:
            break
        if all(sum((x - y) ** 2 for x, y in zip(c, pal[i:i + 3])) > merge ** 2 for i in range(0, len(pal), 3)):
            pal += c
    pal += [255, 0, 255]
    img = Image.new("P", (1, 1))
    img.putpalette(pal + [0] * (768 - len(pal)))
    return img, len(pal) // 3 - 1


def animate(src_path, out, motion, frames=10, loop_ms=700, matte=None):
    if not 8 <= frames <= 12 or not 300 <= loop_ms <= 900:
        sys.exit("use 8-12 frames and a 300-900 ms loop")
    src = Image.open(src_path).convert("RGBA")
    if src.width < 256:
        src = src.resize((512, 512), Image.LANCZOS)
    shots = [frame(src, i / frames, motion, matte=matte) for i in range(frames)]
    if matte:
        strip = Image.new("RGB", (128 * frames, 128), matte)
        for i, s in enumerate(shots):
            strip.paste(s.convert("RGB"), (128 * i, 0), s.getchannel("A"))
        pal = strip.quantize(63, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
        pal.putpalette(pal.getpalette()[: 63 * 3] + [255, 0, 255])
        clear = 63
    else:
        pal, clear = flat_palette(src)
    out_frames = []
    for shot in shots:
        q = shot.convert("RGB").quantize(palette=pal, dither=Image.Dither.NONE)
        q.paste(clear, mask=shot.getchannel("A").point(lambda a: 255 - a))
        out_frames.append(q)
    out_frames[0].save(out, save_all=True, append_images=out_frames[1:], duration=round(loop_ms / frames),
                       loop=0, disposal=2, transparency=clear, optimize=False)
    return out


def review_motion(gif, subject):
    g = Image.open(gif)
    shots = [f.convert("RGBA") for f in ImageSequence.Iterator(g)]
    clipped = [i + 1 for i, f in enumerate(shots) if any(f.getchannel("A").crop(b).getextrema()[1] > 128
                                                         for b in [(0, 0, 128, 1), (0, 127, 128, 128), (0, 0, 1, 128), (127, 0, 128, 128)])]
    verdict = ask(f"These {len(shots)} images are the consecutive frames, in order, of a looping animated Slack emoji of "
                  f"\"{subject}\" ({g.info.get('duration')} ms per frame, then it loops back to frame 1). Picture it playing. "
                  "Describe the motion a viewer perceives, and say whether that motion makes sense for the subject, loops "
                  "smoothly, and keeps the whole subject in frame. "
                  'Reply JSON: {"motion": "...", "makes_sense": true, "problems": "..."}', [numbered(f, i + 1) for i, f in enumerate(shots)])
    verdict["frames_touching_edge"] = clipped
    return verdict


def make(a):
    os.makedirs(a.out, exist_ok=True)
    keys = [chr(65 + i) for i in range(a.n)]
    with ThreadPoolExecutor(a.n) as pool:
        raws = dict(zip(keys, pool.map(lambda k: generate(a.subject, a.image_model, f"{a.out}/{a.name}-{k}.raw.png"), keys)))
    cands = {k: process(raws[k], f"{a.out}/{a.name}-{k}.png") for k in keys}
    scores, bar = judge(cands, a.subject)
    for k in keys:
        scores[k]["defects"] = defects(raws[k])
        scores[k]["passes"] = scores[k]["on_subject"] and not scores[k]["defects"] and scores[k]["score"] >= bar
    best = max(keys, key=lambda k: (scores[k]["passes"], scores[k]["on_subject"], not scores[k]["defects"], scores[k]["score"]))
    result = {"reference_median": bar, "candidates": scores, "best": best, "passes": scores[best]["passes"]}
    final = f"{a.out}/{a.name}.png"
    Image.open(cands[best]).save(final)
    result["png"] = final
    if a.motion:
        result["gif"] = animate(f"{a.out}/{a.name}-{best}.src.png", f"{a.out}/{a.name}.gif", a.motion, a.frames, a.loop_ms)
        result["motion_review"] = review_motion(result["gif"], a.subject)
    for k in ("png", "gif"):
        if k in result and os.path.getsize(result[k]) > 128 * 1024:
            result["warning"] = f"{k} is over Slack's 128KB limit"
    print(json.dumps(result, indent=2))
    if not result["passes"]:
        sys.exit(2)


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    m = sub.add_parser("make")
    m.add_argument("subject")
    m.add_argument("--name", required=True)
    m.add_argument("--out", default="/tmp/emoji")
    m.add_argument("--n", type=int, default=4)
    m.add_argument("--motion", choices=sorted(MOTIONS))
    m.add_argument("--frames", type=int, default=10)
    m.add_argument("--loop-ms", type=int, default=700)
    m.add_argument("--image-model", default="gpt-image-1.5")
    pr = sub.add_parser("process")
    pr.add_argument("src")
    pr.add_argument("out")
    an = sub.add_parser("animate")
    an.add_argument("src")
    an.add_argument("out")
    an.add_argument("subject")
    an.add_argument("--motion", choices=sorted(MOTIONS), required=True)
    an.add_argument("--frames", type=int, default=10)
    an.add_argument("--loop-ms", type=int, default=700)
    an.add_argument("--matte", help="hex mid-tone to blend the silhouette edge toward, e.g. 8c8c8c")
    jd = sub.add_parser("judge")
    jd.add_argument("subject")
    jd.add_argument("images", nargs="+")
    a = p.parse_args()
    if a.cmd == "make":
        make(a)
    elif a.cmd == "process":
        print(process(a.src, a.out))
    elif a.cmd == "animate":
        matte = tuple(int(a.matte[i:i + 2], 16) for i in (0, 2, 4)) if a.matte else None
        print(json.dumps(review_motion(animate(a.src, a.out, a.motion, a.frames, a.loop_ms, matte), a.subject), indent=2))
    else:
        scores, bar = judge({os.path.basename(i): i for i in a.images}, a.subject)
        print(json.dumps({"reference_median": bar, "candidates": scores}, indent=2))


if __name__ == "__main__":
    main()
