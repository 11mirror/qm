import argparse, base64, io, json, math, os, sys, textwrap, urllib.request
from concurrent.futures import ThreadPoolExecutor
from PIL import Image, ImageDraw, ImageFont

LIGHT, DARK = (255, 255, 255), (26, 29, 33)
STYLE = (
    "Slack custom emoji of {subject}. One bold, chunky subject that fills the whole square frame, centered. "
    "Thick dark outline around the whole silhouette. Flat cel-shaded colours, at most 7, no gradients, "
    "no texture, no fine detail. Only add a face if the subject naturally has one, and then keep it to big eyes and mouth. "
    "No text, letters or numbers. No shadow, scenery or background: transparent background. "
    "It must read instantly when shrunk to 22 pixels."
)


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


def generate(subject, model):
    data = broker("https://api.openai.com/v1/images/generations", {
        "model": model, "prompt": STYLE.format(subject=subject), "size": "1024x1024",
        "background": "transparent", "output_format": "png", "quality": "medium"})
    return Image.open(io.BytesIO(base64.b64decode(data["data"][0]["b64_json"]))).convert("RGBA")


def strip_background(im):
    im = im.convert("RGBA")
    if im.getchannel("A").getextrema()[0] > 0:
        for xy in [(0, 0), (im.width - 1, 0), (0, im.height - 1), (im.width - 1, im.height - 1)]:
            if im.getpixel(xy)[3] > 0:
                ImageDraw.floodfill(im, xy, (0, 0, 0, 0), thresh=40)
    im.putalpha(im.getchannel("A").point(lambda a: 0 if a < 32 else 255 if a > 224 else a))
    return im


