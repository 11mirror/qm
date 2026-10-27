import argparse, base64, io, json, math, os, sys, urllib.request
from concurrent.futures import ThreadPoolExecutor
from PIL import Image, ImageChops, ImageDraw, ImageFilter


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


def data_url(im):
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def generate(prompt, model, out):
    data = broker("https://api.openai.com/v1/images/generations", {
        "model": model, "prompt": prompt, "size": "1024x1024",
        "background": "transparent", "output_format": "png", "quality": "high"})
    Image.open(io.BytesIO(base64.b64decode(data["data"][0]["b64_json"]))).convert("RGBA").save(out)
    return out


def derive(base, prompt, model, out):
    data = broker("https://api.openai.com/v1/responses", {
        "model": "gpt-5.5", "reasoning": {"effort": "low"},
        "tools": [{"type": "image_generation", "model": model, "background": "transparent", "quality": "high",
                   "size": "1024x1024", "output_format": "png"}],
        "tool_choice": {"type": "image_generation"},
        "input": [{"role": "user", "content": [
            {"type": "input_text", "text": prompt},
            {"type": "input_image", "image_url": data_url(Image.open(base))}]}]})
    call = next(o for o in data["output"] if o["type"] == "image_generation_call")
    Image.open(io.BytesIO(base64.b64decode(call["result"]))).convert("RGBA").save(out)
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


def process(src, out, opaque=None):
    hi = square(strip_background(Image.open(src)), 512)
    hi.save(out.removesuffix(".png") + ".src.png")
    im = square(hi, 128)
    if opaque:
        im = Image.alpha_composite(Image.new("RGBA", im.size, opaque + (255,)), im)
    im.save(out, optimize=True)
    return out


