# -*- coding: utf-8 -*-
"""把《海弗拉斯26届回忆录》docx 转成站点可用的 posts.json + 压缩后的图片/音频。

用法:
    python scripts/build_site_data.py

输出:
    docs/data/posts.json
    docs/assets/img/*.jpg          (原图, 长边 <=1600 / 超高截图 <=2200)
    docs/assets/img/thumbs/*.jpg   (网格缩略图, 长边 <=560)
    docs/assets/audio/*            (文档中提到的两段音频)
"""
import io
import json
import os
import re
import shutil
import zipfile
from datetime import datetime, timedelta, timezone
from xml.etree import ElementTree as ET

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOCX = os.path.join(ROOT, "海弗拉斯26届回忆录——hw也有回忆录😋.docx")
AUDIO_DIR = os.path.join(ROOT, "音频")
DOCS = os.path.join(ROOT, "docs")
IMG_DIR = os.path.join(DOCS, "assets", "img")
THUMB_DIR = os.path.join(IMG_DIR, "thumbs")
AUDIO_OUT = os.path.join(DOCS, "assets", "audio")
DATA_OUT = os.path.join(DOCS, "data")

NS = {
    "w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "v": "urn:schemas-microsoft-com:vml",
}

AUDIO_FILES = {
    "REC20221121002.wav": {"title": "运动会神曲 · 许奕老师的歌", "out": "sports-song.wav"},
    "蕾歌.m4a": {"title": "蕾歌 · 蕾丽老师", "out": "leige.m4a"},
}

SECTIONS = [
    {
        "id": "prelude",
        "name": "序 · Prelude",
        "short": "序",
        "emoji": "🌱",
        "desc": "写于 2026.10.22，by Marguerite。关于为什么要留下这本回忆录。",
    },
    {
        "id": "scene",
        "name": "浮光掠影 · 忆景",
        "short": "忆景",
        "emoji": "🌸",
        "desc": "我们回到杭外的樱花树下，不要被命运找到。猫猫、花、天台与晚霞。",
    },
    {
        "id": "story",
        "name": "似水流年 · 忆事",
        "short": "忆事",
        "emoji": "📖",
        "desc": "二班十四人略事、1306、寝室夜聊、白板、雪天与白月光。",
    },
    {
        "id": "food",
        "name": "民以食为天 · 食堂",
        "short": "食堂",
        "emoji": "🍜",
        "desc": "二楼拌面、泡泡鸡、铁板饭、免费汤，以及全世界最讨厌的香菜。",
    },
    {
        "id": "love",
        "name": "璀璨如歌 · 表白/展望",
        "short": "表白",
        "emoji": "💌",
        "desc": "好久不见，但我们来日方长。把喜欢的人和照片都放在这里。",
    },
    {
        "id": "rant",
        "name": "苦涩如歌 · 吐槽",
        "short": "吐槽",
        "emoji": "🌧️",
        "desc": "大学、天气、midterm 与香菜。以及“我想回杭外”。",
    },
    {
        "id": "teacher",
        "name": "老师萌 · 老师",
        "short": "老师",
        "emoji": "🍎",
        "desc": "许奕、潘俊、蕾丽、Sylvia、Ms Lu……和我们想再说一次的话。",
    },
    {
        "id": "classmate",
        "name": "同学们 · 同学",
        "short": "同学",
        "emoji": "🤝",
        "desc": "接着盖楼。傻狗、wyt，还有所有在列表里的杭外人。",
    },
]

# docx 标题文字 -> section id
HEADING_MAP = {
    "Prelude": "prelude",
    "浮光掠影": "scene",
    "似水流年": "story",
    "民以食为天": "food",
    "璀璨如歌": "love",
    "苦涩如歌": "rant",
    "老师萌": "teacher",
    "同学们": "classmate",
}

RE_REPLY = re.compile(r"^[（(]?\s*(?:re|Re|RE|rE)\s*[.．]?\s*[:：]\s*")
IMG_MARK = re.compile(r"\[\[IMG:([^\]]+)\]\]")



# ---------------------------------------------------------------- docx parsing
def load_rels(z):
    out = {}
    xml = z.read("word/_rels/document.xml.rels")
    for rel in ET.fromstring(xml):
        target = rel.get("Target")
        if target and not target.startswith("http"):
            out[rel.get("Id")] = target
    return out