def square(im, size):
    box = im.getchannel("A").point(lambda a: 255 if a > 16 else 0).getbbox() or (0, 0, im.width, im.height)
    im = im.crop(box)
    side = max(im.size)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(im, ((side - im.width) // 2, (side - im.height) // 2))
    inner = size - max(2, size // 64) * 2
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    scaled = canvas.convert("RGBa").resize((inner, inner), Image.LANCZOS).convert("RGBA")
    out.paste(scaled, ((size - inner) // 2,) * 2)
    return out


def finish(im, colors=32):
    alpha = im.getchannel("A")
    out = im.convert("RGB").quantize(colors, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).convert("RGBA")
    out.putalpha(alpha)
    return out


def process(src, out):
    hi = square(strip_background(Image.open(src)), 512)
    hi.save(out.replace(".png", ".src.png"))
    finish(square(hi, 128)).save(out, optimize=True)
    return out


def on(bg, im, size):
    tile = Image.new("RGBA", (size, size), bg + (255,))
    small = im if im.width == size else im.convert("RGBa").resize((size, size), Image.LANCZOS).convert("RGBA")
    tile.alpha_composite(small)
    return tile


def sheet(paths, labels, out):
    font = ImageFont.load_default(14)
    cols = ["128 light", "128 dark", "22 light", "22 dark", "22 light x4", "22 dark x4"]
    cw, rh, lw = 136, 140, 220
    img = Image.new("RGBA", (lw + cw * len(cols), 24 + rh * len(paths)), (240, 240, 240, 255))
    d = ImageDraw.Draw(img)
    for c, name in enumerate(cols):
        d.text((lw + c * cw + 4, 4), name, fill="black", font=font)
    for r, (p, label) in enumerate(zip(paths, labels)):
        im = Image.open(p).convert("RGBA")
        y = 24 + r * rh
        d.multiline_text((6, y + 8), label, fill="black", font=font)
        for c, bg in enumerate([LIGHT, DARK]):
            img.paste(on(bg, im, 128), (lw + c * cw, y))
            img.paste(on(bg, im, 22), (lw + (2 + c) * cw + 53, y + 53))
            img.paste(on(bg, im, 22).resize((88, 88), Image.NEAREST), (lw + (4 + c) * cw + 20, y + 20))
    img.convert("RGB").save(out)
    return out


def facts(path):
    a = Image.open(path).convert("RGBA").getchannel("A")
    clear = a.histogram()[0] / (a.width * a.height)
    box = a.point(lambda v: 255 if v > 16 else 0).getbbox() or (0, 0, 0, 0)
    fill = max(box[2] - box[0], box[3] - box[1]) / a.width
    return f"{round(clear * 100)}% transparent, subject spans {round(fill * 100)}% of the frame"


def score(sheet_path, labels, subject, model, paths):
    b64 = base64.b64encode(open(sheet_path, "rb").read()).decode()
    rows = "\n".join(f"{l}: {facts(p)}" for l, p in zip(labels, paths))
    ask = (f"Each row of this sheet is a candidate Slack custom emoji for: {subject}. Score each 1-10 as a "
           "Slack emoji, judged mainly at 22px on both the light (#ffffff) and dark (#1a1d21) themes: "
           "instantly recognisable, one bold silhouette filling the frame, outline visible on dark, flat colours, "
           "no muddy detail, no text. An opaque background (a visible square tile on either theme) is a serious "
           f"defect; cap such a candidate at 4. Measured facts per row:\n{rows}\n"
           'Reply as JSON: {"scores": [{"label": "...", "score": n, "note": "under 15 words"}]}')
    request = {"model": model, "reasoning": {"effort": "medium"}, "text": {"format": {"type": "json_object"}},
               "input": [{"role": "user", "content": [{"type": "input_text", "text": ask},
                                                      {"type": "input_image", "image_url": f"data:image/png;base64,{b64}"}]}]}

    def vote(_):
        data = broker("https://api.openai.com/v1/responses", request)
        text = next(c["text"] for o in data["output"] if o["type"] == "message" for c in o["content"] if c["type"] == "output_text")
        return {s["label"]: s for s in json.loads(text)["scores"]}

    with ThreadPoolExecutor(2) as pool:
        votes = list(pool.map(vote, range(2)))
    return {l: {"score": sum(v.get(l, {}).get("score", 0) for v in votes) / len(votes),
                "note": votes[0].get(l, {}).get("note", "")} for l in labels}


MOTIONS = {
    "bounce": lambda t: dict(dy=-0.16 * abs(math.sin(math.pi * t)), sx=1 + 0.1 * (1 - abs(math.sin(math.pi * t))) ** 4,
                             sy=1 - 0.1 * (1 - abs(math.sin(math.pi * t))) ** 4, scale=0.84),
    "wobble": lambda t: dict(rot=12 * math.sin(2 * math.pi * t), scale=0.9),
    "pulse": lambda t: dict(scale=0.84 + 0.16 * (0.5 - 0.5 * math.cos(2 * math.pi * t))),
    "shake": lambda t: dict(dx=0.05 * math.sin(4 * math.pi * t), rot=4 * math.sin(4 * math.pi * t + 1), scale=0.9),
    "spin": lambda t: dict(rot=-360 * t, scale=0.74),
    "hover": lambda t: dict(dy=0.06 * math.sin(2 * math.pi * t), rot=3 * math.sin(2 * math.pi * t + 1), scale=0.86),
    "fly": lambda t: dict(dy=-2 * t if t < 0.5 else 2 * (1 - t), scale=0.9),
}


def frame(src, t, motion, size=128):
    m = {"dx": 0, "dy": 0, "rot": 0, "sx": 1, "sy": 1, "scale": 1, **MOTIONS[motion](t)}
    big = src.width
    w, h = int(big * m["scale"] * m["sx"]), int(big * m["scale"] * m["sy"])
    layer = src.convert("RGBa").resize((w, h), Image.LANCZOS)
    if m["rot"]:
        layer = layer.rotate(m["rot"], resample=Image.BICUBIC, expand=True)
    canvas = Image.new("RGBa", (big, big))
    x = (big - layer.width) // 2 + int(m["dx"] * big)
    y = big - layer.height - int(big * (1 - m["scale"]) / 2) + int(m["dy"] * big) if motion == "bounce" else (big - layer.height) // 2 + int(m["dy"] * big)
    canvas.paste(layer, (x, y))
    return canvas.resize((size, size), Image.LANCZOS).convert("RGBA")


def animate(src_path, out, motion, frames=10, loop_ms=700):
    if not 8 <= frames <= 12 or not 300 <= loop_ms <= 900:
        sys.exit("use 8-12 frames and a 300-900 ms loop")
    src = Image.open(src_path).convert("RGBA")
    if src.width < 256:
        src = src.resize((512, 512), Image.LANCZOS)
    shots = [frame(src, i / frames, motion) for i in range(frames)]
    masks = [s.getchannel("A").point(lambda a: 255 if a >= 128 else 0) for s in shots]
    strip = Image.new("RGB", (128 * frames, 128), (0, 0, 0))
    for i, (s, m) in enumerate(zip(shots, masks)):
        strip.paste(s.convert("RGB"), (128 * i, 0), m)
    pal = strip.quantize(31, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    palette = pal.getpalette()[: 31 * 3] + [255, 0, 255]
    pal.putpalette(palette)
    out_frames = []
    for s, m in zip(shots, masks):
        q = s.convert("RGB").quantize(palette=pal, dither=Image.Dither.NONE)
        q.paste(31, mask=m.point(lambda a: 255 - a))
        out_frames.append(q)
    out_frames[0].save(out, save_all=True, append_images=out_frames[1:], duration=round(loop_ms / frames),
                       loop=0, disposal=2, transparency=31, optimize=False)
    return out


def make(a):
    os.makedirs(a.out, exist_ok=True)
    with ThreadPoolExecutor(a.n) as pool:
        raws = list(pool.map(lambda _: generate(a.subject, a.image_model), range(a.n)))
    labels = [chr(65 + i) for i in range(a.n)]
    paths = []
    for label, raw in zip(labels, raws):
        raw.save(f"{a.out}/{a.name}-{label}.raw.png")
        paths.append(process(f"{a.out}/{a.name}-{label}.raw.png", f"{a.out}/{a.name}-{label}.png"))
    preview = sheet(paths, labels, f"{a.out}/{a.name}-sheet.png")
    scores = score(preview, labels, a.subject, a.score_model, paths)
    best = max(labels, key=lambda l: scores.get(l, {}).get("score", 0))
    final = f"{a.out}/{a.name}.png"
    Image.open(f"{a.out}/{a.name}-{best}.png").save(final)
    result = {"best": best, "png": final, "sheet": preview, "scores": scores}
    if a.motion:
        result["gif"] = animate(f"{a.out}/{a.name}-{best}.src.png", f"{a.out}/{a.name}.gif", a.motion, a.frames, a.loop_ms)
    for k in ("png", "gif"):
        if k in result and os.path.getsize(result[k]) > 128 * 1024:
            result["warning"] = f"{k} is over Slack's 128KB limit"
    print(json.dumps(result, indent=2))


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
    m.add_argument("--score-model", default="gpt-5.1")
    pr = sub.add_parser("process")
    pr.add_argument("src")
    pr.add_argument("out")
    an = sub.add_parser("animate")
    an.add_argument("src")
    an.add_argument("out")
    an.add_argument("--motion", choices=sorted(MOTIONS), required=True)
    an.add_argument("--frames", type=int, default=10)
    an.add_argument("--loop-ms", type=int, default=700)
    sh = sub.add_parser("sheet")
    sh.add_argument("out")
    sh.add_argument("images", nargs="+")
    sh.add_argument("--score", metavar="SUBJECT")
    sh.add_argument("--score-model", default="gpt-5.1")
    a = p.parse_args()
    if a.cmd == "make":
        make(a)
    elif a.cmd == "process":
        print(process(a.src, a.out))
    elif a.cmd == "animate":
        print(animate(a.src, a.out, a.motion, a.frames, a.loop_ms))
    else:
        labels = [os.path.basename(i).rsplit(".", 1)[0] for i in a.images]
        sheet(a.images, labels, a.out)
        if a.score:
            scores = score(a.out, labels, a.score, a.score_model, a.images)
            sheet(a.images, [f"{l}\n{scores.get(l, {}).get('score', '?')}/10\n{textwrap.fill(scores.get(l, {}).get('note', ''), 26)}" for l in labels], a.out)
            print(json.dumps(scores, indent=2))
        print(a.out)


if __name__ == "__main__":
    main()