def warnings(raw, outputs):
    a = Image.open(raw).convert("RGBA").getchannel("A").point(lambda v: 255 if v > 32 else 0)
    w, h = a.size
    edge = any(a.getpixel((x, y)) for i in range(w) for x, y in ((i, 0), (i, h - 1), (0, i * h // w), (w - 1, i * h // w)))
    outside = a.copy()
    ImageDraw.floodfill(outside, (0, 0), 128)
    hist = outside.histogram()
    holes = hist[0] / max(1, hist[255])
    found = []
    if edge:
        found.append("the subject touches the canvas edge; it may be cut off")
    if holes > 0.03:
        found.append(f"see-through holes inside the subject ({round(holes * 100)}% of its area); white areas often come back transparent")
    for path in outputs:
        if os.path.getsize(path) > 128 * 1024:
            found.append(f"{os.path.basename(path)} is over Slack's 128KB limit")
    return found


MOTIONS = {
    "bounce": lambda t: dict(dy=-0.14 * abs(math.sin(math.pi * t)), sx=1 + 0.08 * (1 - abs(math.sin(math.pi * t))) ** 4,
                             sy=1 - 0.08 * (1 - abs(math.sin(math.pi * t))) ** 4, scale=0.84, ground=True),
    "wobble": lambda t: dict(rot=10 * math.sin(2 * math.pi * t), scale=0.86),
    "pulse": lambda t: dict(scale=0.84 + 0.12 * (0.5 - 0.5 * math.cos(2 * math.pi * t))),
    "shake": lambda t: dict(dx=0.04 * math.sin(4 * math.pi * t), rot=4 * math.sin(4 * math.pi * t + 1), scale=0.88),
    "rumble": lambda t: dict(dx=0.025 * math.sin(6 * math.pi * t), dy=-0.02 * abs(math.sin(4 * math.pi * t)), scale=0.9),
    "nod": lambda t: dict(rot=-7 * max(0.0, math.sin(2 * math.pi * t)), dy=0.05 * max(0.0, math.sin(2 * math.pi * t)), scale=0.86),
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


def animate(src_path, out, motion, frames=10, loop_ms=700, matte=(140, 140, 140), opaque=None):
    if not 8 <= frames <= 12 or not 300 <= loop_ms <= 900:
        sys.exit("use 8-12 frames and a 300-900 ms loop")
    src = Image.open(src_path).convert("RGBA")
    if src.width < 256:
        src = src.resize((512, 512), Image.LANCZOS)
    shots = [frame(src, i / frames, motion, matte=None if opaque else matte) for i in range(frames)]
    strip = Image.new("RGB", (128 * frames, 128), opaque or matte or (255, 0, 255))
    for i, s in enumerate(shots):
        if opaque:
            s = Image.alpha_composite(Image.new("RGBA", s.size, opaque + (255,)), s)
            shots[i] = s
        strip.paste(s.convert("RGB"), (128 * i, 0), s.getchannel("A"))
    if opaque:
        pal = strip.quantize(64, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
        out_frames = [s.convert("RGB").quantize(palette=pal, dither=Image.Dither.NONE) for s in shots]
        out_frames[0].save(out, save_all=True, append_images=out_frames[1:], duration=round(loop_ms / frames), loop=0, optimize=False)
        return out
    pal = strip.quantize(63, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    pal.putpalette(pal.getpalette()[: 63 * 3] + [255, 0, 255])
    out_frames = []
    for shot in shots:
        q = shot.convert("RGB").quantize(palette=pal, dither=Image.Dither.NONE)
        q.paste(63, mask=shot.getchannel("A").point(lambda a: 255 - a))
        out_frames.append(q)
    out_frames[0].save(out, save_all=True, append_images=out_frames[1:], duration=round(loop_ms / frames),
                       loop=0, disposal=2, transparency=63, optimize=False)
    return out


def build(a, name, draw):
    keys = [chr(65 + i) for i in range(a.n)]
    with ThreadPoolExecutor(a.n) as pool:
        raws = dict(zip(keys, pool.map(lambda k: draw(f"{a.out}/{name}-{k}.raw.png"), keys)))
    result = {}
    for k in keys:
        png = process(raws[k], f"{a.out}/{name}-{k}.png", a.opaque)
        files = [png]
        if a.motion:
            files.append(animate(f"{a.out}/{name}-{k}.src.png", f"{a.out}/{name}-{k}.gif", a.motion, a.frames, a.loop_ms, a.matte, a.opaque))
        result[k] = {"files": files, "warnings": warnings(raws[k], files)}
    return result


def colour(text):
    return None if text == "flat" else tuple(int(text[i:i + 2], 16) for i in (0, 2, 4))


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    shared = argparse.ArgumentParser(add_help=False)
    shared.add_argument("--motion", choices=sorted(MOTIONS))
    shared.add_argument("--frames", type=int, default=10)
    shared.add_argument("--loop-ms", type=int, default=700)
    shared.add_argument("--matte", type=colour, default="8c8c8c", help="hex mid-tone the GIF silhouette edge blends toward; 'flat' for a hard edge")
    shared.add_argument("--opaque", type=colour, help="hex background colour to fill the whole canvas instead of transparency")
    m = sub.add_parser("make", parents=[shared], help="generate candidates from your prompt, passed through verbatim")
    m.add_argument("prompt")
    m.add_argument("--name", required=True)
    m.add_argument("--out", default="/tmp/emoji")
    m.add_argument("--n", type=int, default=4)
    m.add_argument("--image-model", default="gpt-image-1.5")
    pk = sub.add_parser("pack", parents=[shared], help="redraw a finished .src.png with your prompt, using it as the reference image")
    pk.add_argument("base")
    pk.add_argument("prompt")
    pk.add_argument("--name", required=True)
    pk.add_argument("--out", default="/tmp/emoji")
    pk.add_argument("--n", type=int, default=2)
    pk.add_argument("--image-model", default="gpt-image-1.5")
    pr = sub.add_parser("process", parents=[shared])
    pr.add_argument("src")
    pr.add_argument("out")
    an = sub.add_parser("animate", parents=[shared])
    an.add_argument("src")
    an.add_argument("out")
    a = p.parse_args()
    if a.cmd in ("make", "pack"):
        os.makedirs(a.out, exist_ok=True)
        draw = (lambda out: generate(a.prompt, a.image_model, out)) if a.cmd == "make" else (lambda out: derive(a.base, a.prompt, a.image_model, out))
        print(json.dumps(build(a, a.name, draw), indent=2))
    elif a.cmd == "process":
        print(process(a.src, a.out, a.opaque))
    else:
        if not a.motion:
            sys.exit("animate needs --motion")
        print(animate(a.src, a.out, a.motion, a.frames, a.loop_ms, a.matte, a.opaque))


if __name__ == "__main__":
    main()