def para_text(p):
    parts = []
    for node in p.iter():
        tag = node.tag.split("}")[-1]
        if tag == "t":
            parts.append(node.text or "")
        elif tag == "br":
            parts.append("\n")
        elif tag == "tab":
            parts.append("    ")
        elif tag == "drawing":
            ids = [b.get("{%s}embed" % NS["r"]) for b in node.iter("{%s}blip" % NS["a"])]
            parts.append("[[IMG:%s]]" % ",".join(i for i in ids if i))
        elif tag == "pict":
            ids = [i.get("{%s}id" % NS["r"]) for i in node.iter("{%s}imagedata" % NS["v"])]
            parts.append("[[IMG:%s]]" % ",".join(i for i in ids if i))
    return "".join(parts)


def read_blocks():
    z = zipfile.ZipFile(DOCX)
    rels = load_rels(z)
    doc = ET.fromstring(z.read("word/document.xml"))
    body = doc.find("w:body", NS)
    blocks = []
    for el in body:
        if el.tag.split("}")[-1] != "p":
            continue
        text = para_text(el)
        if not text.strip():
            continue
        style_el = el.find("w:pPr/w:pStyle", NS)
        style = style_el.get("{%s}val" % NS["w"]) if style_el is not None else ""
        blocks.append({"style": style, "raw": text})
    return z, rels, blocks


def clean_text(text):
    text = text.replace("\u00a0", " ").replace("\u3000", " ")
    text = text.replace("\\n", "\n")
    text = IMG_MARK.sub("", text)
    for name in AUDIO_FILES:
        text = text.replace(name, "")
    lines = []
    for line in text.split("\n"):
        line = re.sub(r"[ \t]{2,}", " ", line).strip()
        lines.append(line)
    text = "\n".join(lines)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    return text


def indent_depth(raw):
    """前导空白 -> 楼中楼层级(0-3)，原文用缩进表示回复关系。"""
    m = re.match(r"^[ \t]*", raw)


# ---------------------------------------------------------------- images
class ImageStore:
    def __init__(self, z, rels):
        self.z = z
        self.rels = rels
        self.cache = {}       # rId -> image dict or None
        self.saved = {}       # media target -> image dict

    def get(self, rid):
        if rid in self.cache:
            return self.cache[rid]
        target = self.rels.get(rid)
        info = self.build(target) if target else None
        self.cache[rid] = info
        return info

    def build(self, target):
        src = "word/" + target
        try:
            raw = self.z.read(src)
        except KeyError:
            return None
        if target in self.saved:
            return self.saved[target]
        base = os.path.splitext(os.path.basename(target))[0]
        name = base.replace("image", "hw-") + ".jpg"
        try:
            im = Image.open(io.BytesIO(raw))
            im.load()
        except Exception as exc:  # noqa: BLE001 - 跳过无法识别的媒体
            print("  ! 跳过无法识别的图片", target, exc)
            return None
        if im.mode in ("RGBA", "LA", "P", "CMYK"):
            im = im.convert("RGBA")
            bg = Image.new("RGB", im.size, (255, 255, 255))
            bg.paste(im, mask=im.split()[-1])
            im = bg
        else:
            im = im.convert("RGB")
        w, h = im.size
        long_side = max(w, h)
        cap = 2200 if h > w * 1.8 else 1600
        if long_side > cap:
            ratio = cap / long_side
            im = im.resize((max(1, round(w * ratio)), max(1, round(h * ratio))), Image.LANCZOS)
            w, h = im.size
        im.save(os.path.join(IMG_DIR, name), "JPEG", quality=82, optimize=True, progressive=True)

        scale = min(1.0, 560 / max(w, h))
        thumb = im.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)
        thumb.save(os.path.join(THUMB_DIR, name), "JPEG", quality=72, optimize=True, progressive=True)
        info = {
            "src": "assets/img/" + name,
            "thumb": "assets/img/thumbs/" + name,
            "w": w,
            "h": h,
        }
        self.saved[target] = info
        return info


def copy_audio():
    os.makedirs(AUDIO_OUT, exist_ok=True)
    out = {}
    for name, meta in AUDIO_FILES.items():
        src = os.path.join(AUDIO_DIR, name)
        out_name = meta.get("out") or name
        if os.path.exists(src):
            shutil.copyfile(src, os.path.join(AUDIO_OUT, out_name))
            out[name] = {"src": "assets/audio/" + out_name, "title": meta["title"]}
        else:
            print("  ! 缺少音频", src)
    return out


# ---------------------------------------------------------------- build posts
def main():
    for d in (IMG_DIR, THUMB_DIR, AUDIO_OUT, DATA_OUT):
        os.makedirs(d, exist_ok=True)

    z, rels, blocks = read_blocks()
    store = ImageStore(z, rels)
    audio_map = copy_audio()

    meta = {"title": "海弗拉斯26届回忆录", "tagline": "hw 也有回忆录 😋"}
    section = None
    group = ""
    posts = []
    current = None
    cursor = datetime(2026, 10, 23, 19, 0, 0, tzinfo=timezone(timedelta(hours=8)))

    def new_post(text="", images=None, audio=None):
        nonlocal cursor, current
        cursor += timedelta(minutes=1)
        post = {
            "id": "doc-%03d" % (len(posts) + 1),
            "section": section,
            "origin": "docx",
            "floor": len(posts) + 1,
            "author": "匿名同学",
            "createdAt": cursor.isoformat(),
            "text": text,
            "images": images or [],
            "audio": audio or [],
            "comments": [],
        }
        if group:
            post["group"] = group
        posts.append(post)
        current = post
        return post

    def add_comment(post, raw, text):
        body = RE_REPLY.sub("", text, count=1).strip()
        if not body:
            return
        post["comments"].append({
            "author": "匿名回复",
            "text": body,
            "depth": 0,
        })

    for idx, block in enumerate(blocks):
        style = block["style"]
        raw = block["raw"]
        text = clean_text(raw)

        images = []
        for m in IMG_MARK.finditer(raw):
            for rid in m.group(1).split(","):
                info = store.get(rid)
                if info and info not in images:
                    images.append(info)
        audios = []
        for name, meta_audio in audio_map.items():
            if name in raw and meta_audio not in audios:
                audios.append(meta_audio)

        if idx == 0 and text and not images:
            meta["title"] = text
            continue
        if idx == 1 and text and not images:
            meta["tagline"] = text
            continue

        if style == "000003" and text and not images:
            for key, sid in HEADING_MAP.items():
                if text.startswith(key):
                    section = sid
                    break
            group = ""
            current = None
            continue
        if style == "000005" and text and not images:
            group = text
            current = None
            continue

        if section is None:
            section = "prelude"
        if not text and not images and not audios:
            continue

        if RE_REPLY.match(text):
            if current is None:
                current = new_post("", [], [])
            add_comment(current, raw, text)
            for info in audios:
                if info not in current["audio"]:
                    current["audio"].append(info)
            continue

        if not text:
            # 纯图片/音频段落：并入上一楼（若上一楼还没人回复），否则新开一楼
            if current is not None and not current["comments"] and not audios:
                for info in images:
                    if info not in current["images"]:
                        current["images"].append(info)
                for info in audios:
                    if info not in current["audio"]:
                        current["audio"].append(info)
                continue
            new_post("", images, audios)
            continue

        post = new_post(text, images, audios)

    # Prelude：多段合成一楼
    pre = [p for p in posts if p["section"] == "prelude" and p["text"]]
    if len(pre) > 1:
        head = pre[0]
        head["text"] = "\n\n".join(p["text"] for p in pre)
        head["title"] = "Prelude · 写在前面"
        head["author"] = "Marguerite."
        drop = {id(p) for p in pre[1:]}
        posts = [p for p in posts if id(p) not in drop]
    elif pre:
        pre[0]["author"] = "Marguerite."
        pre[0]["title"] = "Prelude · 写在前面"

    # 去掉完全空白的楼
    posts = [p for p in posts if p["text"] or p["images"] or p["audio"]]

    for n, p in enumerate(posts, 1):
        p["floor"] = n
        p["id"] = "doc-%03d" % n

    stats_by_section = {}
    for p in posts:
        stats_by_section[p["section"]] = stats_by_section.get(p["section"], 0) + 1

    payload = {
        "site": {
            "title": meta["title"],
            "tagline": meta["tagline"],
            "school": "杭州外国语学校",
            "cohort": "2026 届",
            "generatedAt": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        },
        "sections": SECTIONS,
        "posts": posts,
        "stats": {
            "posts": len(posts),
            "comments": sum(len(p["comments"]) for p in posts),
            "images": sum(len(p["images"]) for p in posts),
            "audio": sum(len(p["audio"]) for p in posts),
            "bySection": stats_by_section,
        },
    }
    out = os.path.join(DATA_OUT, "posts.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)
        f.write("\n")
    print(json.dumps(payload["stats"], ensure_ascii=False))


if __name__ == "__main__":
    main()
